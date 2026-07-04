/**
 * Histogram bin computation tests (pipeline Phase 6) — the pure half shared by
 * the worker op and the inline main-thread fallback.
 */
import { describe, expect, it } from "vitest";
import { computeHistogramBins, isBlankSample } from "./histogramRender";

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

describe("isBlankSample", () => {
  it("flags an all-transparent buffer — the undecoded-drawImage signature", () => {
    // drawImage of a loaded-but-undecoded image silently draws NOTHING
    // (WKWebView under big-jump decode pressure): canvas stays transparent.
    expect(isBlankSample(new Uint8ClampedArray(16))).toBe(true);
    expect(isBlankSample(new Uint8ClampedArray(0))).toBe(true);
  });

  it("never flags a real decoded frame — even a pure-black photo", () => {
    // A decoded JPEG always rasterizes opaque (alpha 255): an intentionally
    // black frame is a legitimate photo whose histogram SHOULD spike at 0.
    const black = new Uint8ClampedArray(16);
    for (let i = 3; i < 16; i += 4) black[i] = 255;
    expect(isBlankSample(black)).toBe(false);
    // One decoded pixel among transparent padding still counts as drawn.
    const partial = new Uint8ClampedArray(16);
    partial[7] = 255;
    expect(isBlankSample(partial)).toBe(false);
  });
});
