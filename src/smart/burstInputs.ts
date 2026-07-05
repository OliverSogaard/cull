import type { Img, ImageMetadata } from "../types";
import type { ImageScore } from "../types/ipc";
import type { BurstInput, SharpInput } from "./groupBursts";

/**
 * Build the grouping inputs for every frame, preferring the smart pass's score
 * (complete: adds mtime + sharpness) and falling back to the EXIF metadata the
 * frame's thumbnail already delivered — so burst boxes render with smart
 * culling OFF, and upgrade in place (winners appear) as scores land.
 */
export function buildBurstInputs(
  images: readonly Img[],
  scores: Readonly<Record<number, ImageScore>>,
  metadata: Readonly<Record<string, ImageMetadata>>,
): { inputs: Record<number, BurstInput>; sharp: Record<number, SharpInput> } {
  const inputs: Record<number, BurstInput> = {};
  const sharp: Record<number, SharpInput> = {};
  for (const img of images) {
    const s = scores[img.id];
    if (s && s.decodeOk) {
      inputs[img.id] = {
        srcFolder: img.srcFolder,
        driveMode: s.driveMode,
        focalLengthMm: s.focalLengthMm,
        capturedAtMs: s.capturedAtMs,
        hasSubSec: s.subSecMs != null,
        mtimeMs: s.mtimeMs,
      };
      const primary = s.faces.reduce(
        (best, f) => (f.bbox[2] * f.bbox[3] > (best?.bbox[2] ?? 0) * (best?.bbox[3] ?? 0) ? f : best),
        null as (typeof s.faces)[number] | null,
      );
      sharp[img.id] = {
        afSharpness: s.afSharpness,
        globalSharpness: s.globalSharpness,
        clipSum: s.blownPct + s.crushedPct,
        faceSharpness: primary ? primary.faceSharpness : null,
      };
      continue;
    }
    const m = metadata[img.path];
    if (m) {
      inputs[img.id] = {
        srcFolder: img.srcFolder,
        driveMode: m.driveMode,
        focalLengthMm: m.focalLengthMm,
        capturedAtMs: capturedAtToMs(m.capturedAt, m.subSecMs),
        hasSubSec: m.subSecMs != null,
        mtimeMs: null, // metadata carries no write time
      };
    }
  }
  return { inputs, sharp };
}

/**
 * "YYYY-MM-DDTHH:MM:SS" (camera local clock) + SubSec ms → one delta-safe ms
 * value. `Date.parse` treats a TZ-less date-time as LOCAL time, which is fine:
 * only deltas are ever taken, and every frame parses under the same rule.
 */
export function capturedAtToMs(
  capturedAt: string | null,
  subSecMs: number | null,
): number | null {
  if (!capturedAt) return null;
  const base = Date.parse(capturedAt);
  if (Number.isNaN(base)) return null;
  return base + (subSecMs ?? 0);
}
