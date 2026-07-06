// src/components/gridWindow.ts
/**
 * Pure windowing math for the grid's row virtualizer — the vertical sibling of
 * `strip/computeWindow.ts` (same contract: pure, no DOM, unit-tested). GridView
 * renders rows [firstRow, lastRow) and auto-scrolls with the selection; both
 * computations MUST agree within one commit — the scrub-flash bug was GridView
 * writing a multi-row scrollTop in a layout effect while the window still
 * derived from the previous frame's scroll state.
 */

export type GridWindow = { firstRow: number; lastRow: number };

/** Rendered row range [firstRow, lastRow) for a scroll position, `buffer`
 *  overscan rows on each side (manual-drag margin, same idea as the strip's
 *  STRIP_BUFFER). */
export function computeGridWindow(args: {
  scrollTop: number;
  viewportH: number;
  rowH: number;
  totalRows: number;
  buffer: number;
}): GridWindow {
  const { scrollTop, viewportH, rowH, totalRows, buffer } = args;
  if (totalRows <= 0 || rowH <= 0) return { firstRow: 0, lastRow: 0 };
  const firstRow = Math.max(0, Math.floor(scrollTop / rowH) - buffer);
  const lastRow = Math.min(totalRows, Math.ceil((scrollTop + viewportH) / rowH) + buffer);
  return { firstRow, lastRow };
}

/**
 * Auto-scroll target keeping the selected cell (`pos` = index into the
 * filtered display list) in view. Returns the scrollTop to write, or `null`
 * when the cell is already fully visible (no write — a scroll event would
 * churn for nothing). `pos === -1` (current frame filtered out, e.g. right
 * after compare exits onto a re-rated frame) pins the grid to the top instead
 * of leaving it wedged mid-scroll looking broken.
 */
export function computeGridAutoScrollTop(args: {
  pos: number;
  cols: number;
  rowH: number;
  scrollTop: number;
  viewportH: number;
}): number | null {
  const { pos, cols, rowH, scrollTop, viewportH } = args;
  if (pos === -1) return 0;
  const row = Math.floor(pos / cols);
  const cellTop = row * rowH;
  const cellBottom = cellTop + rowH;
  if (cellTop < scrollTop) return cellTop;
  if (cellBottom > scrollTop + viewportH) return cellBottom - viewportH;
  return null;
}
