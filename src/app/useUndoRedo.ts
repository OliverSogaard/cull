import { useCallback, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import type {
  Img,
  Label,
  LabelValue,
  MetaChange,
  NavEntry,
  Rating,
  Star,
  UndoAction,
} from "../types";
import { emptiedPaths, type MarkMaps } from "../utils/emptySidecar";
import { withMeta } from "../utils/withChanges";

/** The two halves of {@link MetaChange}, narrowed. `withMeta` is generic over
 *  ONE value type, so the union itself would not fit the `Record<number, Star>`
 *  call; a replay splits the list by field anyway. */
type StarChange = Extract<MetaChange, { field: "star" }>;
type LabelChange = Extract<MetaChange, { field: "label" }>;

/** The frame an undo/redo should land on: the crowned/kept frame of a
 *  compound verdict action (its LAST change), or — for a star or label
 *  action, whose `changes` list is empty — the last frame it marked. Module
 *  scope because it closes over nothing, so no `useCallback` below has to
 *  carry it as a dependency. Indexed by hand: `Array.prototype.at` is not in
 *  this project's ES2020 lib. */
function landingId(action: UndoAction): number | undefined {
  const lastChange = action.changes[action.changes.length - 1];
  if (lastChange) return lastChange.imgId;
  const meta = action.meta;
  const lastMeta = meta && meta.length > 0 ? meta[meta.length - 1] : undefined;
  return lastMeta?.imgId;
}

/** One action's marks with `before` and `after` swapped — what an undo
 *  replays, and the exact inverse of what a redo replays. Written out per
 *  field rather than spread-and-override so the discriminant stays a literal
 *  and no cast is needed. */
function invertMeta(meta: readonly MetaChange[]): MetaChange[] {
  return meta.map((m) =>
    m.field === "star"
      ? { imgId: m.imgId, path: m.path, field: "star", before: m.after, after: m.before }
      : { imgId: m.imgId, path: m.path, field: "label", before: m.after, after: m.before },
  );
}

/**
 * Undo / redo of rating actions, verbatim from App (grand cleanup Phase 6).
 * Each action is a list of per-image changes so compound actions (champion
 * wins/loses) revert atomically. Refs because the stacks themselves don't
 * drive any render — only the rating writes they replay do.
 *
 * An action carries verdicts (`changes`), the star / colour-label layer
 * (`meta`), or both. The live `stars` / `labels` maps are deliberately NOT
 * props here: a replay uses the `before` / `after` the action already recorded,
 * so a second undo can never read its own first result.
 */
export function useUndoRedo({
  images,
  compareMode,
  persistRating,
  persistStar,
  persistLabel,
  setRatings,
  setStars,
  setLabels,
  setCompareMode,
  setGridVisible,
  setChampionIndex,
  setChallengerIndex,
  setCurrentIndex,
  setNavStack,
  marksRef,
}: {
  images: Img[];
  compareMode: boolean;
  persistRating: (path: string, rating: Rating | null) => void;
  persistStar: (path: string, star: Star | null) => void;
  persistLabel: (path: string, label: Label | null) => void;
  setRatings: Dispatch<SetStateAction<Record<number, Rating>>>;
  setStars: Dispatch<SetStateAction<Record<number, Star>>>;
  setLabels: Dispatch<SetStateAction<Record<number, LabelValue>>>;
  setCompareMode: Dispatch<SetStateAction<boolean>>;
  setGridVisible: Dispatch<SetStateAction<boolean>>;
  setChampionIndex: Dispatch<SetStateAction<number>>;
  setChallengerIndex: Dispatch<SetStateAction<number>>;
  setCurrentIndex: Dispatch<SetStateAction<number>>;
  setNavStack: Dispatch<SetStateAction<NavEntry[]>>;
  /**
   * Live mirror of the three mark maps, for ONE read: after a replay clears a
   * mark, is the frame left with nothing at all? A ref, not props — the maps
   * change on every mark, and a changing prop here would re-create `undo` and
   * `redo`, which the keymap effect depends on. It is never a source of
   * replay VALUES: those come from the `before` / `after` the action recorded,
   * so a second undo can still never read its own first result.
   */
  marksRef: RefObject<MarkMaps>;
}) {
  const undoStack = useRef<UndoAction[]>([]);
  const redoStack = useRef<UndoAction[]>([]);
  const HISTORY_LIMIT = 100;

  const recordAction = useCallback((action: UndoAction) => {
    // An action carries verdicts, or marks, or both — never neither. The
    // star/label layer's actions have an EMPTY `changes` array by design, so
    // a bare `changes.length === 0` test would drop every one of them and
    // nothing would say so.
    if (action.changes.length === 0 && (action.meta?.length ?? 0) === 0) return;
    undoStack.current.push(action);
    if (undoStack.current.length > HISTORY_LIMIT) undoStack.current.shift();
    redoStack.current = []; // a new action invalidates the redo branch
  }, []);

  // Apply a list of {id → rating} changes to state + durable XMP in one shot.
  const applyChanges = useCallback(
    (changes: { imgId: number; path: string; rating: Rating | undefined }[]) => {
      setRatings((prev) => {
        const next = { ...prev };
        for (const c of changes) {
          if (c.rating === undefined) delete next[c.imgId];
          else next[c.imgId] = c.rating;
        }
        return next;
      });
      for (const c of changes) persistRating(c.path, c.rating ?? null);
    },
    [persistRating, setRatings],
  );

  /**
   * Replay a list of star / colour-label changes to state + durable XMP in
   * one shot — the orthogonal twin of {@link applyChanges}. `undefined`
   * deletes the key and clears the property on disk (`null` on the wire).
   *
   * `"custom"` is normalised to "no label" for BOTH the map and the wire.
   * It is the user's own Lightroom label string, which CULL only ever read as
   * "custom" and cannot reproduce; the backend refuses it outright, so sending
   * it would surface as a permanently unsaved write. Undoing a colour key
   * pressed over one therefore removes CULL's label rather than inventing a
   * string — and the map follows the same value, so memory and disk cannot
   * disagree about the frame.
   */
  const applyMeta = useCallback(
    (meta: readonly MetaChange[], ratedIds?: ReadonlySet<number>) => {
      const labelValue = (m: LabelChange): LabelValue | undefined =>
        m.after === "custom" ? undefined : m.after;
      const starChanges = meta.filter((m): m is StarChange => m.field === "star");
      const labelChanges = meta
        .filter((m): m is LabelChange => m.field === "label")
        .map((m) => ({ ...m, after: labelValue(m) }));
      if (starChanges.length > 0) setStars((prev) => withMeta(prev, starChanges));
      if (labelChanges.length > 0) setLabels((prev) => withMeta(prev, labelChanges));
      for (const m of starChanges) persistStar(m.path, m.after ?? null);
      for (const m of labelChanges) {
        // `after` is never "custom" here (normalised above), so the narrowing
        // the wire needs is sound.
        persistLabel(m.path, m.after === undefined ? null : (m.after as Label));
      }
      // Undoing a star or label SET can leave a CULL-created sidecar holding
      // nothing at all, and only `clear_xmp_rating` may delete such a file.
      // Send it on the same per-path queue, AFTER the clears — the same sweep
      // `useDecideCallbacks` does for a keypress, so an undo litters no more
      // than the press it reverses.
      //
      // `ratedIds` is whichever frames the SAME action also changed a verdict
      // on: `applyChanges` has just written their rating from the action's own
      // record, and `marksRef` still holds the pre-replay state — so sweeping
      // them would both duplicate a clear and, for an action that restores a
      // verdict, wipe it a line after it was written.
      const swept = emptiedPaths([...starChanges, ...labelChanges], marksRef.current);
      for (const path of swept) {
        const id = meta.find((m) => m.path === path)?.imgId;
        if (id !== undefined && ratedIds?.has(id)) continue;
        persistRating(path, null);
      }
    },
    [persistStar, persistLabel, persistRating, setStars, setLabels, marksRef],
  );

  const undo = useCallback(() => {
    const action = undoStack.current.pop();
    if (!action) return;
    applyChanges(action.changes.map((c) => ({ imgId: c.imgId, path: c.path, rating: c.before })));
    if (action.meta)
      applyMeta(invertMeta(action.meta), new Set(action.changes.map((c) => c.imgId)));
    // Restore the compare cursor for compound actions so Ctrl+Z lands you in the
    // SAME pair you were judging (champion/challenger), not stranded somewhere else.
    if (action.cursorBefore) {
      setCompareMode(action.cursorBefore.compareMode);
      // Sites are mutually exclusive — when undo restores compare-mode, peel
      // grid so we don't end up rendering compare with grid lingering behind.
      if (action.cursorBefore.compareMode) setGridVisible(false);
      setChampionIndex(action.cursorBefore.championIndex);
      setChallengerIndex(action.cursorBefore.challengerIndex);
      setCurrentIndex(action.cursorBefore.currentIndex);
      // Restore the nav back-stack snapshot too, so a later compare auto-exit
      // (goBack) pops the entry the user actually came from (the action's
      // auto-exit may have popped it, leaving the live stack out of sync with
      // the restored compare view).
      if (action.cursorBefore.navStack) setNavStack(action.cursorBefore.navStack);
    } else if (!compareMode) {
      // For a compound (compare) action, changes[0] is the OLD champion that got
      // rejected; the frame the user actually cares about is the crowned/kept
      // one — the LAST change. (Identical to changes[0] for single-change actions.)
      const landId = landingId(action);
      if (landId !== undefined) {
        const idx = images.findIndex((im) => im.id === landId);
        if (idx !== -1) setCurrentIndex(idx);
      }
    }
    redoStack.current.push(action);
  }, [
    applyChanges,
    applyMeta,
    compareMode,
    images,
    setCompareMode,
    setGridVisible,
    setChampionIndex,
    setChallengerIndex,
    setCurrentIndex,
    setNavStack,
  ]);

  const redo = useCallback(() => {
    const action = redoStack.current.pop();
    if (!action) return;
    applyChanges(action.changes.map((c) => ({ imgId: c.imgId, path: c.path, rating: c.after })));
    if (action.meta) applyMeta(action.meta, new Set(action.changes.map((c) => c.imgId)));
    // Compound compare actions snapshot where the crown LANDS (cursorAfter) so a
    // redo re-crowns the NEW champion instead of leaving the old (now-rejected)
    // one in the compare pane. Single-frame rates have no cursorAfter: land on the
    // crowned/kept frame (last change) in the loupe, as before.
    if (action.cursorAfter) {
      setCompareMode(action.cursorAfter.compareMode);
      if (action.cursorAfter.compareMode) setGridVisible(false);
      setChampionIndex(action.cursorAfter.championIndex);
      setChallengerIndex(action.cursorAfter.challengerIndex);
      setCurrentIndex(action.cursorAfter.currentIndex);
    } else if (!compareMode) {
      const landId = landingId(action);
      if (landId !== undefined) {
        const idx = images.findIndex((im) => im.id === landId);
        if (idx !== -1) setCurrentIndex(idx);
      }
    }
    undoStack.current.push(action);
  }, [
    applyChanges,
    applyMeta,
    compareMode,
    images,
    setCompareMode,
    setGridVisible,
    setChampionIndex,
    setChallengerIndex,
    setCurrentIndex,
  ]);

  return { undoStack, redoStack, recordAction, undo, redo };
}
