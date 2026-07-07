import type { PerformanceProfile } from "../types/settings";

/**
 * OS memory-pressure level, forwarded from the Rust side ("memory-pressure"
 * event). macOS raises these BEFORE jetsam starts killing processes — the
 * proven failure mode (2026-07-07: compare-zoom decide spiked WebContent to
 * 2.25 GB lifetimeMax and the OS shot it; gray window). Windows maps its
 * memory-load percentage onto the same three levels.
 */
export type PressureLevel = "normal" | "warn" | "critical";

/**
 * Clamp a performance profile for the current memory pressure. Pure, so the
 * shedding policy is testable and lives in ONE place.
 *
 * Sheds MEMORY, not I/O: read concurrency and settle timing stay untouched —
 * throttling reads under pressure would just make the app feel broken. What
 * shrinks is what holds bytes: decoded pools (the ~130 MB fulls first),
 * blob keep-windows, and speculative prefetch.
 *
 * - warn: halve the windows, at most one decoded full, no background fill.
 * - critical: survival numbers — no decoded fulls, no zoom-full window, no
 *   prefetch; a small preview working set keeps the cull usable.
 */
export function clampProfileForPressure(
  base: PerformanceProfile,
  level: PressureLevel,
): PerformanceProfile {
  if (level === "normal") return base;
  if (level === "warn") {
    return {
      ...base,
      previewKeep: Math.max(8, Math.floor(base.previewKeep / 2)),
      fullKeep: Math.min(base.fullKeep, 1),
      previewPrefetchAhead: Math.min(base.previewPrefetchAhead, 2),
      previewPrefetchBehind: Math.min(base.previewPrefetchBehind, 1),
      decodedPoolPreviews: Math.max(3, Math.floor(base.decodedPoolPreviews / 2)),
      decodedPoolFulls: Math.min(base.decodedPoolFulls, 1),
      backgroundFillConcurrency: 0,
      midGenConcurrency: Math.min(base.midGenConcurrency, 1),
    };
  }
  return {
    ...base,
    previewKeep: Math.max(4, Math.min(base.previewKeep, 8)),
    fullKeep: 0,
    previewPrefetchAhead: 0,
    previewPrefetchBehind: 0,
    decodedPoolPreviews: Math.min(base.decodedPoolPreviews, 2),
    decodedPoolFulls: 0,
    backgroundFillConcurrency: 0,
    midGenConcurrency: 0,
  };
}
