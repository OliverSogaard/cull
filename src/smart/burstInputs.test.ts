import { describe, expect, test } from "vitest";
import { buildBurstInputs, buildSimilarInputs, capturedAtToMs } from "./burstInputs";
import { img, score } from "./__fixtures__/testScores";
import type { ImageMetadata } from "../types";
import type { ImageScore } from "../types/ipc";

const meta = (over: Partial<ImageMetadata> = {}): ImageMetadata => ({
  capturedAt: "2026-05-17T17:18:14",
  subSecMs: null,
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
  phash: null,
  ...over,
});

/** One face occupying `w×h` px of the frame, with the given openness. */
function face(
  w: number,
  h: number,
  eyesOpen: number,
  faceSharpness = 0.5,
): ImageScore["faces"][number] {
  return { bbox: [0, 0, w, h], eyesOpen, faceSharpness };
}

describe("capturedAtToMs", () => {
  test("null capturedAt → null", () => {
    expect(capturedAtToMs(null, 0)).toBeNull();
    expect(capturedAtToMs(null, 470)).toBeNull();
  });

  test("unparseable date → null", () => {
    expect(capturedAtToMs("not a date", 0)).toBeNull();
  });

  test("adds the sub-second fraction; null subSec counts as 0", () => {
    const base = Date.parse("2026-05-17T17:18:14");
    expect(capturedAtToMs("2026-05-17T17:18:14", 470)).toBe(base + 470);
    expect(capturedAtToMs("2026-05-17T17:18:14", null)).toBe(base);
  });

  test("only deltas matter: two frames share the same parse rule", () => {
    const a = capturedAtToMs("2026-05-17T17:18:14", 100)!;
    const b = capturedAtToMs("2026-05-17T17:18:15", 100)!;
    expect(b - a).toBe(1000);
  });
});

describe("buildBurstInputs source preference", () => {
  test("a decoded score supplies mtime + drive mode; metadata is not consulted", () => {
    const images = [img(1)];
    const scores = { 1: score({ mtimeMs: 5_000, driveMode: 8, capturedAtMs: 1_234 }) };
    const { inputs } = buildBurstInputs(images, scores, {});
    expect(inputs[1].mtimeMs).toBe(5_000);
    expect(inputs[1].capturedAtMs).toBe(1_234);
    expect(inputs[1].hasSubSec).toBe(true); // subSecMs 0 is present (not null)
  });

  test("decodeOk=false falls back to metadata (mtime unknown → null)", () => {
    const images = [img(1)];
    const scores = { 1: score({ decodeOk: false, mtimeMs: 9_999 }) };
    const metadata = { [img(1).path]: meta({ capturedAt: "2026-05-17T17:18:14", subSecMs: 470 }) };
    const { inputs } = buildBurstInputs(images, scores, metadata);
    expect(inputs[1].mtimeMs).toBeNull();
    expect(inputs[1].hasSubSec).toBe(true);
    expect(inputs[1].capturedAtMs).toBe(Date.parse("2026-05-17T17:18:14") + 470);
  });

  test("no score and no metadata → the frame contributes no input", () => {
    const { inputs, sharp } = buildBurstInputs([img(1)], {}, {});
    expect(inputs[1]).toBeUndefined();
    expect(sharp[1]).toBeUndefined();
  });
});

describe("buildBurstInputs sharpness", () => {
  test("the primary (largest) face drives faceSharpness + eyesOpen", () => {
    const images = [img(1)];
    const scores = {
      1: score({ faces: [face(10, 10, 0.9, 0.3), face(40, 40, 0.2, 0.8)] }),
    };
    const { sharp } = buildBurstInputs(images, scores, {});
    // Largest bbox is the 40×40 face → its faceSharpness (0.8) and eyesOpen.
    expect(sharp[1].faceSharpness).toBe(0.8);
    expect(sharp[1].eyesOpen).toBe(0.2);
  });

  test("eyesOpen −1 sentinel (unknown) surfaces as null", () => {
    const images = [img(1)];
    const scores = { 1: score({ faces: [face(30, 30, -1)] }) };
    const { sharp } = buildBurstInputs(images, scores, {});
    expect(sharp[1].eyesOpen).toBeNull();
  });

  test("no faces → faceSharpness and eyesOpen null; clipSum is blown+crushed", () => {
    const images = [img(1)];
    const scores = { 1: score({ faces: [], blownPct: 0.01, crushedPct: 0.02 }) };
    const { sharp } = buildBurstInputs(images, scores, {});
    expect(sharp[1].faceSharpness).toBeNull();
    expect(sharp[1].eyesOpen).toBeNull();
    expect(sharp[1].clipSum).toBeCloseTo(0.03, 6);
  });
});

describe("buildSimilarInputs", () => {
  test("phash always comes from thumb metadata, never from the score", () => {
    const images = [img(1)];
    const scores = { 1: score({ phash: "ffffffffffffffff" }) };
    const metadata = { [img(1).path]: meta({ phash: "00000000000000ff" }) };
    const inputs = buildSimilarInputs(images, scores, metadata);
    expect(inputs[1].phash).toBe("00000000000000ff");
  });

  test("score path carries mtime; metadata-only path leaves mtime null", () => {
    const images = [img(1), img(2)];
    const scores = { 1: score({ mtimeMs: 7_000, capturedAtMs: 42 }) };
    const metadata = {
      [img(2).path]: meta({ capturedAt: "2026-05-17T17:18:14", subSecMs: 0, phash: "abcd" }),
    };
    const inputs = buildSimilarInputs(images, scores, metadata);
    expect(inputs[1].mtimeMs).toBe(7_000);
    expect(inputs[1].capturedAtMs).toBe(42);
    expect(inputs[2].mtimeMs).toBeNull();
    expect(inputs[2].capturedAtMs).toBe(Date.parse("2026-05-17T17:18:14"));
  });
});
