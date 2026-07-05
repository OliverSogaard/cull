/**
 * Work-list selection for the smart-culling pass. The pass starts from where
 * the user has reached: frames they already rated need no suggestion, so the
 * initial dispatch is unrated-only — on a half-culled folder suggestions
 * arrive in the frames that still matter instead of after thousands of
 * already-decided reads. Frames unrated LATER are picked up by a small
 * catch-up pass (missingTargets); frames that were scored before being rated
 * keep their score, so re-unrating them costs nothing.
 */

/** The initial dispatch: every frame the user hasn't rated, in capture order. */
export function unratedTargets<T extends { id: number }>(
  images: readonly T[],
  rated: ReadonlySet<number>,
): T[] {
  return images.filter((im) => !rated.has(im.id));
}

/**
 * Catch-up dispatch: unrated frames with no score that haven't been attempted
 * yet. `attempted` keeps a frame whose analysis failed from re-dispatching on
 * every ratings change — one shot per frame per staged set.
 */
export function missingTargets<T extends { id: number }>(
  images: readonly T[],
  rated: ReadonlySet<number>,
  hasScore: (id: number) => boolean,
  attempted: ReadonlySet<number>,
): T[] {
  return images.filter(
    (im) => !rated.has(im.id) && !hasScore(im.id) && !attempted.has(im.id),
  );
}
