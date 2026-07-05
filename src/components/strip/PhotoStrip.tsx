import { useMemo } from "react";
import type { ReactNode } from "react";
import type { Img } from "../../types";
import type { BurstCtx } from "../../smart/groupBursts";
import { FilmStrip } from "./FilmStrip";
import { burstBoxOverlays } from "./BurstBoxes";
import { computeBurstSegments } from "./burstSegments";
import { CELL_H, CELL_STRIDE, CELL_W, STRIP_BUFFER } from "./metrics";

/**
 * THE filmstrip — one component for the loupe strip and the compare strip
 * (they are visually identical; only the cells differ: ratings/suggestions in
 * loupe, champion/challenger roles in compare). Owns the FilmStrip
 * virtualization plumbing and the burst-run overlay (segments, breathing-gap
 * prefix, outlined boxes), so the burst UI can never drift between the two.
 */
export function PhotoStrip({
  images,
  indices,
  centerPos,
  bursts,
  scrubbing = false,
  renderCell,
}: {
  images: Img[];
  /** Positions into `images`, in display order — the loupe passes every
   *  frame; compare passes the unrated subset (plus the champion ghost). */
  indices: readonly number[];
  /** Strip position (index into `indices`) to keep centered. */
  centerPos: number;
  /** Burst membership by image id — runs split by absent frames render one
   *  box per contiguous stretch, only the first labeled. */
  bursts?: Map<number, BurstCtx>;
  /** While scrubbing, a thin full-width position bar fades in under the
   *  cells — the strip shows ~a screenful, the bar shows where that screenful
   *  sits in the whole set. */
  scrubbing?: boolean;
  /** Cell renderer: (imageIndex, stripPos) → the ThumbCell. */
  renderCell: (imageIndex: number, stripPos: number) => ReactNode;
}) {
  const { segs, prefix } = useMemo(
    () =>
      computeBurstSegments(
        indices.map((i) => images[i].id),
        bursts,
      ),
    [indices, images, bursts],
  );
  const burstBoxes = useMemo(
    () => (segs.length > 0 ? burstBoxOverlays(segs, prefix) : null),
    [segs, prefix],
  );

  // Scrub position bar: fraction of the way through the DISPLAY list.
  const frac =
    indices.length > 1 ? Math.max(0, Math.min(1, centerPos / (indices.length - 1))) : 0;

  return (
    <div className="cull-strip-wrap">
      <FilmStrip
        className="cull-thumbs"
        count={indices.length}
        stride={CELL_STRIDE}
        cellWidth={CELL_W}
        trackHeight={CELL_H}
        centerOffset={centerPos}
        buffer={STRIP_BUFFER}
        overlays={burstBoxes}
        prefix={prefix}
        keyForItem={(i) => images[indices[i]].id}
        renderItem={(i) => renderCell(indices[i], i)}
      />
      {indices.length > 1 && (
        <div className={`cull-scrubbar${scrubbing ? " is-on" : ""}`} aria-hidden>
          <div className="cull-scrubbar__thumb" style={{ left: `${frac * 100}%` }} />
        </div>
      )}
    </div>
  );
}
