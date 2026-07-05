// src/components/ThumbStrip.tsx
import { useMemo } from "react";
import type { Img, ImageMetadata, Rating } from "../types";
import type { Suggestion } from "../smart/deriveVerdict";
import type { BurstCtx } from "../smart/groupBursts";
import { ThumbCell } from "./ThumbCell";
import { PhotoStrip } from "./strip/PhotoStrip";

/**
 * The loupe's filmstrip: {@link PhotoStrip} over the FULL staged set, with
 * rating dots, filter dimming, and smart-culling ghost suggestions on the
 * cells. Burst boxes and virtualization live in PhotoStrip (shared with the
 * compare strip, so the two always match).
 */
export function ThumbStrip({
  images,
  currentIndex,
  ratings,
  visibleIndices,
  metadata,
  onPick,
  suggestions,
  bursts,
  scrubbing,
}: {
  images: Img[];
  currentIndex: number;
  ratings: Record<number, Rating>;
  visibleIndices: number[];
  /** Optional metadata map; only `lrcRating` is read here for the corner badge. */
  metadata?: Record<string, ImageMetadata>;
  onPick: (index: number) => void;
  /** Smart-culling ghost suggestions by image id (unrated frames only). */
  suggestions?: Record<number, Suggestion>;
  /** Burst membership by image id. */
  bursts?: Map<number, BurstCtx>;
  /** Fades in the position bar under the cells. */
  scrubbing?: boolean;
}) {
  const visibleSet = useMemo(() => new Set(visibleIndices), [visibleIndices]);
  const indices = useMemo(() => images.map((_, i) => i), [images]);

  return (
    <PhotoStrip
      images={images}
      indices={indices}
      centerPos={currentIndex}
      bursts={bursts}
      scrubbing={scrubbing}
      renderCell={(idx) => (
        <ThumbCell
          img={images[idx]}
          index={idx}
          isCurrent={idx === currentIndex}
          rating={ratings[images[idx].id]}
          lrcRating={metadata?.[images[idx].path]?.lrcRating ?? null}
          dimmed={!visibleSet.has(idx)}
          onPick={onPick}
          suggestion={suggestions?.[images[idx].id] ?? null}
        />
      )}
    />
  );
}
