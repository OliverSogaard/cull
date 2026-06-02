// src/components/ThumbStrip.tsx
import { useMemo } from "react";
import type { Img, ImageMetadata, Rating } from "../types";
import { ThumbCell } from "./ThumbCell";
import { FilmStrip } from "./strip/FilmStrip";
import { CELL_H, CELL_STRIDE, CELL_W, STRIP_BUFFER } from "./strip/metrics";

/**
 * The loupe's filmstrip. Renders every image in the staged set, virtualized via
 * {@link FilmStrip}: only ~viewport+buffer cells around the cursor are live.
 * Cells outside the active filter are dimmed (not hidden) so the user can see
 * what's around them in capture order. Centering is an instant scrollLeft write
 * (smooth scrolling can't keep up with hold-to-scrub).
 */
export function ThumbStrip({
  images,
  currentIndex,
  ratings,
  visibleIndices,
  metadata,
  onPick,
}: {
  images: Img[];
  currentIndex: number;
  ratings: Record<number, Rating>;
  visibleIndices: number[];
  /** Optional metadata map; only `lrcRating` is read here for the corner badge. */
  metadata?: Record<string, ImageMetadata>;
  onPick: (index: number) => void;
}) {
  const visibleSet = useMemo(() => new Set(visibleIndices), [visibleIndices]);

  return (
    <FilmStrip
      className="cull-thumbs"
      count={images.length}
      stride={CELL_STRIDE}
      cellWidth={CELL_W}
      trackHeight={CELL_H}
      centerOffset={currentIndex}
      buffer={STRIP_BUFFER}
      keyForItem={(i) => images[i].id}
      renderItem={(i) => (
        <ThumbCell
          img={images[i]}
          index={i}
          isCurrent={i === currentIndex}
          rating={ratings[images[i].id]}
          lrcRating={metadata?.[images[i].path]?.lrcRating ?? null}
          dimmed={!visibleSet.has(i)}
          onPick={onPick}
        />
      )}
    />
  );
}
