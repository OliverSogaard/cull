import { describe, expect, it } from "vitest";
import { hiResTransform, ZOOM_UNSETTLE_MEASURE_DELAY_MS } from "./paneGeometry";

const rect = { left: 0, top: 0, width: 800, height: 533 };
const native = { w: 6960, h: 4640 };

describe("hiResTransform — the native-size raster reproduces scale(Z) about the origin", () => {
  it("matches the loupe/compare formula", () => {
    const t = hiResTransform(rect, native, 50, 50, 6);
    expect(t.scale).toBeCloseTo((800 / 6960) * 6);
    expect(t.tx).toBeCloseTo(0.5 * 800 * (1 - 6));
    expect(t.ty).toBeCloseTo(0.5 * 533 * (1 - 6));
  });

  it("identity at zoom 1 centered origin still offsets zero", () => {
    const t = hiResTransform(rect, native, 50, 50, 1);
    expect(t.tx).toBe(0);
    expect(t.ty).toBe(0);
  });

  it("null rect or native yields the inert transform", () => {
    expect(hiResTransform(null, native, 50, 50, 6)).toEqual({ tx: 0, ty: 0, scale: 1 });
    expect(hiResTransform(rect, undefined, 50, 50, 6)).toEqual({ tx: 0, ty: 0, scale: 1 });
  });
});

describe("shared constants", () => {
  it("unzoom measure delay outlives the 200ms release transition", () => {
    expect(ZOOM_UNSETTLE_MEASURE_DELAY_MS).toBeGreaterThan(200);
  });
});
