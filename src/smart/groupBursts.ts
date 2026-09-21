import type { Img } from "../types/image";
import { pickWinner } from "./pickWinner";

/**
 * The file's own parent directory, split on both `\` and `/` (Tauri paths use
 * `\` on Windows, `/` on POSIX — mirrors `basename` in `utils/path.ts`, but
 * lives here so both groupers can share it without a cross-file dependency
 * outside this task's scope). This, not `Img.srcFolder`, is what the per-run
 * walks below key on: `srcFolder` is the folder the OWNER staged, which can
 * be one date folder holding BOTH camera cards' subfolders when the scan is
 * recursive — two bodies would then share one `srcFolder` and interleave
 * inside a single walk. A path with no separator has no parent, so it keys
 * on "" (every such frame collapses into one bucket, same as before).
 */
export function dirOf(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx === -1 ? "" : path.slice(0, idx);
}

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
const BURST_GAP_MS = 700;
/** mtime-fallback guard: capture times this far apart NEVER group. */
const CAPTURED_COARSE_GUARD_MS = 2000;

/** Does `cur` extend the burst ending at `prev`? All gates must hold. */
function extendsRun(
  prev: { img: Img; input: BurstInput },
  cur: { img: Img; input: BurstInput },
): boolean {
  const [a, b] = [prev.input, cur.input];
  if (!(a.driveMode != null && a.driveMode > 0) || !(b.driveMode != null && b.driveMode > 0)) {
    return false;
  }
  // Invariant since the per-directory walk below: prev and cur always share a
  // parent directory, and hence a srcFolder (a directory's every file shares
  // its ancestors). Kept as a gate so the function stays correct on its own
  // terms, and as a safety net for the one case the directory key can't
  // distinguish — two flat imports (no subfolder) whose files sit directly in
  // DIFFERENT srcFolders both key on "" (dirOf of a separator-less path).
  if (prev.img.srcFolder !== cur.img.srcFolder) return false;
  if (a.focalLengthMm == null || b.focalLengthMm == null) return false;
  if (Math.abs(a.focalLengthMm - b.focalLengthMm) > 0.01) return false;

  // Cadence source: SubSec-precise capture clock when BOTH frames carry it —
  // immune to buffer-dump mtime stretch and copy-tool mtime flattening.
  const fine = a.capturedAtMs != null && b.capturedAtMs != null && a.hasSubSec && b.hasSubSec;
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
  let groupId = 0;

  /**
   * Walk state PER PARENT DIRECTORY (`dirOf(img.path)`, not `img.srcFolder` —
   * see `dirOf`'s doc). The session order is capture time, so two bodies
   * shooting the same moment interleave frame by frame — with one shared
   * `prev` every switch broke both runs and two simultaneous bursts collapsed
   * into singletons. A run now continues across foreign-directory frames; the
   * gates (including `extendsRun`'s srcFolder one, which can no longer fire —
   * two frames sharing a directory always share their ancestor srcFolder too)
   * are unchanged, and group ids stay session-global.
   */
  type Walk = { run: { id: number }[]; prev: { img: Img; input: BurstInput } | null };
  const walks = new Map<string, Walk>();

  const flush = (w: Walk) => {
    if (w.run.length >= 2) {
      const ids = w.run.map((r) => r.id);
      const { winnerIdx: wi, winnerAf } = pickWinner(ids, sharp, eligible);
      w.run.forEach((r, i) => {
        out.set(r.id, {
          group: groupId,
          pos: i + 1,
          len: w.run.length,
          isWinner: i === wi,
          marginToWinner: wi >= 0 && i !== wi ? winnerAf - sharp![r.id].afSharpness : 0,
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
    if (!input) {
      // A frame without usable inputs is a transparent wall for ITS OWN
      // directory only — the other body's run is none of its business.
      flush(w);
      w.prev = null;
      continue;
    }
    const cur = { img, input };
    if (w.prev && extendsRun(w.prev, cur)) {
      w.run.push({ id: img.id });
    } else {
      flush(w);
      w.run = [{ id: img.id }];
    }
    w.prev = cur;
  }
  // Map iteration is insertion order, so the trailing flushes are
  // deterministic: folders get their last group ids in first-seen order.
  for (const w of walks.values()) flush(w);
  return out;
}
