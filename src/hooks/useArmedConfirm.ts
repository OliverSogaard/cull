import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";

/**
 * Two-step inline confirm state: stage 1 arms (button click), stage 2 fires
 * the real action. Auto-disarms after `disarmMs` so a confirmed-then-walked-
 * away dialog doesn't sit primed. Shared by the finish dialog's move-rejects
 * row and the settings reset row.
 *
 * The third return, `armedRef`, is a ref callback meant to be wired onto BOTH
 * the stage-1 trigger button and the stage-2 "Yes, …" button — only one of
 * them is ever mounted at a time, so it's unambiguous which one it's attached
 * to. Whichever one mounts as a result of `armed` changing (arming OR
 * disarming, whether by confirming, cancelling, or the auto-disarm timeout)
 * takes focus. Without this, the caller's `useFocusTrap` would otherwise see
 * the previously-focused button unmount and re-home focus to the dialog root
 * instead — this wins that race because refs commit before that trap's
 * `focusout` handler runs.
 */
export function useArmedConfirm(
  disarmMs = 4000,
): [boolean, Dispatch<SetStateAction<boolean>>, (node: HTMLElement | null) => void] {
  const [armed, setArmed] = useState(false);

  // Detect an `armed` change during render (before the commit that mounts/
  // unmounts the two buttons), so the ref callback below already knows to
  // focus whatever mounts in this slot next.
  const prevArmedRef = useRef(armed);
  const pendingFocusRef = useRef(false);
  if (prevArmedRef.current !== armed) {
    pendingFocusRef.current = true;
    prevArmedRef.current = armed;
  }

  useEffect(() => {
    if (!armed) return;
    const t = window.setTimeout(() => setArmed(false), disarmMs);
    return () => window.clearTimeout(t);
  }, [armed, disarmMs]);

  const armedRef = useCallback((node: HTMLElement | null) => {
    if (node && pendingFocusRef.current) {
      pendingFocusRef.current = false;
      node.focus();
    }
  }, []);

  return [armed, setArmed, armedRef];
}
