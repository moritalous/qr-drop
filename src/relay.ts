// 1回スキャン方式。QRには使い捨ての秘密だけを載せ、接続情報の交換は公開リレー(Nostr)に任せる。
// 接続情報は秘密から作った鍵で暗号化されるので、リレーは中身を読めず、秘密を知らない端末は参加できない。
// 接続後のファイルは端末間を直接流れ、リレーは通らない。

import { joinRoom, type Room } from "trystero";
import type { FileInfo, TransferEvents } from "./transfer";

const APP_ID = "qr-drop.moritalous.github.io";
const HASH_KEY = "j";
const MAX_RECEIVE_BYTES = 8 * 1024 ** 3;

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function derive(label: string, secret: string): Promise<string> {
  const data = new TextEncoder().encode(`qr-drop:${label}:${secret}`);
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", data)));
}

export function newSecret(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(16)));
}

export function joinUrl(secret: string, base: string = location.href): string {
  const url = new URL(base);
  url.search = "";
  url.hash = `${HASH_KEY}=${secret}`;
  return url.toString();
}

/** 参加用URL(またはその # 以降)から秘密を取り出す。形式が違えば null。 */
export function parseJoin(text: string): string | null {
  const i = text.indexOf("#");
  const hash = i >= 0 ? text.slice(i + 1) : text;
  const m = hash.trim().match(new RegExp(`^${HASH_KEY}=([A-Za-z0-9_-]{22})$`));
  return m?.[1] ?? null;
}

export interface RelayHandlers {
  onConnected(sender: { send(file: File): void }, connection: RTCPeerConnection | null): void;
  onLeft(): void;
  onError(message: string): void;
}

export interface RelaySession {
  leave(): void;
}

export async function connectRelay(secret: string, ev: TransferEvents, handlers: RelayHandlers): Promise<RelaySession> {
  // 部屋IDと暗号鍵は別々に導出する。リレーに見える部屋IDから鍵は逆算できない。
  const [roomId, password] = await Promise.all([derive("room", secret), derive("key", secret)]);
  const room: Room = joinRoom(
    {
      appId: APP_ID,
      password,
      maxUsers: 2,
      identity: "none", // 端末に識別子を保存しない
      maxReceiveBytes: MAX_RECEIVE_BYTES,
      rtcConfig: { iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }] },
    },
    roomId,
  );

  const action = room.makeAction<Blob | ArrayBuffer | ArrayBufferView>("file");
  let partner: string | null = null;
  let seq = 0;
  let queue: Promise<void> = Promise.resolve();

  const metaOf = (metadata: unknown): FileInfo | null => {
    const m = metadata as Partial<FileInfo> | undefined;
    if (!m || typeof m.id !== "string" || typeof m.name !== "string") return null;
    return { id: m.id, name: m.name, size: Number(m.size) || 0, mime: String(m.mime ?? "") };
  };

  const sender = {
    send(file: File): void {
      const info: FileInfo = { id: String(++seq), name: file.name, size: file.size, mime: file.type };
      ev.onStart("send", info);
      queue = queue.then(async () => {
        try {
          if (!partner) throw new Error("接続が切れました");
          await action.send(file, {
            target: partner,
            metadata: { ...info },
            onProgress: (p) => ev.onProgress("send", info.id, Math.round(p * info.size)),
          });
          ev.onDone("send", info.id);
        } catch (e) {
          ev.onError("send", info.id, String((e as Error)?.message ?? e));
        }
      });
    },
  };

  const started = new Set<string>();
  action.onReceive(({ peerId, metadata }) => {
    const info = metaOf(metadata);
    if (peerId !== partner || !info) return false;
    started.add(info.id);
    ev.onStart("recv", info);
    return true;
  });
  action.onReceiveProgress((p, { metadata }) => {
    const info = metaOf(metadata);
    if (info && started.has(info.id)) ev.onProgress("recv", info.id, Math.round(p * info.size));
  });
  action.onMessage((data, { peerId, metadata }) => {
    const info = metaOf(metadata);
    if (peerId !== partner || !info) return;
    if (!started.delete(info.id)) ev.onStart("recv", info);
    const part = data instanceof Blob ? data : (data as ArrayBuffer | ArrayBufferView<ArrayBuffer>);
    ev.onDone("recv", info.id, new Blob([part], { type: info.mime || "application/octet-stream" }));
  });

  room.onPeerJoin(({ peerId }) => {
    if (partner) return; // 相手は最初の1台だけ
    partner = peerId;
    handlers.onConnected(sender, room.getPeers()[peerId]?.connection ?? null);
  });
  room.onPeerLeave(({ peerId }) => {
    if (peerId !== partner) return;
    partner = null;
    handlers.onLeft();
  });
  room.onError((err) => {
    if (partner) return;
    if (err.code === "room-full") handlers.onError("すでに別の端末がこのQRで接続しています。QRを表示し直してください。");
    else if (err.code === "relay-failed") handlers.onError("中継サーバーに接続できませんでした。「中継なしでつなぐ」を試してください。");
    else if (err.code === "peer-connect-failed")
      handlers.onError("相手は見つかりましたが、直接つながりませんでした。同じWi-Fiにつなぐと成功しやすくなります。");
    else if (err.code === "decrypt-failed" || err.code === "handshake-failed")
      handlers.onError("相手を確認できませんでした。QRを表示し直してください。");
  });

  return { leave: () => void room.leave().catch(() => {}) };
}
