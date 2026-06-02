import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { Check, Star, X as XIcon } from "lucide-react";
import type { Img, ImageMetadata, Rating } from "../types";
import { stripExt } from "../utils/path";
import { hasLrcRating } from "../utils/ratingColor";
import { useImage } from "../image/useImage";

/** Visible rows above and below the viewport that we still render. */
const GRID_BUFFER_ROWS = 2;

/**
 * Shared epoch for the skeleton-shimmer animation. Every grid placeholder
 * derives its `animation-delay` from this, so cells that mount at different
 * times (as the user scrolls / the viewport reveals more cells) all land on
 * the SAME phase of the loop — the grid pulses as one, not staggered.
 *
 * Negative delays are well-defined in CSS — they advance the animation by
 * that much. So setting delay = -(epoch elapsed % duration) snaps every cell
 * to "we've been running since the module loaded", regardless of mount time.
 */
const SHIMMER_EPOCH_MS = Date.now();
const SHIMMER_DURATION_MS = 1400; // must match the CSS @keyframes timing

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
 * The currently-visible image-index range is reported via `onViewportChange`
 * (wired to `imageStore.setGridRange` in App) so the store prioritises
 * background thumbnail fill for cells the user is actually looking at. It fires
 * whenever the visible range moves, even on a pure scroll (which won't trigger
 * React renders for already-mounted cells).
 */
export const GridView = memo(function GridView({
  images,
  visibleIndices,
  currentIndex,
  cols,
  ratings,
  metadata,
  selectedIndices,
  onPick,
  containerRef,
  onViewportChange,
}: {
  images: Img[];
  visibleIndices: number[];
  currentIndex: number;
  cols: number;
  ratings: Record<number, Rating>;
  /** Optional metadata map — only the `lrcRating` field is read here, for the
   * tiny corner badge that flags pre-existing LrC ratings. */
  metadata?: Record<string, ImageMetadata>;
  /** Absolute image indices currently in the multi-selection. Cells in this
   * set get the champagne tint + accent outline; a plain click clears the
   * set on the App side and falls back to the single-cell selection. */
  selectedIndices?: Set<number>;
  onPick: (index: number, modifiers: { shift: boolean; ctrl: boolean }) => void;
  containerRef: RefObject<HTMLDivElement | null>;
  /** Reports the visible absolute image-index range to App (→ setGridRange). */
  onViewportChange: (first: number, last: number) => void;
}) {
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(600);
  const [containerW, setContainerW] = useState(0);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      setViewportH(el.clientHeight);
      // clientWidth includes padding; subtract horizontal padding so cells
      // fit within the content area (no horizontal scrollbar).
      const cs = window.getComputedStyle(el);
      const padL = parseFloat(cs.paddingLeft) || 0;
      const padR = parseFloat(cs.paddingRight) || 0;
      setContainerW(Math.max(0, el.clientWidth - padL - padR));
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
    if (viewportFirst === -1) return;
    onViewportChange(viewportFirst, viewportLast);
  }, [viewportFirst, viewportLast, onViewportChange]);

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
            isMultiSelected={selectedIndices?.has(idx) ?? false}
            rating={ratings[images[idx].id]}
            lrcRating={metadata?.[images[idx].path]?.lrcRating ?? null}
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
});

