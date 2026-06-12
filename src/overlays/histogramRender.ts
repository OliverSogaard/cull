/**
 * Pure RGB-histogram helpers shared by the worker op (OffscreenCanvas) and the
 * inline main-thread fallback — extracted from App.tsx's loadHistogram so both
 * paths render the identical 256×64 additive-channel PNG (pipeline Phase 6).
 *
 * Sourced from the nav-tier PREVIEW (bare sensor JPEG, no letterbox) — NOT the
 * embedded THMB, which Canon pads into a fixed 4:3 frame with pure-black bars
 * that dumped a false spike into the darks (0) bin. NOTE: coarse distribution,
 * not pixel-level — clipping (h) covers that.
 */

/** Long-edge bound for the sampling downscale before binning. */
export const HISTOGRAM_SAMPLE = 256;
/** Rendered histogram size (the ExifRail panel's native resolution). */
export const HISTOGRAM_W = 256;
export const HISTOGRAM_H = 64;

export type HistogramBins = {
  r: Uint32Array;
  g: Uint32Array;
  b: Uint32Array;
  /** Largest single bin across all channels, floored at 1. Includes the 0/255
   *  bins on purpose: a clipping spike must set the scale, not rescale away. */
  max: number;
};

export function computeHistogramBins(data: Uint8ClampedArray): HistogramBins {
  const r = new Uint32Array(256);
  const g = new Uint32Array(256);
  const b = new Uint32Array(256);
  for (let i = 0; i < data.length; i += 4) {
    r[data[i]]++;
    g[data[i + 1]]++;
    b[data[i + 2]]++;
  }
  let max = 1;
  for (let v = 0; v < 256; v++) max = Math.max(max, r[v], g[v], b[v]);
  return { r, g, b, max };
}

/** The 2d-context surface the drawing needs — satisfied by both the DOM and
 *  OffscreenCanvas contexts, so worker and fallback share this code. */
type Histogram2d = Pick<
  CanvasRenderingContext2D,
  "globalCompositeOperation" | "fillStyle" | "beginPath" | "moveTo" | "lineTo" | "closePath" | "fill"
>;

/** Draw the three channels additively onto a HISTOGRAM_W × HISTOGRAM_H
 *  context (R+G+B overlap → white). */
export function drawHistogram(hctx: Histogram2d, bins: HistogramBins): void {
  hctx.globalCompositeOperation = "lighter";
  const drawChannel = (channel: Uint32Array, color: string) => {
    hctx.fillStyle = color;
    hctx.beginPath();
    hctx.moveTo(0, HISTOGRAM_H);
    for (let v = 0; v < 256; v++) {
      const y = HISTOGRAM_H - Math.min(1, channel[v] / bins.max) * HISTOGRAM_H;
      hctx.lineTo((v / 255) * HISTOGRAM_W, y);
    }
    hctx.lineTo(HISTOGRAM_W, HISTOGRAM_H);
    hctx.closePath();
    hctx.fill();
  };
  drawChannel(bins.r, "rgba(239,68,68,0.65)");
  drawChannel(bins.g, "rgba(16,185,129,0.65)");
  drawChannel(bins.b, "rgba(59,130,246,0.65)");
}
