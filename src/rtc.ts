import { decode, encode, fromSdp, toSdp } from "./signal";

// STUNは外側のアドレスを教えてもらうだけ。ファイルも接続情報も通らない。
const CONFIG: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
};
const GATHER_TIMEOUT_MS = 3000;

// QRに全候補を載せるため、ICE候補の収集が終わるまで待つ(trickleしない)
function gathered(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      pc.removeEventListener("icegatheringstatechange", check);
      clearTimeout(timer);
      resolve();
    };
    const check = () => pc.iceGatheringState === "complete" && done();
    const timer = setTimeout(done, GATHER_TIMEOUT_MS);
    pc.addEventListener("icegatheringstatechange", check);
  });
}

export interface Offer {
  pc: RTCPeerConnection;
  dc: RTCDataChannel;
  code: string;
}

export async function createOffer(): Promise<Offer> {
  const pc = new RTCPeerConnection(CONFIG);
  const dc = pc.createDataChannel("file");
  await pc.setLocalDescription(await pc.createOffer());
  await gathered(pc);
  const code = encode(fromSdp(pc.localDescription!.sdp, "offer"));
  return { pc, dc, code };
}

export interface Answer {
  pc: RTCPeerConnection;
  dc: Promise<RTCDataChannel>;
  code: string;
}

export async function acceptOffer(offerCode: string): Promise<Answer> {
  const sig = decode(offerCode);
  if (sig.role !== "o") throw new Error("これは応答側のコードです。先に始めた側のQRを読んでください");
  const pc = new RTCPeerConnection(CONFIG);
  const dc = new Promise<RTCDataChannel>((resolve) => {
    pc.addEventListener("datachannel", (e) => resolve(e.channel), { once: true });
  });
  await pc.setRemoteDescription({ type: "offer", sdp: toSdp(sig) });
  await pc.setLocalDescription(await pc.createAnswer());
  await gathered(pc);
  const code = encode(fromSdp(pc.localDescription!.sdp, "answer"));
  return { pc, dc, code };
}

export async function acceptAnswer(pc: RTCPeerConnection, answerCode: string): Promise<void> {
  const sig = decode(answerCode);
  if (sig.role === "o") throw new Error("これは開始側のコードです。相手が表示した応答のQRを読んでください");
  const mid = pc.localDescription?.sdp.match(/^a=mid:(.*)$/m)?.[1]?.trim() ?? "0";
  await pc.setRemoteDescription({ type: "answer", sdp: toSdp(sig, mid) });
}
