import type { Rating } from "../types";
import { RATING_COLOR } from "../utils/ratingColor";
import { verdictGlyph } from "./verdictGlyph";

/**
 * A single rating chip — coloured circle with a centered glyph (✓ / ✕ / ★),
 * rendered by the shared verdictGlyph (Lucide SVG — see its note on why not
 * Unicode). Rendered in the compare panes.
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
      {verdictGlyph(rating, glyphSize, stroke)}
    </div>
  );
}
