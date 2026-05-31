import { Star } from "lucide-react";
import type { Rating } from "../types";
import { RATING_COLOR } from "../utils/ratingColor";

/**
 * A single rating chip — coloured circle, with a white star inside when the
 * frame is a favorite. Three sizes:
 *
 * - `lg` — the big persistent dot in the loupe corner
 * - `md` — thumbnail strip cells, grid cells, compare panes
 * - `sm` — inline contexts where the dot just signals "rated" (no star drawn)
 */
export function RatingDot({ rating, size }: { rating: Rating; size: "lg" | "md" | "sm" }) {
  const dim = size === "lg" ? 24 : size === "md" ? 18 : 11;
  return (
    <div
      className="cull-rating-dot"
      style={{ width: dim, height: dim, backgroundColor: RATING_COLOR[rating] }}
    >
      {size !== "sm" && rating === "favorite" && (
        <Star size={dim * 0.55} color="white" strokeWidth={3} fill="white" />
      )}
    </div>
  );
}
