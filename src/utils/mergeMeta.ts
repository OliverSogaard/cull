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

/**
 * Folds a same-session analyze-pass seed (LrC stars only, `EMPTY_METADATA`
 * otherwise) into the metadata map without discarding an already-staged
 * entry's EXIF or its own star. A whole-entry override (`{...seeded, ...prev}`
 * or the reverse) is wrong either way: one direction wipes camera/lens with
 * the seed's nulls, the other throws the star away whenever `prev` already
 * has an entry with `lrcRating: null` (the re-stage case this exists for).
 *
 * Per path with a `prev` entry, `mergeMeta` runs with the seed as `prev` and
 * the existing entry as `incoming`: the existing entry's fields win via the
 * spread, and only its `lrcRating` (when null) is back-filled from the seed —
 * exactly `mergeMeta`'s own contract, just pointed at the seed instead of an
 * older delivery. A seeded path with no `prev` entry is added as-is; a `prev`
 * path absent from the seed is left untouched.
 */
export function seedLrcMeta(
  prev: Record<string, ImageMetadata>,
  seeded: Record<string, ImageMetadata>,
): Record<string, ImageMetadata> {
  const next = { ...prev };
  for (const [path, seed] of Object.entries(seeded)) {
    const existing = prev[path];
    next[path] = existing ? mergeMeta(seed, existing) : seed;
  }
  return next;
}

/** Applies one flush window's worth of deliveries (see MetaBatcher) to the
 *  metadata map: one clone per 100 ms window instead of one per image. */
export function applyMetaBatch(
  prev: Record<string, ImageMetadata>,
  batch: ReadonlyMap<string, ImageMetadata>,
): Record<string, ImageMetadata> {
  if (batch.size === 0) return prev;
  const next = { ...prev };
  for (const [path, meta] of batch) next[path] = mergeMeta(prev[path], meta);
  return next;
}
