import jsQR from "jsqr";
import qrcode from "qrcode-generator";

export function renderQr(el: HTMLElement, text: string): void {
  const qr = qrcode(0, "L");
  qr.addData(text, "Byte");
  qr.make();
  el.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 16, scalable: true });
}

declare class BarcodeDetector {
  constructor(options?: { formats: string[] });
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}

const SCAN_INTERVAL_MS = 150;
const SCAN_MAX_SIDE = 960;

/** カメラを起動し、QRを読めるたびに onText を呼ぶ。戻り値の関数で停止する。 */
export async function startScanner(video: HTMLVideoElement, onText: (text: string) => void): Promise<() => void> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("このブラウザではカメラを使えません");
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false,
  });
  video.srcObject = stream;
  await video.play().catch(() => {});

  let detector: BarcodeDetector | null = null;
  try {
    if ("BarcodeDetector" in globalThis) detector = new BarcodeDetector({ formats: ["qr_code"] });
  } catch {
    detector = null;
  }
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      if (video.readyState >= 2 && video.videoWidth > 0) {
        let text: string | undefined;
        if (detector) {
          try {
            text = (await detector.detect(video))[0]?.rawValue;
          } catch {
            detector = null;
          }
        }
        if (!detector && !text) {
          const scale = Math.min(1, SCAN_MAX_SIDE / Math.max(video.videoWidth, video.videoHeight));
          canvas.width = Math.round(video.videoWidth * scale);
          canvas.height = Math.round(video.videoHeight * scale);
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          text = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" })?.data;
        }
        if (text && !stopped) onText(text);
      }
    } finally {
      if (!stopped) setTimeout(tick, SCAN_INTERVAL_MS);
    }
  };
  tick();

  return () => {
    stopped = true;
    for (const track of stream.getTracks()) track.stop();
    video.srcObject = null;
  };
}
