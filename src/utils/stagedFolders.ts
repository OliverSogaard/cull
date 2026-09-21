import type { Img } from "../types/image";
import { CAPTURE_OFFSET_LIMIT_MS } from "../types/settings";
import { basename } from "./path";

/**
 * What the staged screen's per-folder rows are built from, and the arithmetic
 * behind their capture-time hint and their ± stepper. Pure — the component
 * only fetches and renders.
 */

/** One staged source folder, in first-staged order. */
export type StagedFolder = {
  /** Absolute `Img.srcFolder` — the `captureOffsets` key. */
  path: string;
  /** Basename, the row's label. */
  name: string;
  count: number;
  /**
   * The folder's FIRST staged frame — the row's capture-time probe. Within a
   * folder the staged order is the backend walk's `paths.sort()` (scan.rs), so
   * this is its lexicographically first CR3.
   */
  firstPath: string;
};

/** Group the staged set by source folder, in the order the folders were
 *  staged. One pass, no sorting: the order IS the append order. */
export function groupStagedFolders(images: readonly Img[]): StagedFolder[] {
  const byPath = new Map<string, StagedFolder>();
  for (const im of images) {
    const seen = byPath.get(im.srcFolder);
    if (seen) seen.count += 1;
    else
      byPath.set(im.srcFolder, {
        path: im.srcFolder,
        name: basename(im.srcFolder),
        count: 1,
        firstPath: im.path,
      });
  }
  return [...byPath.values()];
}

/**
 * A capture time as the CAMERA's wall clock, "14:02:11".
 *
 * UTC in, UTC out, deliberately: the backend's `captured_at_ms` parses the
 * timezone-less EXIF string as UTC (`analyze.rs`), so the epoch it hands back
 * IS the camera's local clock wearing a UTC label. Any local-time formatter
 * here would shift every row by this machine's offset.
 */
export function formatCaptureClock(ms: number): string {
  return new Date(ms).toISOString().slice(11, 19);
}

/**
 * A signed clock difference, as the offset stepper and the delta hint print
 * it: `+0 s`, `−1 min 12 s`, `+1 h 5 min 12 s`. Always signed (an unsigned 0
 * would read as "unset" rather than "no correction"), rounded to whole
 * seconds (sub-second skew between two bodies is noise), and the minus is
 * U+2212 MINUS SIGN, not a hyphen — it has to line up under a plus.
 */
export function formatSignedDuration(ms: number): string {
  const total = Math.round(Math.abs(ms) / 1000);
  const sign = ms < 0 && total > 0 ? "−" : "+";
  const h = Math.floor(total / 3600);
  const min = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h} h`);
  if (min > 0) parts.push(`${min} min`);
  if (s > 0 || parts.length === 0) parts.push(`${s} s`);
  return `${sign}${parts.join(" ")}`;
}

/** One click of the stepper: ±1 s. */
export const OFFSET_STEP_MS = 1000;
/** Shift-click: ±1 min. */
export const OFFSET_STEP_SHIFT_MS = 60_000;

/** One stepper click. Ctrl/Cmd resets to 0 and wins over everything else, so
 *  one click has exactly one meaning; every other result is clamped to
 *  ±CAPTURE_OFFSET_LIMIT_MS, the same bound the settings validator applies. */
export function stepOffset(
  current: number,
  dir: 1 | -1,
  mods: { shift: boolean; reset: boolean },
): number {
  if (mods.reset) return 0;
  const next = current + dir * (mods.shift ? OFFSET_STEP_SHIFT_MS : OFFSET_STEP_MS);
  return Math.max(-CAPTURE_OFFSET_LIMIT_MS, Math.min(CAPTURE_OFFSET_LIMIT_MS, next));
}
