import { describe, expect, test } from "vitest";
import {
  GRID_CELL_PADDING,
  THMB_LONG_EDGE,
  gridFrameDevicePx,
  wantsGridThumb,
} from "./gridThumbRule";

const sheets = import.meta.glob<string>("../styles/grid.css", {
  query: "?raw",
  eager: true,
  import: "default",
});

describe("the grid-thumb request rule", () => {
  test("the painted box is the cell minus its padding on both sides", () => {
    expect(gridFrameDevicePx(179, 1)).toBe(161);
    expect(gridFrameDevicePx(179, 1.5)).toBe(241.5);
  });

  test("asks only when the painted box needs more than the THMB has", () => {
    // Oliver's screen: DPR 1.5. The break-even cell is 160/1.5 + 18 ≈ 124.7.
    expect(wantsGridThumb(124, 1.5)).toBe(false);
    expect(wantsGridThumb(125, 1.5)).toBe(true);
    // Small / Medium / Large at the maximized 2560 window.
    expect(wantsGridThumb(132, 1.5)).toBe(true);
    expect(wantsGridThumb(179, 1.5)).toBe(true);
    expect(wantsGridThumb(279, 1.5)).toBe(true);
    // At DPR 1 the THMB still covers the two smaller steps.
    expect(wantsGridThumb(132, 1)).toBe(false);
    expect(wantsGridThumb(179, 1)).toBe(true);
  });

  test("a closed grid (cellW 0) never asks", () => {
    expect(wantsGridThumb(0, 3)).toBe(false);
    expect(wantsGridThumb(-1, 3)).toBe(false);
  });

  test("the padding constant is the padding the stylesheet actually draws", () => {
    const css = sheets["../styles/grid.css"] ?? "";
    expect(css, "grid.css must arrive as readable text").toContain(".cull-grid__cell {");
    const rule = css.slice(css.indexOf(".cull-grid__cell {"));
    const m = /padding:\s*(\d+)px/.exec(rule.slice(0, rule.indexOf("}")));
    expect(Number(m?.[1])).toBe(GRID_CELL_PADDING);
    expect(THMB_LONG_EDGE).toBe(160);
  });
});
