// src/components/strip/useStripMetrics.ts
import { useCallback, useSyncExternalStore } from "react";
import { STRIP_TALL_QUERY, stripMetricsFor, type StripMetrics } from "./metrics";

/**
 * The strip's step, from ONE matchMedia subscription. useSyncExternalStore
 * rather than a resize listener: the query fires only when the window crosses
 * the threshold, so a drag from 1000 to 1400px of height costs one event, not
 * one per frame (and this machine paints at 240 Hz — a per-frame listener
 * would be 240 needless renders a second).
 *
 * The server snapshot is the small step, which is also styles/tokens.css's
 * `:root` fallback, so a render without a window agrees with the stylesheet.
 */
export function useStripMetrics(): StripMetrics {
  const subscribe = useCallback((onChange: () => void) => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return () => {};
    }
    const mql = window.matchMedia(STRIP_TALL_QUERY);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  const isTall = useCallback(
    () =>
      typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia(STRIP_TALL_QUERY).matches
        : false,
    [],
  );
  return stripMetricsFor(useSyncExternalStore(subscribe, isTall, () => false));
}
