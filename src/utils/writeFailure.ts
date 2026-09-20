/**
 * The backend refuses a sidecar write when the CR3 is no longer at its path
 * (`xmp.rs` `MISSING_SOURCE`). Retrying cannot help — only putting the photo
 * back can — so the write is recorded as failed at once instead of after the
 * 400/1500/4000 ms schedule.
 */
export const MISSING_SOURCE_PREFIX = "source missing:";

export function isPermanentWriteError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  return msg.startsWith(MISSING_SOURCE_PREFIX);
}
