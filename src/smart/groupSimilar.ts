import type { Img } from "../types/image";
import type { ImageScore } from "../types/ipc";
import { dirOf, type BurstCtx, type SharpInput } from "./groupBursts";
import { pickWinner } from "./pickWinner";

/** Same ctx shape as bursts — the UI treats both group kinds identically. */
export type SimilarCtx = BurstCtx;

/**
 * Per-frame grouping inputs for the Similar tier, SOURCE-AGNOSTIC like
 * `BurstInput` (`groupBursts.ts`): similar groups are a STANDING FACT like
 * bursts, so these come from the STANDING thumb-tier pHash the frame's
 * thumbnail already delivered — never from `ImageScore.phash` (see
 * `buildSimilarInputs`, burstInputs.ts).
 *
 * `phash` is ALWAYS the thumb-tier hash. `ImageScore.phash` is computed from
 * a DIFFERENT decode (the PRVW, a different resolution) and stays on the wire
 * only for the calibration harness — mixing the two sources into one Hamming
 * comparison would be cross-source noise, so `groupSimilar` never touches
 * `ImageScore.phash`. The embedding tier (ML builds) is the one signal that
 * DOES still come from `scores`, passed to `groupSimilar` separately, since
 * embeddings have no standing/non-ML source at all.
 */
export type SimilarInput = {
  /** capture-time source: scores' precise capturedAtMs (SubSec-aware) when
   *  the smart pass has scored this frame, else metadata's capturedAt —
   *  same preference order as `BurstInput`. */
  capturedAtMs: number | null;
  /** Write time — only known via the scores path (mirrors `BurstInput`). */
  mtimeMs: number | null;
  /** Standing thumb-tier pHash, 16 lowercase hex chars; `null` on a thumb
   *  decode failure or before the thumbnail has landed. */
  phash: string | null;
};

/** Frames whose neighbors are further apart than this never chain (time-local
 *  only, per the spec: a worked scene, not whole-folder lookalikes). */
export const SIMILAR_WINDOW_MS = 300_000;
/** pHash Hamming distance at or under this ⇒ near-exact duplicate. */
const PHASH_NEAR = 10;
/** DINOv2 cosine at or above this ⇒ lookalike (ML builds only). */
const SIMILAR_COSINE = 0.92;

/** Hamming distance between two 16-hex-char pHashes via BigInt (64-bit safe). */
function phashDistance(a: string, b: string): number {
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

/** Capture-time for chaining: `capturedAtMs` (EXIF SubSec-precise clock)
 *  preferred per-frame, falling back to file mtime only when EXIF is missing.
 *  A pair can end up comparing one frame's capturedAtMs against the other's
 *  mtime — the delta is then approximate, not a true capture-time gap — but
 *  at the 5-minute (SIMILAR_WINDOW_MS) advisory granularity this grouping
 *  operates at, that slack is acceptable. */
function timeOf(s: SimilarInput): number | null {
  return s.capturedAtMs ?? (s.mtimeMs || null);
}

/** Does frame `b` extend a chain ending at frame `a`? (Adjacent-only test.)
 *  `embA`/`embB` are the ML-tier embeddings (from `scores`, when the smart
 *  pass has run with ML) — the ONE signal here that isn't part of the
 *  standing `SimilarInput`. */
function linked(
  a: SimilarInput,
  b: SimilarInput,
  embA: readonly number[] | null,
  embB: readonly number[] | null,
): boolean {
  const ta = timeOf(a);
  const tb = timeOf(b);
  if (ta == null || tb == null || Math.abs(tb - ta) > SIMILAR_WINDOW_MS) return false;
  if (a.phash != null && b.phash != null && phashDistance(a.phash, b.phash) <= PHASH_NEAR) {
    return true;
  }
  if (embA != null && embB != null) {
    return cosine(embA, embB) >= SIMILAR_COSINE;
  }
  return false;
}

/**
 * Time-local near-duplicate grouping (spec: docs/history/SMART_CULLING_PHASE3_DESIGN.md).
 * Pure derivation, mirrors groupBursts: adjacent frames chain when EITHER the
 * pHash tier (standing, always available once thumbnails have decoded) or the
 * embedding tier (ML builds, from `scores`) links them; frames without a
 * standing input yet and burst members are transparent walls; winner comes
 * from the SAME ladder as bursts (pickWinner) so the two cannot drift.
 *
 * Boxes render whether or not smart culling is enabled — `scores` here
 * contributes ONLY the embedding-tier upgrade (empty/absent when the pass
 * hasn't run), never the pHash tier.
 */
export function groupSimilar(
  images: readonly Img[],
  inputs: Readonly<Record<number, SimilarInput>>,
  scores: Readonly<Record<number, ImageScore>>,
  bursts: ReadonlyMap<number, BurstCtx>,
  sharp: Readonly<Record<number, SharpInput>>,
  eligible: Readonly<Record<number, boolean>>,
): Map<number, SimilarCtx> {
  const out = new Map<number, SimilarCtx>();
  let groupId = 0;

  /**
   * Walk state PER PARENT DIRECTORY (`dirOf(img.path)`) — the same shape, key,
   * and reason as groupBursts': a capture-time session order interleaves two
   * bodies frame by frame, and one shared `prev` made every switch break both
   * runs. Keying on `dirOf(img.path)` rather than `img.srcFolder` matters when
   * the owner stages one date folder holding BOTH cards' subfolders (a
   * recursive scan) — the two bodies would otherwise share one `srcFolder`
   * and interleave inside a single walk.
   */
  type Walk = { run: number[]; prev: { img: Img; input: SimilarInput } | null };
  const walks = new Map<string, Walk>();

  const flush = (w: Walk) => {
    if (w.run.length >= 2) {
      const { winnerIdx: wi, winnerAf } = pickWinner(w.run, sharp, eligible);
      w.run.forEach((id, i) => {
        out.set(id, {
          group: groupId,
          pos: i + 1,
          len: w.run.length,
          isWinner: i === wi,
          marginToWinner: wi >= 0 && i !== wi ? winnerAf - sharp[id].afSharpness : 0,
        });
      });
      groupId += 1;
    }
    w.run = [];
  };

  for (const img of images) {
    const dir = dirOf(img.path);
    let w = walks.get(dir);
    if (!w) {
      w = { run: [], prev: null };
      walks.set(dir, w);
    }
    const input = inputs[img.id];
    // Transparent walls: no standing input yet, and burst members, both split
    // — but ONLY their own directory's run.
    if (!input || bursts.has(img.id)) {
      flush(w);
      w.prev = null;
      continue;
    }
    const embCur = scores[img.id]?.embedding ?? null;
    if (
      w.prev &&
      // Invariant since the per-directory walk: prev and img always share a
      // parent directory, and hence a srcFolder. Kept so the condition stays
      // correct on its own terms — see the matching gate in groupBursts.ts's
      // extendsRun for the one edge case (flat, separator-less paths) where
      // it isn't purely redundant.
      w.prev.img.srcFolder === img.srcFolder &&
      linked(w.prev.input, input, scores[w.prev.img.id]?.embedding ?? null, embCur)
    ) {
      if (w.run.length === 0) w.run = [w.prev.img.id];
      w.run.push(img.id);
    } else {
      flush(w);
    }
    w.prev = { img, input };
  }
  // Map iteration is insertion order, so the trailing flushes are
  // deterministic: folders get their last group ids in first-seen order.
  for (const w of walks.values()) flush(w);
  return out;
}
