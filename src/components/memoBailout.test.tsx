// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

/**
 * The four top-level culling views must BAIL OUT when App re-renders with an
 * unchanged prop set. App re-renders on every cursor move, pan mouse-move,
 * feedback flash and save-pill change; without `memo` each of those walks the
 * whole strip/rail subtree again.
 *
 * `PhotoStrip` is stubbed so a render is observable as a single spy call —
 * the strips' real output (virtualization, burst boxes) is irrelevant here and
 * would need layout jsdom can't give.
 */

// vi.mock is hoisted above the imports; a plain outer const would be in its TDZ.
const { stripRenders } = vi.hoisted(() => ({ stripRenders: vi.fn((): void => {}) }));
vi.mock("./strip/PhotoStrip", () => ({
  PhotoStrip: (): null => {
    stripRenders();
    return null;
  },
}));

import { ThumbStrip } from "./ThumbStrip";
import { CompareStrip } from "./CompareStrip";
import { CompareView } from "./CompareView";
import { ExifRail } from "./ExifRail";

const MEMO = Symbol.for("react.memo");
const typeOf = (c: unknown): symbol | undefined => (c as { $$typeof?: symbol }).$$typeof;

describe("top-level views bail out of renders with unchanged props", () => {
  beforeEach(() => {
    stripRenders.mockClear();
  });
  afterEach(cleanup);

  test("all four are memo components", () => {
    for (const c of [ThumbStrip, CompareStrip, CompareView, ExifRail]) expect(typeOf(c)).toBe(MEMO);
  });

  test("ThumbStrip re-renders for a new cursor, not for an identical prop set", () => {
    const props = {
      images: [],
      currentIndex: 0,
      ratings: {},
      visibleIndices: [],
      metadata: {},
      onPick: () => {},
    };
    const { rerender } = render(<ThumbStrip {...props} />);
    rerender(<ThumbStrip {...props} />);
    expect(stripRenders).toHaveBeenCalledTimes(1);
    rerender(<ThumbStrip {...props} currentIndex={1} />);
    expect(stripRenders).toHaveBeenCalledTimes(2);
  });

  test("CompareStrip re-renders for a new challenger, not for an identical prop set", () => {
    const props = {
      images: [],
      stripIndices: [],
      championIndex: 0,
      challengerIndex: 0,
      metadata: {},
      onPickChallenger: () => {},
    };
    const { rerender } = render(<CompareStrip {...props} />);
    rerender(<CompareStrip {...props} />);
    expect(stripRenders).toHaveBeenCalledTimes(1);
    rerender(<CompareStrip {...props} challengerIndex={1} />);
    expect(stripRenders).toHaveBeenCalledTimes(2);
  });
});
