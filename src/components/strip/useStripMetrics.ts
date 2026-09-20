// src/components/strip/useStripMetrics.ts
import { useCallback, useSyncExternalStore } from "react";
import { STRIP_TALL_QUERY, stripMetricsFor, type StripMetrics } from "./metrics";

/**
 * The one `MediaQueryList` for {@link STRIP_TALL_QUERY}, created lazily on
 * first use (never at module load, so a test importing this module in an
 * environment without `window.matchMedia` doesn't crash before it even runs)
 * and cached for the module's lifetime. `getSnapshot` runs on every render
 * useSyncExternalStore triggers, so without this cache it allocated a fresh
 * `MediaQueryList` on every one of those reads; `subscribe` and `getSnapshot`
 * now share the single instance.
 */
let cachedTallQuery: MediaQueryList | null | undefined;

function tallQuery(): MediaQueryList | null {
  if (cachedTallQuery === undefined) {
    cachedTallQuery =
      typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia(STRIP_TALL_QUERY)
        : null;
  }
  return cachedTallQuery;
}

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
    const mql = tallQuery();
    if (!mql) return () => {};
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  const isTall = useCallback(() => tallQuery()?.matches ?? false, []);
  return stripMetricsFor(useSyncExternalStore(subscribe, isTall, () => false));
}
