import type { GridSize } from "../types/settings";

/**
 * Contact-sheet sizing. Pure: GridView and App both derive their numbers from
 * here so `cols` and `cellW` can never come from two different formulas.
 *
 * cols = max(2, floor(contentW / target)); cellW = floor(contentW / cols);
 * rows are square (GridView sets rowH = cellW). Unchanged from the single-size
 * version — only the target moved from a constant to a three-way choice.
 */
export const GRID_SIZES = ["small", "medium", "large"] as const satisfies readonly GridSize[];

/**
 * Column target per step. MEDIUM IS 168, not the board's 176: at 2560 both
 * give 14 columns, but at the 1600 default window 176 drops one — and Medium
 * has to be today's grid at EVERY window size, which is what it promised.
 */
export const GRID_CELL_TARGET: Record<GridSize, number> = {
  small: 128,
  medium: 168,
  large: 256,
};

export const DEFAULT_GRID_SIZE: GridSize = "medium";

export function isGridSize(v: unknown): v is GridSize {
  return typeof v === "string" && (GRID_SIZES as readonly string[]).includes(v);
}

/** One step, clamped at both ends — the grid never wraps small↔large. */
export function stepGridSize(current: GridSize, dir: 1 | -1): GridSize {
  const at = GRID_SIZES.indexOf(current);
  const next = Math.min(GRID_SIZES.length - 1, Math.max(0, at + dir));
  return GRID_SIZES[next];
}

/** Columns for a measured content width (padding already subtracted). */
export function gridColsFor(contentWidth: number, size: GridSize): number {
  return Math.max(2, Math.floor(contentWidth / GRID_CELL_TARGET[size]));
}

/** Cell width for a measured content width and column count. Before the first
 *  measurement (contentWidth 0) it falls back to the medium target — a stable
 *  placeholder to render before the ResizeObserver reports the real content
 *  width, not a prediction of the grid's eventual size. */
export function gridCellWidth(contentWidth: number, cols: number): number {
  return contentWidth > 0 ? Math.floor(contentWidth / cols) : GRID_CELL_TARGET[DEFAULT_GRID_SIZE];
}

/** Minimum time between committed grid-size wheel steps. A precision-touchpad
 *  pinch fires dozens of ctrl+wheel events 5-10ms apart, each closing over
 *  whatever size was current when it landed — without a floor, one gesture
 *  slams straight to an end and Medium becomes unreachable by wheel. No rAF
 *  coalescing: the display this runs on is 240 Hz, so a rAF-throttled step
 *  would drop most of a fast gesture's events instead of spacing them; an
 *  explicit millisecond cooldown is the throttle instead. */
export const GRID_WHEEL_COOLDOWN_MS = 160;

/** True once `GRID_WHEEL_COOLDOWN_MS` has elapsed since the last committed
 *  wheel step. `lastStepMs` is `-Infinity` for "no step has happened yet",
 *  which makes the very first wheel event due regardless of `nowMs`. */
export function wheelStepDue(nowMs: number, lastStepMs: number): boolean {
  return nowMs - lastStepMs >= GRID_WHEEL_COOLDOWN_MS;
}
