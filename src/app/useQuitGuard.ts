import { useEffect, useRef, useState, type RefObject } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * Quit guard, verbatim from App (grand cleanup Phase 6): never let the window
 * close while a rating is still saving or has failed to save. Reads the live
 * write counts from useRatingPersistence — the refs synchronously, so the
 * once-registered close handler can never see a stale zero in the commit-lag
 * window right after a rating keystroke.
 */
export function useQuitGuard({
  savingCount,
  failedCount,
  savingRef,
  failedCountRef,
}: {
  savingCount: number;
  failedCount: number;
  savingRef: RefObject<number>;
  failedCountRef: RefObject<number>;
}) {
  const [quitGuard, setQuitGuard] = useState(false); // close requested while unsafe
  const destroyedRef = useRef(false); // window.destroy() must fire at most once
  const quitShownAtRef = useRef(0); // when the quit guard was shown (min-visible floor)

  // Quit guard: never let the window close while a rating is still saving or has
  // failed to save. Registered once; reads live state via refs. "cancel and warn"
  // = cancel the CLOSE, never the write.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void getCurrentWindow()
      .onCloseRequested((event) => {
        if (savingRef.current > 0 || failedCountRef.current > 0) {
          event.preventDefault();
          quitShownAtRef.current = performance.now();
          setQuitGuard(true);
        }
      })
      .then((u) => {
        unlisten = u;
      });
    return () => unlisten?.();
  }, [savingRef, failedCountRef]);

  // Once a guarded close has flushed everything, finish closing automatically.
  // destroyedRef makes destroy() fire at most once (a stray re-trigger during the
  // async teardown would otherwise reject); .catch swallows the unhandled rejection.
  useEffect(() => {
    if (!(quitGuard && savingCount === 0 && failedCount === 0 && !destroyedRef.current)) return;
    // Keep the guard on screen a beat even if the write finished in the same tick
    // it appeared — otherwise destroy() fires on the overlay's first painted frame
    // and the user never sees the "saving…" panel.
    const elapsed = performance.now() - quitShownAtRef.current;
    const t = window.setTimeout(
      () => {
        if (destroyedRef.current) return;
        destroyedRef.current = true;
        getCurrentWindow()
          .destroy()
          .catch(() => {});
      },
      Math.max(0, 350 - elapsed),
    );
    return () => window.clearTimeout(t);
  }, [quitGuard, savingCount, failedCount]);

  return { quitGuard, setQuitGuard, destroyedRef };
}
