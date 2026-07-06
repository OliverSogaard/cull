import type { Filter, Rating } from "../types";

/**
 * Membership test for the status-bar filter.
 *
 * `keeps` deliberately includes favorites — a ★ frame is by definition also a
 * keep, so the keeps filter shows both. `keepsFavs` is the strict subset.
 */
export function passesFilter(rating: Rating | undefined, filter: Filter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "unrated":
      return !rating;
    case "keeps":
      return rating === "keep" || rating === "favorite";
    case "keepsFavs":
      return rating === "favorite";
    case "suggested":
    case "suggestedRejects":
    case "suggestedKeeps":
    case "suggestedFavs":
      // App.tsx resolves every "suggested*" value against the live
      // suggestions map BEFORE this runs; the pure fallback mirrors
      // "unrated" (suggestions only ever exist on unrated frames) so a stray
      // call stays safe.
      return !rating;
  }
}
