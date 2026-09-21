import type { Rating } from "../types/rating";

/** The fields of an undo `changes` entry this helper needs. The real entries
 *  (see `UndoAction`) also carry `path` and `before`, which only the persist
 *  and revert paths read — a structural subset keeps the helper usable by
 *  both the two-field compare builders and the four-field grid ones. */
export type RatingChange = { imgId: number; after: Rating | undefined };

/**
 * The ratings map AFTER a set of changes — one derivation, used everywhere a
 * decide needs the post-change map.
 *
 * The duplication this removes was real and asymmetric: each compare builder
 * derived `next` by hand to ask `nearestUnrated` what was left, THEN handed
 * `resolveCompareDecide` a `changes` array describing the same edits, which
 * derived the map a third time. Three expressions of one rule, thirty lines
 * apart.
 *
 * `after: undefined` DELETES the key rather than storing `undefined` — an
 * unrated frame must not remain a key, or `Object.keys(ratings).length` and
 * every `id in ratings` check would still count it.
 *
 * Deliberately NOT shared with the decide tests: they hand-build their
 * expected maps as literals, so a bug in here cannot pass on both sides.
 */
export function withChanges(
  ratings: Readonly<Record<number, Rating>>,
  changes: readonly RatingChange[],
): Record<number, Rating> {
  const next: Record<number, Rating> = { ...ratings };
  for (const c of changes) {
    if (c.after === undefined) delete next[c.imgId];
    else next[c.imgId] = c.after;
  }
  return next;
}
