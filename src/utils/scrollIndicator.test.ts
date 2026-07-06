import { describe, expect, it } from "vitest";
import { computeScrollIndicator } from "./scrollIndicator";

describe("computeScrollIndicator", () => {
  it("returns a full-track thumb when content fits within the viewport", () => {
    expect(computeScrollIndicator(0, 600, 600)).toEqual({ topFrac: 0, heightFrac: 1 });
    expect(computeScrollIndicator(0, 600, 400)).toEqual({ topFrac: 0, heightFrac: 1 });
  });

  it("returns a full-track thumb when the viewport height is unknown (<=0)", () => {
    expect(computeScrollIndicator(0, 0, 2400)).toEqual({ topFrac: 0, heightFrac: 1 });
  });

  it("sizes the thumb proportionally to viewport/total at the top", () => {
    // 600 / 2400 = 0.25 of the track, at the very top.
    expect(computeScrollIndicator(0, 600, 2400)).toEqual({ topFrac: 0, heightFrac: 0.25 });
  });

  it("moves the thumb to the bottom when scrolled to the max", () => {
    const maxScroll = 2400 - 600; // 1800
    const { topFrac, heightFrac } = computeScrollIndicator(maxScroll, 600, 2400);
    expect(heightFrac).toBe(0.25);
    expect(topFrac).toBeCloseTo(1 - 0.25, 5);
  });

  it("interpolates the thumb position for a mid-scroll offset", () => {
    const maxScroll = 2400 - 600; // 1800
    const { topFrac, heightFrac } = computeScrollIndicator(maxScroll / 2, 600, 2400);
    expect(heightFrac).toBe(0.25);
    expect(topFrac).toBeCloseTo(0.5 * (1 - 0.25), 5);
  });

  it("clamps an overscrolled (negative) scrollTop to the top", () => {
    expect(computeScrollIndicator(-50, 600, 2400)).toEqual({ topFrac: 0, heightFrac: 0.25 });
  });

  it("clamps an overscrolled (beyond max) scrollTop to the bottom", () => {
    const { topFrac, heightFrac } = computeScrollIndicator(999_999, 600, 2400);
    expect(heightFrac).toBe(0.25);
    expect(topFrac).toBeCloseTo(0.75, 5);
  });

  it("enforces a minimum thumb size for huge content relative to viewport", () => {
    const { heightFrac } = computeScrollIndicator(0, 10, 1_000_000);
    expect(heightFrac).toBe(0.03);
  });
});
