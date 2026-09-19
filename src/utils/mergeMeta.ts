import type { ImageMetadata } from "../types";

/**
 * Merges a freshly-delivered `ImageMetadata` into the previously-known entry
 * for a path. Pure function backing the store's `setMetaSink` (wired in
 * `useImageStoreWiring.ts`) so the carry-forward rules are unit-testable in
 * isolation.
 *
 * `ImageMetadata` rides three wire paths — thumb decode, preview read, and
 * full-res bundle read — but only the thumb path ever computes `phash` (a
 * DCT hash of the decoded thumbnail). Preview/full deliveries always carry
 * `phash: null`. Since source CR3s are immutable, a null in a LATER delivery
 * never means "the hash went away" — it means "this path doesn't compute
 * one" — so the standing thumb-phash must be carried forward or Similar
 * groups (which chain on it) dissolve as the user simply views frames.
 *
 * `lrcRating` has the same shape: the bundle read no longer re-reads the
 * XMP sidecar per navigation (one NAS round-trip saved per image), so the
 * LrC stars exist only in the analyze-pass seed and must also be carried
 * forward when a later delivery omits them.
 */
export function mergeMeta(prev: ImageMetadata | undefined, incoming: ImageMetadata): ImageMetadata {
  if (!prev) return incoming;

  const merged = { ...incoming };
  if (incoming.lrcRating == null && prev.lrcRating != null) {
    merged.lrcRating = prev.lrcRating;
  }
  if (incoming.phash == null && prev.phash != null) {
    merged.phash = prev.phash;
  }
  return merged;
}

/** Applies one frame's worth of deliveries (see MetaBatcher) to the metadata
 *  map: one clone per frame instead of one per image. */
export function applyMetaBatch(
  prev: Record<string, ImageMetadata>,
  batch: ReadonlyMap<string, ImageMetadata>,
): Record<string, ImageMetadata> {
  if (batch.size === 0) return prev;
  const next = { ...prev };
  for (const [path, meta] of batch) next[path] = mergeMeta(prev[path], meta);
  return next;
}
