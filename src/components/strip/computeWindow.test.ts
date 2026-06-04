// src/components/strip/computeWindow.test.ts
import { describe, expect, it } from "vitest";
import { clamp, computeCenterScrollLeft, computeWindow } from "./computeWindow";

describe("clamp", () => {
  it("bounds a value within [lo, hi]", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });
});

describe("computeWindow", () => {
  const stride = 80;
  it("returns an empty range for an empty list", () => {
    expect(
      computeWindow({ scrollLeft: 0, clientWidth: 800, stride, count: 0, buffer: 4 }),
    ).toEqual({ first: 0, last: 0 });
  });
  it("covers the visible span plus buffer at scroll 0 (first clamps to 0)", () => {
    const r = computeWindow({ scrollLeft: 0, clientWidth: 800, stride, count: 1000, buffer: 4 });
    expect(r.first).toBe(0);
    expect(r.last).toBe(14);
  });
  it("slides the window with scroll position", () => {
    const r = computeWindow({ scrollLeft: 8000, clientWidth: 800, stride, count: 1000, buffer: 4 });
    expect(r.first).toBe(96);
    expect(r.last).toBe(114);
  });
  it("clamps last to count near the end", () => {
    const r = computeWindow({ scrollLeft: 79000, clientWidth: 800, stride, count: 1000, buffer: 4 });
    expect(r.last).toBe(1000);
  });
  it("handles a single-item list (count=1) without over-running", () => {
    // single-image set, or a one-candidate compare run
    expect(
      computeWindow({ scrollLeft: 0, clientWidth: 800, stride, count: 1, buffer: 4 }),
    ).toEqual({ first: 0, last: 1 });
  });
  it("floors/ceils sub-pixel scroll + width (WebView2 reports fractional values)", () => {
    const r = computeWindow({ scrollLeft: 123.4, clientWidth: 799.6, stride, count: 1000, buffer: 4 });
    expect(r).toEqual({ first: 0, last: 16 });
  });
});

describe("computeCenterScrollLeft", () => {
  const stride = 80;
  const cellWidth = 76;
  const clientWidth = 800;
  const trackWidth = 1000 * stride; // 80000

  it("centers a mid-list cell", () => {
    expect(
      computeCenterScrollLeft({ centerOffset: 500, stride, cellWidth, clientWidth, trackWidth }),
    ).toBe(39638);
  });
  it("clamps to 0 at the start", () => {
    expect(
      computeCenterScrollLeft({ centerOffset: 0, stride, cellWidth, clientWidth, trackWidth }),
    ).toBe(0);
  });
  it("clamps to max scroll at the end", () => {
    const max = trackWidth - clientWidth; // 79200
    expect(
      computeCenterScrollLeft({ centerOffset: 999, stride, cellWidth, clientWidth, trackWidth }),
    ).toBe(max);
  });
  it("never returns a negative scroll for centerOffset -1 (compare gap before reselect)", () => {
    // The hook guards centerOffset >= 0, but the math must be safe regardless:
    // CompareStrip passes candidates.indexOf(challenger) which is -1 in the gap
    // after a challenger leaves the candidate list and before the next is picked.
    expect(
      computeCenterScrollLeft({ centerOffset: -1, stride, cellWidth, clientWidth, trackWidth }),
    ).toBe(0);
  });
});
