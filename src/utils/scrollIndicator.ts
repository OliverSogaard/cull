/**
 * Pure geometry for a custom scroll-position indicator (used by GridView's
 * right-edge minimap, mirroring the loupe strip's scrub position bar). Given
 * the scrolled distance, the viewport height, and the full scrollable content
 * height, returns where the thumb sits and how tall it is — both expressed
 * as fractions of the TRACK, which is exactly `viewportH` tall (the track is
 * sticky-pinned to the viewport, so it never joins the scroll flow).
 */

/** Thumb never shrinks below this fraction of the track, so it stays visible
 *  (and readable as "there's more content") even for huge grids. */
const MIN_THUMB_FRAC = 0.03;

export interface ScrollIndicatorGeometry {
  /** Thumb top offset, as a fraction (0–1) of the track height. */
  topFrac: number;
  /** Thumb height, as a fraction (0–1) of the track height. */
  heightFrac: number;
}

const FULL_TRACK: ScrollIndicatorGeometry = { topFrac: 0, heightFrac: 1 };

/**
 * Computes the indicator thumb's position and extent. Returns a full-height,
 * zero-offset thumb (the caller should simply not render it) when there is
 * nothing to scroll — no content, no viewport, or content that already fits.
 */
export function computeScrollIndicator(
  scrollTop: number,
  viewportH: number,
  totalH: number,
): ScrollIndicatorGeometry {
  if (viewportH <= 0 || totalH <= viewportH) return FULL_TRACK;

  const heightFrac = Math.min(1, Math.max(MIN_THUMB_FRAC, viewportH / totalH));
  const maxScroll = totalH - viewportH;
  const clampedScrollTop = Math.min(maxScroll, Math.max(0, scrollTop));
  const scrollFrac = clampedScrollTop / maxScroll;
  const topFrac = scrollFrac * (1 - heightFrac);

  return { topFrac, heightFrac };
}
