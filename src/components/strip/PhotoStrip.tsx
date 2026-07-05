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
  similar,
  scrubbing = false,
  scrubSpeed = 1,
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
  /** Similar-set membership by image id — same box treatment as bursts, with
   *  a cooler tint and a "Similar ×N" legend. Bursts win where both would
   *  claim an id (structurally shouldn't overlap — groupSimilar excludes
   *  burst members). */
  similar?: Map<number, BurstCtx>;
  /** While scrubbing, a thin full-width position bar fades in under the
   *  cells — the strip shows ~a screenful, the bar shows where that screenful
   *  sits in the whole set. */
  scrubbing?: boolean;
  /** Staged acceleration factor (1/3/10) — >1 shows a ×N label above the
   *  bar's marker. */
  scrubSpeed?: number;
  /** Cell renderer: (imageIndex, stripPos) → the ThumbCell. */
  renderCell: (imageIndex: number, stripPos: number) => ReactNode;
}) {
  const { segs, prefix } = useMemo(
    () =>
      computeBurstSegments(
        indices.map((i) => images[i].id),
        bursts,
        similar,
      ),
    [indices, images, bursts, similar],
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
          {scrubSpeed > 1 && (
            <div className="cull-scrubbar__speed" style={{ left: `${frac * 100}%` }}>
              {scrubSpeed}×
            </div>
          )}
        </div>
      )}
    </div>
  );
}
