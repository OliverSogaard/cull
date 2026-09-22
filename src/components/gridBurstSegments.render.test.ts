import { describe, expect, it } from "vitest";
import { drawableGridBurstSegments, type GridBurstSegment } from "./gridBurstSegments";

/**
 * The RENDER-side guard only — `gridBurstSegments.test.ts` pins the DATA
 * (`computeGridBurstSegments`) unchanged, including the interleaved-bodies
 * case where every stretch is one cell wide (line 55: `s.c0` === `s.c1` for
 * all four). This file is about which of those stretches actually get a
 * bracket drawn.
 */
const seg = (over: Partial<GridBurstSegment>): GridBurstSegment => ({
  key: "burst:0:0:0",
  row: 0,
  c0: 0,
  c1: 0,
  label: null,
  openLeft: false,
  openRight: false,
  kind: "burst",
  ...over,
});

describe("drawableGridBurstSegments", () => {
  it("drops a one-cell stretch", () => {
    expect(drawableGridBurstSegments([seg({ c0: 2, c1: 2 })])).toEqual([]);
  });

  it("keeps a two-cell (or wider) stretch", () => {
    const s = seg({ c0: 2, c1: 3 });
    expect(drawableGridBurstSegments([s])).toEqual([s]);
  });
});
