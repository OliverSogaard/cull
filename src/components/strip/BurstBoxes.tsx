import { cellX } from "./computeWindow";
import { CELL_STRIDE, CELL_W } from "./metrics";
import type { BurstSegment } from "./burstSegments";

/**
 * The strips' burst-run outlines: real <fieldset>/<legend> boxes (the browser
 * natively gaps the border behind the legend — no masks, no z-index tricks).
 * Shared by the loupe strip and the compare strip so the two match exactly.
 */
export function burstBoxOverlays(
  segs: readonly BurstSegment[],
  prefix: number[] | undefined,
): React.ReactNode[] {
  const x = (i: number) => cellX(i, CELL_STRIDE, prefix);
  return segs.map((s) => (
    <fieldset
      key={`${s.kind}-${s.group}-${s.start}`}
      className={`cull-burst-box${s.kind === "similar" ? " cull-burst-box--similar" : ""}`}
      style={{
        // 4px air from cell edge to the line's INNER face on both sides
        // (box-sizing: border-box; 2px border ⇒ ±6 outside the cells).
        left: x(s.start) - 6,
        width: x(s.end) - x(s.start) + CELL_W + 12,
      }}
      aria-hidden
    >
      {s.labeled && (
        <legend className="cull-burst-box__count">
          {s.kind === "similar" ? "Similar" : "Burst"} ×{s.len}
        </legend>
      )}
    </fieldset>
  ));
}
