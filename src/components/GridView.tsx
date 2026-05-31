import {
  memo,
  useEffect,
  useLayoutEffect,
  useState,
  type MutableRefObject,
  type RefObject,
} from "react";
import type { Img, Rating } from "../types";
import { stripExt } from "../utils/path";
import { RatingDot } from "./RatingDot";

/** Visible rows above and below the viewport that we still render. */
const GRID_BUFFER_ROWS = 2;

/**
 * Target cell width — App's outer ResizeObserver picks `cols = floor(width /
 * GRID_CELL_TARGET)`, so cells fall between ~140 and ~210 px depending on
 * window size.
 */
export const GRID_CELL_TARGET = 168;

/**
 * Contact-sheet view of the staged set. Filter and ratings apply. Click a cell
 * to open it in the loupe; arrow keys step within / between rows; rating keys
 * affect the selected cell exactly like in the loupe.
 *
 * Virtualised — only viewport rows plus a small buffer mount their `<img>`s.
 *
 * ## Viewport reporting
 *
 * The currently-visible image-index range is written into `viewportRangeRef`
 * (read by the read pool's `pumpThumbs` outside the React tree) so visible
 * cells get thumbnail load priority over off-screen entries left in the queue
 * by a scroll/jump. `onViewportPump` re-pumps the queue when the range moves,
 * even if no new cells got queued (a pure scroll won't trigger React renders
 * for already-mounted cells).
 */
export function GridView({
  images,
  visibleIndices,
  currentIndex,
  cols,
  ratings,
  thumbnails,
  loadThumbnail,
  onPick,
  containerRef,
  viewportRangeRef,
  onViewportPump,
}: {
  images: Img[];
  visibleIndices: number[];
  currentIndex: number;
  cols: number;
  ratings: Record<number, Rating>;
  thumbnails: Record<string, string>;
  loadThumbnail: (path: string, index?: number) => void;
  onPick: (index: number) => void;
  containerRef: RefObject<HTMLDivElement | null>;
  viewportRangeRef: MutableRefObject<{ first: number; last: number } | null>;
  onViewportPump: () => void;
}) {
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(600);
  const [containerW, setContainerW] = useState(0);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      setViewportH(el.clientHeight);
      setContainerW(el.clientWidth);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [containerRef]);

  const cellW = containerW > 0 ? Math.floor(containerW / cols) : GRID_CELL_TARGET;
  const rowH = cellW; // square cells — accommodate landscape AND portrait
  const totalRows = Math.ceil(visibleIndices.length / cols);
  const totalH = totalRows * rowH;

  const firstRow = Math.max(0, Math.floor(scrollTop / rowH) - GRID_BUFFER_ROWS);
  const lastRow = Math.min(
    totalRows,
    Math.ceil((scrollTop + viewportH) / rowH) + GRID_BUFFER_ROWS,
  );

  // Auto-scroll: keep the current cell in view as the selection moves. If the
  // current frame isn't in the active filter (a possible state right after
  // compare exits onto a re-rated frame), scroll to the top instead of leaving
  // the grid wedged at scrollTop 0 looking broken.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el || rowH <= 0) return;
    const pos = visibleIndices.indexOf(currentIndex);
    if (pos === -1) {
      el.scrollTop = 0;
      return;
    }
    const row = Math.floor(pos / cols);
    const cellTop = row * rowH;
    const cellBottom = cellTop + rowH;
    if (cellTop < el.scrollTop) el.scrollTop = cellTop;
    else if (cellBottom > el.scrollTop + el.clientHeight)
      el.scrollTop = cellBottom - el.clientHeight;
  }, [currentIndex, visibleIndices, cols, rowH, containerRef]);

  const cells: { idx: number; row: number; col: number }[] = [];
  for (let row = firstRow; row < lastRow; row++) {
    for (let col = 0; col < cols; col++) {
      const i = row * cols + col;
      if (i >= visibleIndices.length) break;
      cells.push({ idx: visibleIndices[i], row, col });
    }
  }
  // cells is generated in (row, col) order from a monotonically-sorted
  // visibleIndices, so cells[0].idx is the min image-index and cells[last].idx
  // the max. The read pool uses this to prefer viewport cells over older
  // off-screen queue entries.
  const viewportFirst = cells.length > 0 ? cells[0].idx : -1;
  const viewportLast = cells.length > 0 ? cells[cells.length - 1].idx : -1;
  useEffect(() => {
    if (viewportFirst === -1) {
      viewportRangeRef.current = null;
      return;
    }
    viewportRangeRef.current = { first: viewportFirst, last: viewportLast };
    onViewportPump();
  }, [viewportFirst, viewportLast, viewportRangeRef, onViewportPump]);

  return (
    <div
      className="cull-grid"
      ref={containerRef}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
    >
      <div className="cull-grid__inner" style={{ height: totalH }}>
        {cells.map(({ idx, row, col }) => (
          <GridCell
            key={images[idx].id}
            img={images[idx]}
            index={idx}
            isCurrent={idx === currentIndex}
            rating={ratings[images[idx].id]}
            url={thumbnails[images[idx].path]}
            loadThumbnail={loadThumbnail}
            onPick={onPick}
            top={row * rowH}
            left={col * cellW}
            width={cellW}
            height={rowH}
          />
        ))}
      </div>
    </div>
  );
}

const GridCell = memo(function GridCell({
  img,
  index,
  isCurrent,
  rating,
  url,
  loadThumbnail,
  onPick,
  top,
  left,
  width,
  height,
}: {
  img: Img;
  index: number;
  isCurrent: boolean;
  rating: Rating | undefined;
  url: string | undefined;
  loadThumbnail: (path: string, index?: number) => void;
  onPick: (index: number) => void;
  top: number;
  left: number;
  width: number;
  height: number;
}) {
  useEffect(() => {
    loadThumbnail(img.path, index);
  }, [img.path, index, loadThumbnail]);
  const isReject = rating === "reject";
  return (
    <div
      className={`cull-grid__cell${isCurrent ? " is-current" : ""}${isReject ? " is-reject" : ""}`}
      style={{ position: "absolute", top, left, width, height }}
      onClick={() => onPick(index)}
    >
      {/* Frame element always exists, so the current-cell outline is visible
          on both the loaded thumb AND the placeholder shimmer — placeholders
          aren't invisible just because their thumb hasn't arrived. */}
      <div className="cull-grid__frame">
        {url ? (
          <img className="cull-grid__img" src={url} alt="" />
        ) : (
          <div className="cull-grid__placeholder">
            <span className="cull-grid__placeholder-name">{stripExt(img.filename)}</span>
          </div>
        )}
      </div>
      {rating && (
        <div className="cull-grid__dot">
          <RatingDot rating={rating} size="md" />
        </div>
      )}
    </div>
  );
});
