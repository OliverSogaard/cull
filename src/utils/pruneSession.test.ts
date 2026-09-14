import { describe, expect, it } from "vitest";
import type { Img, NavEntry, UndoAction } from "../types";
import { omitIds, pruneGone, pruneHistory, remapIndex } from "./pruneSession";

const img = (id: number): Img => ({
  id,
  path: `/s/${id}.cr3`,
  filename: `${id}.cr3`,
  srcFolder: "/s",
});
const five = [0, 1, 2, 3, 4].map(img);

describe("remapIndex", () => {
  it("follows the same frame when it survives", () => {
    const after = five.filter((im) => im.id !== 1);
    expect(remapIndex(five, after, 3)).toBe(2);
  });
  it("lands on the next survivor when the frame itself is gone, clamped at the end", () => {
    const after = five.filter((im) => im.id !== 2 && im.id !== 4);
    expect(remapIndex(five, after, 2)).toBe(2); // → id 3
    expect(remapIndex(five, after, 4)).toBe(2); // last survivor
  });
  it("is 0 for an empty result or an out-of-range index", () => {
    expect(remapIndex(five, [], 3)).toBe(0);
    expect(remapIndex(five, five, 99)).toBe(0);
  });
});

describe("pruneGone", () => {
  it("returns null when no listed path is in the session", () => {
    expect(
      pruneGone(
        { images: five, navStack: [], currentIndex: 0, championIndex: 0, challengerIndex: 0 },
        ["/elsewhere/x.cr3"],
      ),
    ).toBeNull();
  });
  it("removes gone frames, remaps every cursor by frame and rewrites compare nav entries", () => {
    const nav: NavEntry[] = [{ site: "grid" }, { site: "compare", champ: 3, chall: 4 }];
    const out = pruneGone(
      { images: five, navStack: nav, currentIndex: 3, championIndex: 3, challengerIndex: 4 },
      ["/s/1.cr3", "/s/4.cr3"],
    );
    expect(out).not.toBeNull();
    expect(out!.images.map((im) => im.id)).toEqual([0, 2, 3]);
    expect(out!.goneIds).toEqual(new Set([1, 4]));
    expect(out!.currentIndex).toBe(2); // id 3
    expect(out!.championIndex).toBe(2);
    expect(out!.challengerIndex).toBe(2); // id 4 gone → clamped to the last survivor
    expect(out!.navStack).toEqual([{ site: "grid" }, { site: "compare", champ: 2, chall: 2 }]);
  });
  it("never mutates its input", () => {
    const nav: NavEntry[] = [{ site: "loupe" }];
    const input = {
      images: five,
      navStack: nav,
      currentIndex: 0,
      championIndex: 0,
      challengerIndex: 0,
    };
    pruneGone(input, ["/s/0.cr3"]);
    expect(input.images).toHaveLength(5);
    expect(nav).toEqual([{ site: "loupe" }]);
  });
});

describe("omitIds", () => {
  it("drops the listed ids and leaves the rest", () => {
    expect(omitIds({ 1: "keep", 2: "reject", 3: "favorite" }, new Set([2]))).toEqual({
      1: "keep",
      3: "favorite",
    });
  });
});

describe("pruneHistory", () => {
  const change = (imgId: number) => ({
    imgId,
    path: `/s/${imgId}.cr3`,
    before: undefined,
    after: "keep" as const,
  });
  it("drops changes for gone frames, drops emptied actions and strips stale cursor snapshots", () => {
    const stack: UndoAction[] = [
      { changes: [change(1)] },
      {
        changes: [change(2), change(3)],
        cursorBefore: { compareMode: true, championIndex: 2, challengerIndex: 3, currentIndex: 2 },
        cursorAfter: { compareMode: true, championIndex: 3, challengerIndex: 4, currentIndex: 3 },
      },
    ];
    const out = pruneHistory(stack, new Set([1, 2]));
    expect(out).toEqual([{ changes: [change(3)] }]);
    expect(stack[1].cursorBefore).toBeDefined(); // input untouched
  });
  it("returns the same array when nothing is affected", () => {
    const stack: UndoAction[] = [{ changes: [change(7)] }];
    expect(pruneHistory(stack, new Set([1]))).toBe(stack);
  });
});
