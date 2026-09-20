/**
 * The backend refuses a sidecar write when the CR3 is not at its path
 * (`xmp.rs` `MISSING_SOURCE`). Nothing changes within the 400/1500/4000 ms
 * retry schedule that could make the next attempt land — only the drive or the
 * photo coming back can — so such a write is recorded as failed at once
 * instead of six seconds later.
 *
 * "Permanent" is about the SCHEDULE, not about the rating: a deliberate
 * re-check (useRatingPersistence's `retryFailed`) does re-attempt these, since
 * the user clicking it is saying the drive may be back.
 */
export const MISSING_SOURCE_PREFIX = "source missing:";

export function isPermanentWriteError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  return msg.startsWith(MISSING_SOURCE_PREFIX);
}
