// src/components/CompareStrip.tsx
import { useMemo } from "react";
import type { Img, ImageMetadata } from "../types";
import type { Suggestion } from "../smart/deriveVerdict";
import type { BurstCtx } from "../smart/groupBursts";
import { ThumbCell } from "./ThumbCell";
import { PhotoStrip } from "./strip/PhotoStrip";

/** Stable no-op: the champion ghost is display-only — clicks do nothing. */
const NOOP = () => {};

/**
 * Compare-mode strip: {@link PhotoStrip} (identical to the loupe strip) over
 * the unrated candidates, with the CHAMPION rendered in its capture-order
 * slot as a grayed, unselectable ghost wearing the champion tag, and the
 * challenger wearing its own tag. No pinned reference cell — the strip IS
 * the timeline.
 */
export function CompareStrip({
  images,
  stripIndices,
  championIndex,
  challengerIndex,
  metadata,
  onPickChallenger,
  suggestions,
  bursts,
  similar,
  scrubbing,
  scrubSpeed,
}: {
  images: Img[];
  /** Candidates PLUS the champion in its capture slot. */
  stripIndices: number[];
  championIndex: number;
  challengerIndex: number;
  /** Optional metadata map; only `lrcRating` is used here, for the corner ★ badge. */
  metadata?: Record<string, ImageMetadata>;
  onPickChallenger: (index: number) => void;
  /** Smart-culling ghost suggestions by image id — same dots as the loupe
   *  strip (candidates are unrated, so ghosts always render when present). */
  suggestions?: Record<number, Suggestion>;
  /** Burst membership by image id — same outlined boxes as the loupe strip. */
  bursts?: Map<number, BurstCtx>;
  /** Similar-set membership by image id — same outlined boxes, cooler tint. */
  similar?: Map<number, BurstCtx>;
  /** Fades in the position bar under the cells. */
  scrubbing?: boolean;
  /** Staged scrub acceleration factor — labeled above the bar's marker. */
  scrubSpeed?: number;
}) {
  const cpos = useMemo(
    () => stripIndices.indexOf(challengerIndex),
    [stripIndices, challengerIndex],
  );

  return (
    <PhotoStrip
      images={images}
      indices={stripIndices}
      centerPos={cpos}
      bursts={bursts}
      similar={similar}
      scrubbing={scrubbing}
      scrubSpeed={scrubSpeed}
      renderCell={(idx) => {
        const isGhost = idx === championIndex;
        return (
          <ThumbCell
            img={images[idx]}
            index={idx}
            isCurrent={idx === challengerIndex}
            roleVariant={
              isGhost ? "champion-ghost" : idx === challengerIndex ? "challenger" : undefined
            }
            rating={undefined}
            lrcRating={metadata?.[images[idx].path]?.lrcRating ?? null}
            dimmed={false}
            onPick={isGhost ? NOOP : onPickChallenger}
            suggestion={suggestions?.[images[idx].id] ?? null}
          />
        );
      }}
    />
  );
}
