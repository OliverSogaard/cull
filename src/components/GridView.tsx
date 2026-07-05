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
  similar,
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
  /** Similar-set membership by image id — same run-box treatment as bursts,
   *  cooler tint, "Similar ×N" legend. Bursts win where both would claim an
   *  id (structurally shouldn't overlap — groupSimilar excludes burst
   *  members). */
  similar?: Map<number, BurstCtx>;
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
  type Seg = {
    row: number;
    c0: number;
    c1: number;
    label: number | null;
    /** Run continues before/after this segment (row wrap): that edge renders
     *  OPEN (no border, square corners) so the box reads as continuing. */
    openLeft: boolean;
    openRight: boolean;
    /** "burst" = camera burst; "similar" = lookalike set. Drives the box's
     *  modifier class and legend word. */
    kind: "burst" | "similar";
  };
  const burstSegs: ({ key: string } & Seg)[] = [];
  if (bursts || similar) {
    const lookup = (id: number): { c: BurstCtx; kind: "burst" | "similar" } | undefined => {
      const b = bursts?.get(id);
      if (b) return { c: b, kind: "burst" };
      const s = similar?.get(id);
      return s ? { c: s, kind: "similar" } : undefined;
    };
    const segs = new Map<string, Seg & { firstPos: number; lastPos: number; len: number }>();
    for (const { idx, row, col } of cells) {
      const hit = lookup(images[idx].id);
      if (!hit) continue;
      const { c, kind } = hit;
      const key = `${kind}:${c.group}:${row}`;
      const seg = segs.get(key);
      const label = c.pos === 1 ? c.len : null;
      if (!seg) {
        segs.set(key, {
          row,
          c0: col,
          c1: col,
          label,
          firstPos: c.pos,
          lastPos: c.pos,
          len: c.len,
          openLeft: false,
          openRight: false,
          kind,
        });
      } else {
        seg.c0 = Math.min(seg.c0, col);
        seg.c1 = Math.max(seg.c1, col);
        if (label != null) seg.label = label;
        seg.firstPos = Math.min(seg.firstPos, c.pos);
        seg.lastPos = Math.max(seg.lastPos, c.pos);
      }
    }
    for (const [key, s] of segs) {
      burstSegs.push({
        key,
        row: s.row,
        c0: s.c0,
        c1: s.c1,
        label: s.label,
        openLeft: s.firstPos > 1,
        openRight: s.lastPos < s.len,
        kind: s.kind,
      });
    }
  }

  return (
    <div className="cull-grid" ref={containerRef}>
      <div className="cull-grid__inner" style={{ height: totalH }}>
        {burstSegs.map((s) => (
          <fieldset
            key={`burst-${s.key}`}
            className={`cull-burst-box cull-burst-box--grid${
              s.kind === "similar" ? " cull-burst-box--similar" : ""
            }`}
            style={{
              // The box lives INSIDE the inter-image corridor (cells pad 9px,
              // so images sit 18px apart): lines 2px inside the cell bound ⇒
              // ~5px air to the segment's own photos, ~11px to neighbours,
              // 4px between side-by-side boxes, and a labeled edge's legend
              // clears a box ending in the row above. Labeled segments start
              // 4px higher: a fieldset paints its top border at the legend's
              // vertical midpoint.
              left: s.c0 * cellW + (s.openLeft ? 0 : 2),
              top: s.row * rowH + 2 - (s.label != null ? 4 : 0),
              width: (s.c1 - s.c0 + 1) * cellW - (s.openLeft ? 0 : 2) - (s.openRight ? 0 : 2),
              height: rowH - 5 + (s.label != null ? 4 : 0),
              ...(s.openLeft && {
                borderLeft: "none",
                borderTopLeftRadius: 0,
                borderBottomLeftRadius: 0,
              }),
              ...(s.openRight && {
                borderRight: "none",
                borderTopRightRadius: 0,
                borderBottomRightRadius: 0,
              }),
            }}
            aria-hidden
          >
            {s.label != null && (
              <legend className="cull-burst-box__count">
                {s.kind === "similar" ? "Similar" : "Burst"} ×{s.label}
              </legend>
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
  // place. Ghosts are suggestion-driven only; the run outline is drawn
  // at the grid level (segment boxes), not per cell.
  const ghost =
    !rating && (suggestion?.verdict ?? null);
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
