import { renderQr, startScanner } from "./qr";
import { acceptAnswer, acceptOffer, createOffer } from "./rtc";
import { Transfer, type FileInfo } from "./transfer";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const sections = { home: $("home"), pair: $("pair"), room: $("room") };
const pairMsg = $("pair-msg");
const roomMsg = $("room-msg");
const qrBox = $("qr");
const camBox = $("cam");
const video = $<HTMLVideoElement>("video");
const manualOut = $("manual-out");
const myCode = $<HTMLTextAreaElement>("my-code");
const theirCode = $<HTMLTextAreaElement>("their-code");
const fileInput = $<HTMLInputElement>("file");
const drop = $("drop");
const fileList = $("files");

const CONNECT_TIMEOUT_MS = 20000;

let mode: "host" | "join" | null = null;
let pc: RTCPeerConnection | null = null;
let stopScanner: (() => void) | null = null;
let transfer: Transfer | null = null;
let busy = false; // コードを処理中、または処理済み
let connectTimer: ReturnType<typeof setTimeout> | undefined;
let wakeLock: { release(): Promise<void> } | null = null;

function show(name: keyof typeof sections): void {
  for (const [key, el] of Object.entries(sections)) el.hidden = key !== name;
}

function setMsg(el: HTMLElement, text: string, kind: "" | "ok" | "err" = ""): void {
  el.textContent = text;
  el.className = `msg ${kind}`.trim();
}

function showMyCode(code: string): void {
  renderQr(qrBox, code);
  qrBox.hidden = false;
  myCode.value = code;
  manualOut.hidden = false;
}

function stopCamera(): void {
  stopScanner?.();
  stopScanner = null;
  camBox.hidden = true;
}

async function startCamera(): Promise<boolean> {
  camBox.hidden = false;
  try {
    stopScanner = await startScanner(video, (text) => void handleCode(text, false));
    return true;
  } catch {
    camBox.hidden = true;
    $<HTMLDetailsElement>("manual").open = true;
    return false;
  }
}

function watch(conn: RTCPeerConnection): void {
  conn.addEventListener("connectionstatechange", () => {
    if (conn !== pc) return;
    if (conn.connectionState === "failed") {
      if (transfer) lost();
      else failPairing("接続できませんでした。両方の端末が同じWi-Fiにあるか確認して、もう一度試してください。");
    }
  });
}

function failPairing(text: string): void {
  clearTimeout(connectTimer);
  stopCamera();
  setMsg(pairMsg, text, "err");
}

function lost(): void {
  setMsg(roomMsg, "接続が切れました。もう一度つなぐには「切断する」を押して最初からやり直してください。", "err");
  drop.hidden = true;
  void wakeLock?.release().catch(() => {});
}

async function host(): Promise<void> {
  mode = "host";
  show("pair");
  setMsg(pairMsg, "準備中…");
  // 先にカメラを許可してもらうと、ブラウザがLAN内の実アドレスを接続情報に含めるためつながりやすい
  const cam = await startCamera();
  try {
    const offer = await createOffer();
    pc = offer.pc;
    watch(pc);
    offer.dc.addEventListener("open", () => enterRoom(offer.dc), { once: true });
    showMyCode(offer.code);
    setMsg(
      pairMsg,
      cam
        ? "① このQRを相手に読み取ってもらう → ② 相手の画面に出たQRを下のカメラに写す"
        : "カメラを使えません。下の欄でコードをやり取りしてください。",
    );
  } catch (e) {
    failPairing(`準備に失敗しました: ${(e as Error).message}`);
  }
}

async function join(): Promise<void> {
  mode = "join";
  show("pair");
  setMsg(pairMsg, "準備中…");
  const cam = await startCamera();
  setMsg(pairMsg, cam ? "相手の画面のQRをカメラに写してください" : "カメラを使えません。下の欄に相手のコードを貼り付けてください。");
}

async function handleCode(text: string, manual: boolean): Promise<void> {
  if (busy || !mode || !text.startsWith("QD1~")) {
    if (manual && !busy) setMsg(pairMsg, "QR Dropのコードではありません", "err");
    return;
  }
  busy = true;
  try {
    if (mode === "host") {
      if (!pc) throw new Error("まだ準備中です");
      await acceptAnswer(pc, text);
      stopCamera();
      setMsg(pairMsg, "読み取りました。接続中…");
      connectTimer = setTimeout(
        () => failPairing("接続できませんでした。両方の端末が同じWi-Fiにあるか確認して、もう一度試してください。"),
        CONNECT_TIMEOUT_MS,
      );
    } else {
      const answer = await acceptOffer(text);
      pc = answer.pc;
      watch(pc);
      stopCamera();
      showMyCode(answer.code);
      setMsg(pairMsg, "読み取りました。このQRを相手のカメラに写してください");
      void answer.dc.then((dc) => {
        if (dc.readyState === "open") enterRoom(dc);
        else dc.addEventListener("open", () => enterRoom(dc), { once: true });
      });
    }
  } catch (e) {
    busy = false;
    // カメラ読み取りでは同じQRが連続して届くので、役割違いなどのエラーは表示だけして読み取りを続ける
    setMsg(pairMsg, (e as Error).message, "err");
  }
}

