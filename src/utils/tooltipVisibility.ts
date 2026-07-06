/**
 * Pure visibility state machine for the filter sub-mode tooltip (the small
 * floating chip row above the active Keeps/Smart tab — see
 * `.cull-filter-tab-tooltip` in App.css). Mirrors the grid's scroll-position
 * indicator and the loupe strip's scrub bar: activity shows it immediately,
 * an idle window with no activity AND no hover hides it again. The actual
 * fade is carried by CSS transitions on the `.is-on` class; this only tracks
 * the boolean.
 *
 * Kept side-effect-free (no timers) so the transition table is trivial to
 * unit test — the owning hook (`useChipsTooltipVisibility`) is the only
 * place that touches `setTimeout`.
 */

export interface TooltipVisibilityState {
  /** Whether the tooltip should currently render as visible. */
  visible: boolean;
  /** Whether the pointer is currently over the tab or the tooltip itself —
   *  while true, an idle timeout must never hide the tooltip. */
  hovering: boolean;
}

export type TooltipVisibilityEvent =
  /** The active filter just changed (key press or label/chip click). */
  | { type: "pulse" }
  /** Pointer entered the active tab or the tooltip. */
  | { type: "hoverEnter" }
  /** Pointer left both the active tab and the tooltip. */
  | { type: "hoverLeave" }
  /** The idle timer (armed on pulse/hoverLeave) elapsed with no activity. */
  | { type: "idleElapsed" };

export const initialTooltipVisibility: TooltipVisibilityState = {
  visible: false,
  hovering: false,
};

/**
 * Advances the tooltip's visibility state for one event. Pure — same inputs
 * always produce the same output, and the previous state object is never
 * mutated.
 */
export function reduceTooltipVisibility(
  state: TooltipVisibilityState,
  event: TooltipVisibilityEvent,
): TooltipVisibilityState {
  switch (event.type) {
    case "pulse":
      return state.visible ? state : { ...state, visible: true };
    case "hoverEnter":
      return state.visible && state.hovering ? state : { visible: true, hovering: true };
    case "hoverLeave":
      return state.hovering ? { ...state, hovering: false } : state;
    case "idleElapsed":
      // Hovering always wins over an idle timeout that raced it.
      return state.hovering || !state.visible ? state : { ...state, visible: false };
    default:
      return state;
  }
}
