// src/components/ThumbStrip.tsx
import { useMemo } from "react";
import type { Img, ImageMetadata, Rating } from "../types";
import type { Suggestion } from "../smart/deriveVerdict";
import type { BurstCtx } from "../smart/groupBursts";
import { ThumbCell } from "./ThumbCell";
import { FilmStrip } from "./strip/FilmStrip";
import { cellX } from "./strip/computeWindow";
import { CELL_H, CELL_STRIDE, CELL_W, STRIP_BUFFER } from "./strip/metrics";

/** Extra track space inserted before AND after each burst run, so the run box
 *  floats clear of neighbouring images (and of the next burst's box). */
const BURST_BREATH = 10;

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

  // Burst runs as [first..last] index spans (bursts are contiguous in capture
  // order), plus a cumulative gap prefix: BURST_BREATH px of extra track space
  // inserted before and after every run, so the box outline gets real
  // clearance from neighbouring images — and two adjacent bursts can never
  // touch outlines. The virtualizer is prefix-aware (binary-searched window).
  const { burstRuns, gapPrefix } = useMemo(() => {
    if (!bursts || bursts.size === 0) {
      return { burstRuns: null, gapPrefix: undefined };
    }
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
    const prefix = new Array<number>(images.length + 1);
    let acc = 0;
    for (let i = 0; i < images.length; i++) {
      const c = bursts.get(images[i].id);
      if (c && c.pos === 1) acc += BURST_BREATH; // extra space BEFORE a run
      prefix[i] = acc;
      if (c && c.pos === c.len) acc += BURST_BREATH; // and AFTER it
    }
    prefix[images.length] = acc;
    return { burstRuns: runs, gapPrefix: prefix };
  }, [bursts, images]);

  const burstBoxes = useMemo(() => {
    if (!burstRuns) return null;
    const x = (i: number) => cellX(i, CELL_STRIDE, gapPrefix);
    return [...burstRuns.entries()].map(([group, r]) => (
      // A real <fieldset>/<legend>: the browser natively leaves a gap in the
      // border behind the legend — no background masks, no z-index tricks,
      // nothing that can misalign with font metrics.
      <fieldset
        key={`burst-${group}`}
        className="cull-burst-box"
        style={{
          // 4px air from cell edge to the line's INNER face on both sides
          // (box-sizing: border-box; 2px border ⇒ ±6 outside the cells).
          left: x(r.first) - 6,
          width: x(r.last) - x(r.first) + CELL_W + 12,
        }}
        aria-hidden
      >
        <legend className="cull-burst-box__count">Burst ×{r.len}</legend>
      </fieldset>
    ));
  }, [burstRuns, gapPrefix]);

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
      prefix={gapPrefix}
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
