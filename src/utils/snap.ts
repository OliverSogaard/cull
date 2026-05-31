/**
 * Snap an image index to the nearest member of a filtered list. Used when
 * leaving compare onto a frame the current filter may not admit (e.g. a
 * freshly-kept image while the filter is UNRATED) — without this, grid/loupe
 * could land with no current cell visible.
 *
 * Returns the input unchanged if it's already in the filter, the list is
 * empty, or the index is out of bounds.
 *
 * @param idx              Candidate landing image-index.
 * @param visibleIndices   Active filter (image-indices), assumed sorted.
 * @param imagesLength     Total image count (bounds check).
 */
export function snapToFilter(
  idx: number,
  visibleIndices: number[],
  imagesLength: number,
): number {
  if (idx < 0 || idx >= imagesLength) return idx;
  if (visibleIndices.length === 0) return idx;
  if (visibleIndices.indexOf(idx) !== -1) return idx;
  let best = visibleIndices[0];
  let bestDist = Math.abs(best - idx);
  for (const v of visibleIndices) {
    const d = Math.abs(v - idx);
    if (d < bestDist) {
      bestDist = d;
      best = v;
    }
  }
  return best;
}
