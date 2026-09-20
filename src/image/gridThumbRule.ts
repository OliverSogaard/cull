/**
 * When a grid cell needs more pixels than the embedded THMB has.
 *
 * The grid paints the CR3's 160×120 THMB. A cell's painted image box is the
 * cell minus its own padding on both sides (.cull-grid__cell { padding: 9px },
 * styles/grid.css — gridThumbRule.test.ts reads that rule and fails if it
 * moves), so the demand in DEVICE pixels is (cellW − 18) × devicePixelRatio.
 * Above 160 the THMB is being upscaled and the grid tier is worth fetching;
 * at or below it, the THMB is still a downscale and the sharper tier would be
 * bytes for nothing.
 *
 * Pure, so the one number that decides whether 2,726 files get read is a
 * tested function rather than an inline comparison.
 */

/** `.cull-grid__cell`'s padding, per side. */
export const GRID_CELL_PADDING = 9;
/** The embedded THMB's long edge (src-tauri/src/cr3.rs — 160×120). */
export const THMB_LONG_EDGE = 160;

/** The painted image box in device pixels for a cell of `cellW` CSS px. */
export function gridFrameDevicePx(cellW: number, dpr: number): number {
  return (cellW - GRID_CELL_PADDING * 2) * dpr;
}

/** True when the cell is painting the THMB larger than it is. */
export function wantsGridThumb(cellW: number, dpr: number): boolean {
  return cellW > 0 && gridFrameDevicePx(cellW, dpr) > THMB_LONG_EDGE;
}
