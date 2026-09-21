import { describe, expect, it } from "vitest";
import { gridPageStep, stripPageStep } from "./pageStep";

describe("gridPageStep", () => {
  it("is whole rows times the column count", () => {
    // 900px of scrollport, 168px rows -> 5 whole rows; 6 columns -> 30 frames.
    expect(gridPageStep(900, 168, 6)).toBe(30);
    expect(gridPageStep(1000, 250, 4)).toBe(16);
  });

  it("always advances at least one row, even when a row is taller than the scrollport", () => {
    expect(gridPageStep(100, 256, 5)).toBe(5);
    expect(gridPageStep(0, 168, 6)).toBe(6);
  });

  it("degrades to a single step rather than 0 or NaN on an unmeasured grid", () => {
    // rowH 0 is the pre-ResizeObserver state; a 0 or NaN step would make
    // PageDown either a no-op or a clamp to the end of the shoot.
    expect(gridPageStep(900, 0, 6)).toBe(1);
    expect(gridPageStep(900, Number.NaN, 6)).toBe(1);
    expect(gridPageStep(900, 168, 0)).toBe(1);
  });

  it("degrades to a single step on a non-finite viewport instead of NaN or Infinity", () => {
    // A bad measurement can hand back NaN (0/0-shaped math upstream) or
    // Infinity — both must degrade exactly like the other unusable inputs
    // above, never survive into the step.
    expect(gridPageStep(Number.NaN, 168, 6)).toBe(1);
    expect(gridPageStep(Number.POSITIVE_INFINITY, 168, 6)).toBe(1);
    expect(gridPageStep(Number.NEGATIVE_INFINITY, 168, 6)).toBe(1);
  });

  it("a negative but finite viewport still advances a whole row (Math.max floor already handles it)", () => {
    expect(gridPageStep(-100, 168, 6)).toBe(6);
  });
});

describe("stripPageStep", () => {
  it("is the whole cells that fit across the strip", () => {
    // The small step's stride is 80 (76px cell + 4px gap): 18 cells at 1440.
    expect(stripPageStep(1440, 80)).toBe(18);
    // The tall-window step's stride is 108: 13 cells at 1440.
    expect(stripPageStep(1440, 108)).toBe(13);
  });

  it("always advances at least one frame", () => {
    expect(stripPageStep(40, 80)).toBe(1);
    expect(stripPageStep(0, 80)).toBe(1);
    expect(stripPageStep(1440, 0)).toBe(1);
  });

  it("degrades to a single step on a non-finite strip width instead of NaN or Infinity", () => {
    expect(stripPageStep(Number.NaN, 80)).toBe(1);
    expect(stripPageStep(Number.POSITIVE_INFINITY, 80)).toBe(1);
    expect(stripPageStep(Number.NEGATIVE_INFINITY, 80)).toBe(1);
  });

  it("a negative but finite strip width still advances at least one cell", () => {
    expect(stripPageStep(-100, 80)).toBe(1);
  });
});
