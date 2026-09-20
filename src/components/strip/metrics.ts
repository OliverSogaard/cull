// src/components/strip/metrics.ts
/**
 * Filmstrip cell geometry — ONE source of truth, shared by FilmStrip, the
 * virtualizer math, the burst overlays and (as custom properties pushed onto
 * the strip's wrapper by PhotoStrip) the stylesheet. metrics.test.ts reads
 * styles/strip.css raw and fails if the two ever disagree.
 *
 * Two steps: the standard cell, and a bigger one on a tall window (≥1200 CSS
 * px of window height — a maximized 1440p or 4K screen). The THMB behind a
 * cell is 160×120, so even the big step is still a downscale at DPR 1.5
 * (104 × 1.5 = 156 device px) — but not at DPR 2 on a ≥1200-px-tall window
 * (104 × 2 = 208 device px, past the 160 source), where the cell is a
 * (mild) upscale instead.
 */
export type StripMetrics = {
  /** Cell width in CSS px. */
  cellW: number;
  /** Cell height in CSS px. */
  cellH: number;
  /** Per-cell horizontal stride: the frame plus one gap. */
  stride: number;
  /** `.cull-thumbs`' BORDER-box height. The 20px top padding is the burst
   *  legend's headroom (the ×N count sits OUTSIDE the box's top-left corner),
   *  the 8px bottom is the scrub bar's, and the 1px is the border-top. */
  stripH: number;
};

/** Horizontal gap between cells. Lives in `stride`, never in CSS. */
export const CELL_GAP = 4;
/** Burst-legend headroom above the cells (see styles/strip.css). */
export const STRIP_TOP_PAD = 20;
/** Breathing room under the cells, where the scrub bar rides. */
export const STRIP_BOTTOM_PAD = 8;
/** The strip's 1px border (top, or bottom when the strip sits above the photo). */
export const STRIP_BORDER = 1;
/** Cells rendered beyond the visible viewport on each side (manual-drag margin). */
export const STRIP_BUFFER = 4;

const step = (cellW: number, cellH: number): StripMetrics => ({
  cellW,
  cellH,
  stride: cellW + CELL_GAP,
  stripH: STRIP_TOP_PAD + cellH + STRIP_BOTTOM_PAD + STRIP_BORDER,
});

/** The standard step. Also the `:root` fallback in styles/tokens.css. */
export const STRIP_SMALL: StripMetrics = step(76, 54);
/** The tall-window step. */
export const STRIP_LARGE: StripMetrics = step(104, 74);

/** The one media query that chooses the step (see useStripMetrics). */
export const STRIP_TALL_QUERY = "(min-height: 1200px)";

/** Identity-stable: returns one of the two module constants, never a fresh
 *  object — the value is a FilmStrip prop and a useMemo dependency. */
export function stripMetricsFor(tall: boolean): StripMetrics {
  return tall ? STRIP_LARGE : STRIP_SMALL;
}
