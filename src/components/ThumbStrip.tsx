// src/components/ThumbStrip.tsx
import { useMemo } from "react";
import type { Img, ImageMetadata, Rating } from "../types";
import type { Suggestion } from "../smart/deriveVerdict";
import type { BurstCtx } from "../smart/groupBursts";
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

  // One hairline box per burst RUN (bursts are contiguous in capture order, so
  // a run is a [first..last] index span), with the count riding the top-left
  // of the outline. Drawn as track overlays so the box spans the gaps between
  // cells — a per-cell border can't read as "one long square".
  const burstBoxes = useMemo(() => {
    if (!bursts || bursts.size === 0) return null;
    const runs = new Map<number, { first: number; last: number; len: number }>();
    images.forEach((im, i) => {
      const c = bursts.get(im.id);
      if (!c) return;
      const r = runs.get(c.group);
      if (!r) runs.set(c.group, { first: i, last: i, len: c.len });
      else {
        r.first = Math.min(r.first, i);
        r.last = Math.max(r.last, i);
      }
    });
    return [...runs.entries()].map(([group, r]) => (
      <div
        key={`burst-${group}`}
        className="cull-burst-box"
        style={{
          left: r.first * CELL_STRIDE - 3,
          width: (r.last - r.first) * CELL_STRIDE + CELL_W + 6,
        }}
        aria-hidden
      >
        <span className="cull-burst-box__count">×{r.len}</span>
      </div>
    ));
  }, [bursts, images]);

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
          burst={bursts?.get(images[i].id) ?? null}
        />
      )}
    />
  );
}