const GridCell = memo(function GridCell({
  img,
  index,
  isCurrent,
  isMultiSelected,
  rating,
  lrcRating,
  onPick,
  top,
  left,
  width,
  height,
}: {
  img: Img;
  index: number;
  isCurrent: boolean;
  isMultiSelected: boolean;
  rating: Rating | undefined;
  lrcRating: number | null;
  onPick: (index: number, modifiers: { shift: boolean; ctrl: boolean }) => void;
  top: number;
  left: number;
  width: number;
  height: number;
}) {
  // Grid cells render thumbnails only; the store self-schedules the thumb on
  // mount (and prioritises by the reported grid viewport) and re-renders this
  // cell when it lands. `shimmer` → placeholder; otherwise show the thumb.
  const img2 = useImage(img.path, { wantFull: false });
  const url = img2.stage === "shimmer" ? undefined : img2.url;
  // Pin the shimmer phase ONCE at mount. We used to compute this inline in
  // JSX (`Date.now() - epoch`), which re-evaluated on every parent re-render
  // and reset the CSS animation each time → visible glitch / stutter.
  // useMemo([]) captures the elapsed-at-mount value and never changes, so
  // React's style diffing sees a stable string and the animation runs
  // smoothly. The math still snaps to the shared SHIMMER_EPOCH_MS so cells
  // mounted at different times stay in phase with each other.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const shimmerDelayMs = useMemo(
    () => (Date.now() - SHIMMER_EPOCH_MS) % SHIMMER_DURATION_MS,
    [],
  );
  const isReject = rating === "reject";
  // Verdict glyph as a Lucide SVG icon (not Unicode) so it centers cleanly
  // inside the 18px dot — Unicode metrics drift across system fonts.
  const dotIcon: ReactNode =
    rating === "keep" ? (
      <Check size={12} color="#0a0a0c" strokeWidth={3} />
    ) : rating === "reject" ? (
      <XIcon size={12} color="#0a0a0c" strokeWidth={3} />
    ) : rating === "favorite" ? (
      <Star size={12} color="#0a0a0c" strokeWidth={2.6} fill="#0a0a0c" />
    ) : null;
  const dotClass =
    rating === "keep"
      ? "cull-grid__dot--keep"
      : rating === "reject"
      ? "cull-grid__dot--reject"
      : rating === "favorite"
      ? "cull-grid__dot--fav"
      : "";
  const showLrc = hasLrcRating(lrcRating, rating);
  const cellClass = [
    "cull-grid__cell",
    isCurrent ? "is-current" : "",
    isReject ? "is-reject" : "",
    isMultiSelected ? "is-multi-selected" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div
      className={cellClass}
      style={{ position: "absolute", top, left, width, height }}
      onClick={(e) => onPick(index, { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey })}
    >
      {/* Frame element always exists, so the current-cell outline is visible
          on both the loaded thumb AND the placeholder shimmer — placeholders
          aren't invisible just because their thumb hasn't arrived. */}
      <div className="cull-grid__frame">
        {url ? (
          <img className="cull-grid__img" src={url} alt="" />
        ) : (
          <div
            className="cull-grid__placeholder"
            // Snap the shimmer to a shared epoch so every cell pulses in
            // sync regardless of when it mounted. Negative animation-delay
            // = "we've already been running this long". The delay is
            // computed once at mount (useMemo above) so React renders see a
            // stable value — recomputing on every render restarts the CSS
            // animation, which read as a stutter.
            style={{
              animationDelay: `-${shimmerDelayMs}ms`,
            }}
          >
            <span className="cull-grid__placeholder-name">{stripExt(img.filename)}</span>
          </div>
        )}
      </div>
      {showLrc && (
        <div className="cull-grid__lrc-badge" aria-label={`LrC ${lrcRating}★`}>
          <Star size={11} strokeWidth={2.4} fill="currentColor" />
        </div>
      )}
      {/* Hover-revealed filename badge — mono pill at bottom-left, only shown on
          cells that have a loaded thumb (placeholder cells already display
          their filename inline). Mockup .cell-fn. */}
      {url && (
        <div className="cull-grid__fn" aria-hidden>
          {stripExt(img.filename)}
        </div>
      )}
      {/* Multi-select tint sits above the photo but below the rating dot, so
          the dot remains legible. Outline (accent) comes from .is-multi-selected. */}
      {isMultiSelected && <div className="cull-grid__multi-tint" aria-hidden />}
      {dotIcon && (
        <div className={`cull-grid__dot ${dotClass}`} aria-hidden>
          {dotIcon}
        </div>
      )}
    </div>
  );
});
