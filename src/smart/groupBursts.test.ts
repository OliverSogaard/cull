import { describe, expect, test } from "vitest";
import { groupBursts } from "./groupBursts";
import { img, score } from "./testScores";
import type { ImageScore } from "../types/ipc";

/** Burst frame at 12 fps cadence: capturedAtMs base + i·83ms, subSec present. */
function burstScore(i: number, over: Partial<ImageScore> = {}): ImageScore {
  return score({
    index: i,
    capturedAtMs: 1_000_000 + i * 83,
    subSecMs: (i * 83) % 1000,
    mtimeMs: 2_000_000 + i * 90, // write times lag capture; distinct on purpose
    ...over,
  });
}

describe("groupBursts", () => {
  test("groups consecutive cadence frames and crowns the sharpest winner", () => {
    const images = [img(10), img(11), img(12)];
    const scores = {
      10: burstScore(0, { afSharpness: 0.4 }),
      11: burstScore(1, { afSharpness: 0.7 }), // winner
      12: burstScore(2, { afSharpness: 0.5 }),
    };
    const ctx = groupBursts(images, scores);
    expect(ctx.get(11)).toMatchObject({ pos: 2, len: 3, isWinner: true, marginToWinner: 0 });
    expect(ctx.get(10)).toMatchObject({ pos: 1, len: 3, isWinner: false });
    expect(ctx.get(10)!.marginToWinner).toBeCloseTo(0.3, 5);
    expect(ctx.get(12)!.marginToWinner).toBeCloseTo(0.2, 5);
    expect(ctx.get(10)!.group).toBe(ctx.get(12)!.group);
  });

  test("a cadence gap splits groups; a lone frame gets no ctx", () => {
    const images = [img(1), img(2), img(3)];
    const scores = {
      1: burstScore(0),
      2: burstScore(1),
      3: burstScore(1, { capturedAtMs: 1_000_000 + 83 + 5_000, mtimeMs: 2_100_000 }),
    };
    const ctx = groupBursts(images, scores);
    expect(ctx.get(1)!.len).toBe(2);
    expect(ctx.get(3)).toBeUndefined();
  });

  test.each([
    ["focal change", { focalLengthMm: 200 }],
    ["single-shot drive mode", { driveMode: 0 }],
  ])("%s splits the group", (_name, over) => {
    const images = [img(1), img(2)];
    const scores = { 1: burstScore(0), 2: burstScore(1, over) };
    expect(groupBursts(images, scores).size).toBe(0);
  });

  test("same cadence in a DIFFERENT srcFolder never groups", () => {
    const images = [img(1, "/shoot/a"), img(2, "/shoot/b")];
    const scores = { 1: burstScore(0), 2: burstScore(1) };
    expect(groupBursts(images, scores).size).toBe(0);
  });

  test("SubSec cadence outranks mtime: buffer-dump mtimes stretch, still one burst", () => {
    const images = [img(1), img(2)];
    const scores = {
      1: burstScore(0, { mtimeMs: 2_000_000 }),
      2: burstScore(1, { mtimeMs: 2_000_000 + 4_000 }), // slow card wrote 4s later
    };
    expect(groupBursts(images, scores).get(1)!.len).toBe(2);
  });

  test("without SubSec, mtime deltas group — second-precision capture can't veto tight mtimes", () => {
    const images = [img(1), img(2)];
    // 12 fps crossing a second boundary: capturedAt jumps a whole second while
    // mtimes are 90 ms apart. subSec absent → mtime is the fine cadence.
    const scores = {
      1: burstScore(0, { subSecMs: null, capturedAtMs: 1_000_000 }),
      2: burstScore(1, { subSecMs: null, capturedAtMs: 1_001_000, mtimeMs: 2_000_090 }),
    };
    expect(groupBursts(images, scores).get(1)!.len).toBe(2);
  });

  test("coarse guard: flattened copy mtimes cannot group frames captured seconds apart", () => {
    const images = [img(1), img(2)];
    const scores = {
      1: burstScore(0, { subSecMs: null, capturedAtMs: 1_000_000, mtimeMs: 3_000_000 }),
      2: burstScore(1, {
        subSecMs: null,
        capturedAtMs: 1_009_000, // 9 s apart in reality
        mtimeMs: 3_000_050, // copy tool stamped both "now"
      }),
    };
    expect(groupBursts(images, scores).size).toBe(0);
  });

  test("winner self-corrects when a later chunk lands a sharper frame", () => {
    const images = [img(1), img(2), img(3)];
    const early = {
      1: burstScore(0, { afSharpness: 0.5 }),
      2: burstScore(1, { afSharpness: 0.4 }),
    };
    expect(groupBursts(images, early).get(1)!.isWinner).toBe(true);

    const late = { ...early, 3: burstScore(2, { afSharpness: 0.9 }) };
    const ctx = groupBursts(images, late);
    expect(ctx.get(1)!.isWinner).toBe(false);
    expect(ctx.get(3)).toMatchObject({ isWinner: true, len: 3 });
    expect(ctx.get(1)!.marginToWinner).toBeCloseTo(0.4, 5);
  });

  test("an unscored or decode-failed frame splits the run (self-heals as chunks land)", () => {
    const images = [img(1), img(2), img(3), img(4)];
    const scores = {
      1: burstScore(0),
      2: burstScore(1, { decodeOk: false }),
      3: burstScore(2),
      4: burstScore(3),
    };
    const ctx = groupBursts(images, scores);
    expect(ctx.get(1)).toBeUndefined(); // its only neighbour is unusable → lone
    expect(ctx.get(2)).toBeUndefined();
    expect(ctx.get(3)!.len).toBe(2);
    expect(ctx.get(4)!.len).toBe(2);
  });

  test("winner tiebreak: afSharpness, then globalSharpness, then lowest clipping, then earliest", () => {
    const images = [img(1), img(2), img(3)];
    const tie = { afSharpness: 0.6, globalSharpness: 0.5 };
    const scores = {
      1: burstScore(0, { ...tie, blownPct: 0.2 }),
      2: burstScore(1, { ...tie, blownPct: 0.01 }), // wins on lowest clipping
      3: burstScore(2, { ...tie, blownPct: 0.2 }),
    };
    expect(groupBursts(images, scores).get(2)!.isWinner).toBe(true);
  });
});
