import { describe, expect, test } from "vitest";
import { afZoomOrigin } from "./zoom";
import type { ImageMetadata } from "../types";

const NO_PAN = { x: 0, y: 0 };

/** Minimal metadata carrying only the AF point this function reads. */
const withAf = (afXPct: number | null, afYPct: number | null): ImageMetadata =>
  ({ afXPct, afYPct }) as ImageMetadata;

describe("afZoomOrigin", () => {
  test("defaults to dead centre when there is no metadata", () => {
    expect(afZoomOrigin(undefined, NO_PAN)).toEqual({ x: 50, y: 50 });
  });

  test("defaults to centre when the AF point is absent", () => {
    expect(afZoomOrigin(withAf(null, null), NO_PAN)).toEqual({ x: 50, y: 50 });
  });

  test("anchors at the AF point with no pan", () => {
    expect(afZoomOrigin(withAf(30, 70), NO_PAN)).toEqual({ x: 30, y: 70 });
  });

  test("shifts by the current pan", () => {
    expect(afZoomOrigin(withAf(30, 70), { x: 5, y: -10 })).toEqual({ x: 35, y: 60 });
  });

  test("clamps to the image bounds on both axes", () => {
    expect(afZoomOrigin(withAf(90, 10), { x: 40, y: -40 })).toEqual({ x: 100, y: 0 });
    expect(afZoomOrigin(withAf(5, 95), { x: -20, y: 20 })).toEqual({ x: 0, y: 100 });
  });
});
