import type { NavEntry } from "./nav";

/**
 * Rating model — the three states CULL writes (plus the absence of any rating).
 * Mirrors the strings the Rust backend writes into XMP sidecars (`keep` /
 * `reject` / `favorite`) so the round-trip is a single source of truth.
 */
export type Rating = "keep" | "reject" | "favorite";

/**
 * Filter visible in the status bar: keyboard 1–4 cycle these.
 *
 * - `keeps` includes favorites by design (a ★ frame is also a keep).
 */
export type Filter = "all" | "unrated" | "keeps" | "favorites";

/** One per-image rating change. Compound actions (e.g. challengerWins) bundle several into an {@link UndoAction}. */
export type Change = {
  imgId: number;
  path: string;
  before: Rating | undefined;
  after: Rating | undefined;
};

/**
 * One step in the undo stack. The `cursorBefore` snapshot lets a Ctrl+Z that
 * undoes a compare-mode rating land you back on the same champion/challenger
 * pair (not stranded mid-flow).
 */
export type UndoAction = {
  changes: Change[];
  cursorBefore?: {
    compareMode: boolean;
    championIndex: number;
    challengerIndex: number;
    currentIndex: number;
    /**
     * Nav back-stack at record time. An undo that restores compare mode also
     * restores this stack, so ESC afterwards pops the entry the user actually
     * came from — the action's auto-exit may have popped it. Optional: only
     * compare-origin actions snapshot it.
     */
    navStack?: NavEntry[];
  };
};
