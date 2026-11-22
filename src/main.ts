import { renderQr, startScanner } from "./qr";
import { connectRelay, joinUrl, newSecret, parseJoin, type RelaySession } from "./relay";
import { acceptAnswer, acceptOffer, createOffer } from "./rtc";
import { Transfer, type FileInfo, type TransferEvents } from "./transfer";
import { verifyCode } from "./verify";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const sections = { home: $("home"), pair: $("pair"), room: $("room") };
const pairMsg = $("pair-msg");
const roomMsg = $("room-msg");
const qrBox = $("qr");
const camBox = $("cam");
const video = $<HTMLVideoElement>("video");
const manual = $<HTMLDetailsElement>("manual");
const manualOut = $("manual-out");
const manualIn = $("manual-in");
const myCode = $<HTMLTextAreaElement>("my-code");
const theirCode = $<HTMLTextAreaElement>("their-code");
const fileInput = $<HTMLInputElement>("file");
const drop = $("drop");
const fileList = $("files");
const verify = $("verify");

const CONNECT_TIMEOUT_MS = 20000;
const RELAY_JOIN_TIMEOUT_MS = 40000;
const SAME_WIFI_HINT = "接続できませんでした。両方の端末が同じWi-Fiにあるか確認して、もう一度試してください。";

/** relay-host: 1回スキャンの表示側 / manual-host: 2回スキャンの開始側 / join: 読み取る側(両方式) */
let mode: "relay-host" | "manual-host" | "join" | null = null;
let pc: RTCPeerConnection | null = null;
let relay: RelaySession | null = null;
let stopScanner: (() => void) | null = null;
let sender: { send(file: File): void } | null = null;
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
    manual.open = true;
    return false;
  }
}

function watch(conn: RTCPeerConnection): void {
  conn.addEventListener("connectionstatechange", () => {
    if (conn !== pc || conn.connectionState !== "failed") return;
    if (sender) lost();
    else failPairing(SAME_WIFI_HINT);
  });
}

function failPairing(text: string): void {
  if (sender) return;
  clearTimeout(connectTimer);
  stopCamera();
  relay?.leave();
  relay = null;
  qrBox.hidden = true;
  manual.hidden = true;
  setMsg(pairMsg, text, "err");
}

function lost(): void {
  setMsg(roomMsg, "接続が切れました。もう一度つなぐには「切断する」を押して最初からやり直してください。", "err");
  drop.hidden = true;
  void wakeLock?.release().catch(() => {});
}

const events: TransferEvents = {
  onStart: (dir, info) => addRow(dir, info),
  onProgress: (dir, id, bytes) => updateRow(dir, id, bytes),
  onDone: (dir, id, blob) => finishRow(dir, id, blob),
  onError: (dir, id, message) => errorRow(dir, id, message),
};

// ---- 1回スキャン(公開リレー経由) ----

async function startRelay(secret: string): Promise<void> {
  try {
    relay = await connectRelay(secret, events, {
      onConnected: (s, conn) => enterRoom(s, conn),
      onLeft: lost,
      onError: failPairing,
    });
  } catch (e) {
    failPairing(`準備に失敗しました: ${(e as Error).message}`);
  }
}

async function hostRelay(): Promise<void> {
  mode = "relay-host";
  busy = true; // この側は相手のコードを受け取らない
  show("pair");
  manualIn.hidden = true;
  const secret = newSecret();
  showMyCode(joinUrl(secret));
  setMsg(pairMsg, "このQRを相手のカメラで読み取ってもらってください。相手を待っています…");
  await startRelay(secret);
}

async function joinRelay(secret: string): Promise<void> {
  mode = "join";
  busy = true;
  stopCamera();
  show("pair");
  manual.hidden = true;
  setMsg(pairMsg, "接続中…（数秒〜十数秒かかります）");
  connectTimer = setTimeout(
    () => failPairing("相手が見つかりませんでした。相手の画面にQRが出たままか確認して、もう一度読み取ってください。"),
    RELAY_JOIN_TIMEOUT_MS,
  );
  await startRelay(secret);
}

// ---- 2回スキャン(中継なし) ----

async function hostManual(): Promise<void> {
  mode = "manual-host";
  show("pair");
  setMsg(pairMsg, "準備中…");
  // 先にカメラを許可してもらうと、ブラウザがLAN内の実アドレスを接続情報に含めるためつながりやすい
  const cam = await startCamera();
  try {
    const offer = await createOffer();
    pc = offer.pc;
    watch(pc);
    offer.dc.addEventListener("open", () => enterRoomManual(offer.dc), { once: true });
    showMyCode(offer.code);
    setMsg(
      pairMsg,
      cam
        ? "① 相手に「QRを読み取る」でこのQRを読んでもらう → ② 相手の画面に出たQRを下のカメラに写す"
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

async function handleCode(text: string, typed: boolean): Promise<void> {
  if (busy || !mode) return;
  const secret = parseJoin(text);
  if (secret && mode === "join") return joinRelay(secret);
  if (secret || !text.startsWith("QD1~")) {
    if (typed) setMsg(pairMsg, "この画面では使えないコードです", "err");
    return;
  }
  busy = true;
  try {
    if (mode === "manual-host") {
      if (!pc) throw new Error("まだ準備中です");
      await acceptAnswer(pc, text);
      stopCamera();
      setMsg(pairMsg, "読み取りました。接続中…");
      connectTimer = setTimeout(() => failPairing(SAME_WIFI_HINT), CONNECT_TIMEOUT_MS);
    } else {
      const answer = await acceptOffer(text);
      pc = answer.pc;
      watch(pc);
      stopCamera();
      showMyCode(answer.code);
      manualIn.hidden = true;
      setMsg(pairMsg, "読み取りました。このQRを相手のカメラに写してください");
      void answer.dc.then((dc) => {
        if (dc.readyState === "open") enterRoomManual(dc);
        else dc.addEventListener("open", () => enterRoomManual(dc), { once: true });
      });
    }
  } catch (e) {
    busy = false;
    // カメラ読み取りでは同じQRが連続して届くので、役割違いなどのエラーは表示だけして読み取りを続ける
    setMsg(pairMsg, (e as Error).message, "err");
  }
}

function enterRoomManual(dc: RTCDataChannel): void {
  dc.addEventListener("close", lost);
  enterRoom(new Transfer(dc, events), pc);
}

// ---- 接続後 ----

function enterRoom(s: { send(file: File): void }, conn: RTCPeerConnection | null): void {
  clearTimeout(connectTimer);
  stopCamera();
  sender = s;
  show("room");
  void verifyCode(conn).then((code) => {
    if (!code) return;
    verify.innerHTML = `確認コード <b>${code}</b> ・ 相手の画面と同じ数字なら、目の前の相手と直接つながっています。`;
    verify.hidden = false;
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
  if (!row || !row.bar.isConnected) return;
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
  if (!sender || !files) return;
  for (const file of files) sender.send(file);
}

$("btn-host").addEventListener("click", () => void hostRelay());
$("btn-host-manual").addEventListener("click", () => void hostManual());
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

// スマホ標準のカメラでQRを読むと、秘密が # 以降に入ったURLで開かれる
const secretInUrl = parseJoin(location.hash);
if (secretInUrl) {
  // 秘密をアドレスバーと履歴に残さない
  history.replaceState(null, "", location.pathname + location.search);
  void joinRelay(secretInUrl);
}
