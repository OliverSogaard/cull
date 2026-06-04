/**
 * OffscreenCanvas Web Worker for the analysis-overlay masks. Moves the per-pixel
 * scan + PNG encode off the UI thread so toggling clipping / peaking (or settling
 * on a new frame with one on) doesn't jank. Receives a decoded ImageBitmap
 * (transferred zero-copy), downscales it, runs the SHARED scan (maskScans),
 * encodes to a PNG Blob, and posts the Blob back. The main thread turns it into
 * the same `data:` URL the inline path produces, so the overlay cache needs no
 * object-URL revoke lifecycle.
 */
import { runMaskScan, type MaskKind } from "./maskScans";

type MaskRequest = { id: number; kind: MaskKind; bitmap: ImageBitmap; max: number };

// Minimal structural view of the worker global — avoids pulling in the WebWorker
// lib (which conflicts with the project's DOM lib). OffscreenCanvas / MessageEvent
// / ImageBitmap all live in the DOM lib, so that's all this file needs.
const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<MaskRequest>) => void) | null;
  postMessage: (message: unknown) => void;
};

ctx.onmessage = (e: MessageEvent<MaskRequest>) => {
  const { id, kind, bitmap, max } = e.data;
  try {
    const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    const c2d = canvas.getContext("2d", { willReadFrequently: true });
    if (!c2d) {
      bitmap.close();
      ctx.postMessage({ id, error: "no 2d context" });
      return;
    }
    c2d.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    const src = c2d.getImageData(0, 0, w, h).data;
    const mask = c2d.createImageData(w, h);
    runMaskScan(kind, src, mask.data, w, h);
    c2d.putImageData(mask, 0, 0);
    canvas
      .convertToBlob({ type: "image/png" })
      .then((blob) => ctx.postMessage({ id, blob }))
      .catch((err) => ctx.postMessage({ id, error: String(err) }));
  } catch (err) {
    ctx.postMessage({ id, error: String(err) });
  }
};

export {};
