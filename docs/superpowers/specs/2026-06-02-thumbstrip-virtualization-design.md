# Scroll-driven virtual filmstrip — design

**Date:** 2026-06-02
**Status:** approved (pre-implementation)
**Scope:** the LOUPE filmstrip (`ThumbStrip`) and the COMPARE candidate strip
(`CompareStrip`), plus the shared cell (`ThumbCell`).

## Problem

The filmstrip does ~6× more work than it needs to on every scrub step, and the
windowing logic is duplicated across the two strips.

Today both strips virtualize with a fixed `STRIP_RADIUS = 100` → up to **201
live cells** around the cursor, with transparent spacer `<div>`s on each side
reproducing the full scroll width (`CELL_STRIDE = 80px`). On every
`currentIndex` / challenger change — i.e. ~30×/sec during hold-to-scrub — the
strip:

- allocates **201 React elements** via `images.slice(first, last).map(...)` and
  runs **201 `memo` comparisons** (7 props each) to actually re-render ~2 cells;
- runs `querySelector('[data-idx]')` + `scrollIntoView({ behavior: "auto",
  inline: "center" })` — a **DOM query plus a forced synchronous layout**;
- **mounts/unmounts** one cell (subscribe/unsubscribe + effect churn).

A wide monitor only shows ~33 cells (76+4px each), so `STRIP_RADIUS = 100` keeps
~6× more cells live than are visible. The props are otherwise clean — the
`onPick` callbacks are stable `useCallback`s and each cell receives only
primitives — so there is **no re-render bomb**; the cost is purely structural
(window size + forced layout + duplication).

This is not an I/O problem. Thumbs are cached all-session and warmed by the
`imageStore` background fill; scrub responsiveness is already decoupled from
storage. The recode keeps scrub *responsiveness* constant regardless of
NAS-vs-local; it does not (and cannot) conjure thumbs that have not yet loaded —
fast scrubbing past not-yet-filled cells still shows shimmer, which remains the
background fill's concern, not the strip's.

## Goals

1. **Faster scrub** — eliminate the per-step forced layout and shrink the live
   window from 201 cells to ~viewport+buffer (~40).
2. **Less complexity** — collapse the duplicated windowing in `ThumbStrip` and
   `CompareStrip` into one shared, tested unit.

## Non-goals

- Changing the look of the strip or cells (sizing, spacing, badges, dimming,
  outlines, separator, champion pin) — behavior parity is required.
- Changing thumbnail loading / caching / prioritization (`imageStore`).
- Canvas / single-surface rendering — overkill for a strip that is neither I/O-
  nor paint-bound, and it would lose CSS/SVG badges and dimming.

## Architecture

Four units with single responsibilities:

```
ThumbStrip / CompareStrip   (thin wrappers — list semantics only)
        ↓ render
FilmStrip                   (scroll container + positioned window of cells)
        ↓ uses
useStripVirtualizer         (DOM glue: scroll/resize → range, imperative centering)
        ↓ uses
computeWindow / computeCenterScrollLeft   (PURE math — unit-tested)
```

### 1. `src/components/strip/computeWindow.ts` — pure, unit-tested

No DOM, no React. Mirrors how `src/image/stage.ts` isolates the testable rule
set so it can be unit-tested without a renderer.

```ts
computeWindow({ scrollLeft, clientWidth, stride, count, buffer })
  → { first, last }
//   first = clamp(floor(scrollLeft / stride) - buffer, 0, count)
//   last  = clamp(ceil((scrollLeft + clientWidth) / stride) + buffer, 0, count)

computeCenterScrollLeft({ centerOffset, stride, cellWidth, clientWidth, trackWidth })
  → number
//   clamp(centerOffset * stride - (clientWidth - cellWidth) / 2,
//         0, max(0, trackWidth - clientWidth))
```

All off-by-one and clamp logic lives here. Vitest only — consistent with the
repo's "pure helpers are unit-tested; presentational components are not" policy.

### 2. `src/components/strip/useStripVirtualizer.ts` — DOM glue

Owns the scroll-container ref and a `{ first, last }` state. Not unit-tested
(DOM + rAF + ResizeObserver), consistent with the component-test policy.

- **Manual scroll** (user drags the strip): rAF-throttled `scroll` handler
  recomputes the range via `computeWindow`.
- **Centering** (`centerOffset` change): a `useLayoutEffect` writes
  `container.scrollLeft = computeCenterScrollLeft(...)` (direct assignment is
  instant — never animates) **and synchronously recomputes the range in the
  same effect**, so the centered cell is present in the same frame. The range
  does not depend on the asynchronous `scroll` event firing, so there is no
  flash; the scroll handler is only a backstop for manual dragging.
- **Resize** (`ResizeObserver` on the container): recompute range **and**
  re-center, so a monitor resize or a thumb-strip top/bottom toggle keeps the
  active cell centered.
- Returns `{ containerRef, trackWidth, first, last }`.

No `querySelector`, no `scrollIntoView`, no spacer math.

### 3. `src/components/strip/FilmStrip.tsx` — presentational windowed track

