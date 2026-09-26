// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseRenderedScale, readRenderedScale } from "./renderedScale";

/**
 * The grab-pan divides by (rendered scale − 1). A wrong read here is not a
 * crash but a drag that crawls or lurches, so the parser is pinned on the
 * exact strings Chromium and WebKit hand back.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseRenderedScale", () => {
  it("reads the uniform scale out of a computed matrix, mid-transition values included", () => {
    expect(parseRenderedScale("matrix(3, 0, 0, 3, 0, 0)")).toBe(3);
    expect(parseRenderedScale("matrix(1.4137, 0, 0, 1.4137, 0, 0)")).toBeCloseTo(1.4137);
    expect(parseRenderedScale("matrix(7.5e+0, 0, 0, 7.5e+0, 0, 0)")).toBe(7.5);
  });

  it("is 1 for none, empty, garbage, and a non-positive first term", () => {
    expect(parseRenderedScale("none")).toBe(1);
    expect(parseRenderedScale("")).toBe(1);
    expect(parseRenderedScale(undefined)).toBe(1);
    expect(parseRenderedScale("scale(3)")).toBe(1);
    expect(parseRenderedScale("matrix(0, 0, 0, 0, 0, 0)")).toBe(1);
    expect(parseRenderedScale("matrix(-2, 0, 0, -2, 0, 0)")).toBe(1);
  });
});

describe("readRenderedScale", () => {
  it("reads the element's computed transform, and 1 with no element", () => {
    const el = document.createElement("img");
    document.body.appendChild(el);
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      transform: "matrix(2.5, 0, 0, 2.5, 0, 0)",
    } as CSSStyleDeclaration);
    expect(readRenderedScale(el)).toBe(2.5);
    expect(readRenderedScale(null)).toBe(1);
  });
});
