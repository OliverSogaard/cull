import { memo } from "react";
import { Star } from "lucide-react";
import type { Img, Rating } from "../types";
import type { Suggestion } from "../smart/deriveVerdict";
import { hasLrcRating } from "../utils/ratingColor";
import { stripExt } from "../utils/path";
import { useThumb } from "../image/useThumb";
import { ghostGlyph, verdictDotClass, verdictGlyph } from "./verdictGlyph";


type ThumbCellProps = {
  img: Img;
  index: number;
  isCurrent: boolean;
  rating: Rating | undefined;
  /** Optional user LrC 1–5★ rating from the sidecar. Renders a tiny ★ badge
   * top-left when present and not just CULL's own favorite stamp. */
  lrcRating?: number | null;
  dimmed: boolean;
  onPick: (index: number) => void;
  /** Role variant in compare mode — adds a champagne outline + role badge. */
  /** "champion-ghost": the champion in its candidate-track slot — heavily
   *  grayed, unselectable, wearing the champion tag (no pinned cell). */
  roleVariant?: "challenger" | "champion-ghost";
  /** Smart-culling ghost suggestion — renders in the verdict-dot slot ONLY
   *  while the frame is unrated (compare strips never pass it: suppressed
   *  by construction there). */
  suggestion?: Suggestion | null;
  /** Burst membership — run tint, "Burst · N" pill on the first cell, and a
   *  solid winner border. */
};

/**
 * One filmstrip cell — thumbnail or shimmer placeholder, current-cell outline,
 * verdict glyph dot, and a reject opacity. Memoised because a single nav step
 * changes props for only ~2 cells out of ~200 rendered; shallow-prop equality
 * skips the rest.
 */
export const ThumbCell = memo(function ThumbCell({
  img,
  index,
  isCurrent,
  rating,
  lrcRating,
  dimmed,
  onPick,
  roleVariant,
  suggestion,
}: ThumbCellProps) {
  // Strip cells only ever need the thumbnail (plumbing shared with GridCell).
  const { url, shimmerDelayMs: shimmerDelay } = useThumb(img.path);

  // Reject cells get an opacity drop unless they're the current cell.
  const isReject = rating === "reject";
  const cellOpacity = dimmed ? 0.18 : isReject && !isCurrent ? 0.45 : 1;

  // Verdict glyph + colour modifier for the bottom-right chip (shared with GridCell).
  const dotIcon = verdictGlyph(rating, 9);
  const dotClass = verdictDotClass(rating, "cull-thumb__dot");

  // Outline colour on the active cell. In compare mode the role variant takes
  // over (always champagne); in loupe it's the standard champagne accent.
  const isGhost = roleVariant === "champion-ghost";
  const frameClass = [
    "cull-thumb__frame",
    roleVariant === "challenger" ? "cull-thumb--challenger" : "",
    isGhost ? "cull-thumb--champion-ghost" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const outlineColor =
    (isCurrent || roleVariant) && !isGhost ? "var(--accent)" : "transparent";

  const showLrc = hasLrcRating(lrcRating, rating);

  // Ghost suggestion renders ONLY while unrated — a keypress paints the solid
  // dot and this guard stops rendering it (superseded in place, never stored).
  // Ghosts are SUGGESTION-driven only (the burst winner's ✓ arrives via its
  // rail's Burst row); the run itself is outlined by the strip-level box.
  const ghost =
    !rating && (suggestion?.verdict ?? null);

  return (
    <div
      className={`cull-thumb${isGhost ? " cull-thumb--ghost-cell" : ""}`}
      onClick={() => !isGhost && onPick(index)}
      role="button"
      aria-disabled={isGhost || undefined}
      aria-label={`${stripExt(img.filename)}${rating ? `, ${rating}` : ""}${
        isGhost ? ", champion" : roleVariant ? `, ${roleVariant}` : isCurrent ? ", current" : ""
      }`}
      style={{ opacity: cellOpacity }}
    >
      <div
        className={frameClass}
        style={{ ["--thumb-outline" as string]: outlineColor }}
      >
        {url ? (
          // decoding="sync": these are ~15 KB JPEGs — decode with layout so a
          // remounted cell paints its cached thumb immediately instead of
          // flashing blank for 1–2 frames while an async decode round-trips.
          <img className="cull-thumb__img" src={url} alt="" decoding="sync" />
        ) : (
          <div
            className="cull-thumb__placeholder"
            style={{ ["--shimmer-delay" as string]: `-${shimmerDelay}ms` }}
          />
        )}
        {/* When the cell has a compare role, the role badge subsumes the
            LrC badge into its label ("champion ★" / "challenger ★") so the
            two top-left pills don't stack on the same 76px cell. Star
            rendered as a Lucide SVG so it sits on the text baseline cleanly
            instead of riding high (Unicode ★ has weird metrics in
            Segoe UI on Windows). */}
        {roleVariant ? (
          <div
            className={`cull-thumb__role-badge cull-thumb__role-badge--${
              isGhost ? "champion" : roleVariant
            }`}
            aria-hidden
          >
            <span className="cull-thumb__role-badge-text">
              {isGhost ? "champion" : roleVariant}
            </span>
            {showLrc && (
              <Star
                size={8}
                strokeWidth={2.4}
                fill="currentColor"
                aria-hidden
              />
            )}
          </div>
        ) : (
          showLrc && (
            <div className="cull-thumb__lrc-badge" aria-label={`LrC ${lrcRating}★`}>
              <Star size={9} strokeWidth={2.4} fill="currentColor" />
            </div>
          )
        )}
      </div>
      {dotIcon ? (
        <div className={`cull-thumb__dot ${dotClass}`} aria-hidden>
          {dotIcon}
        </div>
      ) : (
        ghost && (
          <div
            className={`cull-thumb__dot cull-thumb__dot--ghost cull-thumb__dot--ghost-${
              ghost === "reject" ? "reject" : ghost === "favorite" ? "favorite" : "keep"
            }`}
            aria-hidden
          >
            {ghostGlyph(ghost, 9)}
          </div>
        )
      )}
    </div>
  );
});
