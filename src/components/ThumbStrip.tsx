// src/components/ThumbStrip.tsx
import { useMemo } from "react";
import type { Img, ImageMetadata, Rating } from "../types";
import type { Suggestion } from "../smart/deriveVerdict";
import type { BurstCtx } from "../smart/groupBursts";
import { ThumbCell } from "./ThumbCell";
import { FilmStrip } from "./strip/FilmStrip";
import { burstBoxOverlays } from "./strip/BurstBoxes";
import { computeBurstSegments } from "./strip/burstSegments";
import { CELL_H, CELL_STRIDE, CELL_W, STRIP_BUFFER } from "./strip/metrics";

/**
 * The loupe's filmstrip. Renders every image in the staged set, virtualized via
 * {@link FilmStrip}: only ~viewport+buffer cells around the cursor are live.
 * Cells outside the active filter are dimmed (not hidden) so the user can see
 * what's around them in capture order. Centering is an instant scrollLeft write
 * (smooth scrolling can't keep up with hold-to-scrub).
 *
 * Burst runs get outlined boxes with extra track space around them (the
 * shared strip/burstSegments derivation — the compare strip renders the same
 * overlay, so the two match).
 */
export function ThumbStrip({
  images,
  currentIndex,
  ratings,
  visibleIndices,
  metadata,
  onPick,
  suggestions,
  bursts,
}: {
  images: Img[];
  currentIndex: number;
  ratings: Record<number, Rating>;
  visibleIndices: number[];
  /** Optional metadata map; only `lrcRating` is read here for the corner badge. */
  metadata?: Record<string, ImageMetadata>;
  onPick: (index: number) => void;
  /** Smart-culling ghost suggestions by image id (unrated frames only). */
  suggestions?: Record<number, Suggestion>;
  /** Burst membership by image id. */
  bursts?: Map<number, BurstCtx>;
}) {
  const visibleSet = useMemo(() => new Set(visibleIndices), [visibleIndices]);

  const { segs, prefix } = useMemo(
    () =>
      computeBurstSegments(
        images.map((im) => im.id),
        bursts,
      ),
    [images, bursts],
  );
  const burstBoxes = useMemo(
    () => (segs.length > 0 ? burstBoxOverlays(segs, prefix) : null),
    [segs, prefix],
  );

  return (
    <FilmStrip
      className="cull-thumbs"
      count={images.length}
      stride={CELL_STRIDE}
      cellWidth={CELL_W}
      trackHeight={CELL_H}
      centerOffset={currentIndex}
      buffer={STRIP_BUFFER}
      overlays={burstBoxes}
      prefix={prefix}
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
          suggestion={suggestions?.[images[i].id] ?? null}
        />
      )}
    />
  );
}
