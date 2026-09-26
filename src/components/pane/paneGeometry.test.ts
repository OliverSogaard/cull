// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  hiResFitScale,
  paneZoomZ,
  prefersReducedMotion,
  unzoomRetreatMs,
  ZOOM_UNSETTLE_MEASURE_DELAY_MS,
} from "./paneGeometry";

const rect = { left: 0, top: 0, width: 800, height: 533 };
const native = { w: 6960, h: 4640 };

describe("hiResFitScale — the native-size raster fits the displayed box", () => {
  it("is displayed width over native width, so fit × zoomZ is the base's scale(Z)", () => {
    expect(hiResFitScale(rect, native)).toBeCloseTo(800 / 6960);
    expect(hiResFitScale(rect, native) * paneZoomZ(native, rect, 1, true)).toBeCloseTo(1);
  });

  it("null rect or native yields the inert scale", () => {
    expect(hiResFitScale(null, native)).toBe(1);
    expect(hiResFitScale(rect, undefined)).toBe(1);
    expect(hiResFitScale(rect, { w: 0, h: 0 })).toBe(1);
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

describe("unzoomRetreatMs — reduced motion skips the removed glide", () => {
  it("is 0 when the OS asks for reduced motion", () => {
    expect(unzoomRetreatMs(true)).toBe(0);
  });

  it("is 240 otherwise", () => {
    expect(unzoomRetreatMs(false)).toBe(240);
  });
});

describe("prefersReducedMotion — reads the OS setting fresh, not at module load", () => {
  it("is false when window.matchMedia is not a function", () => {
    const original = window.matchMedia;
    // Simulate a host without matchMedia (some embeds, older test runners).
    // @ts-expect-error assigning undefined models the missing API.
    window.matchMedia = undefined;
    expect(prefersReducedMotion()).toBe(false);
    window.matchMedia = original;
  });

  it("reflects the media query's matches", () => {
    const original = window.matchMedia;
    const matchMedia = vi.fn((_query: string) => ({ matches: true }) as MediaQueryList);
    window.matchMedia = matchMedia;
    expect(prefersReducedMotion()).toBe(true);
    expect(matchMedia).toHaveBeenCalledWith("(prefers-reduced-motion: reduce)");
    window.matchMedia = original;
  });
});
