// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { PhotoStrip } from "./PhotoStrip";
import { STRIP_LARGE, STRIP_SMALL } from "./metrics";

/**
 * PhotoStrip's whole reason for taking a `style` prop is to push StripMetrics'
 * numbers onto `.cull-strip-wrap` as custom properties (see the component's
 * own comment) — FilmStrip, the cells and the stylesheet all read them from
 * there. Nothing asserted that the `style` prop even existed before this
 * test: deleting it left every other test green. `renderCell` is never
 * invoked (`indices` is empty), so this only exercises the metrics wiring,
 * not virtualization — see memoBailout.test.tsx for how PhotoStrip itself is
 * stubbed where its output doesn't matter.
 *
 * useStripMetrics caches ONE MediaQueryList for the module's lifetime (see
 * its own file), so `window.matchMedia` here always hands back the SAME
 * mutable object across both tests — matching how a real MediaQueryList's
 * `.matches` flips live rather than the object being recreated — and each
 * test flips that object's `.matches` rather than swapping the stub function.
 */

/** A mutable stand-in for the one cached `MediaQueryList` — plain fields, so
 *  `mql.matches = …` between tests is a normal assignment; only the value
 *  handed to `window.matchMedia`'s return type needs the real interface. */
type MutableMql = {
  matches: boolean;
  media: string;
  onchange: null;
  addListener: () => void;
  removeListener: () => void;
  addEventListener: () => void;
  removeEventListener: () => void;
  dispatchEvent: () => boolean;
};

const mql: MutableMql = {
  matches: false,
  media: "",
  onchange: null,
  addListener: vi.fn((): void => {}),
  removeListener: vi.fn((): void => {}),
  addEventListener: vi.fn((): void => {}),
  removeEventListener: vi.fn((): void => {}),
  dispatchEvent: vi.fn((): boolean => true),
};

const originalMatchMedia = window.matchMedia;

afterEach(() => {
  cleanup();
  window.matchMedia = originalMatchMedia;
});

const stubMatchMedia = (): void => {
  window.matchMedia = vi.fn((query: string): MediaQueryList => {
    mql.media = query;
    return mql;
  });
};

const renderStrip = () =>
  render(<PhotoStrip images={[]} indices={[]} centerPos={0} renderCell={() => null} />);

const wrapOf = (container: HTMLElement): HTMLElement => {
  const wrap = container.querySelector<HTMLElement>(".cull-strip-wrap");
  if (!wrap) throw new Error("no .cull-strip-wrap");
  return wrap;
};

describe("PhotoStrip wires StripMetrics onto .cull-strip-wrap's inline style", () => {
  test("the small step's numbers land when the tall query doesn't match", () => {
    mql.matches = false;
    stubMatchMedia();
    const wrap = wrapOf(renderStrip().container);
    expect(wrap.style.getPropertyValue("--cell-w")).toBe(`${STRIP_SMALL.cellW}px`);
    expect(wrap.style.getPropertyValue("--cell-h")).toBe(`${STRIP_SMALL.cellH}px`);
    expect(wrap.style.getPropertyValue("--strip-h")).toBe(`${STRIP_SMALL.stripH}px`);
  });

  test("the large step's numbers land when the tall query matches", () => {
    mql.matches = true;
    stubMatchMedia();
    const wrap = wrapOf(renderStrip().container);
    expect(wrap.style.getPropertyValue("--cell-w")).toBe(`${STRIP_LARGE.cellW}px`);
    expect(wrap.style.getPropertyValue("--cell-h")).toBe(`${STRIP_LARGE.cellH}px`);
    expect(wrap.style.getPropertyValue("--strip-h")).toBe(`${STRIP_LARGE.stripH}px`);
  });
});
