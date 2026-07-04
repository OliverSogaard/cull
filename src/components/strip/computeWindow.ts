// src/components/strip/computeWindow.ts
export type WindowRange = { first: number; last: number };

export function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

/**
 * Visible cell range [first, last) for a horizontal strip, given the scroll
 * position and viewport width. Pure — no DOM. `buffer` extends the range on
 * each side so a manual drag reveals already-rendered cells.
 */
/**
 * Optional cumulative gap offsets (burst breathing room): `prefix[i]` = total
 * extra px inserted before cell i, monotone non-decreasing, length count+1
 * (`prefix[count]` = total extra, for the track width). Cell i renders at
 * `i * stride + prefix[i]`.
 */
export function cellX(i: number, stride: number, prefix?: readonly number[]): number {
  return i * stride + (prefix?.[i] ?? 0);
}

/** Smallest i in [0, count] with pred(i) true; pred must be monotone. */
function lowerBound(count: number, pred: (i: number) => boolean): number {
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pred(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

export function computeWindow(args: {
  scrollLeft: number;
  clientWidth: number;
  stride: number;
  count: number;
  buffer: number;
  prefix?: readonly number[];
}): WindowRange {
  const { scrollLeft, clientWidth, stride, count, buffer, prefix } = args;
  if (count <= 0 || stride <= 0) return { first: 0, last: 0 };
  if (!prefix) {
    // Linear fast path (no gaps) — the every-scrub-frame common case.
    const first = clamp(Math.floor(scrollLeft / stride) - buffer, 0, count);
    const last = clamp(Math.ceil((scrollLeft + clientWidth) / stride) + buffer, 0, count);
    return { first, last };
  }
  // Gap-aware: positions are monotone, so binary-search the boundaries.
  // first = smallest i whose right edge passes scrollLeft; last = smallest i
  // starting at/after the right viewport edge (exclusive end).
  const firstRaw = lowerBound(count, (i) => cellX(i, stride, prefix) + stride > scrollLeft);
  const lastRaw = lowerBound(count, (i) => cellX(i, stride, prefix) >= scrollLeft + clientWidth);
  return {
    first: clamp(firstRaw - buffer, 0, count),
    last: clamp(lastRaw + buffer, 0, count),
  };
}

/**
 * scrollLeft that centers cell `centerOffset` in the viewport, clamped to the
 * scrollable range. At the list ends the cell sits off-center (same as the old
 * `scrollIntoView({ inline: "center" })` clamp).
 */
export function computeCenterScrollLeft(args: {
  centerOffset: number;
  stride: number;
  cellWidth: number;
  clientWidth: number;
  trackWidth: number;
  prefix?: readonly number[];
}): number {
  const { centerOffset, stride, cellWidth, clientWidth, trackWidth, prefix } = args;
  const target = cellX(centerOffset, stride, prefix) - (clientWidth - cellWidth) / 2;
  const max = Math.max(0, trackWidth - clientWidth);
  return clamp(target, 0, max);
}
