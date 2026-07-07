import { describe, expect, it } from "vitest";
import { hiResTransform, paneZoomZ, ZOOM_UNSETTLE_MEASURE_DELAY_MS } from "./paneGeometry";

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

describe("paneZoomZ — zoomLevel × true-1:1, one formula for loupe and compare", () => {
  it("1 while not zooming, regardless of geometry", () => {
    expect(paneZoomZ(native, rect, 1, false)).toBe(1);
    expect(paneZoomZ(undefined, null, 2, false)).toBe(1);
  });

  it("zoomLevel × native.w / rect.width when zooming with known geometry", () => {
    expect(paneZoomZ(native, rect, 1, true)).toBeCloseTo(6960 / 800);
    expect(paneZoomZ(native, rect, 2, true)).toBeCloseTo(2 * (6960 / 800));
  });

  it("falls back to a 5× one-to-one while dims or rect are unknown", () => {
    expect(paneZoomZ(undefined, rect, 1, true)).toBe(5);
    expect(paneZoomZ(native, null, 2, true)).toBe(10);
  });
});

describe("shared constants", () => {
  it("unzoom measure delay outlives the 200ms release transition", () => {
    expect(ZOOM_UNSETTLE_MEASURE_DELAY_MS).toBeGreaterThan(200);
  });
});
