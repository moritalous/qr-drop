// DataChannel上のファイル転送。
// 制御メッセージは文字列(JSON)、ファイル本体はバイナリで送る。
// 各方向は「start → バイナリ... → end」を1ファイルずつ順番に流す。

const CHUNK = 64 * 1024;
const BUFFER_HIGH = 4 * 1024 * 1024;
const BUFFER_LOW = 1 * 1024 * 1024;

export interface FileInfo {
  id: string;
  name: string;
  size: number;
  mime: string;
}

export interface TransferEvents {
  onStart(dir: "send" | "recv", info: FileInfo): void;
  onProgress(dir: "send" | "recv", id: string, bytes: number): void;
  onDone(dir: "send" | "recv", id: string, blob?: Blob): void;
  onError(dir: "send" | "recv", id: string, message: string): void;
}

type Control = { t: "start"; id: string; name: string; size: number; mime: string } | { t: "end"; id: string };

export class Transfer {
  private queue: Promise<void> = Promise.resolve();
  private seq = 0;
  private incoming: { info: FileInfo; chunks: ArrayBuffer[]; bytes: number } | null = null;

  constructor(
    private dc: RTCDataChannel,
    private ev: TransferEvents,
  ) {
    dc.binaryType = "arraybuffer";
    dc.bufferedAmountLowThreshold = BUFFER_LOW;
    dc.addEventListener("message", (e) => this.receive(e.data));
  }

  send(file: File): void {
    const info: FileInfo = { id: String(++this.seq), name: file.name, size: file.size, mime: file.type };
    this.ev.onStart("send", info);
    this.queue = this.queue.then(() =>
      this.sendOne(file, info).catch((e) => this.ev.onError("send", info.id, String(e?.message ?? e))),
    );
  }

  private async sendOne(file: File, info: FileInfo): Promise<void> {
    this.control({ t: "start", ...info });
    for (let offset = 0; offset < file.size; offset += CHUNK) {
      if (this.dc.readyState !== "open") throw new Error("接続が切れました");
      const buf = await file.slice(offset, offset + CHUNK).arrayBuffer();
      if (this.dc.bufferedAmount > BUFFER_HIGH) await this.drained();
      this.dc.send(buf);
      this.ev.onProgress("send", info.id, Math.min(offset + CHUNK, file.size));
    }
    this.control({ t: "end", id: info.id });
    this.ev.onDone("send", info.id);
  }

  private control(msg: Control): void {
    this.dc.send(JSON.stringify(msg));
  }

  private drained(): Promise<void> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.dc.removeEventListener("bufferedamountlow", ok);
        this.dc.removeEventListener("close", ng);
      };
      const ok = () => (cleanup(), resolve());
      const ng = () => (cleanup(), reject(new Error("接続が切れました")));
      this.dc.addEventListener("bufferedamountlow", ok);
      this.dc.addEventListener("close", ng);
    });
  }

  private receive(data: unknown): void {
    if (typeof data === "string") {
      let msg: Control;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }
      if (msg.t === "start") {
        const info: FileInfo = {
          id: String(msg.id),
          name: String(msg.name),
          size: Number(msg.size) || 0,
          mime: String(msg.mime ?? ""),
        };
        this.incoming = { info, chunks: [], bytes: 0 };
        this.ev.onStart("recv", info);
      } else if (msg.t === "end" && this.incoming) {
        const { info, chunks, bytes } = this.incoming;
        this.incoming = null;
        if (bytes !== info.size) {
          this.ev.onError("recv", info.id, "サイズが一致しません");
          return;
        }
        this.ev.onDone("recv", info.id, new Blob(chunks, { type: info.mime || "application/octet-stream" }));
      }
      return;
    }
    if (data instanceof ArrayBuffer && this.incoming) {
      this.incoming.chunks.push(data);
      this.incoming.bytes += data.byteLength;
      this.ev.onProgress("recv", this.incoming.info.id, this.incoming.bytes);
    }
  }
}
