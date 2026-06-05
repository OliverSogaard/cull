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
