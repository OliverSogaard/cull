import type { ImageScore } from "../types/ipc";
import type { Img } from "../types/image";

/** Burst membership + winner context for one frame, derived in TS. */
export type BurstCtx = {
  /** 0-based group id (session-local, stable per derivation pass). */
  group: number;
  /** 1-based position within the group (for "3 of 7"). */
  pos: number;
  len: number;
  isWinner: boolean;
  /** winner.afSharpness − this frame's (0 for the winner) — verdict confidence input. */
  marginToWinner: number;
};

/** Frames closer than this in capture cadence extend the current burst. */
export const BURST_GAP_MS = 700;
/** mtime-fallback guard: capture times this far apart NEVER group. */
export const CAPTURED_COARSE_GUARD_MS = 2000;

/** Strict "a beats b" for winner selection (ties fall through → earliest wins). */
function beats(a: ImageScore, b: ImageScore): boolean {
  if (a.afSharpness !== b.afSharpness) return a.afSharpness > b.afSharpness;
  if (a.globalSharpness !== b.globalSharpness) return a.globalSharpness > b.globalSharpness;
  const ac = a.blownPct + a.crushedPct;
  const bc = b.blownPct + b.crushedPct;
  return ac < bc;
}

type RunEntry = { id: number; s: ImageScore };

/** Does `cur` extend the burst ending at `prev`? All gates must hold. */
function extendsRun(prev: { img: Img; s: ImageScore }, cur: { img: Img; s: ImageScore }): boolean {
  const [a, b] = [prev.s, cur.s];
  if (!(a.driveMode != null && a.driveMode > 0) || !(b.driveMode != null && b.driveMode > 0)) {
    return false;
  }
  if (prev.img.srcFolder !== cur.img.srcFolder) return false;
  if (a.focalLengthMm == null || b.focalLengthMm == null) return false;
  if (Math.abs(a.focalLengthMm - b.focalLengthMm) > 0.01) return false;

  // Cadence source: SubSec-precise capture clock when BOTH frames carry it —
  // immune to buffer-dump mtime stretch and copy-tool mtime flattening.
  const fine =
    a.capturedAtMs != null && b.capturedAtMs != null && a.subSecMs != null && b.subSecMs != null;
  if (fine) return Math.abs(b.capturedAtMs! - a.capturedAtMs!) < BURST_GAP_MS;

  // mtime fallback, with the coarse capture-time guard: frames captured
  // seconds apart NEVER group, no matter what a copy tool did to mtimes.
  if (
    a.capturedAtMs != null &&
    b.capturedAtMs != null &&
    Math.abs(b.capturedAtMs - a.capturedAtMs) > CAPTURED_COARSE_GUARD_MS
  ) {
    return false;
  }
  return Math.abs(b.mtimeMs - a.mtimeMs) < BURST_GAP_MS;
}

/**
 * Pure derivation over the accumulated scores map + the session's image order.
 * Frames without a usable score are transparent walls: they split runs and get
 * no ctx — groups and winners self-correct as later chunks land (this re-runs
 * in the same useMemo as the verdicts).
 */
export function groupBursts(
  images: readonly Img[],
  scores: Readonly<Record<number, ImageScore>>,
): Map<number, BurstCtx> {
  const out = new Map<number, BurstCtx>();
  let run: RunEntry[] = [];
  let groupId = 0;

  const flush = () => {
    if (run.length >= 2) {
      let w = 0;
      for (let i = 1; i < run.length; i++) {
        if (beats(run[i].s, run[w].s)) w = i;
      }
      const winnerSharp = run[w].s.afSharpness;
      run.forEach((r, i) => {
        out.set(r.id, {
          group: groupId,
          pos: i + 1,
          len: run.length,
          isWinner: i === w,
          marginToWinner: i === w ? 0 : winnerSharp - r.s.afSharpness,
        });
      });
      groupId += 1;
    }
    run = [];
  };

  let prev: { img: Img; s: ImageScore } | null = null;
  for (const img of images) {
    const s = scores[img.id];
    if (!s || !s.decodeOk) {
      flush();
      prev = null;
      continue;
    }
    const cur = { img, s };
    if (prev && extendsRun(prev, cur)) {
      run.push({ id: img.id, s });
    } else {
      flush();
      run = [{ id: img.id, s }];
    }
    prev = cur;
  }
  flush();
  return out;
}
