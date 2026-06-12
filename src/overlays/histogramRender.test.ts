/**
 * Histogram bin computation tests (pipeline Phase 6) — the pure half shared by
 * the worker op and the inline main-thread fallback.
 */
import { describe, expect, it } from "vitest";
import { computeHistogramBins } from "./histogramRender";

/** Build an RGBA buffer from [r,g,b] pixel triples (alpha pinned to 255). */
function rgba(...pixels: [number, number, number][]): Uint8ClampedArray {
  const data = new Uint8ClampedArray(pixels.length * 4);
  pixels.forEach(([r, g, b], i) => {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  });
  return data;
}

describe("computeHistogramBins", () => {
  it("counts each channel into its own 256-bin array", () => {
    const bins = computeHistogramBins(rgba([0, 128, 255], [0, 128, 255], [10, 20, 30]));
    expect(bins.r[0]).toBe(2);
    expect(bins.r[10]).toBe(1);
    expect(bins.g[128]).toBe(2);
    expect(bins.g[20]).toBe(1);
    expect(bins.b[255]).toBe(2);
    expect(bins.b[30]).toBe(1);
  });

  it("includes the 0/255 bins in max so a clipping spike doesn't rescale away", () => {
    // Three crushed-black pixels + one midtone: max must be 3 (the 0-bin),
    // not 1 (the largest interior bin).
    const bins = computeHistogramBins(rgba([0, 0, 0], [0, 0, 0], [0, 0, 0], [128, 128, 128]));
    expect(bins.max).toBe(3);
  });

  it("max floors at 1 for an empty buffer (no divide-by-zero downstream)", () => {
    const bins = computeHistogramBins(new Uint8ClampedArray(0));
    expect(bins.max).toBe(1);
  });
});
