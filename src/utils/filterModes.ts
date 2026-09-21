import type { Filter } from "../types/rating";

/**
 * The five footer tabs. Every {@link Filter} value belongs to exactly one via
 * {@link topOf} — "keeps"/"keepsFavs" both belong to `"keeps"`,
 * "suggested"/"suggestedRejects"/"suggestedKeeps"/"suggestedFavs" all belong
 * to `"suggested"`. `"all"`, `"unrated"` and `"rejects"` have no sub-modes, so
 * they ARE their own top.
 */
export type TopFilter = "all" | "unrated" | "keeps" | "suggested" | "rejects";

/**
 * The digit that selects each tab on the BARE row — the keymap's own order
 * (`useCullKeymap`'s `SHIFT_DIGIT` table), so a hint can never name a key the
 * keymap does not bind.
 */
export const FILTER_DIGIT: Record<TopFilter, string> = {
  all: "1",
  unrated: "2",
  keeps: "3",
  suggested: "4",
  rejects: "5",
};

/**
 * How a hint spells the key for `top`. With the stars-and-labels layer on the
 * bare digits are stars, so the five filters move to Shift+digit — one
 * function so the footer tips, the empty-filter hints, Settings and the help
 * sheet can never disagree about which row the filters are on.
 */
export function filterKeyHint(top: TopFilter, starsAndLabels?: boolean): string {
  return starsAndLabels ? `Shift+${FILTER_DIGIT[top]}` : FILTER_DIGIT[top];
}

/** Ordered sub-mode cycle for each top, base mode first. */
const CYCLES: Record<TopFilter, Filter[]> = {
  all: ["all"],
  unrated: ["unrated"],
  keeps: ["keeps", "keepsFavs"],
  suggested: ["suggested", "suggestedRejects", "suggestedKeeps", "suggestedFavs"],
  rejects: ["rejects"],
};

/** Which top-level tab a (possibly sub-mode) filter value belongs to. */
export function topOf(filter: Filter): TopFilter {
  switch (filter) {
    case "keepsFavs":
      return "keeps";
    case "suggestedRejects":
    case "suggestedKeeps":
    case "suggestedFavs":
      return "suggested";
    default:
      return filter;
  }
}

/**
 * Resolve the next filter value for a press of `top`'s key/tab, given the
 * `current` filter.
 *
 * - Pressing an inactive top activates its base mode.
 * - Re-pressing the already-active top cycles forward through its sub-modes
 *   (base → subs → wraps back to base). Tops with no sub-modes are a no-op.
 */
export function cycleFilter(current: Filter, top: TopFilter): Filter {
  const cycle = CYCLES[top];
  if (topOf(current) !== top) return cycle[0];
  const idx = cycle.indexOf(current);
  const nextIdx = idx === -1 ? 0 : (idx + 1) % cycle.length;
  return cycle[nextIdx];
}
