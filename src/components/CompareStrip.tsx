// src/components/CompareStrip.tsx
import type { Img, ImageMetadata } from "../types";
import { ThumbCell } from "./ThumbCell";
import { FilmStrip } from "./strip/FilmStrip";
import { CELL_H, CELL_STRIDE, CELL_W, STRIP_BUFFER } from "./strip/metrics";

/**
 * Compare-mode strip: pinned champion + scrolling unrated candidates.
 *
 * Only UNRATED frames appear in the candidate list (rated ones aren't rendered).
 * The champion is pinned on the left as a fixed reference; then a separator dot;
 * then the candidate filmstrip, virtualized via {@link FilmStrip}, scrolling to
 * keep the (amber-outlined) challenger centered as it changes.
 */
export function CompareStrip({
  images,
  candidates,
  championIndex,
  challengerIndex,
  metadata,
  onPickChallenger,
}: {
  images: Img[];
  candidates: number[];
  championIndex: number;
  challengerIndex: number;
  /** Optional metadata map; only `lrcRating` is used here, for the corner ★ badge. */
  metadata?: Record<string, ImageMetadata>;
  onPickChallenger: (index: number) => void;
}) {
  const cpos = candidates.indexOf(challengerIndex);
  const champion = images[championIndex];

  return (
    <footer className="cull-cmp-strip">
      <div className="cull-cmp-strip__champion">
        {champion && (
          <ThumbCell
            img={champion}
            index={championIndex}
            isCurrent
            roleVariant="champion"
            rating={undefined}
            lrcRating={metadata?.[champion.path]?.lrcRating ?? null}
            dimmed={false}
            onPick={() => {}}
          />
        )}
      </div>
      <div className="cull-cmp-strip__sep" aria-hidden />
      <FilmStrip
        className="cull-cmp-strip__candidates"
        count={candidates.length}
        stride={CELL_STRIDE}
        cellWidth={CELL_W}
        trackHeight={CELL_H}
        centerOffset={cpos}
        buffer={STRIP_BUFFER}
        keyForItem={(i) => images[candidates[i]].id}
        renderItem={(i) => {
          const idx = candidates[i];
          return (
            <ThumbCell
              img={images[idx]}
              index={idx}
              isCurrent={idx === challengerIndex}
              roleVariant={idx === challengerIndex ? "challenger" : undefined}
              rating={undefined}
              lrcRating={metadata?.[images[idx].path]?.lrcRating ?? null}
              dimmed={false}
              onPick={onPickChallenger}
            />
          );
        }}
      />
    </footer>
  );
}
