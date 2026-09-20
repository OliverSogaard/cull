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
 *  measurement (contentWidth 0) it answers the medium target, so the very
 *  first paint is the size the grid is about to become. */
export function gridCellWidth(contentWidth: number, cols: number): number {
  return contentWidth > 0 ? Math.floor(contentWidth / cols) : GRID_CELL_TARGET[DEFAULT_GRID_SIZE];
}
