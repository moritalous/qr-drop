// 両端末のDTLS証明書フィンガープリントから4桁の確認コードを作る。
// 両方の画面で同じ数字なら、間に第三者が入っていない。
export async function verifyCode(pc: RTCPeerConnection | null): Promise<string | null> {
  const fp = (sdp?: string) => sdp?.match(/^a=fingerprint:\S+ (\S+)/m)?.[1]?.toUpperCase();
  const a = fp(pc?.localDescription?.sdp);
  const b = fp(pc?.remoteDescription?.sdp);
  if (!a || !b) return null;
  const data = new TextEncoder().encode([a, b].sort().join("|"));
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  const n = ((d[0]! << 24) | (d[1]! << 16) | (d[2]! << 8) | d[3]!) >>> 0;
  return String(n % 10000).padStart(4, "0");
}
