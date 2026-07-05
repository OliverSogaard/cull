/**
 * The zoom glide, shared by EVERY layer that scales with zoom (presenter
 * layers, hi-res raster, clip/peak masks — loupe and compare). One source so
 * the layers can never animate on different curves and tear apart mid-glide.
 *
 * Directional on purpose: engaging covers scale 1 → ~8× — with the old
 * 200ms ease-out nearly all of that motion landed in the first ~60ms and
 * read as a jump-cut. A longer, slow-start curve makes the departure
 * visible. Releasing keeps the original ease-out: it decelerates INTO the
 * fit view, which always felt right.
 */
export const ZOOM_ENGAGE_TRANSITION = "transform 300ms cubic-bezier(0.4, 0, 0.2, 1)";
export const ZOOM_RELEASE_TRANSITION = "transform 200ms ease-out";

export function zoomTransition(isZooming: boolean): string {
  return isZooming ? ZOOM_ENGAGE_TRANSITION : ZOOM_RELEASE_TRANSITION;
}
