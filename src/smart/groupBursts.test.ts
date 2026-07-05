import { describe, expect, test } from "vitest";
import { groupBursts, type BurstInput, type SharpInput } from "./groupBursts";
import { buildBurstInputs, capturedAtToMs } from "./burstInputs";
import { img, score } from "./testScores";
import type { ImageMetadata } from "../types";

/** Burst frame at 12 fps cadence: capturedAtMs base + i·83ms, SubSec present. */
function input(i: number, over: Partial<BurstInput> = {}): BurstInput {
  return {
    srcFolder: "/shoot/a",
    driveMode: 8,
    focalLengthMm: 85,
    capturedAtMs: 1_000_000 + i * 83,
    hasSubSec: true,
    mtimeMs: 2_000_000 + i * 90,
    ...over,
  };
}

function sharpOf(afSharpness: number, over: Partial<SharpInput> = {}): SharpInput {
  return { afSharpness, globalSharpness: 0.5, clipSum: 0.005, faceSharpness: null, ...over };
}

describe("groupBursts", () => {
  test("groups consecutive cadence frames and crowns the sharpest winner", () => {
    const images = [img(10), img(11), img(12)];
    const inputs = { 10: input(0), 11: input(1), 12: input(2) };
    const sharp = { 10: sharpOf(0.4), 11: sharpOf(0.7), 12: sharpOf(0.5) };
    const ctx = groupBursts(images, inputs, sharp);
    expect(ctx.get(11)).toMatchObject({ pos: 2, len: 3, isWinner: true, marginToWinner: 0 });
    expect(ctx.get(10)).toMatchObject({ pos: 1, len: 3, isWinner: false });
    expect(ctx.get(10)!.marginToWinner).toBeCloseTo(0.3, 5);
    expect(ctx.get(12)!.marginToWinner).toBeCloseTo(0.2, 5);
    expect(ctx.get(10)!.group).toBe(ctx.get(12)!.group);
  });

  test("groups WITHOUT any sharpness data (smart culling off) — no winner, zero margins", () => {
    const images = [img(1), img(2), img(3)];
    const inputs = { 1: input(0), 2: input(1), 3: input(2) };
    const ctx = groupBursts(images, inputs); // no sharp map at all
    expect(ctx.get(1)!.len).toBe(3);
    for (const id of [1, 2, 3]) {
      expect(ctx.get(id)!.isWinner).toBe(false);
      expect(ctx.get(id)!.marginToWinner).toBe(0);
    }
  });

  test("a half-scored burst has NO winner yet — no premature crown mid-analysis", () => {
    const images = [img(1), img(2), img(3)];
    const inputs = { 1: input(0), 2: input(1), 3: input(2) };
    const partial = { 1: sharpOf(0.5), 2: sharpOf(0.4) }; // 3 unscored
    const ctx = groupBursts(images, inputs, partial);
    expect(ctx.get(1)!.len).toBe(3);
    expect([1, 2, 3].some((id) => ctx.get(id)!.isWinner)).toBe(false);

    const full = { ...partial, 3: sharpOf(0.9) };
    const ctx2 = groupBursts(images, inputs, full);
    expect(ctx2.get(3)).toMatchObject({ isWinner: true, len: 3 });
    expect(ctx2.get(1)!.marginToWinner).toBeCloseTo(0.4, 5);
  });

  test("a cadence gap splits groups; a lone frame gets no ctx", () => {
    const images = [img(1), img(2), img(3)];
    const inputs = {
      1: input(0),
      2: input(1),
      3: input(1, { capturedAtMs: 1_000_000 + 83 + 5_000, mtimeMs: 2_100_000 }),
    };
    const ctx = groupBursts(images, inputs);
    expect(ctx.get(1)!.len).toBe(2);
    expect(ctx.get(3)).toBeUndefined();
  });

  test.each([
    ["focal change", { focalLengthMm: 200 }],
    ["single-shot drive mode", { driveMode: 0 }],
  ])("%s splits the group", (_name, over) => {
    const images = [img(1), img(2)];
    const inputs = { 1: input(0), 2: input(1, over) };
    expect(groupBursts(images, inputs).size).toBe(0);
  });

  test("same cadence in a DIFFERENT srcFolder never groups", () => {
    const images = [img(1, "/shoot/a"), img(2, "/shoot/b")];
    const inputs = {
      1: input(0),
      2: input(1, { srcFolder: "/shoot/b" }),
    };
    expect(groupBursts(images, inputs).size).toBe(0);
  });

  test("SubSec cadence outranks mtime: buffer-dump mtimes stretch, still one burst", () => {
    const images = [img(1), img(2)];
    const inputs = {
      1: input(0, { mtimeMs: 2_000_000 }),
      2: input(1, { mtimeMs: 2_000_000 + 4_000 }), // slow card wrote 4s later
    };
    expect(groupBursts(images, inputs).get(1)!.len).toBe(2);
  });

  test("without SubSec, mtime deltas group — second-precision capture can't veto tight mtimes", () => {
    const images = [img(1), img(2)];
    // 12 fps crossing a second boundary: capturedAt jumps a whole second while
    // mtimes are 90 ms apart. No SubSec → mtime is the fine cadence.
    const inputs = {
      1: input(0, { hasSubSec: false, capturedAtMs: 1_000_000 }),
      2: input(1, { hasSubSec: false, capturedAtMs: 1_001_000, mtimeMs: 2_000_090 }),
    };
    expect(groupBursts(images, inputs).get(1)!.len).toBe(2);
  });

  test("no SubSec AND no mtime (metadata-only source) → no fine cadence → no group", () => {
    const images = [img(1), img(2)];
    const inputs = {
      1: input(0, { hasSubSec: false, mtimeMs: null }),
      2: input(1, { hasSubSec: false, mtimeMs: null }),
    };
    expect(groupBursts(images, inputs).size).toBe(0);
  });

  test("coarse guard: flattened copy mtimes cannot group frames captured seconds apart", () => {
    const images = [img(1), img(2)];
    const inputs = {
      1: input(0, { hasSubSec: false, capturedAtMs: 1_000_000, mtimeMs: 3_000_000 }),
      2: input(1, {
        hasSubSec: false,
        capturedAtMs: 1_009_000, // 9 s apart in reality
        mtimeMs: 3_000_050, // copy tool stamped both "now"
      }),
    };
    expect(groupBursts(images, inputs).size).toBe(0);
  });

  test("a frame with no input splits the run (self-heals as data lands)", () => {
    const images = [img(1), img(2), img(3), img(4)];
    const inputs = { 1: input(0), 3: input(2), 4: input(3) }; // 2 missing
    const ctx = groupBursts(images, inputs);
    expect(ctx.get(1)).toBeUndefined(); // its only neighbour is unusable → lone
    expect(ctx.get(2)).toBeUndefined();
    expect(ctx.get(3)!.len).toBe(2);
    expect(ctx.get(4)!.len).toBe(2);
  });

  test("a sharper FACE beats a sharper AF crop when both frames carry faces (Tier-2)", () => {
    const images = [img(1), img(2)];
    const inputs = { 1: input(0), 2: input(1) };
    const sharp = {
      1: sharpOf(0.7, { faceSharpness: 0.3 }),
      2: sharpOf(0.5, { faceSharpness: 0.6 }), // softer AF crop, sharper face -> wins
    };
    expect(groupBursts(images, inputs, sharp).get(2)!.isWinner).toBe(true);
  });

  test("face tiebreak needs faces on BOTH sides - one-sided falls back to AF sharpness", () => {
    const images = [img(1), img(2)];
    const inputs = { 1: input(0), 2: input(1) };
    const sharp = {
      1: sharpOf(0.7, { faceSharpness: null }),
      2: sharpOf(0.5, { faceSharpness: 0.9 }),
    };
    expect(groupBursts(images, inputs, sharp).get(1)!.isWinner).toBe(true);
  });

  test("winner tiebreak: afSharpness, then globalSharpness, then lowest clipping, then earliest", () => {
    const images = [img(1), img(2), img(3)];
    const inputs = { 1: input(0), 2: input(1), 3: input(2) };
    const sharp = {
      1: sharpOf(0.6, { clipSum: 0.2 }),
      2: sharpOf(0.6, { clipSum: 0.01 }), // wins on lowest clipping
      3: sharpOf(0.6, { clipSum: 0.2 }),
    };
    expect(groupBursts(images, inputs, sharp).get(2)!.isWinner).toBe(true);
  });
});

