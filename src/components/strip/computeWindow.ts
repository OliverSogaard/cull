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
export function computeWindow(args: {
  scrollLeft: number;
  clientWidth: number;
  stride: number;
  count: number;
  buffer: number;
}): WindowRange {
  const { scrollLeft, clientWidth, stride, count, buffer } = args;
  if (count <= 0 || stride <= 0) return { first: 0, last: 0 };
  const first = clamp(Math.floor(scrollLeft / stride) - buffer, 0, count);
  const last = clamp(Math.ceil((scrollLeft + clientWidth) / stride) + buffer, 0, count);
  return { first, last };
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
}): number {
  const { centerOffset, stride, cellWidth, clientWidth, trackWidth } = args;
  const target = centerOffset * stride - (clientWidth - cellWidth) / 2;
  const max = Math.max(0, trackWidth - clientWidth);
  return clamp(target, 0, max);
}
