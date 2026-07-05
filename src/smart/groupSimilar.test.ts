import { describe, expect, test } from "vitest";
import { groupSimilar, PHASH_NEAR, SIMILAR_COSINE, SIMILAR_WINDOW_MS } from "./groupSimilar";
import type { BurstCtx } from "./groupBursts";
import type { Img } from "../types/image";
import { img, score } from "./testScores";

/** Orthogonal unit embeddings for "unrelated"; same vector for "identical". */
const e = (dir: number): number[] => {
  const v = new Array(8).fill(0);
  v[dir] = 1;
  return v;
};

const scoreHelper = (
  id: number,
  t: number,
  overrides: Partial<ReturnType<typeof score>> = {},
) => ({
  ...score(),
  index: id,
  capturedAtMs: t,
  subSecMs: 0,
  mtimeMs: t,
  phash: "0000000000000000",
  embedding: null,
  ...overrides,
});

const NO_BURSTS: ReadonlyMap<number, BurstCtx> = new Map();

describe("groupSimilar", () => {
  test("near-identical pHash neighbors group; distant hashes don't", () => {
    const images = [img(1), img(2), img(3)];
    const scores = {
      1: scoreHelper(1, 0, { phash: "0000000000000000" }),
      2: scoreHelper(2, 1000, { phash: "0000000000000003" }), // hamming 2 ≤ PHASH_NEAR
      3: scoreHelper(3, 2000, { phash: "ffffffffffffffff" }), // hamming 62 — far
    };
    const out = groupSimilar(images, scores, NO_BURSTS, {}, {});
    expect(out.get(1)?.group).toBe(out.get(2)?.group);
    expect(out.get(1)?.len).toBe(2);
    expect(out.has(3)).toBe(false);
  });

  test("embedding cosine links what pHash misses", () => {
    const images = [img(1), img(2)];
    const scores = {
      1: scoreHelper(1, 0, { phash: "0000000000000000", embedding: e(0) }),
      2: scoreHelper(2, 1000, { phash: "ffffffffffffffff", embedding: e(0) }), // cosine 1
    };
    const out = groupSimilar(images, scores, NO_BURSTS, {}, {});
    expect(out.get(1)?.group).toBe(out.get(2)?.group);
  });

  test("time window splits: same look, too far apart never groups", () => {
    const images = [img(1), img(2)];
    const scores = {
      1: scoreHelper(1, 0),
      2: scoreHelper(2, SIMILAR_WINDOW_MS + 1),
    };
    expect(groupSimilar(images, scores, NO_BURSTS, {}, {}).size).toBe(0);
  });

  test("adjacency chaining: a stray frame splits the group in two", () => {
    const images = [img(1), img(2), img(3)];
    const scores = {
      1: scoreHelper(1, 0, { phash: "0000000000000000" }),
      2: scoreHelper(2, 1000, { phash: "ffffffffffffffff" }), // the stray
      3: scoreHelper(3, 2000, { phash: "0000000000000000" }),
    };
    const out = groupSimilar(images, scores, NO_BURSTS, {}, {});
    expect(out.size).toBe(0); // 1 and 3 alike but not ADJACENT — no group (MVP semantics)
  });

  test("burst members never join a similar group", () => {
    const images = [img(1), img(2)];
    const scores = { 1: scoreHelper(1, 0), 2: scoreHelper(2, 1000) };
    const bursts = new Map<number, BurstCtx>([
      [2, { group: 0, pos: 1, len: 3, isWinner: false, marginToWinner: 0 }],
    ]);
    expect(groupSimilar(images, scores, bursts, {}, {}).size).toBe(0);
  });

  test("unscored frames are transparent walls (mirror groupBursts)", () => {
    const images = [img(1), img(2), img(3)];
    const scores = { 1: scoreHelper(1, 0), 3: scoreHelper(3, 2000) }; // 2 unscored
    expect(groupSimilar(images, scores, NO_BURSTS, {}, {}).size).toBe(0);
  });

  test("winner rides the shared ladder and self-corrects as scores land", () => {
    const images = [img(1), img(2)];
    const scores = { 1: scoreHelper(1, 0), 2: scoreHelper(2, 1000) };
    const sharp = {
      1: { afSharpness: 0.9, globalSharpness: 0.9, clipSum: 0, faceSharpness: null, eyesOpen: null },
      2: { afSharpness: 0.5, globalSharpness: 0.5, clipSum: 0, faceSharpness: null, eyesOpen: null },
    };
    const out = groupSimilar(images, scores, NO_BURSTS, sharp, { 1: true, 2: true });
    expect(out.get(1)?.isWinner).toBe(true);
    expect(out.get(2)?.isWinner).toBe(false);
    expect(out.get(2)?.marginToWinner).toBeCloseTo(0.4);
    // Nobody eligible → no winner at all.
    const none = groupSimilar(images, scores, NO_BURSTS, sharp, { 1: false, 2: false });
    expect(none.get(1)?.isWinner).toBe(false);
  });

  test("different srcFolder never groups", () => {
    const images = [img(1), { id: 2, srcFolder: "/b", path: "/b/img2.CR3", filename: "img2.CR3" } as Img];
    const scores = { 1: scoreHelper(1, 0), 2: scoreHelper(2, 1000) };
    expect(groupSimilar(images, scores, NO_BURSTS, {}, {}).size).toBe(0);
  });
});
