import { expect, test } from "bun:test";
import jsQR from "jsqr";
import qrcode from "qrcode-generator";
import { decode, encode, fromSdp, toSdp } from "../src/signal";

const FP =
  "3A:4B:5C:6D:7E:8F:90:A1:B2:C3:D4:E5:F6:07:18:29:3A:4B:5C:6D:7E:8F:90:A1:B2:C3:D4:E5:F6:07:18:29";

const CHROME_OFFER = [
  "v=0",
  "o=- 4611731400430051336 2 IN IP4 127.0.0.1",
  "s=-",
  "t=0 0",
  "a=group:BUNDLE 0",
  "a=extmap-allow-mixed",
  "a=msid-semantic: WMS",
  "m=application 54321 UDP/DTLS/SCTP webrtc-datachannel",
  "c=IN IP4 203.0.113.7",
  "a=candidate:1 1 udp 2113937151 0f0e2a44-6f0c-4f3a-9d3e-2f6a8f1f2b11.local 54321 typ host generation 0 network-cost 999",
  "a=candidate:2 1 udp 2122260223 192.168.1.23 50000 typ host generation 0 network-id 1",
  "a=candidate:3 1 tcp 1518280447 192.168.1.23 9 typ host tcptype active generation 0",
  "a=candidate:4 1 udp 1686052607 203.0.113.7 61000 typ srflx raddr 192.168.1.23 rport 50000 generation 0",
  "a=candidate:5 1 udp 2122262783 fe80::1c2d:3e4f:5a6b:7c8d 50001 typ host generation 0",
  "a=candidate:6 1 udp 2122262783 2001:db8::1234 50002 typ host generation 0",
  "a=ice-ufrag:AbCd",
  "a=ice-pwd:abcdefghijklmnopqrstu+/1",
  "a=ice-options:trickle",
  `a=fingerprint:sha-256 ${FP}`,
  "a=setup:actpass",
  "a=mid:0",
  "a=sctp-port:5000",
  "a=max-message-size:262144",
  "",
].join("\r\n");

test("SDPから必要な項目だけを取り出す", () => {
  const sig = fromSdp(CHROME_OFFER, "offer");
  expect(sig.role).toBe("o");
  expect(sig.ufrag).toBe("AbCd");
  expect(sig.pwd).toBe("abcdefghijklmnopqrstu+/1");
  expect(sig.fp.length).toBe(32);
  // TCPとリンクローカルIPv6は除外し、IPv4 host → srflx → mDNS → IPv6 の順に並ぶ
  expect(sig.cands).toEqual([
    { kind: "h", addr: "192.168.1.23", port: 50000 },
    { kind: "s", addr: "203.0.113.7", port: 61000 },
    { kind: "m", addr: "0f0e2a44-6f0c-4f3a-9d3e-2f6a8f1f2b11", port: 54321 },
    { kind: "h", addr: "2001:db8::1234", port: 50002 },
  ]);
});

test("文字列にして戻すと同じ内容になる", () => {
  const sig = fromSdp(CHROME_OFFER, "offer");
  const text = encode(sig);
  expect(text.length).toBeLessThan(300);
  expect(decode(text)).toEqual(sig);
});

test("組み立て直したSDPから同じ内容を取り出せる", () => {
  const sig = fromSdp(CHROME_OFFER, "offer");
  const sdp = toSdp(sig);
  expect(sdp).toContain(`a=fingerprint:sha-256 ${FP}`);
  expect(sdp).toContain("a=setup:actpass");
  expect(fromSdp(sdp, "offer")).toEqual(sig);
});

test("answerはsetupの向きを保持する", () => {
  const answer = CHROME_OFFER.replace("a=setup:actpass", "a=setup:active");
  const sig = fromSdp(answer, "answer");
  expect(sig.role).toBe("a");
  expect(toSdp(decode(encode(sig)), "data")).toContain("a=setup:active\r\na=mid:data");
});

test("不正なコードは拒否する", () => {
  expect(() => decode("hello")).toThrow();
  expect(() => decode("QD1~x~a~b~c~")).toThrow();
  const good = encode(fromSdp(CHROME_OFFER, "offer"));
  expect(() => decode(good.replace("192.168.1.23", "192.168.1.23\r\na=evil"))).toThrow();
  expect(() => decode(good.replace(",50000", ",99999"))).toThrow();
});

test("QRにして読み戻せる", () => {
  const text = encode(fromSdp(CHROME_OFFER, "offer"));
  const qr = qrcode(0, "L");
  qr.addData(text, "Byte");
  qr.make();
  const n = qr.getModuleCount();
  const cell = 4;
  const margin = 4;
  const size = (n + margin * 2) * cell;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!qr.isDark(r, c)) continue;
      for (let y = 0; y < cell; y++) {
        for (let x = 0; x < cell; x++) {
          const i = (((r + margin) * cell + y) * size + (c + margin) * cell + x) * 4;
          data[i] = data[i + 1] = data[i + 2] = 0;
        }
      }
    }
  }
  expect(jsQR(data, size, size)?.data).toBe(text);
});
