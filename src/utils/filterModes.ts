import type { Filter } from "../types/rating";

/**
 * The four footer tabs. Every {@link Filter} value belongs to exactly one via
 * {@link topOf} — "keeps"/"keepsFavs" both belong to `"keeps"`,
 * "suggested"/"suggestedRejects"/"suggestedKeeps"/"suggestedFavs" all belong
 * to `"suggested"`. `"all"` and `"unrated"` have no sub-modes, so they ARE
 * their own top.
 */
export type TopFilter = "all" | "unrated" | "keeps" | "suggested";

/** Ordered sub-mode cycle for each top, base mode first. */
const CYCLES: Record<TopFilter, Filter[]> = {
  all: ["all"],
  unrated: ["unrated"],
  keeps: ["keeps", "keepsFavs"],
  suggested: ["suggested", "suggestedRejects", "suggestedKeeps", "suggestedFavs"],
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
