/**
 * Staged held-key scrub acceleration, shared by every hold-to-navigate flow:
 * the loupe/compare horizontal arrow-hold AND the grid's vertical arrow-hold.
 * 1× for the first SCRUB_STAGE2_AT_MS of a hold, 3× until SCRUB_STAGE3_AT_MS,
 * then 10× — long albums/sets stay traversable without the accel feeling
 * abrupt.
 *
 * HARD-WON LESSON: a hold's repeat tick must call its nav function ONCE with
 * step = speed. Calling it `speed` times in a row re-reads the same
 * render-frozen position each time and moves a single frame/row total, not
 * `speed` of them (the "50× hold that only scrubbed at 1×" bug). See
 * app/useHeldRepeat.ts for the one-call usage.
 */
export const SCRUB_STAGE2_AT_MS = 2000;
export const SCRUB_STAGE3_AT_MS = 5000;
export type ScrubSpeed = 1 | 3 | 10;

/** Pure stage lookup: how many frames/rows per repeat tick after holding for `heldMs`. */
export function scrubSpeedForHeldMs(heldMs: number): ScrubSpeed {
  if (heldMs >= SCRUB_STAGE3_AT_MS) return 10;
  if (heldMs >= SCRUB_STAGE2_AT_MS) return 3;
  return 1;
}
