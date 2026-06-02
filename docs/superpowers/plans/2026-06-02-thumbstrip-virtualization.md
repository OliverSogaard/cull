# Thumbstrip Virtualization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the LOUPE/COMPARE filmstrip's 201-cell radius window + `scrollIntoView` centering with one shared scroll-driven virtualizer that renders only ~visible+buffer cells and centers by a direct `scrollLeft` write.

**Architecture:** A pure math module (`computeWindow`) feeds a DOM-glue hook (`useStripVirtualizer`) that drives a presentational `FilmStrip` (single fixed-width track, absolutely-positioned windowed cells). `ThumbStrip` and `CompareStrip` become thin wrappers over `FilmStrip`. No `querySelector`, no forced layout, no spacer math.

**Tech Stack:** React 18 (`useSyncExternalStore` already wires per-cell image state), TypeScript, Vitest, Vite, Tauri.

**Reference spec:** `docs/superpowers/specs/2026-06-02-thumbstrip-virtualization-design.md`

**Commands** (run from the worktree root; use the Bash tool):
- Typecheck: `pnpm exec tsc --noEmit`
- Unit test (single file): `CI=true pnpm exec vitest run src/components/strip/computeWindow.test.ts`
  - PowerShell variant if needed: `$env:CI="true"; pnpm exec vitest run src/components/strip/computeWindow.test.ts`
- Full unit suite: `CI=true pnpm exec vitest run`

**Commit-green invariant:** every task leaves `pnpm exec tsc --noEmit` passing. The old `ThumbCell` exports (`STRIP_RADIUS`, `CELL_STRIDE`) stay in place until *both* strips are migrated (Task 7), so no commit has a dangling import.

---

### Task 1: Strip metrics constants

**Files:**
- Create: `src/components/strip/metrics.ts`

- [ ] **Step 1: Create the metrics module**

```ts
// src/components/strip/metrics.ts
/** Filmstrip cell geometry, shared by FilmStrip + the virtualizer math. */
export const CELL_W = 76;
export const CELL_H = 54;
export const CELL_GAP = 4;
/** Per-cell horizontal stride: 76px frame + 4px gap (see App.css .cull-thumb). */
export const CELL_STRIDE = CELL_W + CELL_GAP; // 80
/** Cells rendered beyond the visible viewport on each side (manual-drag margin). */
export const STRIP_BUFFER = 4;
```

- [ ] **Step 2: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: PASS (no errors).

- [ ] **Step 3: Commit**

```bash
git add src/components/strip/metrics.ts
git commit -m "feat(strip): cell metrics module for shared virtualizer"
```

---

### Task 2: Pure window math (`computeWindow`, `computeCenterScrollLeft`)

**Files:**
- Create: `src/components/strip/computeWindow.ts`
- Test: `src/components/strip/computeWindow.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/components/strip/computeWindow.test.ts
import { describe, expect, it } from "vitest";
import { clamp, computeCenterScrollLeft, computeWindow } from "./computeWindow";

describe("clamp", () => {
  it("bounds a value within [lo, hi]", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });
});

describe("computeWindow", () => {
  const stride = 80;
  it("returns an empty range for an empty list", () => {
    expect(
      computeWindow({ scrollLeft: 0, clientWidth: 800, stride, count: 0, buffer: 4 }),
    ).toEqual({ first: 0, last: 0 });
  });
  it("covers the visible span plus buffer at scroll 0 (first clamps to 0)", () => {
    // 800/80 = 10 visible cells; ceil(800/80)=10, +4 buffer = 14; first = 0-4 clamped to 0.
    const r = computeWindow({ scrollLeft: 0, clientWidth: 800, stride, count: 1000, buffer: 4 });
    expect(r.first).toBe(0);
    expect(r.last).toBe(14);
  });
  it("slides the window with scroll position", () => {
    // floor(8000/80)=100 → first=96; ceil(8800/80)=110 → last=114.
    const r = computeWindow({ scrollLeft: 8000, clientWidth: 800, stride, count: 1000, buffer: 4 });
    expect(r.first).toBe(96);
    expect(r.last).toBe(114);
  });
  it("clamps last to count near the end", () => {
    const r = computeWindow({ scrollLeft: 79000, clientWidth: 800, stride, count: 1000, buffer: 4 });
    expect(r.last).toBe(1000);
  });
});

describe("computeCenterScrollLeft", () => {
  const stride = 80;
  const cellWidth = 76;
  const clientWidth = 800;
  const trackWidth = 1000 * stride; // 80000

  it("centers a mid-list cell", () => {
    // 500*80 - (800-76)/2 = 40000 - 362 = 39638
    expect(
      computeCenterScrollLeft({ centerOffset: 500, stride, cellWidth, clientWidth, trackWidth }),
    ).toBe(39638);
  });
  it("clamps to 0 at the start", () => {
    expect(
      computeCenterScrollLeft({ centerOffset: 0, stride, cellWidth, clientWidth, trackWidth }),
    ).toBe(0);
  });
  it("clamps to max scroll at the end", () => {
    const max = trackWidth - clientWidth; // 79200
    expect(
      computeCenterScrollLeft({ centerOffset: 999, stride, cellWidth, clientWidth, trackWidth }),
    ).toBe(max);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `CI=true pnpm exec vitest run src/components/strip/computeWindow.test.ts`
Expected: FAIL — cannot resolve `./computeWindow` / functions not defined.

- [ ] **Step 3: Write the implementation**

```ts
// src/components/strip/computeWindow.ts
export type WindowRange = { first: number; last: number };

