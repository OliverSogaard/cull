/**
 * Transparent inline-SVG data URI whose intrinsic width/height carry an aspect
 * ratio. Used as an in-flow "sizer" <img> so a photo matte is sized by the
 * KNOWN display ratio — never by whatever pixels happen to be decoded (the THMB
 * is tiny; a mid-decode full is 0). Renders nothing. Rendered by PhotoPane
 * (the unified loupe/compare pane).
 */
export const sizerSrc = (w: number, h: number): string =>
  `data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='${w}'%20height='${h}'%2F%3E`;
