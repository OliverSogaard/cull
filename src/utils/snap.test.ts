import { describe, expect, it } from "vitest";
import { snapToFilter } from "./snap";

describe("snapToFilter", () => {
  it("returns the input when it is already in the filter", () => {
    expect(snapToFilter(5, [1, 3, 5, 7, 9], 10)).toBe(5);
  });

  it("snaps to the nearer member", () => {
    // 4 is closer to 5 than to 1.
    expect(snapToFilter(4, [1, 5, 9], 10)).toBe(5);
    // 8 is closer to 9 than to 5.
    expect(snapToFilter(8, [1, 5, 9], 10)).toBe(9);
  });

  it("ties go to the first member we hit (left-biased)", () => {
    // 4 is equidistant from 3 and 5; the iteration encounters 3 first.
    expect(snapToFilter(4, [1, 3, 5, 7, 9], 10)).toBe(3);
    expect(snapToFilter(6, [1, 3, 5, 7], 10)).toBe(5);
  });

  it("returns the input unchanged when the filter is empty", () => {
    expect(snapToFilter(42, [], 100)).toBe(42);
  });

  it("returns the input unchanged when out of bounds", () => {
    expect(snapToFilter(-1, [0, 1, 2], 5)).toBe(-1);
    expect(snapToFilter(99, [0, 1, 2], 5)).toBe(99);
  });

  it("handles sparse filters that span far in image-index space", () => {
    // Filter has favs at indices 50 and 5000; landing at 1500 should snap to 50.
    expect(snapToFilter(1500, [50, 5000], 6000)).toBe(50);
    // Landing at 3000 (closer to 5000) snaps the other way.
    expect(snapToFilter(3000, [50, 5000], 6000)).toBe(5000);
  });
});
