import type { Rating } from "../types";

/**
 * Single source of truth for the rating-dot colours that read out across the
 * loupe, the thumb strip, the grid, the compare panels, and the home recap.
 * Mirrored in CSS only where the colour is fixed at author time (e.g. the
 * landing summary chips); state-driven dots pull from here.
 */
export const RATING_COLOR: Record<Rating, string> = {
  keep: "#10b981",
  reject: "#ef4444",
  favorite: "#f59e0b",
};

/**
 * True when the LrC star rating is a real pre-existing user rating, not just
 * CULL's own favorite stamp.
 *
 * CULL writes `xmp:Rating="1"` for its own favorite — so a lone 1★ on a frame
 * whose CULL rating is "favorite" is just CULL's mark, not a user rating that
 * should be surfaced. Everything else (2–5★, or 1★ on a non-fav frame) counts
 * as a user rating.
 */
export function hasLrcRating(
  lrcRating: number | null | undefined,
  cullRating: Rating | undefined,
): boolean {
  if (lrcRating == null || lrcRating < 1) return false;
  if (lrcRating === 1 && cullRating === "favorite") return false;
  return true;
}
