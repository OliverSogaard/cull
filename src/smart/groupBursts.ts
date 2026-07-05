import type { Img } from "../types/image";
import { pickWinner, EYES_OPEN_MIN } from "./pickWinner";

export { EYES_OPEN_MIN };

/**
 * Per-frame grouping inputs, SOURCE-AGNOSTIC: built from smart-culling scores
 * when the pass has run, else from the EXIF metadata every frame already
 * receives via its thumbnail — bursts are a standing fact about the shoot and
 * render whether or not smart culling is enabled (see `buildBurstInputs`).
 */
export type BurstInput = {
  srcFolder: string;
  driveMode: number | null;
  focalLengthMm: number | null;
  /** captured_at + SubSec combined to ms (deltas only). */
  capturedAtMs: number | null;
  /** SubSec present ⇒ capturedAtMs is ms-precise (the fine cadence source). */
  hasSubSec: boolean;
  /** Write time — only known via the scores path; null from metadata. */
  mtimeMs: number | null;
};

/** Winner-selection inputs — only available once the smart pass scored a frame. */
export type SharpInput = {
  afSharpness: number;
  globalSharpness: number;
  /** blownPct + crushedPct (winner tiebreak: lowest clipping). */
  clipSum: number;
  /** Primary (largest) face's sharpness, when Tier-2 detected faces — for
   *  people shots the sharpest FACE outranks the sharpest AF crop. */
  faceSharpness: number | null;
  /** Primary face's OCEC prob_open (Phase 3b) — null while unknown. */
  eyesOpen: number | null;
};

/** Burst membership + (when every member is scored) winner context. */
export type BurstCtx = {
  /** 0-based group id (session-local, stable per derivation pass). */
  group: number;
  /** 1-based position within the group (for "3 of 7"). */
  pos: number;
  len: number;
  /** Sharpest of the run — false everywhere while any member is unscored. */
  isWinner: boolean;
  /** winner.afSharpness − this frame's (0 for the winner / while unscored). */
  marginToWinner: number;
};

/** Frames closer than this in capture cadence extend the current burst. */
export const BURST_GAP_MS = 700;
/** mtime-fallback guard: capture times this far apart NEVER group. */
export const CAPTURED_COARSE_GUARD_MS = 2000;

/** Does `cur` extend the burst ending at `prev`? All gates must hold. */
function extendsRun(
  prev: { img: Img; input: BurstInput },
  cur: { img: Img; input: BurstInput },
): boolean {
  const [a, b] = [prev.input, cur.input];
  if (!(a.driveMode != null && a.driveMode > 0) || !(b.driveMode != null && b.driveMode > 0)) {
    return false;
  }
  if (prev.img.srcFolder !== cur.img.srcFolder) return false;
  if (a.focalLengthMm == null || b.focalLengthMm == null) return false;
  if (Math.abs(a.focalLengthMm - b.focalLengthMm) > 0.01) return false;

  // Cadence source: SubSec-precise capture clock when BOTH frames carry it —
  // immune to buffer-dump mtime stretch and copy-tool mtime flattening.
  const fine =
    a.capturedAtMs != null && b.capturedAtMs != null && a.hasSubSec && b.hasSubSec;
  if (fine) return Math.abs(b.capturedAtMs! - a.capturedAtMs!) < BURST_GAP_MS;

  // mtime fallback (scores path only), with the coarse capture-time guard:
  // frames captured seconds apart NEVER group, whatever a copy tool did.
  if (
    a.capturedAtMs != null &&
    b.capturedAtMs != null &&
    Math.abs(b.capturedAtMs - a.capturedAtMs) > CAPTURED_COARSE_GUARD_MS
  ) {
    return false;
  }
  if (a.mtimeMs == null || b.mtimeMs == null) return false; // no fine source at all
  return Math.abs(b.mtimeMs - a.mtimeMs) < BURST_GAP_MS;
}

/**
 * Pure derivation over the session's image order. Frames without usable
 * inputs are transparent walls: they split runs and get no ctx — groups (and,
 * once every member is scored, winners) self-correct as data lands.
 * Winner selection needs `sharp` for EVERY member of a run — a half-scored
 * burst has no winner yet rather than a premature one.
 */
export function groupBursts(
  images: readonly Img[],
  inputs: Readonly<Record<number, BurstInput>>,
  sharp?: Readonly<Record<number, SharpInput>>,
  /** Winner candidacy per id (smart culling's threshold gate): only eligible
   *  members may win; none eligible → the burst has NO winner. Omitted →
   *  every scored member is a candidate. */
  eligible?: Readonly<Record<number, boolean>>,
): Map<number, BurstCtx> {
  const out = new Map<number, BurstCtx>();
  let run: { id: number }[] = [];
  let groupId = 0;

  const flush = () => {
    if (run.length >= 2) {
      const ids = run.map((r) => r.id);
      const { winnerIdx: w, winnerAf } = pickWinner(ids, sharp, eligible);
      run.forEach((r, i) => {
        out.set(r.id, {
          group: groupId,
          pos: i + 1,
          len: run.length,
          isWinner: i === w,
          marginToWinner: w >= 0 && i !== w ? winnerAf - sharp![r.id]!.afSharpness : 0,
        });
      });
      groupId += 1;
    }
    run = [];
  };

  let prev: { img: Img; input: BurstInput } | null = null;
  for (const img of images) {
    const input = inputs[img.id];
    if (!input) {
      flush();
      prev = null;
      continue;
    }
    const cur = { img, input };
    if (prev && extendsRun(prev, cur)) {
      run.push({ id: img.id });
    } else {
      flush();
      run = [{ id: img.id }];
    }
    prev = cur;
  }
  flush();
  return out;
}
