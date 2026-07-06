/**
 * dlog.ts — DEV-only diagnostic logger (mid-dims-bug-report §6).
 *
 * Gated the same way as DevHud (`components/DevHud.tsx`): flip
 * `localStorage["cull:devlog"] = "1"` in devtools + reload. Ships in every
 * build (no bundler dead-code elimination relied on) but costs a single
 * cached boolean check per call site in the normal (flag-off) path — no
 * string building, no object allocation, no console call.
 *
 * Call sites that would otherwise pay for non-trivial data collection just to
 * log it (canvas readbacks, byte-array scans) MUST guard with `dlogEnabled()`
 * themselves before doing that work — `dlog()` alone only makes the *logging*
 * free, not the caller's argument expressions (those still evaluate before
 * the call, per normal JS evaluation order).
 */

let cached: boolean | null = null;

/** Cheap, cached check — safe to call even where `localStorage` doesn't exist
 *  (the default vitest environment: no DOM, no Tauri IPC). */
export function dlogEnabled(): boolean {
  if (cached === null) {
    try {
      cached = typeof localStorage !== "undefined" && localStorage.getItem("cull:devlog") === "1";
    } catch {
      cached = false;
    }
  }
  return cached;
}

/** Test-only: forget the cached flag (e.g. after mutating localStorage). */
export function resetDlogForTests(): void {
  cached = null;
}

/** Log `msg` (bracketed by `scope`) plus optional structured `data`, only
 *  when dev-logging is enabled. Mirrors the existing `console.debug("[cull] …")`
 *  convention (see `smart/useSmartCulling.ts`). */
export function dlog(scope: string, msg: string, data?: Record<string, unknown>): void {
  if (!dlogEnabled()) return;
  // eslint-disable-next-line no-console
  console.debug(`[dlog:${scope}] ${msg}`, data ?? "");
}
