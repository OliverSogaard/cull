import { useEffect, useRef } from "react";

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),' +
  'textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Trap keyboard focus inside a modal dialog while it's mounted, and restore
 * focus to the previously-active element when it unmounts. Return value goes on
 * the dialog's root element — give that root `tabIndex={-1}` so it can receive
 * the fallback focus when it has no focusable children yet.
 *
 * Assumes the dialog is rendered ONLY while open (conditionally mounted), so the
 * mount = open / unmount = close lifecycle drives the trap.
 *
 * Addresses the modal-accessibility gap (WCAG 2.4.3 focus order): Tab /
 * Shift+Tab cycle within the dialog instead of leaking to the controls behind
 * it, and focus returns to the trigger when the dialog closes.
 */
export function useFocusTrap<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const prevFocus = document.activeElement as HTMLElement | null;

    // Visible focusables only — getClientRects() is empty for display:none
    // elements and works for position:fixed/absolute (unlike offsetParent).
    const focusable = () =>
      Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.getClientRects().length > 0,
      );

    // Move focus into the dialog on open. preventScroll so a scrollable dialog
    // body doesn't jump to bring the first control into view.
    (focusable()[0] ?? node).focus({ preventScroll: true });

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const els = focusable();
      if (els.length === 0) {
        e.preventDefault();
        return;
      }
      const first = els[0];
      const last = els[els.length - 1];
      const active = document.activeElement;
      if (!node.contains(active)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    // If a focused control is removed from the DOM (e.g. the Reset row
    // auto-disarms, or the export-mode switch swaps rows) focus would otherwise
    // strand on <body>, escaping the trap. Re-home it into the dialog.
    const onFocusOut = (e: FocusEvent) => {
      const next = e.relatedTarget as Node | null;
      if (next && node.contains(next)) return; // moving within the dialog — fine
      // Defer so React can finish reconciling the removed node. Re-home to the
      // dialog root (not the first control) with preventScroll, so a button that
      // disables/removes itself on click doesn't make the body scroll up to the
      // top control.
      requestAnimationFrame(() => {
        if (!node.contains(document.activeElement)) node.focus({ preventScroll: true });
      });
    };

    node.addEventListener("keydown", onKeyDown);
    node.addEventListener("focusout", onFocusOut);
    return () => {
      node.removeEventListener("keydown", onKeyDown);
      node.removeEventListener("focusout", onFocusOut);
      // Restore focus to whatever was focused before the dialog opened.
      prevFocus?.focus?.();
    };
  }, []);

  return ref;
}
