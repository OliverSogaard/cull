/**
 * overlayCompute.ts — the production compute fn injected into overlayService
 * (pipeline Phase 6). One entry point, three outputs: clip mask / peak mask /
 * histogram, each a PNG data URL computed from the nav-tier PREVIEW blob URL.
 *
 * Route per request: decode a probe <img> from the blob URL, then prefer the
 * overlay worker (scan/bin + PNG encode off the UI thread); ANY failure —
 * unsupported runtime, probe not yet answered (histogram), bitmap creation,
 * worker crash — falls back to the inline main-thread path, so behaviour never
 * regresses below the pre-worker baseline. The `cancelled` poll (fed by the
 * service's generation/toggle hooks) bails between the async steps so a
 * session switch doesn't pay for a scan nobody will see.
 */
import { runMaskScan, type MaskKind } from "./maskScans";
import {
  histogramWorkerAvailable,
  maskWorkerAvailable,
  primeOverlayWorker,
  requestHistogramOffThread,
  requestMaskOffThread,
} from "./maskClient";
import {
  HISTOGRAM_H,
  HISTOGRAM_SAMPLE,
  HISTOGRAM_W,
  computeHistogramBins,
  drawHistogram,
  isBlankSample,
} from "./histogramRender";
import type { OverlayKind } from "./overlayService";

// Bounded working size for the mask scan: the mask is a diagnostic overlay CSS
// stretches to the image rect, so scanning/encoding beyond ~1600px buys no
// visible gain (the preview source is 1620px anyway).
const MASK_MAX = 1600;

// Boot the worker at app startup (module import) so its boot-time capability
// probe has answered before the first histogram request. Guarded: in unit
// tests / SSR there's no window, and maskClient itself no-ops without Worker.
if (typeof window !== "undefined") primeOverlayWorker();

function loadProbe(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const probe = new Image();
    probe.onload = () => resolve(probe);
    probe.onerror = () => reject(new Error("overlay probe failed to load"));
    probe.src = url;
  });
}

/**
 * Per-element decode gating — the codebase's standing correctness rule for
 * WebKit (see the presenter): `onload` does NOT guarantee decoded pixels, and
 * `drawImage` of an undecoded image silently draws nothing. Landing a big
 * scrub jump is peak decode pressure — exactly when the histogram probe used
 * to sample a blank canvas (the false far-left spike, then cached). A decode
 * rejection is a real failure: throw so the service frees the marker and a
 * later ensure() retries, instead of binning garbage.
 */
async function decodeProbe(probe: HTMLImageElement): Promise<void> {
  if (typeof probe.decode !== "function") return; // older engines: best effort
  try {
    await probe.decode();
  } catch {
    throw new Error("overlay probe decode failed");
  }
}

/** Downscale `probe` to `maxEdge` on a fresh canvas; null if no 2d context. */
function rasterizeInline(
  probe: HTMLImageElement,
  maxEdge: number,
): CanvasRenderingContext2D | null {
  const scale = Math.min(1, maxEdge / Math.max(probe.naturalWidth, probe.naturalHeight));
  const w = Math.max(1, Math.round(probe.naturalWidth * scale));
  const h = Math.max(1, Math.round(probe.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const c2d = canvas.getContext("2d", { willReadFrequently: true });
  if (!c2d) return null;
  c2d.drawImage(probe, 0, 0, w, h);
  return c2d;
}

/** Inline main-thread mask path — also the fallback when the worker is
 *  unavailable or errors. Same pixels as the worker op (shared runMaskScan). */
function maskInline(kind: MaskKind, probe: HTMLImageElement): string {
  const c2d = rasterizeInline(probe, MASK_MAX);
  if (!c2d) throw new Error("no 2d context");
  const { width: w, height: h } = c2d.canvas;
  const src = c2d.getImageData(0, 0, w, h).data;
  const mask = c2d.createImageData(w, h);
  runMaskScan(kind, src, mask.data, w, h);
  c2d.putImageData(mask, 0, 0);
  return c2d.canvas.toDataURL("image/png");
}

/** Inline main-thread histogram path (shared bins/draw with the worker op). */
function histogramInline(probe: HTMLImageElement): string {
  const c2d = rasterizeInline(probe, HISTOGRAM_SAMPLE);
  if (!c2d) throw new Error("no 2d context");
  const { width: w, height: h } = c2d.canvas;
  const sample = c2d.getImageData(0, 0, w, h).data;
  // Same guard as the worker op: never bin (or let the service cache) a
  // canvas nothing was drawn into.
  if (isBlankSample(sample)) throw new Error("blank sample (source not decoded)");
  const bins = computeHistogramBins(sample);
  const hc = document.createElement("canvas");
  hc.width = HISTOGRAM_W;
  hc.height = HISTOGRAM_H;
  const hctx = hc.getContext("2d");
  if (!hctx) throw new Error("no 2d context");
  drawHistogram(hctx, bins);
  return hc.toDataURL("image/png");
}

export async function computeOverlay(
  kind: OverlayKind,
  url: string,
  cancelled: () => boolean,
): Promise<string> {
  const probe = await loadProbe(url);
  if (cancelled()) throw new Error("cancelled");
  await decodeProbe(probe);
  // Session changed / toggled off while the probe decoded — skip the scan.
  if (cancelled()) throw new Error("cancelled");
  const workerReady = kind === "histogram" ? histogramWorkerAvailable() : maskWorkerAvailable();
  if (workerReady) {
    try {
      const bitmap = await createImageBitmap(probe);
      return kind === "histogram"
        ? await requestHistogramOffThread(bitmap)
        : await requestMaskOffThread(kind, bitmap, MASK_MAX);
    } catch {
      // Fall through to the inline path — but not for a result nobody wants.
      if (cancelled()) throw new Error("cancelled");
    }
  }
  return kind === "histogram" ? histogramInline(probe) : maskInline(kind, probe);
}
