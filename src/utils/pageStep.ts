/**
 * How far one PgUp / PgDn moves the cursor — a SCREENFUL, in the units the
 * surface under it uses. Pure and read fresh at keypress time (App measures
 * the live grid container / window), so nothing here is state and nothing
 * re-renders to keep it current.
 *
 * Deliberately NOT "the next burst": burst groups are advisory, absent on
 * most frames, and upgrade in place as smart scores land, so the same key
 * would move a different distance at t=0 and t=30s (spec §A).
 */

/**
 * Frames in one grid screenful: whole rows that fit in the scrollport, times
 * the column count. `viewportH` is `.cull-grid`'s `clientHeight` — the SAME
 * number GridView feeds `computeGridAutoScrollTop` (`GridView.tsx:232`), so
 * "a screenful" means the same thing to the key and to the auto-scroll that
 * follows it. Any unusable input (an unmeasured grid, a zero column count)
 * degrades to a single step rather than 0 (a dead key) or NaN (a clamp to the
 * end of the shoot).
 */
export function gridPageStep(viewportH: number, rowH: number, cols: number): number {
  if (!Number.isFinite(viewportH) || !(rowH > 0) || !(cols > 0)) return 1;
  return Math.max(1, Math.floor(viewportH / rowH)) * cols;
}

/**
 * Frames in one filmstrip screenful: whole cells that fit across it.
 * `stride` is the live `StripMetrics.stride` (80 at the small step, 108 at the
 * tall-window one), so the key moves a screenful at BOTH steps rather than a
 * number baked in at one of them.
 */
export function stripPageStep(stripW: number, stride: number): number {
  if (!Number.isFinite(stripW) || !(stride > 0)) return 1;
  return Math.max(1, Math.floor(stripW / stride));
}