describe("buildBurstInputs", () => {
  const meta = (over: Partial<ImageMetadata> = {}): ImageMetadata =>
    ({
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
      ...over,
    }) as ImageMetadata;

  test("prefers the score (adds mtime + sharpness), falls back to metadata", () => {
    const images = [img(1), img(2)];
    const scores = { 1: score({ mtimeMs: 5_000, afSharpness: 0.33 }) };
    const metadata = { [images[1].path]: meta() };
    const { inputs, sharp } = buildBurstInputs(images, scores, metadata);
    expect(inputs[1].mtimeMs).toBe(5_000);
    expect(sharp[1].afSharpness).toBeCloseTo(0.33, 5);
    expect(inputs[2].mtimeMs).toBeNull(); // metadata carries no write time
    expect(inputs[2].driveMode).toBe(8);
    expect(inputs[2].hasSubSec).toBe(true);
    expect(sharp[2]).toBeUndefined(); // no score → no winner input
    expect(sharp[1].faceSharpness).toBeNull(); // no faces on this score
  });

  test("primary face = largest bbox; its sharpness feeds the tiebreak", () => {
    const images = [img(1)];
    const scores = {
      1: score({
        faces: [
          { bbox: [0.1, 0.1, 0.1, 0.1], eyesOpen: -1, faceSharpness: 0.9 },
          { bbox: [0.3, 0.3, 0.4, 0.4], eyesOpen: -1, faceSharpness: 0.4 }, // largest
        ],
      }),
    };
    const { sharp } = buildBurstInputs(images, scores, {});
    expect(sharp[1].faceSharpness).toBeCloseTo(0.4, 5);
  });

  test("a decode-failed score falls back to metadata rather than lying", () => {
    const images = [img(1)];
    const scores = { 1: score({ decodeOk: false }) };
    const metadata = { [images[0].path]: meta() };
    const { inputs, sharp } = buildBurstInputs(images, scores, metadata);
    expect(inputs[1].driveMode).toBe(8); // from metadata
    expect(sharp[1]).toBeUndefined();
  });

  test("capturedAtToMs combines datetime and SubSec; malformed → null", () => {
    const a = capturedAtToMs("2026-05-17T17:18:14", 920)!;
    const b = capturedAtToMs("2026-05-17T17:18:15", 3)!;
    expect(b - a).toBe(83); // 12 fps across the second boundary
    expect(capturedAtToMs(null, 500)).toBeNull();
    expect(capturedAtToMs("not a date", 500)).toBeNull();
    expect(capturedAtToMs("2026-05-17T17:18:14", null)! - a).toBe(-920);
  });
});

