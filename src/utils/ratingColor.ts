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
 * True when the LrC star rating is a real pre-existing user rating.
 *
 * Star ownership is decided at the read boundary: Rust's `parse_lrc_rating`
 * never reports CULL's own `cull:fav="star"` stamp, so any star that reaches
 * the frontend is the user's — including a genuine 1★ on a flag-mode favorite.
 * (The old frontend rule keyed on the CURRENT rating, which flips on demote
 * while the loaded star doesn't: that was the phantom "LrC 1★" after unrating
 * a favorite.)
 */
export function hasLrcRating(lrcRating: number | null | undefined): boolean {
  if (lrcRating == null || lrcRating < 1) return false;
  return true;
}
