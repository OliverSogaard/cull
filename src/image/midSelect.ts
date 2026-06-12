/**
 * midSelect.ts — display-adaptive tier choice (pipeline Phase 8).
 *
 * The mid tier exists for high-DPI stages where the 1620×1080 preview
 * upscales past visible softness. The store decides per request with
 * `needPx = stage rect HEIGHT (CSS px) × devicePixelRatio`, computed FRESH
 * each time (never cached at mount) and re-evaluated on stage resizes and
 * DPR flips (window dragged 4K ↔ 1440p).
 *
 * WHY HEIGHT (a deliberate deviation from the plan line's `width`): the
 * loupe's fit is height-bound on 16:9-class displays showing 3:2 frames, so
 * the stage height tracks what the preview is actually stretched to — the
 * preview's 1080-px height upscaled ~1.6× ⇒ needPx ≈ 1700, the plan's own
 * threshold. The plan's width formula cannot satisfy its own verify line:
 * a 1440p stage is ~2540 CSS px wide × DPR 1 (over ANY threshold that still
 * engages on 4K-at-150%, whose stage is the SAME ~2540 CSS px × 1.5), while
 * heights separate cleanly: ~1240 device px on 1440p vs ~1860 on 4K.
 *
 * ~100 px hysteresis around the 1700 threshold so resize jitter at the
 * boundary can't flap the tier choice: engage above 1750, release below
 * 1650, hold in between.
 */

/** needPx above this engages the mid tier. */
export const MID_ENGAGE_PX = 1750;
/** needPx below this releases it (the ~100 px hysteresis band's floor). */
export const MID_RELEASE_PX = 1650;

/**
 * Next hysteresis state. `needPx === null` (stage unmounted / unmeasurable)
 * keeps the previous choice — a transient layout gap must not flap tiers.
 */
export function nextMidEngaged(prev: boolean, needPx: number | null): boolean {
  if (needPx === null || !Number.isFinite(needPx)) return prev;
  if (needPx > MID_ENGAGE_PX) return true;
  if (needPx < MID_RELEASE_PX) return false;
  return prev;
}