function enterRoom(dc: RTCDataChannel): void {
  clearTimeout(connectTimer);
  stopCamera();
  show("room");
  dc.addEventListener("close", lost);
  transfer = new Transfer(dc, {
    onStart: (dir, info) => addRow(dir, info),
    onProgress: (dir, id, bytes) => updateRow(dir, id, bytes),
    onDone: (dir, id, blob) => finishRow(dir, id, blob),
    onError: (dir, id, message) => errorRow(dir, id, message),
  });
  // 転送中に画面が消えて止まるのを防ぐ(対応ブラウザのみ)
  const wl = (navigator as Navigator & { wakeLock?: { request(type: "screen"): Promise<{ release(): Promise<void> }> } })
    .wakeLock;
  wl?.request("screen").then(
    (lock) => (wakeLock = lock),
    () => {},
  );
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n;
  let i = -1;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

interface Row {
  info: FileInfo;
  li: HTMLLIElement;
  state: HTMLElement;
  bar: HTMLProgressElement;
}
const rows = new Map<string, Row>();

function addRow(dir: "send" | "recv", info: FileInfo): void {
  const li = document.createElement("li");
  const name = document.createElement("div");
  name.className = "name";
  name.textContent = info.name;
  const meta = document.createElement("div");
  meta.className = "meta";
  const size = document.createElement("span");
  size.textContent = `${dir === "send" ? "送信" : "受信"} ・ ${formatSize(info.size)}`;
  const state = document.createElement("span");
  state.textContent = dir === "send" ? "待機中" : "0%";
  meta.append(size, state);
  const bar = document.createElement("progress");
  bar.max = Math.max(info.size, 1);
  bar.value = 0;
  li.append(name, meta, bar);
  fileList.prepend(li);
  rows.set(`${dir}:${info.id}`, { info, li, state, bar });
}

function updateRow(dir: "send" | "recv", id: string, bytes: number): void {
  const row = rows.get(`${dir}:${id}`);
  if (!row) return;
  row.bar.value = bytes;
  row.state.textContent = `${Math.floor((bytes / Math.max(row.info.size, 1)) * 100)}%`;
}

function finishRow(dir: "send" | "recv", id: string, blob?: Blob): void {
  const row = rows.get(`${dir}:${id}`);
  if (!row) return;
  row.bar.remove();
  row.state.textContent = dir === "send" ? "送信完了" : "受信完了";
  if (blob) {
    const a = document.createElement("a");
    a.className = "save";
    a.href = URL.createObjectURL(blob);
    a.download = row.info.name;
    a.textContent = "保存する";
    row.li.append(a);
  }
}

function errorRow(dir: "send" | "recv", id: string, message: string): void {
  const row = rows.get(`${dir}:${id}`);
  if (!row) return;
  row.bar.remove();
  row.state.textContent = `失敗: ${message}`;
  row.state.className = "err";
}

function sendFiles(files: FileList | null | undefined): void {
  if (!transfer || !files) return;
  for (const file of files) transfer.send(file);
}

$("btn-host").addEventListener("click", () => void host());
$("btn-join").addEventListener("click", () => void join());
$("btn-cancel").addEventListener("click", () => location.reload());
$("btn-leave").addEventListener("click", () => location.reload());
$("btn-apply").addEventListener("click", () => void handleCode(theirCode.value.trim(), true));
$("btn-copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(myCode.value);
    $("btn-copy").textContent = "コピーしました";
  } catch {
    myCode.select();
  }
});
fileInput.addEventListener("change", () => {
  sendFiles(fileInput.files);
  fileInput.value = "";
});
for (const type of ["dragenter", "dragover"]) {
  drop.addEventListener(type, (e) => {
    e.preventDefault();
    drop.classList.add("over");
  });
}
for (const type of ["dragleave", "drop"]) {
  drop.addEventListener(type, (e) => {
    e.preventDefault();
    drop.classList.remove("over");
  });
}
drop.addEventListener("drop", (e) => sendFiles((e as DragEvent).dataTransfer?.files));
