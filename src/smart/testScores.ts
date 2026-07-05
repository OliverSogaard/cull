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
    decodeOk: true,
    ...over,
  };
}

export function img(id: number, srcFolder = "/shoot/a"): Img {
  return { id, path: `${srcFolder}/img${id}.CR3`, filename: `img${id}.CR3`, srcFolder };
}
