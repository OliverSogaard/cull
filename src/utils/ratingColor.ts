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
