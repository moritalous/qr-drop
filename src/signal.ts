// 接続情報(SDP)から必要な項目だけを抜き出し、QRに載る短い文字列にする。
// 受け取った側はその文字列からSDPを組み立て直す。

export interface Cand {
  /** h: host(IP) / s: srflx(STUNで得た外側アドレス) / m: mDNS名(.local) */
  kind: "h" | "s" | "m";
  addr: string;
  port: number;
}

export interface Signal {
  /** o: offer / a: answer(setup:active) / p: answer(setup:passive) */
  role: "o" | "a" | "p";
  ufrag: string;
  pwd: string;
  /** DTLS証明書のSHA-256フィンガープリント(32バイト) */
  fp: Uint8Array;
  cands: Cand[];
}

const MAGIC = "QD1";
const MAX_CANDS = 8;

function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(text: string): Uint8Array {
  const s = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function attr(sdp: string, name: string): string | undefined {
  const m = sdp.match(new RegExp(`^a=${name}:(.*)$`, "m"));
  return m?.[1]?.trim();
}

function candRank(c: Cand): number {
  const v6 = c.addr.includes(":");
  if (c.kind === "h") return v6 ? 3 : 0;
  if (c.kind === "s") return v6 ? 4 : 1;
  return 2;
}

export function fromSdp(sdp: string, type: "offer" | "answer"): Signal {
  const ufrag = attr(sdp, "ice-ufrag");
  const pwd = attr(sdp, "ice-pwd");
  const fpAttr = attr(sdp, "fingerprint");
  if (!ufrag || !pwd || !fpAttr) throw new Error("SDPに必要な項目がありません");
  const [alg, hex] = fpAttr.split(/\s+/);
  if (alg?.toLowerCase() !== "sha-256" || !hex) throw new Error("sha-256以外のフィンガープリントには未対応です");
  const fp = new Uint8Array(hex.split(":").map((x) => parseInt(x, 16)));
  if (fp.length !== 32 || fp.some(Number.isNaN)) throw new Error("フィンガープリントが不正です");

  const cands: Cand[] = [];
  const seen = new Set<string>();
  for (const line of sdp.split(/\r?\n/)) {
    if (!line.startsWith("a=candidate:")) continue;
    const p = line.slice("a=candidate:".length).trim().split(/\s+/);
    // foundation component transport priority addr port typ type ...
    const [, component, transport, , addr, port, , typ] = p;
    if (component !== "1" || transport?.toLowerCase() !== "udp" || !addr || !port) continue;
    if (typ !== "host" && typ !== "srflx") continue;
    if (addr.toLowerCase().startsWith("fe80:")) continue;
    const isMdns = addr.endsWith(".local");
    const c: Cand = {
      kind: isMdns ? "m" : typ === "srflx" ? "s" : "h",
      addr: isMdns ? addr.slice(0, -".local".length) : addr,
      port: Number(port),
    };
    const key = `${c.addr},${c.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cands.push(c);
  }
  cands.sort((a, b) => candRank(a) - candRank(b));

  let role: Signal["role"] = "o";
  if (type === "answer") role = attr(sdp, "setup") === "passive" ? "p" : "a";
  return { role, ufrag, pwd, fp, cands: cands.slice(0, MAX_CANDS) };
}

export function toSdp(sig: Signal, mid = "0"): string {
  const hex = [...sig.fp].map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(":");
  const setup = sig.role === "o" ? "actpass" : sig.role === "p" ? "passive" : "active";
  const lines = [
    "v=0",
    "o=- 1 2 IN IP4 127.0.0.1",
    "s=-",
    "t=0 0",
    `a=group:BUNDLE ${mid}`,
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
    "c=IN IP4 0.0.0.0",
  ];
  sig.cands.forEach((c, i) => {
    const addr = c.kind === "m" ? `${c.addr}.local` : c.addr;
    if (c.kind === "s") {
      const any = addr.includes(":") ? "::" : "0.0.0.0";
      lines.push(`a=candidate:${i + 1} 1 udp ${1686052607 - i} ${addr} ${c.port} typ srflx raddr ${any} rport 0`);
    } else {
      lines.push(`a=candidate:${i + 1} 1 udp ${2122260223 - i} ${addr} ${c.port} typ host`);
    }
  });
  lines.push(
    "a=end-of-candidates",
    `a=ice-ufrag:${sig.ufrag}`,
    `a=ice-pwd:${sig.pwd}`,
    `a=fingerprint:sha-256 ${hex}`,
    `a=setup:${setup}`,
    `a=mid:${mid}`,
    "a=sctp-port:5000",
    "a=max-message-size:262144",
  );
  return lines.join("\r\n") + "\r\n";
}

// 区切り文字 ~ ! , は ufrag/pwd(英数字と+/)にもIPアドレスにも現れない
export function encode(sig: Signal): string {
  const cands = sig.cands.map((c) => `${c.kind},${c.addr},${c.port}`).join("!");
  return [MAGIC, sig.role, sig.ufrag, sig.pwd, b64urlEncode(sig.fp), cands].join("~");
}

export function decode(text: string): Signal {
  const parts = text.trim().split("~");
  if (parts.length !== 6 || parts[0] !== MAGIC) throw new Error("QR Dropのコードではありません");
  const [, role, ufrag, pwd, fpText, candText] = parts as [string, string, string, string, string, string];
  if (role !== "o" && role !== "a" && role !== "p") throw new Error("コードが不正です");
  if (!/^[A-Za-z0-9+/]+$/.test(ufrag) || !/^[A-Za-z0-9+/]+$/.test(pwd)) throw new Error("コードが不正です");
  const fp = b64urlDecode(fpText);
  if (fp.length !== 32) throw new Error("コードが不正です");
  const cands: Cand[] = [];
  for (const item of candText ? candText.split("!") : []) {
    const [kind, addr, port] = item.split(",");
    const n = Number(port);
    if ((kind !== "h" && kind !== "s" && kind !== "m") || !addr || !/^[0-9A-Za-z.:-]+$/.test(addr)) throw new Error("コードが不正です");
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error("コードが不正です");
    cands.push({ kind, addr, port: n });
  }
  return { role, ufrag, pwd, fp, cands };
}
