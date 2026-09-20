import { describe, expect, test } from "vitest";
import {
  CELL_GAP,
  STRIP_BORDER,
  STRIP_BOTTOM_PAD,
  STRIP_LARGE,
  STRIP_SMALL,
  STRIP_TOP_PAD,
  stripMetricsFor,
} from "./metrics";

const sheets = import.meta.glob<string>("../../styles/*.css", {
  query: "?raw",
  eager: true,
  import: "default",
});
const strip = sheets["../../styles/strip.css"] ?? "";
const tokens = sheets["../../styles/tokens.css"] ?? "";

const ruleBody = (css: string, selector: string): string => {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`no rule \`${selector}\``);
  return css.slice(at, css.indexOf("}", at));
};
const px = (css: string, name: string): number => {
  const m = new RegExp(`${name}:\\s*(\\d+)px`).exec(css);
  if (!m) throw new Error(`no ${name} in that rule`);
  return Number(m[1]);
};

describe("strip metrics", () => {
  test("the stylesheets arrive as readable text", () => {
    expect(strip).toContain(".cull-thumbs {");
    expect(tokens).toContain(":root {");
  });

  test("the two steps are the ones the board picked", () => {
    expect([STRIP_SMALL.cellW, STRIP_SMALL.cellH]).toEqual([76, 54]);
    expect([STRIP_LARGE.cellW, STRIP_LARGE.cellH]).toEqual([104, 74]);
    expect(stripMetricsFor(false)).toBe(STRIP_SMALL);
    expect(stripMetricsFor(true)).toBe(STRIP_LARGE);
  });

  test("stride is the cell plus one gap, and the strip height is its real border box", () => {
    for (const m of [STRIP_SMALL, STRIP_LARGE]) {
      expect(m.stride).toBe(m.cellW + CELL_GAP);
      expect(m.stripH).toBe(STRIP_TOP_PAD + m.cellH + STRIP_BOTTOM_PAD + STRIP_BORDER);
    }
    expect(STRIP_SMALL.stripH).toBe(83);
    expect(STRIP_LARGE.stripH).toBe(103);
  });

  test("the CSS declares the SAME padding and border the height is summed from", () => {
    const thumbs = ruleBody(strip, ".cull-thumbs");
    // border-box is load-bearing: without it the rendered box is height +
    // padding + border, which is exactly the 28px of dead space this fixed.
    expect(thumbs).toMatch(/box-sizing:\s*border-box/);
    expect(thumbs).toMatch(/height:\s*var\(--strip-h\)/);
    expect(px(thumbs, "padding")).toBe(STRIP_TOP_PAD);
    expect(thumbs).toContain(`0 ${STRIP_BOTTOM_PAD}px`);
    expect(px(thumbs, "border-top")).toBe(STRIP_BORDER);
  });

  test("the cells read their size from the custom properties, never a literal", () => {
    expect(ruleBody(strip, ".cull-thumb")).toContain("flex: 0 0 var(--cell-w)");
    expect(ruleBody(strip, ".cull-thumb")).toContain("height: var(--cell-h)");
    expect(ruleBody(strip, ".cull-thumb__frame")).toContain("width: var(--cell-w)");
    expect(ruleBody(strip, ".cull-thumb__frame")).toContain("height: var(--cell-h)");
  });

  test("the :root fallbacks are the SMALL step, so a strip that never mounts still measures", () => {
    expect(px(ruleBody(tokens, ":root"), "--cell-w")).toBe(STRIP_SMALL.cellW);
    expect(px(ruleBody(tokens, ":root"), "--cell-h")).toBe(STRIP_SMALL.cellH);
    expect(px(ruleBody(tokens, ":root"), "--strip-h")).toBe(STRIP_SMALL.stripH);
  });
});