Props: `className, count, stride, cellWidth, trackHeight, centerOffset, buffer,
keyForItem, renderItem`.

Renders the scroll container (`className`) wrapping a single fixed-width track
(`width = count * stride`, `height = trackHeight`, `position: relative`). Each
windowed item (`first..last`) is wrapped in an absolutely-positioned div at
`left = listIndex * stride`, keyed by `keyForItem(listIndex)` so a cell's
identity — and therefore its `useImage` subscription — survives window shifts.
`renderItem(listIndex)` returns the `ThumbCell`.

### 4. `ThumbStrip` / `CompareStrip` — thin wrappers

**ThumbStrip** keeps the `visibleSet` memo (for dimming) and renders:

```tsx
<FilmStrip
  className="cull-thumbs"
  count={images.length}
  centerOffset={currentIndex}
  keyForItem={(i) => images[i].id}
  renderItem={(i) => (
    <ThumbCell
      img={images[i]} index={i}
      isCurrent={i === currentIndex}
      rating={ratings[images[i].id]}
      lrcRating={metadata?.[images[i].path]?.lrcRating ?? null}
      dimmed={!visibleSet.has(i)}
      onPick={onPick}
    />
  )}
/>
```

**CompareStrip** keeps its pinned champion + separator markup; only the
candidate strip becomes a `FilmStrip`:

```tsx
const cpos = candidates.indexOf(challengerIndex); // unchanged from today
<FilmStrip
  className="cull-cmp-strip__candidates"
  count={candidates.length}
  centerOffset={cpos}              // < 0 → virtualizer skips centering
  keyForItem={(i) => images[candidates[i]].id}
  renderItem={(i) => {
    const idx = candidates[i];
    return (
      <ThumbCell
        img={images[idx]} index={idx}
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
```

### `ThumbCell` and metrics

`ThumbCell` is unchanged except: remove the `STRIP_RADIUS` export (gone) and the
`data-idx` attribute (its only consumer was the removed `querySelector` — grep
to confirm no other consumer before deleting). Cell metrics move to a small
`src/components/strip/metrics.ts`:

```ts
export const CELL_W = 76;
export const CELL_H = 54;
export const CELL_GAP = 4;
export const CELL_STRIDE = CELL_W + CELL_GAP; // 80
export const STRIP_BUFFER = 4;                // cells beyond viewport each side
```

## Data flow per scrub step (after)

`setCurrentIndex` → `ThumbStrip` re-renders → `FilmStrip` renders ~40 windowed
cells → `useStripVirtualizer` layout-effect writes `scrollLeft` and sets the
range once. No DOM query, no forced reflow loop; ~40 element allocations and
`memo` comparisons instead of 201.

## Behavior parity (must stay identical)

Instant centering, dimming of out-of-filter cells (opacity 0.18), reject opacity
(0.45), verdict dots, LrC/role badges, champion pin, separator dot. The only
observable change is identical look with smoother scrub.

## Edge cases

- `count === 0` (empty candidate strip) → empty track, no crash.
- `centerOffset === -1` (challenger not in candidates) → skip centering, keep
  current scroll position.
- Single-cell list → small track, no scroll.
- End-of-list clamp → the active cell sits off-center at the very start/end
  (same as today's `inline: "center"` clamp behavior).
- The scroll container must not carry `scroll-behavior: smooth` (verify the CSS;
  current `.cull-thumbs` / `.cull-cmp-strip__candidates` do not).

## Thumb-request implication (intentional)

The strip now fires `requestThumbFor` for ~40 cells instead of 201.
Off-window thumbs are covered by `imageStore`'s background fill, which is already
cursor-prioritized (`setCursor` re-sorts by distance to cursor). Net effect:
fewer redundant on-demand requests competing with on-screen reads — strictly
better, and the reason NAS-vs-local feel is unaffected. Cached thumbs are not
evicted when a cell unmounts (session LRU is independent of mount state), so
revisiting an off-window frame is still instant.

## Testing

- **Unit (Vitest):** `computeWindow.test.ts` — window bounds, buffer, clamps at
  0 and `count`, center math, and the two end-of-list clamps.
- **Smoke (manual, in-app):** loupe scrub on the 5k NAS shoot; compare scrub;
  manual drag of the strip; window resize; thumb-strip top↔bottom toggle;
  jump-click to a far cell; both ends of the list.

## Rollback

Fully contained to the strip files (`ThumbStrip`, `CompareStrip`, `ThumbCell`,
the new `strip/` module). Revert the single feature commit.

## File layout

```
src/components/strip/computeWindow.ts        (new, pure)
src/components/strip/computeWindow.test.ts   (new)
src/components/strip/useStripVirtualizer.ts  (new)
src/components/strip/FilmStrip.tsx           (new)
src/components/strip/metrics.ts              (new)
src/components/ThumbStrip.tsx                (slimmed to a wrapper)
src/components/CompareStrip.tsx              (slimmed to a wrapper)
src/components/ThumbCell.tsx                 (drop STRIP_RADIUS + data-idx)
```
