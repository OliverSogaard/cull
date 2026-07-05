import type { BurstCtx } from "../../smart/groupBursts";

/** Extra track space inserted before AND after each burst segment, so the box
 *  floats clear of neighbouring images. Sized so the visible dark gap from a
 *  neighbour image to the box line is 8px (4px base gap + 10 − 6px overhang). */
export const BURST_BREATH = 10;
/** Leading insertion when a segment starts DIRECTLY after another segment's
 *  end: both boxes overhang 6px, so 16px total insertion (10 + 6) makes the
 *  line-to-line gap the same 8px as the image-to-line gap. */
export const BURST_BREATH_AFTER_RUN = 6;

export type BurstSegment = {
  /** Strip-position span (inclusive). */
  start: number;
  end: number;
  group: number;
  /** The burst's TOTAL length ("Burst ×N"), regardless of how many members
   *  this strip shows. */
  len: number;
  /** Only the group's first segment (strip order) carries the ×N legend. */
  labeled: boolean;
};

/**
 * Shared burst-overlay derivation for both filmstrips. `ids` is the strip's
 * items in display order — the loupe strip passes every image (runs come out
 * contiguous), the compare strip passes the candidate SUBSET, where a run
 * interrupted by filtered-out frames yields one segment per contiguous
 * stretch (the first labeled). Also builds the gap prefix (extra track space
 * around each segment) consumed by the prefix-aware virtualizer.
 */
export function computeBurstSegments(
  ids: readonly number[],
  bursts: Map<number, BurstCtx> | undefined,
): { segs: BurstSegment[]; prefix: number[] | undefined } {
  if (!bursts || bursts.size === 0) return { segs: [], prefix: undefined };

  const segs: BurstSegment[] = [];
  const labeledGroups = new Set<number>();
  let open: BurstSegment | null = null;
  for (let i = 0; i < ids.length; i++) {
    const c = bursts.get(ids[i]);
    if (open && (!c || c.group !== open.group)) {
      segs.push(open);
      open = null;
    }
    if (c && !open) {
      open = {
        start: i,
        end: i,
        group: c.group,
        len: c.len,
        labeled: !labeledGroups.has(c.group),
      };
      labeledGroups.add(c.group);
    } else if (c && open) {
      open.end = i;
    }
  }
  if (open) segs.push(open);
  if (segs.length === 0) return { segs, prefix: undefined };

  const starts = new Set(segs.map((s) => s.start));
  const ends = new Set(segs.map((s) => s.end));
  const prefix = new Array<number>(ids.length + 1);
  let acc = 0;
  let prevWasSegEnd = false;
  for (let i = 0; i < ids.length; i++) {
    if (starts.has(i)) acc += prevWasSegEnd ? BURST_BREATH_AFTER_RUN : BURST_BREATH;
    prefix[i] = acc;
    prevWasSegEnd = ends.has(i);
    if (prevWasSegEnd) acc += BURST_BREATH; // space AFTER a segment
  }
  prefix[ids.length] = acc;
  return { segs, prefix };
}
