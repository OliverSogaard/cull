import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

/**
 * Two-step inline confirm state: stage 1 arms (button click), stage 2 fires
 * the real action. Auto-disarms after `disarmMs` so a confirmed-then-walked-
 * away dialog doesn't sit primed. Shared by the finish dialog's move-rejects
 * row and the settings reset row.
 *
 * The third return, `armedRef`, is a ref callback meant to be wired onto BOTH
 * the stage-1 trigger button and the stage-2 "Yes, …" button — only one of
 * them is ever mounted at a time, so it's unambiguous which one it's attached
 * to. When `armed` changes, a layout effect checks whether the button that
 * used to occupy this slot was focused and that focus fell all the way to
 * `<body>` — the DOM's "nothing is focused" state, and also what a
 * just-removed focused element's focus fixes up to — and ONLY THEN focuses
 * whatever button occupies the slot now:
 *
 *   - it does NOT steal focus back if the user tabbed to some other control
 *     before an auto-disarm or a cancel fires (focus isn't on <body>, so it's
 *     left alone);
 *   - it does NOT queue a claim that could fire on some later, unrelated
 *     mount when this commit has no ref-bearing node at all (e.g. a
 *     mid-operation progress row with no button) — nothing is persisted
 *     across commits, so a later render simply doesn't reactivate anything.
 *
 * This runs in a `useLayoutEffect`, never during render (refs must not be
 * written mid-render, and a discarded render must not be able to leak a
 * stale focus claim), which keeps it ordered ahead of the caller's
 * `useFocusTrap`, whose `focusout` handler only re-homes focus via
 * `requestAnimationFrame` — strictly later than any layout effect in the
 * same commit.
 *
 * Because that focus move happens the instant the confirm appears, the ref
 * callback also guards the button against the keypress that armed it — see
 * `ignoreHeldEnter` at the foot of this file.
 */
export function useArmedConfirm(
  disarmMs = 4000,
): [
  boolean,
  Dispatch<SetStateAction<boolean>>,
  (node: HTMLElement | null) => (() => void) | undefined,
] {
  const [armed, setArmed] = useState(false);
  const nodeRef = useRef<HTMLElement | null>(null);
  const isFirstRenderRef = useRef(true);

  useLayoutEffect(() => {
    if (isFirstRenderRef.current) {
      isFirstRenderRef.current = false;
      return;
    }
    const active = document.activeElement;
    const orphaned = active === null || active === document.body;
    if (orphaned) nodeRef.current?.focus();
  }, [armed]);

  useEffect(() => {
    if (!armed) return;
    const t = window.setTimeout(() => setArmed(false), disarmMs);
    return () => window.clearTimeout(t);
  }, [armed, disarmMs]);

  const armedRef = useCallback((node: HTMLElement | null) => {
    nodeRef.current = node;
    if (node === null) return;
    node.addEventListener("keydown", ignoreHeldEnter);
    // React 19 ref cleanup: it runs when this node is detached (and before the
    // ref is called with the node that replaces it), so the listener lives
    // exactly as long as the button it guards.
    return () => {
      node.removeEventListener("keydown", ignoreHeldEnter);
      if (nodeRef.current === node) nodeRef.current = null;
    };
  }, []);

  return [armed, setArmed, armedRef];
}

/**
 * Arming focuses the confirm button (above), and Chromium activates a focused
 * button on Enter KEYDOWN — so the very Enter that armed it is still down when
 * it arrives, and the OS's auto-repeat of that keypress fires the real action
 * about 300 ms later. Holding Enter on "Move rejects" therefore moved the
 * rejects without the user ever confirming.
 *
 * Cancelling the repeated keydown suppresses the click Chromium would
 * synthesize from it: a confirm needs a press the user made after seeing the
 * question. Enter only — a repeat is the normal, wanted behaviour of every
 * other held key (Tab opens the help sheet while held, arrows navigate).
 */
function ignoreHeldEnter(e: KeyboardEvent): void {
  if (e.repeat && e.key === "Enter") e.preventDefault();
}
