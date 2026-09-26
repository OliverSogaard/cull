/**
 * Pure geometry for PhotoPane (and App's mouse-zoom mirror). Historical note:
 * the loupe stage and each compare pane grew as hand-copied siblings and
 * drifted (the compare glide/measure gaps of 2026-07-07); this module was the
 * first consolidation step, PhotoPane the last — one pane implementation, so
 * a fix lands everywhere by construction.
 */

/** Displayed-image rect relative to its measuring container. */
export type PaneRect = { left: number; top: number; width: number; height: number };

/** After an unzoom, wait out the release transition before measuring — an
 *  immediate measure captures the animating, still-scaled box (the "unzoom
 *  snaps to a huge top-left image" bug). Shared: loupe and compare must
 *  breathe on the same clock. */
export const ZOOM_UNSETTLE_MEASURE_DELAY_MS = 260;

/** How long after unzoom starts before the settle-time hi-res layer may
 *  return — the release glide plus slack. */
const UNZOOM_RETREAT_MS = 240;

/** The settle wait to use before the hi-res layer may return after an
 *  unzoom: 0 under reduced motion, since motion.css removes the release
 *  glide entirely there and there is nothing left to wait out; the full
 *  retreat otherwise. */
export function unzoomRetreatMs(prefersReducedMotion: boolean): number {
  return prefersReducedMotion ? 0 : UNZOOM_RETREAT_MS;
}

/** Whether the OS currently asks for reduced motion. Read fresh on every
 *  call rather than cached, since the setting can change while the app is
 *  running. Hosts without `matchMedia` (some test runners, non-browser
 *  embeds) read as false rather than throwing. */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * The deferred hi-res layer's FIT scale: what shrinks the native-size raster
 * onto the displayed box, so that a wrapper scaling it by `Z` about
 * (originX%, originY%) reproduces the base layer's zoom EXACTLY and the sharp
 * pixels can appear/disappear with zero visible shift. The origin lives on
 * the wrapper as transform-origin (not folded into a translate as it once
 * was): a translate is part of `transform`, so every pan update restarted
 * the 300 ms transform transition — a drag on the sharp layer eased and
 * lagged, and a drag during the engage glide kept restarting the glide.
 * transform-origin is not transitioned, so the origin moves instantly while
 * only the scale glides, the same as the presenter layers.
 */
export function hiResFitScale(
  rect: PaneRect | null | undefined,
  native: { w: number; h: number } | null | undefined,
): number {
  if (!rect || !native || native.w <= 0) return 1;
  return rect.width / native.w;
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
