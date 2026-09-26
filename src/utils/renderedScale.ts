/**
 * The scale a zoom layer is ACTUALLY painted at right now — mid-glide
 * included. `getComputedStyle().transform` reports the interpolated
 * `matrix(a, b, c, d, tx, ty)` of a running transition, and for a pure
 * uniform scale `a` is that scale. "none" (not zoomed, or the transition
 * has not started) reads as 1.
 *
 * The grab-pan needs this and not the target zoom: dragging by dx pixels
 * has to move the origin by dx / (Z − 1), and during the 300 ms engage glide
 * the target Z overstates the divisor several-fold, which made a drag during
 * the glide crawl and then lurch as the scale caught up.
 */
export function parseRenderedScale(transform: string | null | undefined): number {
  if (!transform || transform === "none") return 1;
  const m = /^matrix\(\s*([-\d.eE+]+)\s*,/.exec(transform);
  if (!m) return 1;
  const a = Number(m[1]);
  return Number.isFinite(a) && a > 0 ? a : 1;
}

export function readRenderedScale(el: Element | null): number {
  if (!el) return 1;
  return parseRenderedScale(getComputedStyle(el).transform);
}
