import type { NavEntry } from "./nav";

/**
 * Rating model — the three states CULL writes (plus the absence of any rating).
 * Mirrors the strings the Rust backend writes into XMP sidecars (`keep` /
 * `reject` / `favorite`) so the round-trip is a single source of truth.
 */
export type Rating = "keep" | "reject" | "favorite";

/**
 * A star rating, 1–5 — `xmp:Rating` on disk, exactly what Lightroom Classic
 * reads. ORTHOGONAL to {@link Rating}: a 3★ frame with no keep/reject is
 * still unrated, which is the truth about a second pass that only stars.
 *
 * 0 is deliberately not a member: clearing removes the property (Lightroom's
 * own `0` = "remove rating"), so the absence of a key in the `stars` map is
 * the only way "no star" is spelled.
 */
export type Star = 1 | 2 | 3 | 4 | 5;

/** The five colour labels CULL can SET. */
export type Label = "red" | "yellow" | "green" | "blue" | "purple";

/**
 * What a sidecar's `xmp:Label` reads back as. `xmp:Label` is a LOCALISED
 * free-text string, not an enum — a German Lightroom writes "Rot", and a user
 * with a custom label set writes whatever they named it. CULL understands the
 * five English defaults; anything else non-empty is the user's and comes back
 * as `"custom"`: shown, never rewritten, and never cleared by a key that did
 * not set it.
 */
export type LabelValue = Label | "custom";

/** The five labels in keyboard order — `6` `7` `8` `9` `Shift+6`. */
export const LABELS: readonly Label[] = ["red", "yellow", "green", "blue", "purple"];

/** Display name per label value. The XMP strings CULL writes are the same
 *  five words (the backend owns that mapping); this is the UI's copy. */
export const LABEL_NAME: Record<LabelValue, string> = {
  red: "Red",
  yellow: "Yellow",
  green: "Green",
  blue: "Blue",
  purple: "Purple",
  custom: "Custom",
};

/** Narrow an unknown (a restored wire value) to a settable label. */
export function isLabel(v: unknown): v is Label {
  return typeof v === "string" && (LABELS as readonly string[]).includes(v);
}

/** Narrow an unknown (a restored wire value) to a readable label value. */
export function isLabelValue(v: unknown): v is LabelValue {
  return v === "custom" || isLabel(v);
}

/** Narrow an unknown (a restored wire value) to a star. */
export function isStar(v: unknown): v is Star {
  return v === 1 || v === 2 || v === 3 || v === 4 || v === 5;
}

/**
 * Filter visible in the status bar: keyboard 1–5 select the five top-level
 * tabs (All / Unrated / Keeps / Smart / Rejects); repressing an active tab's
 * key cycles through its sub-modes (see `src/utils/filterModes.ts`).
 *
 * - `keeps` includes favorites by design (a ★ frame is also a keep);
 *   `keepsFavs` narrows to favorite-rated only.
 * - `suggested` = frames with a live smart-culling suggestion that are still
 *   unrated (App.tsx resolves it against the suggestions map);
 *   `suggestedRejects` / `suggestedKeeps` / `suggestedFavs` narrow by the
 *   suggestion's verdict.
 * - `rejects` = frames the user actually rated `reject` — the pile "move
 *   rejects" will take, so it can be checked before it is moved. Nothing to
 *   do with `suggestedRejects`, which is an unrated frame the smart pass
 *   thinks should go.
 */
export type Filter =
  | "all"
  | "unrated"
  | "keeps"
  | "keepsFavs"
  | "suggested"
  | "suggestedRejects"
  | "suggestedKeeps"
  | "suggestedFavs"
  | "rejects";

/** One per-image rating change. Compound actions (e.g. challengerWins) bundle several into an {@link UndoAction}. */
type Change = {
  imgId: number;
  path: string;
  before: Rating | undefined;
  after: Rating | undefined;
};

/**
 * One per-image change to a frame's STAR or LABEL — the orthogonal layer, so
 * it rides beside `changes` in an {@link UndoAction} rather than widening
 * `Change`. One keypress is still one undo step: a grid multi-select produces
 * one action holding one entry per selected frame.
 *
 * `after` is never `"custom"` — CULL writes the five labels it knows and
 * nothing else — but `before` can be, because a frame may have arrived from
 * Lightroom carrying a label string CULL does not recognise.
 */
export type MetaChange =
  | {
      imgId: number;
      path: string;
      field: "star";
      before: Star | undefined;
      after: Star | undefined;
    }
  | {
      imgId: number;
      path: string;
      field: "label";
      before: LabelValue | undefined;
      after: LabelValue | undefined;
    };

/** A compare-cursor snapshot (which pair was on screen) for undo/redo restore. */
type CompareCursor = {
  compareMode: boolean;
  championIndex: number;
  challengerIndex: number;
  currentIndex: number;
  /**
   * Nav back-stack at record time. An undo that restores compare mode also
   * restores this stack, so ESC afterwards pops the entry the user actually
   * came from — the action's auto-exit may have popped it. Optional: only
   * compare-origin actions snapshot it (and only `cursorBefore` uses it).
   */
  navStack?: NavEntry[];
};

/**
 * One step in the undo stack. The `cursorBefore` snapshot lets a Ctrl+Z that
 * undoes a compare-mode rating land you back on the same champion/challenger
 * pair (not stranded mid-flow); `cursorAfter` lets a Ctrl+Y re-crown the NEW
 * champion (not the just-rejected old one) when redoing a compound compare
 * action. Single-frame rates set neither — redo then lands on the changed frame.
 *
 * `meta` is the star / colour-label layer (Phase 5A). An action carries
 * `changes`, or `meta`, or both — never neither. It is optional so every
 * existing `{ changes }` literal in the codebase still type-checks, and so an
 * action recorded before the layer existed replays unchanged.
 */
export type UndoAction = {
  changes: Change[];
  meta?: MetaChange[];
  cursorBefore?: CompareCursor;
  cursorAfter?: CompareCursor;
};
