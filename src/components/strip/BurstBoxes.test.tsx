// @vitest-environment jsdom
import { describe, expect, test } from "vitest";
import { render } from "@testing-library/react";
import { burstBoxOverlays } from "./BurstBoxes";
import { STRIP_SMALL } from "./metrics";
import type { BurstSegment } from "./burstSegments";

/**
 * Two bodies bursting at once interleave by capture time, so `computeBurstSegments`
 * (the DATA — unchanged here) can hand back a run of one-cell stretches, each its
 * own contiguous segment. Drawing a bracket around every one of them fenced the
 * strip in tiny boxes. The fix is at the RENDER site only: a one-cell stretch
 * draws no bracket; the frame stays in its group for the burst walk regardless.
 */

const seg = (over: Partial<BurstSegment>): BurstSegment => ({
  start: 0,
  end: 0,
  group: 0,
  len: 3,
  labeled: true,
  kind: "burst",
  ...over,
});

describe("burstBoxOverlays — the one-cell fence", () => {
  test("a one-cell stretch draws no bracket", () => {
    const nodes = burstBoxOverlays([seg({ start: 3, end: 3 })], undefined, STRIP_SMALL);
    const { container } = render(<>{nodes}</>);
    expect(container.querySelectorAll("fieldset")).toHaveLength(0);
  });

  test("a two-cell stretch still draws its bracket", () => {
    const nodes = burstBoxOverlays([seg({ start: 3, end: 4 })], undefined, STRIP_SMALL);
    const { container } = render(<>{nodes}</>);
    expect(container.querySelectorAll("fieldset")).toHaveLength(1);
  });
});
