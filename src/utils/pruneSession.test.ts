import { describe, expect, it } from "vitest";
import type { Img, NavEntry, UndoAction } from "../types";
import { omitIds, pruneGone, pruneHistory, remapIndex, remapNavStack } from "./pruneSession";

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
    expect(pruneGone(five, ["/elsewhere/x.cr3"])).toBeNull();
  });
  it("removes gone frames and returns a remap function keyed by surviving frame", () => {
    const out = pruneGone(five, ["/s/1.cr3", "/s/4.cr3"]);
    expect(out).not.toBeNull();
    expect(out!.images.map((im) => im.id)).toEqual([0, 2, 3]);
    expect(out!.goneIds).toEqual(new Set([1, 4]));
    expect(out!.remap(3)).toBe(2); // id 3 survives
    expect(out!.remap(4)).toBe(2); // id 4 gone → clamped to the last survivor
    expect(out!.remap(1)).toBe(1); // id 1 gone → next survivor id 2
  });
  it("never mutates its input", () => {
    const input = [...five];
    pruneGone(input, ["/s/0.cr3"]);
    expect(input).toHaveLength(5);
    expect(input).toEqual(five);
  });
});

describe("remapNavStack", () => {
  it("remaps compare entries and leaves other sites untouched (same object)", () => {
    const grid: NavEntry = { site: "grid" };
    const nav: NavEntry[] = [grid, { site: "compare", champ: 3, chall: 4 }];
    const { remap } = pruneGone(five, ["/s/1.cr3", "/s/4.cr3"])!;
    const out = remapNavStack(nav, remap);
    expect(out).toEqual([{ site: "grid" }, { site: "compare", champ: 2, chall: 2 }]);
    expect(out[0]).toBe(grid);
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
  it("returns the same array when no frame is gone, even if actions carry cursor snapshots", () => {
    const stack: UndoAction[] = [
      {
        changes: [change(5)],
        cursorBefore: { compareMode: true, championIndex: 0, challengerIndex: 1, currentIndex: 0 },
      },
    ];
    expect(pruneHistory(stack, new Set<number>())).toBe(stack);
    expect(stack[0].cursorBefore).toBeDefined();
  });
});
