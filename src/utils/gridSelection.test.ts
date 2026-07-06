import { describe, expect, it } from "vitest";
import { extendSelection } from "./gridSelection";

// visibleIndices are ABSOLUTE image indices in filter order — deliberately
// non-contiguous here (a filtered view) so position math can't cheat with
// arithmetic on the values themselves.
const VISIBLE = [2, 5, 7, 11, 13];

describe("extendSelection — anchor→target range over the filtered order", () => {
  it("selects the inclusive range, either direction", () => {
    expect(extendSelection(VISIBLE, 5, 11)).toEqual(new Set([5, 7, 11]));
    expect(extendSelection(VISIBLE, 11, 5)).toEqual(new Set([5, 7, 11]));
  });

  it("anchor === target selects just that cell", () => {
    expect(extendSelection(VISIBLE, 7, 7)).toEqual(new Set([7]));
  });

  it("returns null when either end fell out of the filter", () => {
    expect(extendSelection(VISIBLE, 3, 11)).toBeNull();
    expect(extendSelection(VISIBLE, 5, 4)).toBeNull();
  });
});
