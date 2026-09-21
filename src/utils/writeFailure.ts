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

/**
 * The backend also refuses to overwrite an `xmp:Label` CULL did not write —
 * the user's own Lightroom label, which CULL only ever reads as "custom" and
 * cannot reproduce. The file is left exactly as it was, so this is NOT a
 * failed save: nothing was lost and nothing is pending. It should only ever
 * happen when the in-memory label map is stale (Lightroom edited the sidecar
 * while the session was open), and the honest response is to put "custom"
 * back in the map rather than stamp a phantom "unsaved".
 */
export const CUSTOM_LABEL_KEPT_PREFIX = "custom label kept";

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : typeof e === "string" ? e : "";
}

export function isPermanentWriteError(e: unknown): boolean {
  return messageOf(e).startsWith(MISSING_SOURCE_PREFIX);
}

/** True for the backend's refusal to overwrite a custom Lightroom label. */
export function isCustomLabelKept(e: unknown): boolean {
  return messageOf(e).startsWith(CUSTOM_LABEL_KEPT_PREFIX);
}
