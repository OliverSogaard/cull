import { useLayoutEffect, useMemo, useRef } from "react";
import type { Img, ImageMetadata, Rating } from "../types";
import { CELL_STRIDE, STRIP_RADIUS, ThumbCell } from "./ThumbCell";
import type { BlurInfo } from "../utils/bundle";

/**
 * The loupe's bottom filmstrip. Renders every image in the staged set, but
 * virtualised: only a window of `STRIP_RADIUS` cells around the cursor is live,
 * padded by spacers reproducing the full scroll width on either side. Cells
 * outside the active filter are dimmed (not hidden) so the user can see
 * what's around them in capture order.
 *
 * Scroll behaviour is deliberately INSTANT (`behavior: "auto"`). Smooth
 * scrolling can't keep up with the hold-to-scrub cadence — overlapping
 * animations stutter and visibly skip cells — so instant re-centering at the
 * step rate is what reads as fluid scrolling.
 */
export function ThumbStrip({
  images,
  currentIndex,
  ratings,
  visibleIndices,
  thumbnails,
  blurhashes,
  metadata,
  loadThumbnail,
  onPick,
}: {
  images: Img[];
  currentIndex: number;
  ratings: Record<number, Rating>;
  visibleIndices: number[];
  thumbnails: Record<string, string>;
  /** Per-image blurhash placeholders, shown before each thumbnail JPEG loads. */
  blurhashes?: Record<string, BlurInfo>;
  /** Optional metadata map; only `lrcRating` is read here for the corner badge. */
  metadata?: Record<string, ImageMetadata>;
  loadThumbnail: (path: string, index?: number) => void;
  onPick: (index: number) => void;
}) {
  const stripRef = useRef<HTMLDivElement>(null);
  const visibleSet = useMemo(() => new Set(visibleIndices), [visibleIndices]);

  useLayoutEffect(() => {
    const el = stripRef.current?.querySelector(`[data-idx="${currentIndex}"]`);
    el?.scrollIntoView({ behavior: "auto", block: "nearest", inline: "center" });
  }, [currentIndex]);

  const first = Math.max(0, currentIndex - STRIP_RADIUS);
  const last = Math.min(images.length, currentIndex + STRIP_RADIUS + 1);
  const leftPad = first * CELL_STRIDE;
  const rightPad = (images.length - last) * CELL_STRIDE;

  return (
    <footer className="cull-thumbs" ref={stripRef}>
      {leftPad > 0 && <div style={{ flex: `0 0 ${leftPad}px` }} aria-hidden />}
      {images.slice(first, last).map((img, k) => {
        const i = first + k;
        return (
          <ThumbCell
            key={img.id}
            img={img}
            index={i}
            isCurrent={i === currentIndex}
            rating={ratings[img.id]}
            lrcRating={metadata?.[img.path]?.lrcRating ?? null}
            dimmed={!visibleSet.has(i)}
            url={thumbnails[img.path]}
            blur={blurhashes?.[img.path]}
            loadThumbnail={loadThumbnail}
            onPick={onPick}
          />
        );
      })}
      {rightPad > 0 && <div style={{ flex: `0 0 ${rightPad}px` }} aria-hidden />}
    </footer>
  );
}
