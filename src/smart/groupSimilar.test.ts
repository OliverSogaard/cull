import { describe, expect, test } from "vitest";
import { groupSimilar, SIMILAR_WINDOW_MS, type SimilarInput } from "./groupSimilar";
import type { BurstCtx } from "./groupBursts";
import type { ImageScore } from "../types/ipc";
import type { ImageMetadata } from "../types";
import { buildSimilarInputs } from "./burstInputs";
import { img, score } from "./testScores";

/** Orthogonal unit embeddings for "unrelated"; same vector for "identical". */
const e = (dir: number): number[] => {
  const v = new Array<number>(8).fill(0);
  v[dir] = 1;
  return v;
};

/** Standing (thumb-tier) grouping input — the phash tier is ALWAYS this
 *  source, never `ImageScore.phash` (that field stays wire-only). */
const input = (t: number, overrides: Partial<SimilarInput> = {}): SimilarInput => ({
  capturedAtMs: t,
  mtimeMs: t,
  phash: "0000000000000000",
  ...overrides,
});

const NO_BURSTS: ReadonlyMap<number, BurstCtx> = new Map();
const NO_SCORES: Readonly<Record<number, ImageScore>> = {};

describe("groupSimilar", () => {
  test("near-identical pHash neighbors group; distant hashes don't", () => {
    const images = [img(1), img(2), img(3)];
    const inputs = {
      1: input(0, { phash: "0000000000000000" }),
      2: input(1000, { phash: "0000000000000003" }), // hamming 2 ≤ PHASH_NEAR
      3: input(2000, { phash: "ffffffffffffffff" }), // hamming 62 — far
    };
    const out = groupSimilar(images, inputs, NO_SCORES, NO_BURSTS, {}, {});
    expect(out.get(1)?.group).toBe(out.get(2)?.group);
    expect(out.get(1)?.len).toBe(2);
    expect(out.has(3)).toBe(false);
  });

  test("embedding cosine (from scores) links what the standing pHash tier misses", () => {
    const images = [img(1), img(2)];
    const inputs = {
      1: input(0, { phash: "0000000000000000" }),
      2: input(1000, { phash: "ffffffffffffffff" }), // far
    };
    const scores = {
      1: score({ embedding: e(0) }),
      2: score({ embedding: e(0) }), // cosine 1
    };
    const out = groupSimilar(images, inputs, scores, NO_BURSTS, {}, {});
    expect(out.get(1)?.group).toBe(out.get(2)?.group);
  });

  test("groupSimilar never reads ImageScore.phash — a scored phash never substitutes for the standing one", () => {
    const images = [img(1), img(2)];
    // Standing inputs carry NO usable phash link (far apart); scores DO carry
    // a matching ImageScore.phash and no embedding — must NOT group on that.
    const inputs = {
      1: input(0, { phash: "0000000000000000" }),
      2: input(1000, { phash: "ffffffffffffffff" }),
    };
    const scores = {
      1: score({ phash: "0000000000000000", embedding: null }),
      2: score({ phash: "0000000000000000", embedding: null }),
    };
    expect(groupSimilar(images, inputs, scores, NO_BURSTS, {}, {}).size).toBe(0);
  });

  test("time window splits: same look, too far apart never groups", () => {
    const images = [img(1), img(2)];
    const inputs = {
      1: input(0),
      2: input(SIMILAR_WINDOW_MS + 1),
    };
    expect(groupSimilar(images, inputs, NO_SCORES, NO_BURSTS, {}, {}).size).toBe(0);
  });

  test("adjacency chaining: a stray frame splits the group in two", () => {
    const images = [img(1), img(2), img(3)];
    const inputs = {
      1: input(0, { phash: "0000000000000000" }),
      2: input(1000, { phash: "ffffffffffffffff" }), // the stray
      3: input(2000, { phash: "0000000000000000" }),
    };
    const out = groupSimilar(images, inputs, NO_SCORES, NO_BURSTS, {}, {});
    expect(out.size).toBe(0); // 1 and 3 alike but not ADJACENT — no group (MVP semantics)
  });

  test("burst members never join a similar group", () => {
    const images = [img(1), img(2)];
    const inputs = { 1: input(0), 2: input(1000) };
    const bursts = new Map<number, BurstCtx>([
      [2, { group: 0, pos: 1, len: 3, isWinner: false, marginToWinner: 0 }],
    ]);
    expect(groupSimilar(images, inputs, NO_SCORES, bursts, {}, {}).size).toBe(0);
  });

  test("frames without a standing input yet are transparent walls (mirror groupBursts)", () => {
    const images = [img(1), img(2), img(3)];
    const inputs = { 1: input(0), 3: input(2000) }; // 2 has no thumb metadata yet
    expect(groupSimilar(images, inputs, NO_SCORES, NO_BURSTS, {}, {}).size).toBe(0);
  });

  test("winner rides the shared ladder and self-corrects as scores land", () => {
    const images = [img(1), img(2)];
    const inputs = { 1: input(0), 2: input(1000) };
    const sharp = {
      1: {
        afSharpness: 0.9,
        globalSharpness: 0.9,
        clipSum: 0,
        faceSharpness: null,
        eyesOpen: null,
      },
      2: {
        afSharpness: 0.5,
        globalSharpness: 0.5,
        clipSum: 0,
        faceSharpness: null,
        eyesOpen: null,
      },
    };
    const out = groupSimilar(images, inputs, NO_SCORES, NO_BURSTS, sharp, { 1: true, 2: true });
    expect(out.get(1)?.isWinner).toBe(true);
    expect(out.get(2)?.isWinner).toBe(false);
    expect(out.get(2)?.marginToWinner).toBeCloseTo(0.4);
    // Nobody eligible → no winner at all.
    const none = groupSimilar(images, inputs, NO_SCORES, NO_BURSTS, sharp, { 1: false, 2: false });
    expect(none.get(1)?.isWinner).toBe(false);
  });

  test("no scores at all (smart culling off): groups still form, nobody wins", () => {
    const images = [img(1), img(2)];
    const inputs = { 1: input(0), 2: input(1000) };
    const out = groupSimilar(images, inputs, {}, NO_BURSTS, {}, {});
    expect(out.get(1)?.group).toBe(out.get(2)?.group);
    expect(out.get(1)?.isWinner).toBe(false);
    expect(out.get(2)?.isWinner).toBe(false);
  });

  test("different srcFolder never groups", () => {
    const images = [img(1), { id: 2, srcFolder: "/b", path: "/b/img2.CR3", filename: "img2.CR3" }];
    const inputs = { 1: input(0), 2: input(1000) };
    expect(groupSimilar(images, inputs, NO_SCORES, NO_BURSTS, {}, {}).size).toBe(0);
  });
});

