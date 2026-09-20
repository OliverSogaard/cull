import type { ImageMetadata } from "../types";

/**
 * Zoom transform-origin (in display %), anchored at the active AF point and
 * shifted by the current pan, clamped to the image. Defaults to dead-centre
 * (50/50) when the frame has no AF metadata. Shared by the loupe (App) and the
 * compare panes so the two never drift apart on the AF default or the clamp range.
 */
export function afZoomOrigin(
  meta: ImageMetadata | undefined,
  pan: { x: number; y: number },
): { x: number; y: number } {
  const afX = meta?.afXPct ?? 50;
  const afY = meta?.afYPct ?? 50;
  return {
    x: Math.max(0, Math.min(100, afX + pan.x)),
    y: Math.max(0, Math.min(100, afY + pan.y)),
  };
}

/**
 * Picks the metadata `afZoomOrigin` should read for a frame's zoom origin.
 * The committed metadata (App's `metadata` map / CompareView's `metadata`
 * prop) wins whenever it already carries an AF point. Only when it doesn't —
 * most often because a zoom engaged inside the metadata batcher's up-to-100ms
 * flush window, before the committed delivery landed — does this fall back to
 * `pending`, so a zoom still lands on the AF point instead of dead-centre.
 * `pending` is a thunk so the (store-read) lookup only happens when it's
 * actually needed, never on the far more common path where committed already
 * has what it needs. If pending's own metadata has no AF point either, it's
 * not worth preferring over committed, so committed wins by default.
 */
export function zoomOriginMeta(
  committed: ImageMetadata | undefined,
  pending: () => ImageMetadata | undefined,
): ImageMetadata | undefined {
  if (committed?.afXPct != null) return committed;
  const pendingMeta = pending();
  return pendingMeta?.afXPct != null ? pendingMeta : committed;
}
