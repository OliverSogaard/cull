import type { LabelValue, MetaChange, Rating, Star } from "../types";

/**
 * The three per-frame maps a sidecar's emptiness is decided from. Read-only:
 * this module answers a question about them and changes nothing.
 */
export type MarkMaps = {
  ratings: Readonly<Record<number, Rating>>;
  stars: Readonly<Record<number, Star>>;
  labels: Readonly<Record<number, LabelValue>>;
};

/**
 * The paths whose sidecar `meta` leaves holding NOTHING — no verdict, no
 * star, no colour label — once it is applied to `maps`.
 *
 * Why the caller needs this: the backend deletes a CULL-created, contentless
 * sidecar only inside `clear_xmp_rating`, and the unrate key returns early for
 * a frame that is already unrated — so `3` then `0` on an unrated frame wrote
 * a sidecar and then emptied it, and the empty file stayed in the folder
 * forever. The caller follows the clear with `persistRating(path, null)` on
 * the SAME per-path queue; the backend still refuses to delete anything it did
 * not create or that holds user content.
 *
 * A `"custom"` label counts as content — it is the user's own Lightroom label,
 * the one thing here most worth not deleting. Each path appears at most once,
 * so a multi-select asks for one unrate per frame.
 */
export function emptiedPaths(meta: readonly MetaChange[], maps: MarkMaps): string[] {
  // What each touched field will hold once `meta` is applied. `has` rather
  // than a truthiness test, because `undefined` is the meaningful value.
  const starAfter = new Map<number, Star | undefined>();
  const labelAfter = new Map<number, LabelValue | undefined>();
  for (const m of meta) {
    if (m.field === "star") starAfter.set(m.imgId, m.after);
    else labelAfter.set(m.imgId, m.after);
  }

  const out: string[] = [];
  const seen = new Set<number>();
  for (const m of meta) {
    if (seen.has(m.imgId)) continue;
    seen.add(m.imgId);
    if (maps.ratings[m.imgId] !== undefined) continue;
    const star = starAfter.has(m.imgId) ? starAfter.get(m.imgId) : maps.stars[m.imgId];
    if (star !== undefined) continue;
    const label = labelAfter.has(m.imgId) ? labelAfter.get(m.imgId) : maps.labels[m.imgId];
    if (label !== undefined) continue;
    out.push(m.path);
  }
  return out;
}
