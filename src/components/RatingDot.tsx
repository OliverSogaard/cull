import { Check, Star, X as XIcon } from "lucide-react";
import type { Rating } from "../types";
import { RATING_COLOR } from "../utils/ratingColor";

/**
 * A single rating chip — coloured circle with a centered glyph (✓ / ✕ / ★).
 *
 * The glyph is rendered as a Lucide SVG icon (not a Unicode character) because
 * Unicode glyphs like ★ ✓ ✕ have inconsistent baselines / visual centerlines
 * across system fonts on Windows vs. macOS, which broke `flex; center; center`
 * centering for the star in particular. SVG icons are intrinsically centered.
 *
 * Three sizes:
 *  - `lg` — the big persistent dot in the loupe corner / feedback popup
 *  - `md` — thumbnail strip cells, grid cells, compare panes
 *  - `sm` — inline contexts where the dot just signals "rated" (no glyph drawn)
 */
export function RatingDot({ rating, size }: { rating: Rating; size: "lg" | "md" | "sm" }) {
  const dim = size === "lg" ? 24 : size === "md" ? 18 : 11;
  // Glyph stroke / size proportions tuned to read clearly at small sizes.
  const glyphSize = Math.round(dim * 0.62);
  const stroke = size === "lg" ? 3 : 2.6;
  // Accessible label so the verdict isn't conveyed by colour alone (WCAG 1.4.1).
  // Covers the `sm` size too, which draws no glyph at all.
  const label = rating === "keep" ? "Kept" : rating === "reject" ? "Rejected" : "Favorite";
  return (
    <div
      className="cull-rating-dot"
      role="img"
      aria-label={label}
      style={{ width: dim, height: dim, backgroundColor: RATING_COLOR[rating] }}
    >
      {size !== "sm" &&
        (rating === "keep" ? (
          <Check size={glyphSize} color="#0a0a0c" strokeWidth={stroke} />
        ) : rating === "reject" ? (
          <XIcon size={glyphSize} color="#0a0a0c" strokeWidth={stroke} />
        ) : (
          <Star size={glyphSize} color="#0a0a0c" strokeWidth={stroke} fill="#0a0a0c" />
        ))}
    </div>
  );
}
