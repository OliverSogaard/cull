import { describe, expect, test } from "vitest";
import { pickWinner } from "./pickWinner";
import type { SharpInput } from "./groupBursts";

const sharp = (af: number, extra?: Partial<SharpInput>): SharpInput => ({
  afSharpness: af,
  globalSharpness: af,
  clipSum: 0,
  faceSharpness: null,
  eyesOpen: null,
  ...extra,
});

describe("pickWinner", () => {
  test("sharpest eligible member wins; ties go to the earliest", () => {
    const s = { 1: sharp(0.5), 2: sharp(0.9), 3: sharp(0.9) };
    expect(pickWinner([1, 2, 3], s, undefined)).toEqual({ winnerIdx: 1, winnerAf: 0.9 });
  });

  test("no winner while any member is unscored", () => {
    expect(pickWinner([1, 2], { 1: sharp(0.5) }, undefined).winnerIdx).toBe(-1);
  });

  test("no winner when nobody is eligible", () => {
    const s = { 1: sharp(0.5), 2: sharp(0.9) };
    expect(pickWinner([1, 2], s, { 1: false, 2: false }).winnerIdx).toBe(-1);
  });

  test("eyes-open beats sharper-but-blinking (both known, opposite sides)", () => {
    const s = {
      1: sharp(0.9, { eyesOpen: 0.1 }),
      2: sharp(0.6, { eyesOpen: 0.9 }),
    };
    expect(pickWinner([1, 2], s, undefined).winnerIdx).toBe(1);
  });

  test("face sharpness outranks af sharpness when both frames carry faces", () => {
    const s = {
      1: sharp(0.9, { faceSharpness: 0.3 }),
      2: sharp(0.6, { faceSharpness: 0.8 }),
    };
    expect(pickWinner([1, 2], s, undefined).winnerIdx).toBe(1);
  });
});
