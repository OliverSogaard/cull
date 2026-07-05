import type { Img } from "../types/image";
import type { ImageScore } from "../types/ipc";
import type { BurstCtx, SharpInput } from "./groupBursts";
import { pickWinner } from "./pickWinner";

/** Same ctx shape as bursts — the UI treats both group kinds identically. */
export type SimilarCtx = BurstCtx;

/** Frames whose neighbors are further apart than this never chain (time-local
 *  only, per the spec: a worked scene, not whole-folder lookalikes). */
export const SIMILAR_WINDOW_MS = 300_000;
/** pHash Hamming distance at or under this ⇒ near-exact duplicate. */
export const PHASH_NEAR = 10;
/** DINOv2 cosine at or above this ⇒ lookalike (ML builds only). */
export const SIMILAR_COSINE = 0.92;

/** Hamming distance between two 16-hex-char pHashes via BigInt (64-bit safe). */
export function phashDistance(a: string, b: string): number {
  let x = BigInt("0x" + a) ^ BigInt("0x" + b);
  let n = 0;
  while (x > 0n) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}

function cosine(a: readonly number[], b: readonly number[]): number {
  // Embeddings arrive L2-normalized — the dot product IS the cosine.
  let s = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) s += a[i] * b[i];
  return s;
}

/** Capture-time for chaining: SubSec-precise clock preferred, mtime fallback
 *  (both frames must use the SAME source or the delta is meaningless). */
function timeOf(s: ImageScore): number | null {
  return s.capturedAtMs ?? (s.mtimeMs || null);
}

/** Does frame `b` extend a chain ending at frame `a`? (Adjacent-only test.) */
function linked(a: ImageScore, b: ImageScore): boolean {
  const ta = timeOf(a);
  const tb = timeOf(b);
  if (ta == null || tb == null || Math.abs(tb - ta) > SIMILAR_WINDOW_MS) return false;
  if (a.phash != null && b.phash != null && phashDistance(a.phash, b.phash) <= PHASH_NEAR) {
    return true;
  }
  if (a.embedding != null && b.embedding != null) {
    return cosine(a.embedding, b.embedding) >= SIMILAR_COSINE;
  }
  return false;
}

/**
 * Time-local near-duplicate grouping (spec: SMART_CULLING_PHASE3_DESIGN.md).
 * Pure derivation, mirrors groupBursts: adjacent frames chain when EITHER the
 * pHash tier (always available) or the embedding tier (ML builds) links them;
 * unscored frames and burst members are transparent walls; winner comes from
 * the SAME ladder as bursts (pickWinner) so the two cannot drift.
 */
export function groupSimilar(
  images: readonly Img[],
  scores: Readonly<Record<number, ImageScore>>,
  bursts: ReadonlyMap<number, BurstCtx>,
  sharp: Readonly<Record<number, SharpInput>>,
  eligible: Readonly<Record<number, boolean>>,
): Map<number, SimilarCtx> {
  const out = new Map<number, SimilarCtx>();
  let run: number[] = [];
  let groupId = 0;

  const flush = () => {
    if (run.length >= 2) {
      const { winnerIdx: w, winnerAf } = pickWinner(run, sharp, eligible);
      run.forEach((id, i) => {
        out.set(id, {
          group: groupId,
          pos: i + 1,
          len: run.length,
          isWinner: i === w,
          marginToWinner: w >= 0 && i !== w ? winnerAf - sharp[id]!.afSharpness : 0,
        });
      });
      groupId += 1;
    }
    run = [];
  };

  let prev: { img: Img; score: ImageScore } | null = null;
  for (const img of images) {
    const score = scores[img.id];
    // Transparent walls: unscored, decode-failed, and burst members all split.
    if (!score || !score.decodeOk || bursts.has(img.id)) {
      flush();
      prev = null;
      continue;
    }
    if (prev && prev.img.srcFolder === img.srcFolder && linked(prev.score, score)) {
      if (run.length === 0) run = [prev.img.id];
      run.push(img.id);
    } else {
      flush();
    }
    prev = { img, score };
  }
  flush();
  return out;
}