export function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

/**
 * Visible cell range [first, last) for a horizontal strip, given the scroll
 * position and viewport width. Pure — no DOM. `buffer` extends the range on
 * each side so a manual drag reveals already-rendered cells.
 */
export function computeWindow(args: {
  scrollLeft: number;
  clientWidth: number;
  stride: number;
  count: number;
  buffer: number;
}): WindowRange {
  const { scrollLeft, clientWidth, stride, count, buffer } = args;
  if (count <= 0 || stride <= 0) return { first: 0, last: 0 };
  const first = clamp(Math.floor(scrollLeft / stride) - buffer, 0, count);
  const last = clamp(Math.ceil((scrollLeft + clientWidth) / stride) + buffer, 0, count);
  return { first, last };
}

/**
 * scrollLeft that centers cell `centerOffset` in the viewport, clamped to the
 * scrollable range. At the list ends the cell sits off-center (same as the old
 * `scrollIntoView({ inline: "center" })` clamp).
 */
export function computeCenterScrollLeft(args: {
  centerOffset: number;
  stride: number;
  cellWidth: number;
  clientWidth: number;
  trackWidth: number;
}): number {
  const { centerOffset, stride, cellWidth, clientWidth, trackWidth } = args;
  const target = centerOffset * stride - (clientWidth - cellWidth) / 2;
  const max = Math.max(0, trackWidth - clientWidth);
  return clamp(target, 0, max);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `CI=true pnpm exec vitest run src/components/strip/computeWindow.test.ts`
Expected: PASS — all assertions green.

- [ ] **Step 5: Commit**

```bash
git add src/components/strip/computeWindow.ts src/components/strip/computeWindow.test.ts
git commit -m "feat(strip): pure window + center-scroll math with unit tests"
```

---

### Task 3: `useStripVirtualizer` hook (DOM glue)

**Files:**
- Create: `src/components/strip/useStripVirtualizer.ts`

No unit test — this is DOM/rAF/ResizeObserver glue, consistent with the repo's policy of unit-testing pure helpers only (see `ARCHITECTURE.md` "Test surface"). The math it relies on is covered by Task 2.

- [ ] **Step 1: Write the hook**

```ts
// src/components/strip/useStripVirtualizer.ts
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { computeCenterScrollLeft, computeWindow, type WindowRange } from "./computeWindow";

/**
 * Scroll-driven virtualizer for a horizontal filmstrip. Owns the scroll
 * container ref and the visible {first,last} range. Centering on `centerOffset`
 * is an imperative `scrollLeft` write (instant); the range is recomputed
 * synchronously in the same layout effect so the centered cell is present the
 * same frame. A rAF-throttled scroll handler backstops manual dragging, and a
 * ResizeObserver re-centers on container resize (monitor resize / strip toggle).
 */
export function useStripVirtualizer(args: {
  count: number;
  stride: number;
  cellWidth: number;
  centerOffset: number;
  buffer: number;
}) {
  const { count, stride, cellWidth, centerOffset, buffer } = args;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [range, setRange] = useState<WindowRange>({ first: 0, last: 0 });
  const rafRef = useRef<number | null>(null);
  const trackWidth = count * stride;

  const recompute = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const next = computeWindow({
      scrollLeft: el.scrollLeft,
      clientWidth: el.clientWidth,
      stride,
      count,
      buffer,
    });
    setRange((prev) =>
      prev.first === next.first && prev.last === next.last ? prev : next,
    );
  }, [stride, count, buffer]);

  const center = useCallback(() => {
    const el = containerRef.current;
    if (el && centerOffset >= 0) {
      el.scrollLeft = computeCenterScrollLeft({
        centerOffset,
        stride,
        cellWidth,
        clientWidth: el.clientWidth,
        trackWidth: count * stride,
      });
    }
    recompute();
  }, [centerOffset, stride, cellWidth, count, recompute]);

  // Keep a stable ref to the latest `center` so the scroll/resize subscriptions
  // don't tear down + re-subscribe on every scrub step (centerOffset change).
  const centerRef = useRef(center);
  useLayoutEffect(() => {
    centerRef.current = center;
  });

  // Re-center whenever the active offset or geometry changes.
  useLayoutEffect(() => {
    center();
  }, [center]);

  // Manual-scroll backstop: rAF-throttled range recompute.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onScroll = () => {
      if (rafRef.current != null) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        recompute();
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [recompute]);

  // Resize: re-center + recompute (clientWidth changed). Subscribed once.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => centerRef.current());
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return { containerRef, trackWidth, first: range.first, last: range.last };
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/components/strip/useStripVirtualizer.ts
git commit -m "feat(strip): scroll-driven virtualizer hook"
```

---

### Task 4: `FilmStrip` presentational track

**Files:**
- Create: `src/components/strip/FilmStrip.tsx`

- [ ] **Step 1: Write the component**

```tsx
// src/components/strip/FilmStrip.tsx
import type { ReactNode } from "react";
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
}) {
  const { containerRef, trackWidth, first, last } = useStripVirtualizer({
    count,
    stride,
    cellWidth,
    centerOffset,
    buffer,
  });

  const items: ReactNode[] = [];
  for (let i = first; i < last; i++) {
    items.push(
      <div
        key={keyForItem(i)}
        style={{
          position: "absolute",
          left: i * stride,
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
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/components/strip/FilmStrip.tsx
git commit -m "feat(strip): FilmStrip windowed-track component"
```

---

### Task 5: Migrate `ThumbStrip` to `FilmStrip` (+ CSS padding)

**Files:**
- Modify (full rewrite): `src/components/ThumbStrip.tsx`
- Modify: `src/App.css` (`.cull-thumbs` horizontal padding → 0)

The old `ThumbCell` still exports `STRIP_RADIUS`/`CELL_STRIDE`; `CompareStrip` still imports them — leave them until Task 7 so the build stays green.

- [ ] **Step 1: Rewrite `ThumbStrip.tsx`**

Replace the entire file with:

```tsx
// src/components/ThumbStrip.tsx
import { useMemo } from "react";
import type { Img, ImageMetadata, Rating } from "../types";
import { ThumbCell } from "./ThumbCell";
import { FilmStrip } from "./strip/FilmStrip";
import { CELL_H, CELL_STRIDE, CELL_W, STRIP_BUFFER } from "./strip/metrics";

/**
 * The loupe's filmstrip. Renders every image in the staged set, virtualized via
 * {@link FilmStrip}: only ~viewport+buffer cells around the cursor are live.
 * Cells outside the active filter are dimmed (not hidden) so the user can see
 * what's around them in capture order. Centering is an instant scrollLeft write
 * (smooth scrolling can't keep up with hold-to-scrub).
 */
export function ThumbStrip({
  images,
  currentIndex,
  ratings,
  visibleIndices,
  metadata,
  onPick,
}: {
  images: Img[];
  currentIndex: number;
  ratings: Record<number, Rating>;
  visibleIndices: number[];
  /** Optional metadata map; only `lrcRating` is read here for the corner badge. */
  metadata?: Record<string, ImageMetadata>;
  onPick: (index: number) => void;
}) {
  const visibleSet = useMemo(() => new Set(visibleIndices), [visibleIndices]);

  return (
    <FilmStrip
      className="cull-thumbs"
      count={images.length}
      stride={CELL_STRIDE}
      cellWidth={CELL_W}
      trackHeight={CELL_H}
      centerOffset={currentIndex}
      buffer={STRIP_BUFFER}
      keyForItem={(i) => images[i].id}
      renderItem={(i) => (
        <ThumbCell
          img={images[i]}
          index={i}
          isCurrent={i === currentIndex}
          rating={ratings[images[i].id]}
          lrcRating={metadata?.[images[i].path]?.lrcRating ?? null}
          dimmed={!visibleSet.has(i)}
          onPick={onPick}
        />
      )}
    />
  );
}
```

- [ ] **Step 2: Update `.cull-thumbs` padding in `src/App.css`**

The old code centered via `scrollIntoView`, which is padding-aware. The new code maps `scrollLeft` directly to `index * stride`, so horizontal padding on the scroll container would offset centering. Remove the horizontal padding (keep vertical). Find (around `App.css:2526`):

```css
.cull-thumbs {
  flex: 0 0 auto;
  height: 70px;
  display: flex;
  align-items: center;
  padding: 8px 12px;
  gap: 4px;
  overflow-x: auto;
  overflow-y: hidden;
```

Change the `padding` line to:

```css
  padding: 8px 0;
```

(Leave every other line unchanged. `align-items: center` still vertically centers the 54px track in the 70px strip; `gap` is now inert with a single track child.)

- [ ] **Step 3: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Manual sanity (loupe)**

Run the app (`pnpm tauri dev`), open a folder, enter LOUPE. Verify: the strip shows thumbnails centered on the current cell; arrow-scrub keeps the current cell centered and instant; out-of-filter cells are dimmed; verdict dots + LrC badges render. Compare-mode strip is untouched this task.

- [ ] **Step 5: Commit**

```bash
git add src/components/ThumbStrip.tsx src/App.css
git commit -m "feat(strip): migrate ThumbStrip to FilmStrip virtualizer"
```

---

### Task 6: Migrate `CompareStrip` to `FilmStrip`

**Files:**
- Modify (full rewrite): `src/components/CompareStrip.tsx`

- [ ] **Step 1: Rewrite `CompareStrip.tsx`**

Replace the entire file with:

```tsx
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
```

- [ ] **Step 2: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Manual sanity (compare)**

Run the app, enter COMPARE. Verify: champion pinned left with separator; candidate strip centers the challenger; scrubbing the challenger keeps it centered and instant; role badges render; `count === 0` (no candidates) does not crash; `cpos === -1` (challenger rated away) keeps the current scroll position without throwing.

- [ ] **Step 4: Commit**

```bash
git add src/components/CompareStrip.tsx
git commit -m "feat(strip): migrate CompareStrip to FilmStrip virtualizer"
```

---

### Task 7: Remove dead `ThumbCell` exports + `data-idx`

**Files:**
- Modify: `src/components/ThumbCell.tsx`

Both strips now import geometry from `strip/metrics`, so `ThumbCell`'s
`STRIP_RADIUS`/`CELL_STRIDE` exports and the `data-idx` attribute (only consumer
was the removed `querySelector`) are dead.

- [ ] **Step 1: Confirm nothing else imports the old exports**

Run: `grep -rn "STRIP_RADIUS\|data-idx" src; grep -rn "CELL_STRIDE" src | grep -v "strip/metrics\|strip/computeWindow\|strip/FilmStrip\|strip/useStripVirtualizer"`
Expected: the first grep matches only the lines about to be deleted in `ThumbCell.tsx`; the second grep matches only the `ThumbCell.tsx` export line about to be deleted (the new strip files import `CELL_STRIDE` from `strip/metrics`, which the filter excludes). If any *other* file still imports `STRIP_RADIUS`/`CELL_STRIDE` from `./ThumbCell`, stop and migrate it to `strip/metrics` first.

- [ ] **Step 2: Edit `ThumbCell.tsx`**

Delete the virtualization-knobs block near the top (the doc comment plus the two exports):

```tsx
/**
 * Strip virtualization knobs. Both the loupe strip and the compare candidate
 * strip render at most this many cells around the cursor; the missing cells on
 * either side are reproduced as transparent spacers (`CELL_STRIDE` wide each)
 * so the scrollbar still represents the full list.
 */
export const STRIP_RADIUS = 100;

/** Per-cell horizontal stride: 76 px frame + 4 px gap (see CSS). */
export const CELL_STRIDE = 80;
```

Delete that entire block. Then delete the `data-idx` attribute on the cell's
outer `<div>`:

```tsx
      data-idx={index}
```

(Keep the `index` prop and the `onClick={() => onPick(index)}` handler — `index` is still used for the click target.)

- [ ] **Step 3: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: PASS (no unused-symbol or missing-import errors).

- [ ] **Step 4: Commit**

```bash
git add src/components/ThumbCell.tsx
git commit -m "refactor(strip): drop dead STRIP_RADIUS/CELL_STRIDE/data-idx from ThumbCell"
```

---

### Task 8: Full verification + smoke

**Files:** none (verification only).

- [ ] **Step 1: Full unit suite**

Run: `CI=true pnpm exec vitest run`
Expected: PASS — all suites green, including `computeWindow.test.ts`.

- [ ] **Step 2: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Production build**

Run: `pnpm build`
Expected: PASS — Vite build succeeds, no TS errors.

- [ ] **Step 4: In-app smoke on the 5k NAS shoot**

Run `pnpm tauri dev`, open the 5k folder on NAS. Verify each:
- LOUPE arrow-scrub: current cell stays centered, instant, no stutter/skip; smoother than before.
- COMPARE: champion pinned; challenger centered; scrub smooth.
- Manual drag of the loupe strip with the mouse: cells render across the dragged range (no blank gaps within the viewport).
- Resize the window / toggle the thumb strip top↔bottom (settings): active cell re-centers, no layout drift.
- Jump-click a far cell: strip recenters on it.
- Both ends of the list: first/last cell reachable; sits against the edge (off-center) at the extremes, no crash.
- Filter active: out-of-filter cells dimmed in LOUPE.

- [ ] **Step 5: Final confirmation**

No commit needed (Tasks 1-7 already committed). Report results of Steps 1-4.

---

## Self-Review

**Spec coverage:**
- `computeWindow` / `computeCenterScrollLeft` pure + tested → Task 2. ✓
- `useStripVirtualizer` (scroll backstop, layout-effect centering, ResizeObserver) → Task 3. ✓
- `FilmStrip` (fixed-width track, absolute windowed cells, keyForItem) → Task 4. ✓
- `metrics.ts` (CELL_*, STRIP_BUFFER) → Task 1. ✓
- ThumbStrip wrapper + dimming via visibleSet → Task 5. ✓
- CompareStrip wrapper (champion/sep preserved, cpos centering, count===0 / cpos===-1) → Task 6. ✓
- ThumbCell: drop STRIP_RADIUS + data-idx → Task 7. ✓
- No `scroll-behavior: smooth` — verified absent in App.css (no change needed). ✓
- Testing (unit + smoke) → Tasks 2 and 8. ✓

**Placeholder scan:** none — every code/test step contains complete code; every command has expected output.

**Type consistency:** `computeWindow`/`computeCenterScrollLeft` arg shapes match between Task 2 (definition) and Task 3 (call sites). `WindowRange` used in Tasks 2-3. `FilmStrip` prop names (`className, count, stride, cellWidth, trackHeight, centerOffset, buffer, keyForItem, renderItem`) match between Task 4 (definition) and Tasks 5-6 (usage). `metrics` exports (`CELL_W, CELL_H, CELL_STRIDE, STRIP_BUFFER`) defined in Task 1, imported in Tasks 5-6.
