/**
 * OffscreenCanvas Web Worker for the analysis overlays. Moves the per-pixel
 * work + PNG encode off the UI thread so toggling clipping / peaking / the
 * EXIF histogram (or settling on a new frame with one on) doesn't jank.
 *
 * Two ops, both fed a decoded ImageBitmap (transferred zero-copy):
 *  - "mask": downscale, run the SHARED scan (maskScans), encode a PNG Blob.
 *  - "histogram": downscale to a sample size, bin RGB (histogramRender), draw
 *    the 256×64 additive-channel chart, encode a PNG Blob. (Phase 6)
 *
 * The main thread turns each Blob into the same `data:` URL the inline paths
 * produce, so the overlay cache needs no object-URL revoke lifecycle.
 *
 * At BOOT the worker probes its own OffscreenCanvas 2d + convertToBlob with a
 * 1×1 canvas and posts `{ probe, ok }` unsolicited — WKWebView support is
 * "test before trust" (plan platform notes), and the client gates histogram
 * requests on that answer (masks keep their per-request fallback).
 */
import { runMaskScan, type MaskKind } from "./maskScans";
import {
  HISTOGRAM_H,
  HISTOGRAM_SAMPLE,
  HISTOGRAM_W,
  computeHistogramBins,
  drawHistogram,
  isBlankSample,
} from "./histogramRender";

type OverlayRequest =
  | { id: number; op: "mask"; kind: MaskKind; bitmap: ImageBitmap; max: number }
  | { id: number; op: "histogram"; bitmap: ImageBitmap };

// Minimal structural view of the worker global — avoids pulling in the WebWorker
// lib (which conflicts with the project's DOM lib). OffscreenCanvas / MessageEvent
// / ImageBitmap all live in the DOM lib, so that's all this file needs.
const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<OverlayRequest>) => void) | null;
  postMessage: (message: unknown) => void;
};

/** Draw `bitmap` into a fresh OffscreenCanvas bounded to `maxEdge`, close the
 *  bitmap, and return the 2d context (null if the runtime refuses one). */
function rasterize(
  bitmap: ImageBitmap,
  maxEdge: number,
): OffscreenCanvasRenderingContext2D | null {
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  const c2d = canvas.getContext("2d", { willReadFrequently: true });
  if (!c2d) {
    bitmap.close();
    return null;
  }
  c2d.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  return c2d;
}

function postBlobOf(id: number, canvas: OffscreenCanvas): void {
  canvas
    .convertToBlob({ type: "image/png" })
    .then((blob) => ctx.postMessage({ id, blob }))
    .catch((err) => ctx.postMessage({ id, error: String(err) }));
}

function maskOp(id: number, kind: MaskKind, bitmap: ImageBitmap, max: number): void {
  const c2d = rasterize(bitmap, max);
  if (!c2d) {
    ctx.postMessage({ id, error: "no 2d context" });
    return;
  }
  const { width: w, height: h } = c2d.canvas;
  const src = c2d.getImageData(0, 0, w, h).data;
  const mask = c2d.createImageData(w, h);
  runMaskScan(kind, src, mask.data, w, h);
  c2d.putImageData(mask, 0, 0);
  postBlobOf(id, c2d.canvas);
}

function histogramOp(id: number, bitmap: ImageBitmap): void {
  const c2d = rasterize(bitmap, HISTOGRAM_SAMPLE);
  if (!c2d) {
    ctx.postMessage({ id, error: "no 2d context" });
    return;
  }
  const { width: w, height: h } = c2d.canvas;
  const sample = c2d.getImageData(0, 0, w, h).data;
  if (isBlankSample(sample)) {
    // Nothing rasterized (undecoded bitmap) — error out so the caller falls
    // back / retries instead of caching a false bin-0 spike.
    ctx.postMessage({ id, error: "blank sample (source not decoded)" });
    return;
  }
  const bins = computeHistogramBins(sample);
  const hc = new OffscreenCanvas(HISTOGRAM_W, HISTOGRAM_H);
  const hctx = hc.getContext("2d");
  if (!hctx) {
    ctx.postMessage({ id, error: "no 2d context" });
    return;
  }
  drawHistogram(hctx, bins);
  postBlobOf(id, hc);
}

ctx.onmessage = (e: MessageEvent<OverlayRequest>) => {
  try {
    if (e.data.op === "histogram") histogramOp(e.data.id, e.data.bitmap);
    else maskOp(e.data.id, e.data.kind, e.data.bitmap, e.data.max);
  } catch (err) {
    ctx.postMessage({ id: e.data.id, error: String(err) });
  }
};

// Boot-time capability probe (plan Phase 6): 1×1 convertToBlob, posted
// unsolicited. Failure is an answer, not an error — the client falls back to
// the inline main-thread histogram for the session.
void (async () => {
  try {
    const c = new OffscreenCanvas(1, 1);
    const c2d = c.getContext("2d");
    if (!c2d) throw new Error("no 2d context");
    c2d.fillRect(0, 0, 1, 1);
    await c.convertToBlob({ type: "image/png" });
    ctx.postMessage({ probe: true, ok: true });
  } catch (err) {
    ctx.postMessage({ probe: true, ok: false, error: String(err) });
  }
})();

export {};
