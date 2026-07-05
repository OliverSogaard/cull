import { describe, expect, test } from "vitest";
import { missingTargets, unratedTargets } from "./analysisTargets";

const imgs = [{ id: 0 }, { id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];

describe("unratedTargets", () => {
  test("keeps only unrated frames, preserving capture order", () => {
    expect(unratedTargets(imgs, new Set([0, 1, 3]))).toEqual([{ id: 2 }, { id: 4 }]);
  });

  test("nothing rated → the full set (fresh folder)", () => {
    expect(unratedTargets(imgs, new Set())).toEqual(imgs);
  });

  test("everything rated → empty (finished cull reopened)", () => {
    expect(unratedTargets(imgs, new Set([0, 1, 2, 3, 4]))).toEqual([]);
  });
});

describe("missingTargets", () => {
  test("unrated frames without a score and not yet attempted", () => {
    // 1 was unrated by the user after the pass: no score yet → catch-up target.
    const rated = new Set([0, 3]);
    const scored = new Set([2, 4]);
    expect(missingTargets(imgs, rated, (id) => scored.has(id), new Set())).toEqual([{ id: 1 }]);
  });

  test("already-attempted frames are excluded so a failing frame can't loop forever", () => {
    const rated = new Set([0, 3]);
    const scored = new Set([2, 4]);
    expect(missingTargets(imgs, rated, (id) => scored.has(id), new Set([1]))).toEqual([]);
  });

  test("scored frames never re-analyze even when unrated later", () => {
    // 2 was rated during the pass, then unrated — its score survives, no work.
    expect(missingTargets(imgs, new Set([0, 1, 3]), (id) => id === 2 || id === 4, new Set())).toEqual([]);
  });
});
