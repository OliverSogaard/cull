import { cellX } from "./computeWindow";
import type { StripMetrics } from "./metrics";
import type { BurstSegment } from "./burstSegments";

/**
 * The strips' burst-run outlines: real <fieldset>/<legend> boxes (the browser
 * natively gaps the border behind the legend — no masks, no z-index tricks).
 * Shared by the loupe strip and the compare strip so the two match exactly.
 */
export function burstBoxOverlays(
  segs: readonly BurstSegment[],
  prefix: number[] | undefined,
  m: StripMetrics,
): React.ReactNode[] {
  const x = (i: number) => cellX(i, m.stride, prefix);
  // Two bodies bursting at once interleave by capture time, so a run can
  // fragment into a series of one-cell stretches — a "fence" of tiny brackets
  // side by side. The DATA still carries every stretch (the burst walk needs
  // it); only the RENDER skips a one-cell one, drawing no box for it.
  return segs
    .filter((s) => s.end > s.start)
    .map((s) => (
      <fieldset
        key={`${s.kind}-${s.group}-${s.start}`}
        className={`cull-burst-box${s.kind === "similar" ? " cull-burst-box--similar" : ""}`}
        style={{
          // 4px air from cell edge to the line's INNER face on both sides
          // (box-sizing: border-box; 2px border ⇒ ±6 outside the cells).
          left: x(s.start) - 6,
          width: x(s.end) - x(s.start) + m.cellW + 12,
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
