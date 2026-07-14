import type { Rating } from "../types";
import type { Suggestion } from "../smart/deriveVerdict";
import { ghostGlyph, ghostTitle, verdictDotClass, verdictGlyph } from "./verdictGlyph";

/**
 * A cell's verdict-dot slot: the SOLID committed dot when rated, else the
 * smart-culling GHOST dot while a suggestion with a verdict exists. The ghost
 * renders ONLY while unrated — a keypress paints the solid dot and this guard
 * stops rendering it (superseded in place, never stored). Ghosts are
 * SUGGESTION-driven only; burst/similar run outlines are drawn at the
 * grid/strip level (segment boxes), not per cell. Shared by the grid cells
 * (prefix "cull-grid__dot", size 12) and the filmstrip cells
 * ("cull-thumb__dot", size 9); compare strips never pass a suggestion —
 * suppressed by construction there.
 */
export function VerdictDot({
  rating,
  suggestion,
  prefix,
  size,
}: {
  rating: Rating | undefined;
  suggestion: Suggestion | null | undefined;
  prefix: "cull-grid__dot" | "cull-thumb__dot";
  size: number;
}) {
  const dotIcon = verdictGlyph(rating, size);
  if (dotIcon) {
    return (
      <div className={`${prefix} ${verdictDotClass(rating, prefix)}`} aria-hidden>
        {dotIcon}
      </div>
    );
  }
  if (!suggestion || !suggestion.verdict) return null;
  const ghost = suggestion.verdict;
  return (
    <div
      className={`${prefix} ${prefix}--ghost ${prefix}--ghost-${
        ghost === "reject" ? "reject" : ghost === "favorite" ? "favorite" : "keep"
      }`}
      title={ghostTitle(suggestion)}
      aria-hidden
    >
      {ghostGlyph(ghost, size)}
    </div>
  );
}
