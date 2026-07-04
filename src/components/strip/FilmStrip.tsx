// src/components/strip/FilmStrip.tsx
import type { ReactNode } from "react";
import { cellX } from "./computeWindow";
import { useStripVirtualizer } from "./useStripVirtualizer";

/**
 * A horizontally-scrolling, virtualized filmstrip. Renders a single fixed-width
 * track (`count * stride`) and only the windowed cells, each absolutely
 * positioned at `listIndex * stride`. The caller maps a list index to a cell via
 * `renderItem` and to a stable React key via `keyForItem` (so a cell's identity
 * — and its useImage subscription — survives window shifts).
 */
export function FilmStrip({
  className,
  count,
  stride,
  cellWidth,
  trackHeight,
  centerOffset,
  buffer,
  keyForItem,
  renderItem,
  overlays,
  prefix,
}: {
  className: string;
  count: number;
  stride: number;
  cellWidth: number;
  trackHeight: number;
  centerOffset: number;
  buffer: number;
  keyForItem: (listIndex: number) => string | number;
  renderItem: (listIndex: number) => ReactNode;
  /** Absolutely-positioned siblings rendered over the track (burst run boxes).
   *  Positioned in track coordinates (use `cellX` when a prefix is set), so
   *  they scroll with the cells; keep them `pointer-events: none`. */
  overlays?: ReactNode;
  /** Cumulative gap offsets (burst breathing room) — see computeWindow. */
  prefix?: readonly number[];
}) {
  const { containerRef, trackWidth, first, last } = useStripVirtualizer({
    count,
    stride,
    cellWidth,
    centerOffset,
    buffer,
    prefix,
  });

  const items: ReactNode[] = [];
  for (let i = first; i < last; i++) {
    items.push(
      <div
        key={keyForItem(i)}
        style={{
          position: "absolute",
          left: cellX(i, stride, prefix),
          top: 0,
          width: cellWidth,
          height: trackHeight,
        }}
      >
        {renderItem(i)}
      </div>,
    );
  }

  return (
    <div ref={containerRef} className={className}>
      <div
        style={{
          position: "relative",
          width: trackWidth,
          height: trackHeight,
          flex: "0 0 auto",
        }}
      >
        {items}
        {overlays}
      </div>
    </div>
  );
}
