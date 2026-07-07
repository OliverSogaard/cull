/**
 * Geometry shared by the LOUPE stage and each COMPARE pane. The two surfaces
 * grew as hand-copied siblings and drifted (the compare glide/measure gaps of
 * 2026-07-07); anything both need now lives here so a fix lands in both by
 * construction.
 */

/** Displayed-image rect relative to its measuring container. */
export type PaneRect = { left: number; top: number; width: number; height: number };

/** After an unzoom, wait out the release transition before measuring — an
 *  immediate measure captures the animating, still-scaled box (the "unzoom
 *  snaps to a huge top-left image" bug). Shared: loupe and compare must
 *  breathe on the same clock. */
export const ZOOM_UNSETTLE_MEASURE_DELAY_MS = 260;

/**
 * Transform for the deferred hi-res layer: the native-size raster reproduces
 * the base layer's `scale(Z)` about (originX%, originY%) EXACTLY, so it can
 * appear/disappear with zero visible shift. One formula for loupe and compare
 * (they had byte-identical copies).
 */
export function hiResTransform(
  rect: PaneRect | null | undefined,
  native: { w: number; h: number } | null | undefined,
  originX: number,
  originY: number,
  zoomZ: number,
): { tx: number; ty: number; scale: number } {
  if (!rect || !native || native.w <= 0) return { tx: 0, ty: 0, scale: 1 };
  return {
    tx: (originX / 100) * rect.width * (1 - zoomZ),
    ty: (originY / 100) * rect.height * (1 - zoomZ),
    scale: (rect.width / native.w) * zoomZ,
  };
}

/**
 * The pane's zoom scale factor: zoomLevel × the true-1:1 scale (native pixels
 * over displayed width — rendering the displayed image at that factor lands
 * one image pixel per screen pixel). Falls back to a 5× one-to-one while dims
 * or rect are unknown; 1 while not zooming. One formula for the loupe stage,
 * each compare pane, and App's mouse-drag factor mirror (they had identical
 * hand-copies).
 */
export function paneZoomZ(
  native: { w: number; h: number } | null | undefined,
  rect: PaneRect | null | undefined,
  zoomLevel: number,
  isZooming: boolean,
): number {
  if (!isZooming) return 1;
  const oneToOne = native && rect ? native.w / rect.width : 5;
  return zoomLevel * oneToOne;
}

/**
 * Measure the displayed image's rect relative to `container`, transform-safe.
 *
 * - Un-zoomed: the img's own rect IS the displayed box.
 * - Zoomed: the img's rect is the SCALED box (useless) — measure its parent
 *   instead: the `__clip` window never transforms, the base layer fills it
 *   exactly (inset 0, 100%), and frame AR == photo AR makes it the displayed
 *   photo box. (The carried-zoom fix, 069a06c, now shared with compare.)
 *
 * Returns null when the element isn't measurable yet (unmounted / zero-width).
 */
export function measurePaneRect(
  img: HTMLElement | null,
  container: HTMLElement | null,
  zoomed: boolean,
): PaneRect | null {
  const target = zoomed ? (img?.parentElement ?? null) : img;
  if (!target || !container) return null;
  const tr = target.getBoundingClientRect();
  if (tr.width < 1) return null;
  const cr = container.getBoundingClientRect();
  return { left: tr.left - cr.left, top: tr.top - cr.top, width: tr.width, height: tr.height };
}
