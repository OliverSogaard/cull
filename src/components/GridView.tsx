import {
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { Star } from "lucide-react";
import { ghostGlyph, verdictDotClass, verdictGlyph } from "./verdictGlyph";
import type { Img, ImageMetadata, Rating } from "../types";
import type { Suggestion } from "../smart/deriveVerdict";
import type { BurstCtx } from "../smart/groupBursts";
import { stripExt } from "../utils/path";
import { hasLrcRating } from "../utils/ratingColor";
import { useThumb } from "../image/useThumb";

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
 * The rendered-window image-index range (visible rows plus GRID_BUFFER_ROWS of
 * overscan each side) is reported via `onViewportChange` (wired to
 * `imageStore.setGridRange` in App) so the store prioritises background
 * thumbnail fill for cells at or near the viewport. It fires whenever that range
 * moves, even on a pure scroll (which won't trigger React renders for
 * already-mounted cells).
 */
export const GridView = memo(function GridView({
  images,
  visibleIndices,
  currentIndex,
  cols,
  contentWidth,
  ratings,
  metadata,
  selectedIndices,
  onPick,
  containerRef,
  onViewportChange,
  suggestions,
  bursts,
}: {
  images: Img[];
  visibleIndices: number[];
  currentIndex: number;
  cols: number;
  /** Grid content width (px, padding-subtracted) measured by App's ResizeObserver
   *  — the single width source, so cellW and cols never derive from two separate
   *  measurements that can disagree for a frame. */
  contentWidth: number;
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
  /** Smart-culling ghost suggestions by image id (rendered only when unrated). */
  suggestions?: Record<number, Suggestion>;
  /** Burst membership by image id — tint, count pill, winner border. */
  bursts?: Map<number, BurstCtx>;
}) {
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(600);

  // Height-only observer: WIDTH (and the padding math) is owned by App's RO,
  // which derives `cols` AND passes `contentWidth` down — so cellW and cols come
  // from one measurement (no two-observer disagreement) and there's no
  // getComputedStyle on this resize path.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setViewportH(el.clientHeight);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [containerRef]);

  // rAF-throttle scroll → one scrollTop update per frame (mirrors the strip
  // virtualizer), so a fling doesn't re-run this component's body many times per
  // frame. Native passive listener; the prev===next guard skips a no-op render
  // when a settled scroll lands on the same offset.
  const scrollRafRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onScroll = () => {
      if (scrollRafRef.current != null) return;
      scrollRafRef.current = requestAnimationFrame(() => {
        scrollRafRef.current = null;
        setScrollTop((prev) => (prev === el.scrollTop ? prev : el.scrollTop));
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (scrollRafRef.current != null) cancelAnimationFrame(scrollRafRef.current);
    };
  }, [containerRef]);

  const cellW = contentWidth > 0 ? Math.floor(contentWidth / cols) : GRID_CELL_TARGET;
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

  // Burst run boxes, one per (group, row) segment of RENDERED cells — grid
  // rows wrap, so "one long square" becomes one box per row the run crosses.
  // The ×N count rides the segment containing the run's first frame.
  const burstSegs: { key: string; row: number; c0: number; c1: number; label: number | null }[] =
    [];
  if (bursts) {
    const segs = new Map<string, { row: number; c0: number; c1: number; label: number | null }>();
    for (const { idx, row, col } of cells) {
      const c = bursts.get(images[idx].id);
      if (!c) continue;
      const key = `${c.group}:${row}`;
      const seg = segs.get(key);
      const label = c.pos === 1 ? c.len : null;
      if (!seg) segs.set(key, { row, c0: col, c1: col, label });
      else {
        seg.c0 = Math.min(seg.c0, col);
        seg.c1 = Math.max(seg.c1, col);
        if (label != null) seg.label = label;
      }
    }
    for (const [key, s] of segs) burstSegs.push({ key, ...s });
  }

  return (
    <div className="cull-grid" ref={containerRef}>
      <div className="cull-grid__inner" style={{ height: totalH }}>
        {burstSegs.map((s) => (
          <fieldset
            key={`burst-${s.key}`}
            className="cull-burst-box cull-burst-box--grid"
            style={{
              // border-box: 3px outside cell bounds + the cells' 3px internal
              // padding ⇒ ~4px air from the line's inner face to the photos.
              // Labeled segments start ~4px higher: a fieldset's painted top
              // border sits at its legend's vertical midpoint.
              left: s.c0 * cellW - 3,
              top: s.row * rowH - (s.label != null ? 7 : 3),
              width: (s.c1 - s.c0 + 1) * cellW + 6,
              height: rowH + (s.label != null ? 10 : 6),
            }}
            aria-hidden
          >
            {s.label != null && (
              <legend className="cull-burst-box__count">Burst ×{s.label}</legend>
            )}
          </fieldset>
        ))}
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
            suggestion={suggestions?.[images[idx].id] ?? null}
            burst={bursts?.get(images[idx].id) ?? null}
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
  suggestion,
  burst,
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
  suggestion?: Suggestion | null;
  burst?: BurstCtx | null;
}) {
  // Grid cells render thumbnails only; the store self-schedules the thumb on
  // mount (and prioritises by the reported grid viewport) and re-renders this
  // cell when it lands. `shimmer` → placeholder; otherwise show the thumb.
  // Thumbnail + pinned shimmer phase, shared with the strip's ThumbCell.
  const { url, shimmerDelayMs } = useThumb(img.path);
  const isReject = rating === "reject";
  // Verdict glyph + colour modifier for the dot (shared with the strip's ThumbCell).
  const dotIcon = verdictGlyph(rating, 12);
  const dotClass = verdictDotClass(rating, "cull-grid__dot");
  const showLrc = hasLrcRating(lrcRating, rating);
  // Ghost suggestion only while unrated — the committed dot supersedes in
  // place. The burst winner wears the same ghost ✓; the run outline is drawn
  // at the grid level (segment boxes), not per cell.
  const ghost =
    !rating && (suggestion?.verdict ?? (burst?.isWinner ? ("keep" as const) : null));
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
      role="button"
      aria-label={`${stripExt(img.filename)}${rating ? `, ${rating}` : ""}${
        isMultiSelected ? ", selected" : isCurrent ? ", current" : ""
      }`}
    >
      {/* Frame element always exists, so the current-cell outline is visible
          on both the loaded thumb AND the placeholder shimmer — placeholders
          aren't invisible just because their thumb hasn't arrived. */}
      <div className="cull-grid__frame">
        {url ? (
          // decoding="sync": tiny JPEG — paint with layout, no remount blank
          // (see ThumbCell; same 1–2-frame re-shimmer fix).
          <img className="cull-grid__img" src={url} alt="" decoding="sync" />
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
              ["--shimmer-delay" as string]: `-${shimmerDelayMs}ms`,
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
          their filename inline). */}
      {url && (
        <div className="cull-grid__fn" aria-hidden>
          {stripExt(img.filename)}
        </div>
      )}
      {/* Multi-select tint sits above the photo but below the rating dot, so
          the dot remains legible. Outline (accent) comes from .is-multi-selected. */}
      {isMultiSelected && <div className="cull-grid__multi-tint" aria-hidden />}
      {dotIcon ? (
        <div className={`cull-grid__dot ${dotClass}`} aria-hidden>
          {dotIcon}
        </div>
      ) : (
        ghost && (
          <div
            className={`cull-grid__dot cull-grid__dot--ghost cull-grid__dot--ghost-${
              ghost === "reject" ? "reject" : "keep"
            }`}
            aria-hidden
          >
            {ghostGlyph(ghost, 12)}
          </div>
        )
      )}
    </div>
  );
});
