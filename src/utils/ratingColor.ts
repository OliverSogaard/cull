import type { Rating } from "../types";

/**
 * Single source of truth for the rating-dot colours that read out across the
 * loupe, the thumb strip, the grid, the compare panels, and the home recap.
 * Points at the CSS tokens so the compare dot and the feedback pop can never
 * drift from the strip/grid dots again (they used to be Tailwind hexes).
 */
export const RATING_COLOR: Record<Rating, string> = {
  keep: "var(--ok)",
  reject: "var(--bad)",
  favorite: "var(--fav)",
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
