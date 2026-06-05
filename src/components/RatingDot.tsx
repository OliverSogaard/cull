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
 * Rendered in the compare panes. (Earlier `lg`/`sm` size variants — a loupe-corner
 * dot and a glyphless inline dot — were removed when those call sites went away.)
 */
export function RatingDot({ rating }: { rating: Rating }) {
  const dim = 18;
  // Glyph stroke / size proportions tuned to read clearly at this size.
  const glyphSize = Math.round(dim * 0.62);
  const stroke = 2.6;
  // Accessible label so the verdict isn't conveyed by colour alone (WCAG 1.4.1).
  const label = rating === "keep" ? "Kept" : rating === "reject" ? "Rejected" : "Favorite";
  return (
    <div
      className="cull-rating-dot"
      role="img"
      aria-label={label}
      style={{ width: dim, height: dim, backgroundColor: RATING_COLOR[rating] }}
    >
      {rating === "keep" ? (
        <Check size={glyphSize} color="#0a0a0c" strokeWidth={stroke} />
      ) : rating === "reject" ? (
        <XIcon size={glyphSize} color="#0a0a0c" strokeWidth={stroke} />
      ) : (
        <Star size={glyphSize} color="#0a0a0c" strokeWidth={stroke} fill="#0a0a0c" />
      )}
    </div>
  );
}
