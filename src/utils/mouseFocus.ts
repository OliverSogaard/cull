import type { MouseEvent as ReactMouseEvent } from "react";

/**
 * Whether a left-button press on `target` may move keyboard focus.
 *
 * In the culling chrome it must not: Chromium shows nothing on a plain click,
 * but the NEXT key press flips it into keyboard modality and the button the
 * mouse landed on lights up with the focus ring — and stays lit until the
 * next click, because every key the app takes is a window listener that
 * never moves focus. Refusing the focus move at mousedown keeps the ring
 * for keyboard users only (Tab still focuses everything).
 *
 * Dialogs keep the browser default: their focus trap and armed confirms
 * depend on focus following the click. So do text fields, where the caret
 * IS the focus.
 */
export function mousePressMovesFocus(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return true;
  if (!target.closest("button")) return true;
  if (target.closest("input, textarea, select, [contenteditable]")) return true;
  return target.closest('[role="dialog"], .dialog') !== null;
}

/** Capture-phase mousedown handler for the app root. */
export function keepKeyboardFocusOffChrome(e: ReactMouseEvent) {
  if (e.button === 0 && !mousePressMovesFocus(e.target)) e.preventDefault();
}
