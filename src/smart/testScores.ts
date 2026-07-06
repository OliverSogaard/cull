import type { ImageScore } from "../types/ipc";
import type { Img } from "../types/image";

/** A healthy, sharp, judgeable score — tests override what they probe. */
export function score(over: Partial<ImageScore> = {}): ImageScore {
  return {
    index: 0,
    afSharpness: 0.6,
    afValid: true,
    afTexture: 0.6,
    globalSharpness: 0.55,
    // Below TEXTURE_MIN (0.12) on purpose: this fixture's default
    // globalSharpness (0.55) already sits comfortably above HEAVY_BLUR_SHARP
    // (0.05), so Rule 2b (heavy blur) can't fire by accident from that gate
    // alone — but tests that override globalSharpness low (e.g. the `soft()`
    // fixture in deriveVerdict.test.ts) do so WITHOUT touching globalTexture,
    // so a low default globalTexture is the second, belt-and-suspenders gate
    // that keeps every pre-existing test silent on the new rule. Tests that
    // want to exercise Rule 2b override globalTexture explicitly.
    globalTexture: 0.05,
    noiseFloor: 10,
    blownPct: 0.002,
    crushedPct: 0.002,
    exposureScore: 0.9,
    motionBlurLikelihood: 0.05,
    tenengrad: 0.55,
    phash: null,
    mtimeMs: 1_000_000,
    driveMode: 8,
    focalLengthMm: 85,
    shutterSeconds: 1 / 500,
    iso: 400,
    subSecMs: 0,
    capturedAtMs: 1_000_000,
    faces: [],
    aesthetic: null,
    embedding: null,
    decodeOk: true,
    ...over,
  };
}

export function img(id: number, srcFolder = "/shoot/a"): Img {
  return { id, path: `${srcFolder}/img${id}.CR3`, filename: `img${id}.CR3`, srcFolder };
}
