import { memo, useEffect } from "react";
import type { Img, Rating } from "../types";
import { RatingDot } from "./RatingDot";

/**
 * Strip virtualization knobs. Both the loupe strip and the compare candidate
 * strip render at most this many cells around the cursor; the missing cells on
 * either side are reproduced as transparent spacers (`CELL_STRIDE` wide each)
 * so the scrollbar still represents the full list.
 */
export const STRIP_RADIUS = 100;

/** Per-cell horizontal stride: 88 px frame + 6 px right margin (see CSS). */
export const CELL_STRIDE = 94;

type ThumbCellProps = {
  img: Img;
  index: number;
  isCurrent: boolean;
  rating: Rating | undefined;
  dimmed: boolean;
  url: string | undefined;
  loadThumbnail: (path: string, index?: number) => void;
  onPick: (index: number) => void;
  /** Outline colour when current (defaults to white). Compare uses green / amber. */
  accentColor?: string;
};

/**
 * One filmstrip cell — thumbnail or shimmer placeholder, current-cell outline,
 * rating dot, and a reject grayscale tint. Memoised because a single nav step
 * changes props for only ~2 cells out of ~200 rendered; shallow-prop equality
 * skips the rest.
 *
 * The cell self-requests its thumbnail on mount; the bounded thumb pool
 * dedupes and reorders requests according to the current view's prioritisation
 * (nearest-cursor in loupe/compare, viewport-first in grid).
 */
export const ThumbCell = memo(function ThumbCell({
  img,
  index,
  isCurrent,
  rating,
  dimmed,
  url,
  loadThumbnail,
  onPick,
  accentColor,
}: ThumbCellProps) {
  useEffect(() => {
    loadThumbnail(img.path, index);
  }, [img.path, index, loadThumbnail]);

  return (
    <div
      data-idx={index}
      className="cull-thumb"
      onClick={() => onPick(index)}
      style={{
        opacity: dimmed ? 0.18 : 1,
        filter: rating === "reject" ? "grayscale(0.85)" : "none",
      }}
    >
      <div
        className="cull-thumb__frame"
        style={{ borderColor: isCurrent ? accentColor ?? "#fafafa" : "transparent" }}
      >
        {url ? (
          <img className="cull-thumb__img" src={url} alt="" />
        ) : (
          <div className="cull-thumb__placeholder" />
        )}
      </div>
      {rating && (
        <div className="cull-thumb__dot">
          <RatingDot rating={rating} size="sm" />
        </div>
      )}
    </div>
  );
});
