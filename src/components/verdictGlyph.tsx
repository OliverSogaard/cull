import { Check, Star, X as XIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { Rating } from "../types";

/**
 * The verdict glyph (✓ / ✕ / ★) as a Lucide SVG icon — intrinsically centered,
 * unlike Unicode glyphs whose metrics drift across system fonts on Windows.
 * Shared by the grid and filmstrip cells (which pass size 12 / 9). `null` for
 * unrated. Stroke is per-glyph (keep/reject 3, favorite 2.6), not size-based.
 */
export function verdictGlyph(rating: Rating | undefined, size: number): ReactNode {
  switch (rating) {
    case "keep":
      return <Check size={size} color="#0a0a0c" strokeWidth={3} />;
    case "reject":
      return <XIcon size={size} color="#0a0a0c" strokeWidth={3} />;
    case "favorite":
      return <Star size={size} color="#0a0a0c" strokeWidth={2.6} fill="#0a0a0c" />;
    default:
      return null;
  }
}

/** The rating-dot CSS modifier class for a verdict, given the cell's class prefix. */
export function verdictDotClass(
  rating: Rating | undefined,
  prefix: "cull-grid__dot" | "cull-thumb__dot",
): string {
  switch (rating) {
    case "keep":
      return `${prefix}--keep`;
    case "reject":
      return `${prefix}--reject`;
    case "favorite":
      return `${prefix}--fav`;
    default:
      return "";
  }
}
