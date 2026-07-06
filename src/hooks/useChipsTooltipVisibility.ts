import { useCallback, useEffect, useReducer, useRef } from "react";
import { reduceTooltipVisibility, initialTooltipVisibility } from "../utils/tooltipVisibility";

/** How long after the last activity (filter cycle or hover) the tooltip
 *  waits before it's allowed to fade out — same idle-then-fade shape as the
 *  grid's SCROLL_INDICATOR_IDLE_MS, just a touch longer since this is a
 *  deliberate "look where I landed" affordance rather than a passive scroll
 *  cue. */
const CHIPS_TOOLTIP_IDLE_MS = 800;

/**
 * Activity-driven visibility for the filter sub-mode tooltip. The pure
 * transition table lives in `reduceTooltipVisibility`; this hook only owns
 * the one side effect a state machine can't: the idle timer that fires
 * `idleElapsed` after `CHIPS_TOOLTIP_IDLE_MS` of no activity.
 *
 * - `pulse()` — call on every filter change (key press or click); shows the
 *   tooltip immediately and (re)arms the idle timer.
 * - `hoverProps` — spread onto both the active tab button and the tooltip
 *   itself; entering either cancels the idle timer, leaving both re-arms it.
 */
export function useChipsTooltipVisibility() {
  const [state, dispatch] = useReducer(reduceTooltipVisibility, initialTooltipVisibility);
  const idleTimerRef = useRef<number | null>(null);

  const clearIdleTimer = useCallback(() => {
    if (idleTimerRef.current != null) {
      window.clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  }, []);

  const armIdleTimer = useCallback(() => {
    clearIdleTimer();
    idleTimerRef.current = window.setTimeout(() => {
      idleTimerRef.current = null;
      dispatch({ type: "idleElapsed" });
    }, CHIPS_TOOLTIP_IDLE_MS);
  }, [clearIdleTimer]);

  const pulse = useCallback(() => {
    dispatch({ type: "pulse" });
    armIdleTimer();
  }, [armIdleTimer]);

  const onPointerEnter = useCallback(() => {
    clearIdleTimer();
    dispatch({ type: "hoverEnter" });
  }, [clearIdleTimer]);

  const onPointerLeave = useCallback(() => {
    dispatch({ type: "hoverLeave" });
    armIdleTimer();
  }, [armIdleTimer]);

  useEffect(() => clearIdleTimer, [clearIdleTimer]);

  return {
    visible: state.visible,
    pulse,
    hoverProps: { onPointerEnter, onPointerLeave },
  };
}
