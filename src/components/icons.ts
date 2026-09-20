/**
 * The one icon scale.
 *
 * Every Lucide icon in the chrome picks a step and spreads it:
 * `<Check {...ICON.md} aria-hidden />`. Three steps, not seven sizes and five
 * strokes — the stroke lightens as the icon grows so the drawn weight stays
 * even, which is what makes a row of unrelated icons look like one set.
 *
 * Which step: `sm` inside mono micro-labels and chips (9–11px text), `md`
 * beside body copy (12–13px), `lg` in a dialog title (16px+).
 *
 * Colour is never set here — icons inherit `currentColor` from the element
 * they sit in, so a warning turns red because its note is red.
 */
export const ICON = {
  sm: { size: 12, strokeWidth: 1.75 },
  md: { size: 14, strokeWidth: 1.75 },
  lg: { size: 16, strokeWidth: 1.5 },
} as const;

/**
 * Stroke for the two DISPLAY glyphs, which keep their own size because the
 * size is the point: the 40px staged tick and the 36px drop-target arrow are
 * the largest thing on their screen. Only their weight joins the scale.
 */
export const ICON_DISPLAY_STROKE = 1.5;

/*
 * OFF-SCALE BY DESIGN — four families whose size is dictated by a fixed-size
 * container they have to fill, not by taste. Growing them to a scale step
 * would overflow the box; shrinking the box is a layout change, not an icon
 * change. Each is tuned to its container and stays:
 *
 * 1. Verdict glyphs inside the rating dots (verdictGlyph.tsx, RatingDot.tsx,
 *    and the `size` VerdictDot is given by ThumbCell.tsx / GridView.tsx /
 *    StatusBar.tsx). The dot is 9–18px of coloured circle; the glyph is a
 *    fraction of it, and the heavy stroke is what keeps a 5px tick legible.
 * 2. The LrC star badges pinned to a cell corner (GridView.tsx,
 *    ThumbCell.tsx) — 8–11px to fit the badge pill on a 76px thumbnail.
 * 3. The 22px / stroke 3 glyph inside the 48px rating-feedback pop
 *    (App.tsx, `.cull-feedback__circle`), sized against that circle.
 * 4. The window controls (WindowControls.tsx), whose 13px / 11px icons follow
 *    the Windows caption-button metric so CULL's title bar matches every
 *    other window on the desktop. Their STROKE is on the scale (1.5).
 */
