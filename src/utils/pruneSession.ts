import type { Img, NavEntry, UndoAction } from "../types";

/**
 * Pure helpers for taking frames OUT of a live session after "Move rejects"
 * (subfolder or Trash). The backend reports which sources are gone
 * (`FileOpResult.gone`); everything index-based follows the FRAME, not the
 * slot, so the user keeps their place and the undo history stays sound.
 *
 * `pruneGone` hands back a `remap` function rather than applying it itself —
 * the caller (`pruneMoved`) runs after an `await`, so any cursor/nav-stack
 * value captured in a closure may be stale by the time the result lands.
 * Applying `remap` through functional setState (`setX((prev) => remap(prev))`)
 * guarantees every cursor is remapped from its LIVE value, not a snapshot.
 */

export type PruneOutput = {
  images: Img[];
  goneIds: Set<number>;
  /** Old index → new index (same frame, else first survivor at/after, clamped). */
  remap: (index: number) => number;
};

/** The index in `after` of the frame at `index` in `before`; when that frame
 *  is gone, the first survivor at or after its old position (clamped to the
 *  last survivor); 0 when nothing survives or the index was out of range. */
export function remapIndex(before: readonly Img[], after: readonly Img[], index: number): number {
  if (after.length === 0) return 0;
  const target = before[index];
  if (!target) return 0;
  const same = after.findIndex((im) => im.id === target.id);
  if (same !== -1) return same;
  const survivors = new Set(after.map((im) => im.id));
  let ahead = 0;
  for (let i = 0; i < index; i++) if (survivors.has(before[i].id)) ahead++;
  return Math.min(ahead, after.length - 1);
}

/** Remove the frames whose files left the session. `null` when no listed
 *  path is in the set (nothing to do — a copy, or every reject was skipped). */
export function pruneGone(images: readonly Img[], gone: readonly string[]): PruneOutput | null {
  const gonePaths = new Set(gone);
  const goneIds = new Set(images.filter((im) => gonePaths.has(im.path)).map((im) => im.id));
  if (goneIds.size === 0) return null;
  const survivors = images.filter((im) => !goneIds.has(im.id));
  return { images: survivors, goneIds, remap: (i) => remapIndex(images, survivors, i) };
}

/** Compare entries follow their frames; loupe/grid entries are untouched (same object). */
export function remapNavStack(
  navStack: readonly NavEntry[],
  remap: (index: number) => number,
): NavEntry[] {
  return navStack.map((e) =>
    e.site === "compare" ? { ...e, champ: remap(e.champ), chall: remap(e.chall) } : e,
  );
}

/** A copy of `map` without the listed ids (rating map keyed by frame id). */
export function omitIds<T>(
  map: Readonly<Record<number, T>>,
  ids: ReadonlySet<number>,
): Record<number, T> {
  const out: Record<number, T> = {};
  for (const [k, v] of Object.entries(map)) {
    const id = Number(k);
    if (!ids.has(id)) out[id] = v;
  }
  return out;
}

/** Undo/redo entries after a prune: changes for gone frames are dropped (their
 *  files are not in the folder any more — replaying would ask the backend to
 *  write a sidecar it now refuses), actions left empty are dropped, and the
 *  compare-cursor snapshots are stripped because their indices are stale —
 *  undo/redo then land by frame id (`useUndoRedo`'s existing fallback).
 *  Returns the same array when nothing is affected. */
export function pruneHistory(
  stack: readonly UndoAction[],
  goneIds: ReadonlySet<number>,
): UndoAction[] {
  // No frame left the session: history is untouched, snapshots included.
  if (goneIds.size === 0) return stack as UndoAction[];
  const touched = stack.some(
    (a) => a.cursorBefore || a.cursorAfter || a.changes.some((c) => goneIds.has(c.imgId)),
  );
  if (!touched) return stack as UndoAction[];
  const out: UndoAction[] = [];
  for (const action of stack) {
    const changes = action.changes.filter((c) => !goneIds.has(c.imgId));
    if (changes.length > 0) out.push({ changes });
  }
  return out;
}