describe("buildSimilarInputs", () => {
  const meta = (over: Partial<ImageMetadata> = {}): ImageMetadata => ({
    capturedAt: "2026-05-17T17:18:14",
    camera: null,
    lens: null,
    focalLengthMm: 105,
    aperture: null,
    shutterSeconds: null,
    iso: null,
    gpsLat: null,
    gpsLon: null,
    afXPct: null,
    afYPct: null,
    exposureBias: null,
    whiteBalance: null,
    driveMode: 8,
    pixelWidth: null,
    pixelHeight: null,
    fileSize: null,
    lrcRating: null,
    subSecMs: 470,
    phash: "1234000000000000",
    ...over,
  });

  test("phash ALWAYS comes from the standing thumb metadata, never from the score", () => {
    const images = [img(1)];
    // The score carries its OWN (different-source) phash — must be ignored.
    const scores = { 1: score({ phash: "ffffffffffffffff" }) };
    const metadata = { [images[0].path]: meta({ phash: "1234000000000000" }) };
    const inputs = buildSimilarInputs(images, scores, metadata);
    expect(inputs[1].phash).toBe("1234000000000000");
  });

  test("with no thumb metadata at all, phash is null even when scored", () => {
    const images = [img(1)];
    const scores = { 1: score({ phash: "ffffffffffffffff" }) };
    const inputs = buildSimilarInputs(images, scores, {});
    expect(inputs[1].phash).toBeNull();
  });

  test("prefers the score's precise capture clock, falls back to metadata", () => {
    const images = [img(1), img(2)];
    const scores = { 1: score({ mtimeMs: 5_000, capturedAtMs: 9_000 }) };
    const metadata = { [images[1].path]: meta() };
    const inputs = buildSimilarInputs(images, scores, metadata);
    expect(inputs[1]).toMatchObject({ mtimeMs: 5_000, capturedAtMs: 9_000 });
    expect(inputs[2].mtimeMs).toBeNull(); // metadata carries no write time
    expect(inputs[2].capturedAtMs).not.toBeNull();
  });

  test("a frame with neither a score nor thumb metadata gets no entry", () => {
    const images = [img(1), img(2)];
    const scores = { 1: score() };
    const inputs = buildSimilarInputs(images, scores, {});
    expect(inputs[2]).toBeUndefined();
  });
});