describe("winner eligibility (smart-culling threshold)", () => {
  const two = () => [img(0), img(1)];
  const inputsFor = () => ({ 0: input(0), 1: input(1) });

  test("no member eligible -> the burst picks NO winner", () => {
    const ctx = groupBursts(
      two(),
      inputsFor(),
      { 0: sharpOf(0.4), 1: sharpOf(0.45) },
      { 0: false, 1: false },
    );
    expect(ctx.get(0)!.isWinner).toBe(false);
    expect(ctx.get(1)!.isWinner).toBe(false);
    expect(ctx.get(0)!.marginToWinner).toBe(0);
    expect(ctx.get(1)!.marginToWinner).toBe(0);
  });

  test("only eligible frames can win, even when an ineligible one is sharper", () => {
    const ctx = groupBursts(
      two(),
      inputsFor(),
      { 0: sharpOf(0.9), 1: sharpOf(0.6) },
      { 0: false, 1: true },
    );
    expect(ctx.get(0)!.isWinner).toBe(false);
    expect(ctx.get(1)!.isWinner).toBe(true);
    // Losers still measure their margin against the ACTUAL winner.
    expect(ctx.get(0)!.marginToWinner).toBeCloseTo(-0.3, 5);
  });

  test("eligibility omitted -> every scored member is a candidate (legacy callers)", () => {
    const ctx = groupBursts(two(), inputsFor(), { 0: sharpOf(0.9), 1: sharpOf(0.6) });
    expect(ctx.get(0)!.isWinner).toBe(true);
  });
});
