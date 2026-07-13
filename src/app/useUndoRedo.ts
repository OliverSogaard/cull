import { useCallback, useRef, type Dispatch, type SetStateAction } from "react";
import type { Img, NavEntry, Rating, UndoAction } from "../types";

/**
 * Undo / redo of rating actions, verbatim from App (grand cleanup Phase 6).
 * Each action is a list of per-image changes so compound actions (champion
 * wins/loses) revert atomically. Refs because the stacks themselves don't
 * drive any render — only the rating writes they replay do.
 */
export function useUndoRedo({
  images,
  compareMode,
  persistRating,
  setRatings,
  setCompareMode,
  setGridVisible,
  setChampionIndex,
  setChallengerIndex,
  setCurrentIndex,
  setNavStack,
}: {
  images: Img[];
  compareMode: boolean;
  persistRating: (path: string, rating: Rating | null) => void;
  setRatings: Dispatch<SetStateAction<Record<number, Rating>>>;
  setCompareMode: Dispatch<SetStateAction<boolean>>;
  setGridVisible: Dispatch<SetStateAction<boolean>>;
  setChampionIndex: Dispatch<SetStateAction<number>>;
  setChallengerIndex: Dispatch<SetStateAction<number>>;
  setCurrentIndex: Dispatch<SetStateAction<number>>;
  setNavStack: Dispatch<SetStateAction<NavEntry[]>>;
}) {
  const undoStack = useRef<UndoAction[]>([]);
  const redoStack = useRef<UndoAction[]>([]);
  const HISTORY_LIMIT = 100;

  const recordAction = useCallback((action: UndoAction) => {
    if (action.changes.length === 0) return;
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

  const undo = useCallback(() => {
    const action = undoStack.current.pop();
    if (!action) return;
    applyChanges(action.changes.map((c) => ({ imgId: c.imgId, path: c.path, rating: c.before })));
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
      // Restore the nav back-stack snapshot too, so ESC after this undo pops the
      // entry the user actually came from (the action's auto-exit may have popped
      // it, leaving the live stack out of sync with the restored compare view).
      if (action.cursorBefore.navStack) setNavStack(action.cursorBefore.navStack);
    } else if (!compareMode) {
      // For a compound (compare) action, changes[0] is the OLD champion that got
      // rejected; the frame the user actually cares about is the crowned/kept
      // one — the LAST change. (Identical to changes[0] for single-change actions.)
      const landId = action.changes[action.changes.length - 1].imgId;
      const idx = images.findIndex((im) => im.id === landId);
      if (idx !== -1) setCurrentIndex(idx);
    }
    redoStack.current.push(action);
  }, [
    applyChanges,
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
      const landId = action.changes[action.changes.length - 1].imgId;
      const idx = images.findIndex((im) => im.id === landId);
      if (idx !== -1) setCurrentIndex(idx);
    }
    undoStack.current.push(action);
  }, [
    applyChanges,
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
