import type { Filter, Rating } from "../types";

/**
 * Membership test for the status-bar filter.
 *
 * `keeps` deliberately includes favorites — a ★ frame is by definition also a
 * keep, so the keeps filter shows both. `favorites` is the strict subset.
 */
export function passesFilter(rating: Rating | undefined, filter: Filter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "unrated":
      return !rating;
    case "keeps":
      return rating === "keep" || rating === "favorite";
    case "favorites":
      return rating === "favorite";
  }
}
