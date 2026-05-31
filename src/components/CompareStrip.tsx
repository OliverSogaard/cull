import { useLayoutEffect, useRef } from "react";
import type { Img } from "../types";
import { CELL_STRIDE, STRIP_RADIUS, ThumbCell } from "./ThumbCell";

/**
 * Compare-mode strip: pinned champion + scrolling unrated candidates.
 *
 * Only UNRATED frames appear here (rated ones aren't rendered at all). The
 * champion is pinned on the left with a green outline as a fixed reference;
 * then a separator dot; then the candidate filmstrip, which scrolls to keep
 * the (amber-outlined) challenger centered as it changes — so a challenger
 * far away in capture order stays easy to track. Virtualised like
 * {@link ThumbStrip}: only a window of cells around the challenger is live.
 */
export function CompareStrip({
  images,
  candidates,
  championIndex,
  challengerIndex,
  thumbnails,
  loadThumbnail,
  onPickChallenger,
}: {
  images: Img[];
  candidates: number[];
  championIndex: number;
  challengerIndex: number;
  thumbnails: Record<string, string>;
  loadThumbnail: (path: string, index?: number) => void;
  onPickChallenger: (index: number) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const cpos = candidates.indexOf(challengerIndex);

  useLayoutEffect(() => {
    const el = scrollRef.current?.querySelector(`[data-idx="${challengerIndex}"]`);
    el?.scrollIntoView({ behavior: "auto", block: "nearest", inline: "center" });
  }, [challengerIndex]);

  const first = Math.max(0, cpos - STRIP_RADIUS);
  const last = Math.min(candidates.length, cpos + STRIP_RADIUS + 1);
  const leftPad = first * CELL_STRIDE;
  const rightPad = (candidates.length - last) * CELL_STRIDE;

  const champion = images[championIndex];

  return (
    <footer className="cull-cmp-strip">
      <div className="cull-cmp-strip__champion">
        {champion && (
          <ThumbCell
            img={champion}
            index={championIndex}
            isCurrent
            accentColor="#10b981" /* green — champion, matching the panel outline */
            rating={undefined}
            dimmed={false}
            url={thumbnails[champion.path]}
            loadThumbnail={loadThumbnail}
            onPick={() => {}}
          />
        )}
      </div>
      <div className="cull-cmp-strip__sep" aria-hidden />
      <div className="cull-cmp-strip__candidates" ref={scrollRef}>
        {leftPad > 0 && <div style={{ flex: `0 0 ${leftPad}px` }} aria-hidden />}
        {candidates.slice(first, last).map((idx) => (
          <ThumbCell
            key={images[idx].id}
            img={images[idx]}
            index={idx}
            isCurrent={idx === challengerIndex}
            accentColor="#f59e0b" /* amber — challenger, matching the panel outline */
            rating={undefined}
            dimmed={false}
            url={thumbnails[images[idx].path]}
            loadThumbnail={loadThumbnail}
            onPick={onPickChallenger}
          />
        ))}
        {rightPad > 0 && <div style={{ flex: `0 0 ${rightPad}px` }} aria-hidden />}
      </div>
    </footer>
  );
}
