import { describe, expect, test } from "vitest";
import { runMaskScan } from "./maskScans";

/** RGBA buffer of `w*h` transparent-black pixels. */
function rgba(w: number, h: number): Uint8ClampedArray {
  return new Uint8ClampedArray(w * h * 4);
}

/** Paint one pixel (x,y) of an RGBA buffer. */
function paint(
  buf: Uint8ClampedArray,
  w: number,
  x: number,
  y: number,
  rgb: [number, number, number],
): void {
  const i = (y * w + x) * 4;
  buf[i] = rgb[0];
  buf[i + 1] = rgb[1];
  buf[i + 2] = rgb[2];
  buf[i + 3] = 255;
}

/** The four mask channels at pixel (x,y). */
function px(
  m: Uint8ClampedArray,
  w: number,
  x: number,
  y: number,
): [number, number, number, number] {
  const i = (y * w + x) * 4;
  return [m[i], m[i + 1], m[i + 2], m[i + 3]];
}

describe("clip scan", () => {
  test("blown white (all three ≥250) stripes red on a stripe pixel", () => {
    // 1×1: pixel (0,0) → (x+y)%8 = 0 < 3, so it lands on a red stripe.
    const src = rgba(1, 1);
    paint(src, 1, 0, 0, [255, 255, 255]);
    const m = rgba(1, 1);
    runMaskScan("clip", src, m, 1, 1);
    expect(px(m, 1, 0, 0)).toEqual([239, 68, 68, 215]);
  });

  test("crushed black (all three ≤5) stripes blue on a crush-stripe pixel", () => {
    // 1×1: (x - y + h)%8 = (0 - 0 + 1)%8 = 1 < 3 → blue stripe.
    const src = rgba(1, 1);
    paint(src, 1, 0, 0, [0, 0, 0]);
    const m = rgba(1, 1);
    runMaskScan("clip", src, m, 1, 1);
    expect(px(m, 1, 0, 0)).toEqual([59, 130, 246, 215]);
  });

  test("saturated yellow (R255 G210 B0) does NOT trip clipping", () => {
    // The false-positive the all-three-channel rule exists to avoid: one
    // channel blown, one crushed, but not all three either way → no mask.
    const src = rgba(1, 1);
    paint(src, 1, 0, 0, [255, 210, 0]);
    const m = rgba(1, 1);
    runMaskScan("clip", src, m, 1, 1);
    expect(px(m, 1, 0, 0)).toEqual([0, 0, 0, 0]);
  });

  test("blown pixel off the stripe phase is left unmarked", () => {
    // width 8, pixel (3,0): (x+y)%8 = 3, NOT < 3 → between stripes.
    const w = 8;
    const src = rgba(w, 1);
    paint(src, w, 3, 0, [255, 255, 255]);
    const m = rgba(w, 1);
    runMaskScan("clip", src, m, w, 1);
    expect(px(m, w, 3, 0)).toEqual([0, 0, 0, 0]);
  });
});

describe("peak scan", () => {
  test("a strong luminance edge on an interior pixel stipples warm yellow", () => {
    // 3×3, center (1,1) is the only interior pixel. Left neighbour black,
    // right neighbour white → |lumR - lumL| = 255 > 60.
    const w = 3;
    const h = 3;
    const src = rgba(w, h);
    paint(src, w, 0, 1, [0, 0, 0]);
    paint(src, w, 2, 1, [255, 255, 255]);
    const m = rgba(w, h);
    runMaskScan("peak", src, m, w, h);
    expect(px(m, w, 1, 1)).toEqual([252, 211, 77, 215]);
  });

  test("a flat interior (gradient below threshold) stays transparent", () => {
    const w = 3;
    const h = 3;
    const src = rgba(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) paint(src, w, x, y, [120, 120, 120]);
    const m = rgba(w, h);
    runMaskScan("peak", src, m, w, h);
    expect(px(m, w, 1, 1)).toEqual([0, 0, 0, 0]);
  });

  test("border pixels are never marked (they would false-trigger on letterbox)", () => {
    const w = 3;
    const h = 3;
    const src = rgba(w, h);
    // Max contrast at the top-left corner — but it's on the border.
    paint(src, w, 0, 0, [255, 255, 255]);
    const m = rgba(w, h);
    runMaskScan("peak", src, m, w, h);
    expect(px(m, w, 0, 0)).toEqual([0, 0, 0, 0]);
  });
});

describe("runMaskScan dispatch", () => {
  test("kind selects the scanner: clip → red, peak → yellow, on the same input", () => {
    const w = 3;
    const h = 3;
    const build = () => {
      const s = rgba(w, h);
      // Center blown white; left neighbour black so peak also has an edge.
      paint(s, w, 1, 1, [255, 255, 255]);
      paint(s, w, 0, 1, [0, 0, 0]);
      paint(s, w, 2, 1, [255, 255, 255]);
      return s;
    };
    const clipM = rgba(w, h);
    runMaskScan("clip", build(), clipM, w, h);
    // (1,1): (x+y)%8 = 2 < 3 → clip red stripe.
    expect(px(clipM, w, 1, 1)).toEqual([239, 68, 68, 215]);

    const peakM = rgba(w, h);
    runMaskScan("peak", build(), peakM, w, h);
    expect(px(peakM, w, 1, 1)).toEqual([252, 211, 77, 215]);
  });
});
