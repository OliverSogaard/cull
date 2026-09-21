# Phase 3C — Navigate and review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the cull the three things it still cannot do — cross a shoot in one keystroke (`Home` / `End` / `PgUp` / `PgDn`), look at the reject pile before moving it (a fifth filter tab), and put the frames in the order the shutter fired them in rather than the order the card wrote them (EXIF capture time, with a per-folder clock offset for a second body).

**Architecture:** Three independent slices. **A** is keyboard only: two pure step functions (`src/utils/pageStep.ts`) plus four `case`s in each of `useCullKeymap`'s two mode handlers, reading the grid container's `clientHeight` and the live strip stride at keypress time — no new state, no new render path. **B** widens the `Filter` union by one value and follows the compile errors out through `filterModes` / `filter` / `StatusBar` / `EmptyFilter`, then pays for the fifth tab inside the footer's existing `< 1360px` tier. **C** swaps the epoch that `scan.rs`'s existing global chronological sort already runs on: a new `cr3::read_capture_time` (moov-head read, CMT2 only) feeds `analyze_folder`, which prefers a thumb-tier cache hit, falls back to the file's mtime, and adds a per-folder offset the TS side resolves before the call. A new presentational `StagedFolders` surface owns the toggle and the offset steppers; `groupBursts` learns to walk per folder so interleaving two bodies does not shred their bursts.

**Tech Stack:** Tauri 2, Rust (pure-Rust CR3 pipeline: zune-jpeg, fast_image_resize, jpeg-encoder), React 19, TypeScript 5.8 strict, plain CSS with tier-2 tokens, lucide-react, Vitest 4, stylelint 17, pnpm 10.

**Spec:** `docs/superpowers/specs/2026-09-20-phase-3c-navigate-and-review-design.md` (binding — every ruling in it is a decision already taken). Background: `~/.claude/plans/cull-audit-2026-09-13/phase-3c-scout.txt`. The scout is a POINTER, not truth — where this plan and the scout disagree, this plan says so explicitly and the code is what was read.

## Global Constraints

- Branch `phase-3c-navigate-and-review`, cut from `main` @ `c822a3c` (plus `a6f0850`, the spec commit). Every file:line in this plan was read at that tip; if a symbol moved, the **name** wins over the line number, and report the drift.
- **CR3 only.** No other RAW format, no JPEG ingest, no format branching.
- **Scope is the spec.** No drive-by refactors, no new dependencies (JS or Rust), no renames outside a task's own Files list. If the code contradicts the plan, the code wins — report it rather than "fixing" the surroundings.
- **Tests never import `node:*`.** `@types/node` is not installed, so `node:fs` / `node:path` fail both `pnpm typecheck:tests` and the type-aware lint. Read source files with
  `const files = import.meta.glob<string>(pattern, { query: "?raw", eager: true, import: "default" });`
  (always pass the `<string>` type argument). `vite.config.ts`'s `test.css.include` is already scoped to `/\.css\?.*\braw\b/`, so `?raw` CSS reads return real text while ordinary CSS imports stay stubbed. Every such test must first assert the glob returned readable text (`Object.keys(files).length` > 0 and a known substring), or the suite passes on empty strings.
- **Test files are linted type-aware.** Type every `vi.fn` callback (`vi.fn((_x: T) => {})`), and hoist anything a `vi.mock` factory closes over with `vi.hoisted`. Unused bindings need a `_` prefix.
- **jsdom only via a first-line docblock**: `// @vitest-environment jsdom` as line 1 of the file. Default env is node.
- **The app has NO global CSS reset.** Any rule that sets a `height`/`width` alongside padding or a border must declare `box-sizing: border-box` itself, or the rendered box is larger than the number. Chromium's UA sheet also resets `text-transform` and `letter-spacing` on `<button>`, so a button that must inherit an ancestor's casing has to restate it.
- **Focus rings come from `--ring` / `--ring-inset`** (`src/styles/tokens.css`); never invent an outline. `--ring-inset` is for controls with less than 4 px to a neighbour or a window edge.
- **Motion rules live in `src/styles/motion.css`.** `src/styles/motion.test.ts` fails on an `@keyframes` name that no `reviewed:` marker names. Opacity-only transitions are not motion and need no entry. **No task in 3C adds a keyframe.**
- **The display is 240 Hz.** Never assume 60 Hz and never batch work "per animation frame" — a rAF coalescer drops 3 of every 4 events on this machine. Where throttling is needed, use an explicit millisecond window.
- **Immutable updates** (spread, never mutate a settings object or a profile in place). **No `console.log`.**
- **Sentence case** for every user-visible string; CSS does the uppercasing where a surface wants it.
- **Icons come from `src/components/icons.ts`'s `ICON` scale.** No Unicode chrome glyph outside `src/components/icons.test.ts`'s `ALLOWLIST`, and every allowlist entry must match a real trimmed source line. `CHROME_GLYPHS` is `["✓", "✕", "★", "⚠", "↓", "⟶"]` (`icons.test.ts:18`) — U+2212 MINUS SIGN (`−`) is **not** on that list and needs no allowlist entry (`HelpOverlay.tsx:129` already ships one).
- **TDD**: write the failing test first, watch it fail for the right reason, then implement.
- **Commits** are conventional (`feat:`, `fix:`, `refactor:`, `style:`, `perf:`, `docs:`, `test:`), always in pathspec form — `git commit -m "<type>: <desc>" -- <files>` — with **no attribution trailers**. Never `git add -A`, never a bare `git commit`.
  A pathspec commit takes a file's **whole working-tree content**, not a hunk: never plan two commits that split different hunks of one file. One file, one commit, per task.
  The prettier hook reformats after a commit: content leftovers go in a follow-up `style:` pathspec commit; line-ending-only noise is `git add <file>`.
- **Implementers never run `git stash` / `git checkout` / `git restore` / `git reset`.** To watch a test fail, temporarily edit the one line under test and edit it back.
- **Never run the app**, never open a real photo folder, never touch `C:\Canon Media`. A vite dev server may be listening on port 1420 — leave it alone.
- **Gate for every task** (run from the repo root): `pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm lint:css && pnpm test`.
  **Rust tasks additionally** run, from `src-tauri/`: `cargo fmt` FIRST — the Rust in this plan is hand-written, not rustfmt output, so transcribing it verbatim can fail the check gate on nothing but a chain wrap — then, exactly as `.github/workflows/ci.yml` does, `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test`.
  The final task adds `pnpm build` and `pnpm css:census`.
- **Media queries use range notation.** `stylelint-config-standard` sets `media-feature-range-notation: "context"`, so `(max-width: …)` is a lint error; write `(width < 1360px)`. **3C adds no new breakpoint** — every new rule goes inside a block that already exists.
- **A regex over CSS must not be satisfiable by a comment.** Assert with `ruleBody(...)` from `src/styles/layout.test.ts` (exported, `layout.test.ts:25`), which anchors on a **line start** (`\n` plus optional indent) followed by `selector {` — a bare `toContain(".cull-foo")` passes on a comment merely naming the class, and a fix-round report caught exactly that false positive in 3B.
- **A footer width sum must enumerate EVERY always-shown piece from the DOM** (`src/components/StatusBar.tsx`), not from memory, and must count **margins as well as flex gaps** — `.cull-filter-tabs` carries `margin-left: 4px; margin-right: 4px` on top of `.cull-statusbar__right`'s `gap: 14px` (`chrome.css:384-395`).
- **A test that can only run with the `CULL_TEST_CR3_DIR` corpus is not CI coverage.** CI has no CR3 files. Every Rust behaviour added here needs an ungated test of its pure part; a corpus-gated test may only be an *extra*.
- `design-board/` is git-excluded. Nothing in 3C uses it.

---

### Task 1: The page-step arithmetic, and a strip stride readable outside a render

**Files:** Create `src/utils/pageStep.ts`, `src/utils/pageStep.test.ts`. Modify `src/components/strip/useStripMetrics.ts`, `src/components/strip/PhotoStrip.metrics.test.tsx`.

**Interfaces — Produces:**

```ts
// src/utils/pageStep.ts
export function gridPageStep(viewportH: number, rowH: number, cols: number): number;
export function stripPageStep(stripW: number, stride: number): number;
```

```ts
// src/components/strip/useStripMetrics.ts — beside the existing hook
export function stripMetricsNow(): StripMetrics;
```

**Consumes:** `StripMetrics` / `stripMetricsFor` / `STRIP_TALL_QUERY` from `./metrics` (already imported there).

**Ruling (where the strip's width comes from):** `window.innerWidth`, not a new ref. `.cull-strip-wrap` and `.cull-thumbs` are direct children of `main.cull-app` (`App.tsx:2065`, `:2067`, `:1971`, `:2021`), which is `width: 100%; padding: 0` inside a `#root`/`body` that are the same (`base.css:47-62`), and `.cull-thumbs`' padding is `20px 0 8px` — **zero horizontal** (`strip.css`, and `src/components/strip/metrics.test.ts` already pins that exact declaration). `body` is `overflow: hidden`, so no viewport scrollbar eats into it, and `.cull-thumbs`' own horizontal scrollbar is suppressed (`scrollbar-width: none`). The strip's content width therefore **is** the window's inner width, exactly. Threading a ref from `App` through `ThumbStrip` **and** `CompareStrip` into `PhotoStrip` would touch three otherwise-untouched components to learn a number that is already free.

- [ ] **Step 1: failing test** — create `src/utils/pageStep.test.ts` (node env):

```ts
import { describe, expect, it } from "vitest";
import { gridPageStep, stripPageStep } from "./pageStep";

describe("gridPageStep", () => {
  it("is whole rows times the column count", () => {
    // 900px of scrollport, 168px rows -> 5 whole rows; 6 columns -> 30 frames.
    expect(gridPageStep(900, 168, 6)).toBe(30);
    expect(gridPageStep(1000, 250, 4)).toBe(16);
  });

  it("always advances at least one row, even when a row is taller than the scrollport", () => {
    expect(gridPageStep(100, 256, 5)).toBe(5);
    expect(gridPageStep(0, 168, 6)).toBe(6);
  });

  it("degrades to a single step rather than 0 or NaN on an unmeasured grid", () => {
    // rowH 0 is the pre-ResizeObserver state; a 0 or NaN step would make
    // PageDown either a no-op or a clamp to the end of the shoot.
    expect(gridPageStep(900, 0, 6)).toBe(1);
    expect(gridPageStep(900, Number.NaN, 6)).toBe(1);
    expect(gridPageStep(900, 168, 0)).toBe(1);
  });
});

describe("stripPageStep", () => {
  it("is the whole cells that fit across the strip", () => {
    // The small step's stride is 80 (76px cell + 4px gap): 18 cells at 1440.
    expect(stripPageStep(1440, 80)).toBe(18);
    // The tall-window step's stride is 108: 13 cells at 1440.
    expect(stripPageStep(1440, 108)).toBe(13);
  });

  it("always advances at least one frame", () => {
    expect(stripPageStep(40, 80)).toBe(1);
    expect(stripPageStep(0, 80)).toBe(1);
    expect(stripPageStep(1440, 0)).toBe(1);
  });
});
```

Run it: the module does not exist, so collection fails — that is the right first failure.

- [ ] **Step 2: implement** — create `src/utils/pageStep.ts`:

```ts
/**
 * How far one PgUp / PgDn moves the cursor — a SCREENFUL, in the units the
 * surface under it uses. Pure and read fresh at keypress time (App measures
 * the live grid container / window), so nothing here is state and nothing
 * re-renders to keep it current.
 *
 * Deliberately NOT "the next burst": burst groups are advisory, absent on
 * most frames, and upgrade in place as smart scores land, so the same key
 * would move a different distance at t=0 and t=30s (spec §A).
 */

/**
 * Frames in one grid screenful: whole rows that fit in the scrollport, times
 * the column count. `viewportH` is `.cull-grid`'s `clientHeight` — the SAME
 * number GridView feeds `computeGridAutoScrollTop` (`GridView.tsx:232`), so
 * "a screenful" means the same thing to the key and to the auto-scroll that
 * follows it. Any unusable input (an unmeasured grid, a zero column count)
 * degrades to a single step rather than 0 (a dead key) or NaN (a clamp to the
 * end of the shoot).
 */
export function gridPageStep(viewportH: number, rowH: number, cols: number): number {
  if (!(rowH > 0) || !(cols > 0)) return 1;
  return Math.max(1, Math.floor(viewportH / rowH)) * cols;
}

/**
 * Frames in one filmstrip screenful: whole cells that fit across it.
 * `stride` is the live `StripMetrics.stride` (80 at the small step, 108 at the
 * tall-window one), so the key moves a screenful at BOTH steps rather than a
 * number baked in at one of them.
 */
export function stripPageStep(stripW: number, stride: number): number {
  if (!(stride > 0)) return 1;
  return Math.max(1, Math.floor(stripW / stride));
}
```

- [ ] **Step 3: failing test for the out-of-render read.** Append to `src/components/strip/PhotoStrip.metrics.test.tsx` (its `mql` stub, `stubMatchMedia` and `afterEach` restore are already in the file). The file does not import `./useStripMetrics` today, so add a new import line under the `PhotoStrip` one: `import { stripMetricsNow } from "./useStripMetrics";`

```tsx
describe("stripMetricsNow reads the step without a render", () => {
  test("hands back the same two module constants the hook does", () => {
    mql.matches = false;
    stubMatchMedia();
    expect(stripMetricsNow()).toBe(STRIP_SMALL);
    mql.matches = true;
    expect(stripMetricsNow()).toBe(STRIP_LARGE);
  });
});
```

(The file's own docblock already explains why flipping `mql.matches` rather than swapping the stub is correct: `useStripMetrics` caches ONE `MediaQueryList` for the module's lifetime.)

- [ ] **Step 4: implement.** In `src/components/strip/useStripMetrics.ts`, after `tallQuery()` and before `useStripMetrics`:

```ts
/**
 * The step RIGHT NOW, outside React. The keymap's PgUp / PgDn need the live
 * stride at keypress time, and a `useSyncExternalStore` subscription in App
 * would buy a re-render on every crossing of the tall query for a number only
 * a keystroke ever reads. Shares the one cached `MediaQueryList` with the hook
 * above, so this adds no listener and allocates nothing.
 */
export function stripMetricsNow(): StripMetrics {
  return stripMetricsFor(tallQuery()?.matches ?? false);
}
```

- [ ] **Step 5:** gate green. Commit: `feat(nav): pure page-step maths for the grid and the filmstrip` — `git commit -m "feat(nav): pure page-step maths for the grid and the filmstrip" -- src/utils/pageStep.ts src/utils/pageStep.test.ts src/components/strip/useStripMetrics.ts src/components/strip/PhotoStrip.metrics.test.tsx`

### Task 2: Home / End / PgUp / PgDn

**Files:** Modify `src/App.tsx`, `src/app/useCullKeymap.ts`.

**Interfaces — Consumes:** `gridPageStep` / `stripPageStep` (Task 1), `stripMetricsNow` (Task 1), `gridCellWidth` from `src/utils/gridSize.ts` (already imported in `App.tsx:85`'s import block). **Produces:** two new `useCullKeymap` props —

```ts
  /** Frames in one screenful of whatever surface is up, measured at keypress
   *  time. Grid: whole rows × cols. Loupe / compare: whole filmstrip cells. */
  pageStep: () => number;
  /** Compare's cursor move (App's useSiteNavigation) — the compare twin of
   *  `advance`, used by PgUp / PgDn there. */
  cycleChallenger: (dir: 1 | -1, step?: number) => boolean;
```

**Ruling (`e.repeat`):** holding `PgDn` to fly through a shoot is a reasonable gesture, so the plain keys allow OS auto-repeat — `advance` (`App.tsx:1002-1019`) clamps and returns `false` **without calling `setCurrentIndex`** when it cannot move, so a held `Home` at the top costs nothing, and there is no rAF loop for a repeat to race (unlike the held arrows, which is why those guard). **Shift+Home / Shift+End** DO guard `e.repeat`: `growGridSelection` (`App.tsx:1260-1284`) writes a fresh `Set` on every call and their step is always the whole list, so each repeat would rebuild an identical selection and re-render for nothing. **Shift+PgUp / Shift+PgDn** do not guard it — each repeat genuinely grows the selection by another screenful, exactly like a held Shift+ArrowDown.

**Ruling (Shift+PgUp / PgDn extend the selection):** the spec names only Shift+Home / Shift+End, but leaving the page keys' Shift form to fall through to the plain branch would *clear* a grid selection the user was plainly building — the opposite of what every other Shift+navigation key in the grid does. In the grid they call `growGridSelection(±pageStep())`, the exact shape of the Shift+arrow cases. Outside the grid Shift is ignored, as it is for the arrows.

**Ruling (compare gets PgUp / PgDn only):** compare navigates candidates through `cycleChallenger`, which walks `findUnrated` once per step in a loop (`useSiteNavigation.ts:245-266`). `cycleChallenger(dir, images.length)` is therefore O(n²) — 17.6 M scans on a 4,194-frame shoot, a visible freeze. A page step (13–18) is the same magnitude as the existing 10× scrub and is fine. `Home` / `End` are loupe + grid only (they are defined in terms of "the active filter", and the filter tablist is hidden in compare — `StatusBar.tsx:295`); they still get an explicit `preventDefault`-and-break in the compare switch so none of the four keys ever reaches a platform default while the cull keymap is live (spec §A: "All new cases `preventDefault`"). This matches the scout's own help-row proposal.

**Ruling (zoom):** no `isZooming` branch. A cursor move while zoomed already drops the zoom through `usePaneZoom`'s index-change effect (`usePaneZoom.ts:114-121`, "Leaving a zoomed frame via a cursor move drops the zoom"), which is what every non-rating cursor move does. `PgUp` / `Home` have no pan meaning, so panning them would be an invention.

- [ ] **Step 1: App's step callback.** In `src/App.tsx`, the existing `./utils/gridSize` import (`App.tsx:82-88`) already pulls `gridCellWidth` and needs **no change**. Add two new import statements beside the other local ones:

```ts
import { gridPageStep, stripPageStep } from "./utils/pageStep";
import { stripMetricsNow } from "./components/strip/useStripMetrics";
```

Then, directly **after** the `growGridSelection` callback (`App.tsx:1260-1284`) and before `selectAllInGrid`:

```tsx
  // One screenful, measured at keypress time — PgUp / PgDn's step. Nothing
  // here is state: the grid's height is read off the container App already
  // holds a ref to, and the strip's width is the window's (the strip is a
  // full-bleed row of .cull-app with no horizontal padding — see
  // utils/pageStep and strip/metrics.test.ts, which pins that padding).
  // gridCellWidth is the SAME formula GridView uses for its square rows
  // (GridView.tsx:180-181), so the key and the layout can never disagree.
  // clientHeight INCLUDES .cull-grid's own 20px top + 20px bottom padding
  // (grid.css:18), so a page is a hair more than the fully visible rows —
  // deliberately, because it is the identical number GridView feeds
  // computeGridAutoScrollTop (GridView.tsx:232), and the key and the
  // auto-scroll that follows it must mean the same thing by "in view".
  const pageStep = useCallback((): number => {
    if (gridVisible && !compareMode) {
      const el = gridContainerRef.current;
      return gridPageStep(el?.clientHeight ?? 0, gridCellWidth(gridContentW, gridCols), gridCols);
    }
    return stripPageStep(window.innerWidth, stripMetricsNow().stride);
  }, [gridVisible, compareMode, gridContentW, gridCols]);
```

- [ ] **Step 2: pass the two props.** In the `useCullKeymap({ … })` call (`App.tsx:1300-1362`), add `pageStep,` directly after `advance,` and `cycleChallenger,` directly after `goBack,`. `cycleChallenger` is already in scope — it is destructured from `useSiteNavigation` at `App.tsx:1029`.
- [ ] **Step 3: declare them in the keymap.** In `src/app/useCullKeymap.ts`, add `pageStep,` after `advance,` in the destructuring (`:47`) and in the type block after `advance: (dir: 1 | -1, step?: number) => boolean;` (`:109`):

```ts
  /** Frames in one screenful of whatever surface is up, measured at keypress
   *  time (see utils/pageStep). Grid: whole rows × cols. Loupe / compare: the
   *  whole filmstrip cells that fit across the window. */
  pageStep: () => number;
```

and add `cycleChallenger,` after `goBack,` in the destructuring (`:69`) and in the type block after `goBack: (landIndex?: number) => void;` (`:131`):

```ts
  /** Compare's cursor move — the compare twin of `advance`. Its per-step
   *  findUnrated scan makes a WHOLE-LIST step O(n²), so only the page keys
   *  use it, never Home / End. */
  cycleChallenger: (dir: 1 | -1, step?: number) => boolean;
```

- [ ] **Step 4: the compare cases.** In `handleCompareKey` (`useCullKeymap.ts:267-343`), insert directly after the `case "ArrowDown":` block (`:307-310`) and before `case "i":`:

```ts
        // One candidate-strip screenful. The strip is the same component and
        // the same metrics module as the loupe's, so the step is identical.
        case "PageUp":
          e.preventDefault();
          cycleChallenger(-1, pageStep());
          break;
        case "PageDown":
          e.preventDefault();
          cycleChallenger(1, pageStep());
          break;
        // Home / End are LOUPE + GRID only — they mean "first / last frame of
        // the active FILTER", and the filter tablist is hidden in compare
        // (StatusBar.tsx:295). cycleChallenger walks findUnrated once per
        // step, so a whole-list step here would be O(n²) — 17.6M scans on a
        // 4,194-frame shoot. Swallowed anyway, so neither key can reach a
        // platform default while compare is up.
        case "Home":
        case "End":
          e.preventDefault();
          break;
```

- [ ] **Step 5: the single-mode cases.** In `handleSingleModeKey` (`useCullKeymap.ts:346-506`), insert directly after the `case "ArrowDown":` block (`:426-439`) and before `case "g":`:

```ts
        // First / last frame OF THE ACTIVE FILTER, not index 0: `advance`
        // works in filter-position space and clamps (App.tsx:1002-1019), so a
        // step of images.length always lands on visibleIndices[0] / [len-1].
        // (Its pos === -1 arm lands on visibleIndices[0] for BOTH directions,
        // but that state is unreachable from a keypress: the pre-paint
        // auto-jump at App.tsx:948-953 snaps an out-of-filter cursor back in
        // whenever the filter is non-empty, and on an empty filter advance
        // returns false at :1004.)
        //
        // In the grid, Shift extends the selection to the same target instead
        // of moving the cursor alone — the keyboard twin of shift-clicking the
        // first / last cell, and of the Shift+arrow cases above.
        //
        // No mid-hold stopGridVertHold() call here, unlike the Shift+arrow
        // cases: none of these four keys is a vertical arrow, so :238-239 has
        // already stopped any held row-jump before the switch is reached, and
        // useHeldRepeat's stop() zeroes the ref synchronously.
        //
        // e.repeat is deliberately NOT guarded on the plain Home / End — a
        // clamped advance returns false without touching state, so a held key
        // is free, and there is no rAF loop for a repeat to race. The SHIFT
        // forms of Home / End DO guard it: growGridSelection writes a fresh
        // Set every call and their step is always the whole list, so each
        // repeat would rebuild an identical selection and re-render for
        // nothing. Shift+PgUp / PgDn are NOT guarded, because each repeat
        // genuinely grows the selection by another screenful — exactly like a
        // held Shift+ArrowDown.
        case "Home":
          e.preventDefault();
          if (gridVisible && e.shiftKey) {
            if (e.repeat) break;
            growGridSelection(-images.length);
            break;
          }
          if (gridVisible) clearMultiSelection();
          advance(-1, images.length);
          break;
        case "End":
          e.preventDefault();
          if (gridVisible && e.shiftKey) {
            if (e.repeat) break;
            growGridSelection(images.length);
            break;
          }
          if (gridVisible) clearMultiSelection();
          advance(1, images.length);
          break;
        // One screenful: rows × cols in the grid, one filmstrip width in the
        // loupe (utils/pageStep, measured live — see App's `pageStep`).
        case "PageUp":
          e.preventDefault();
          if (gridVisible && e.shiftKey) {
            growGridSelection(-pageStep());
            break;
          }
          if (gridVisible) clearMultiSelection();
          advance(-1, pageStep());
          break;
        case "PageDown":
          e.preventDefault();
          if (gridVisible && e.shiftKey) {
            growGridSelection(pageStep());
            break;
          }
          if (gridVisible) clearMultiSelection();
          advance(1, pageStep());
          break;
```

- [ ] **Step 6: the effect deps.** Add `pageStep,` and `cycleChallenger,` to the big keymap effect's dependency array (`useCullKeymap.ts:647-686`), beside `advance` and `goBack`. The array is hand-maintained behind an `eslint-disable-next-line react-hooks/exhaustive-deps` (`:646`), so they must be added by hand. Neither is a new churn class: `pageStep`'s identity turns on `gridVisible` / `compareMode` / `gridContentW` / `gridCols` (three of which are already deps; `gridContentW` moves only on a resize), and `cycleChallenger`'s turns on `challengerIndex` / `ratings`, which already move `challengerWins` / `challengerLoses` / `challengerKeptBoth` on the same commits.
- [ ] **Step 7: read the whole dispatch path once more and confirm four things**, then record the confirmation in the task report (there is no test harness for `useCullKeymap.ts` — spec §Testing says the wiring is verified by review, and building the harness is Phase 4):
  1. the new cases sit INSIDE the two mode switches, so `handleModalKeys` (`:208-265`) has already returned `true` for settings / quit-guard / non-culling phase / leave-confirm / actions dialog before they can run;
  2. the help-sheet swallow (`:562-572`) and the `e.ctrlKey || e.metaKey || e.altKey` drop (`:580`) both sit ABOVE `handleCompareKey` / `handleSingleModeKey` (`:612-613`), so Ctrl+Home never reaches a case and no key fires behind the help sheet;
  3. a page key pressed mid-scrub stops the hold — `:234-239` calls `stopHold()` / `stopGridVertHold()` for any key that is not the held arrow, and none of the four is an arrow;
  4. all four keys call `e.preventDefault()` on every path through their cases — plain, Shift and compare-inert alike (`.cull-grid` is `overflow: hidden auto`, `grid.css:14`, so an unhandled PageDown scrolls it behind the cursor).
- [ ] **Step 8:** gate green. Commit: `feat(nav): Home / End / PgUp / PgDn in loupe, grid and compare` — one pathspec commit over both files.

### Task 3: The `rejects` filter value

**Files:** Modify `src/types/rating.ts`, `src/utils/filterModes.ts`, `src/utils/filterModes.test.ts`, `src/utils/filter.ts`, `src/utils/filter.test.ts`.

**Interfaces — Produces:** `Filter` gains `"rejects"`; `TopFilter` gains `"rejects"`; `CYCLES.rejects = ["rejects"]`; `passesFilter(rating, "rejects") === (rating === "reject")`. No signature changes. **The type widening is the gate for Tasks 4 and 5** — `passesFilter`'s switch has no `default`, so adding the value makes its return type `boolean | undefined` and `App.tsx:377` stops compiling until the case exists. That is the good kind of failure; do not add a `default`.

- [ ] **Step 1: failing tests.** Append to `src/utils/filter.test.ts` (that file imports `describe, expect, it` — `it`, not `test`):

```ts
describe("the rejects filter", () => {
  it("admits ONLY rejected frames", () => {
    expect(passesFilter("reject", "rejects")).toBe(true);
    expect(passesFilter("keep", "rejects")).toBe(false);
    expect(passesFilter("favorite", "rejects")).toBe(false);
    expect(passesFilter(undefined, "rejects")).toBe(false);
  });
});
```

Append to `src/utils/filterModes.test.ts` (same `it` import), inside the existing `describe("topOf")` and `describe("cycleFilter")` blocks respectively:

```ts
  it("maps rejects to itself — it has no sub-modes", () => {
    expect(topOf("rejects")).toBe("rejects");
  });
```

```ts
  it("re-activating Rejects is a no-op, like All and Unrated", () => {
    expect(cycleFilter("rejects", "rejects")).toBe("rejects");
  });

  it("switching into and out of Rejects always lands on a base mode", () => {
    expect(cycleFilter("keepsFavs", "rejects")).toBe("rejects");
    expect(cycleFilter("rejects", "keeps")).toBe("keeps");
    expect(cycleFilter("rejects", "suggested")).toBe("suggested");
  });
```

Run them: `pnpm typecheck:tests` fails on every new line (`"rejects"` is not assignable to `Filter` / `TopFilter`). At RUNTIME only the two `cycleFilter(…, "rejects")` calls throw (`CYCLES["rejects"]` is `undefined`, so `cycle[0]` is a TypeError) and the `passesFilter` block fails on `undefined`; `topOf("rejects")` and the two `cycleFilter("rejects", <other top>)` lines already pass through the existing `default` arms (`filterModes.ts:29-31`, `:44`). That is the right failure — do **not** add a `default` to `passesFilter` to quiet it.

- [ ] **Step 2: `src/types/rating.ts`.** Add the value to the union (`:22-30`) and extend the doc block above it (`:10-21`):

```ts
/**
 * Filter visible in the status bar: keyboard 1–5 select the five top-level
 * tabs (All / Unrated / Keeps / Smart / Rejects); repressing an active tab's
 * key cycles through its sub-modes (see `src/utils/filterModes.ts`).
 *
 * - `keeps` includes favorites by design (a ★ frame is also a keep);
 *   `keepsFavs` narrows to favorite-rated only.
 * - `suggested` = frames with a live smart-culling suggestion that are still
 *   unrated (App.tsx resolves it against the suggestions map);
 *   `suggestedRejects` / `suggestedKeeps` / `suggestedFavs` narrow by the
 *   suggestion's verdict.
 * - `rejects` = frames the user actually rated `reject` — the pile "move
 *   rejects" will take, so it can be checked before it is moved. Nothing to
 *   do with `suggestedRejects`, which is an unrated frame the smart pass
 *   thinks should go.
 */
export type Filter =
  | "all"
  | "unrated"
  | "keeps"
  | "keepsFavs"
  | "suggested"
  | "suggestedRejects"
  | "suggestedKeeps"
  | "suggestedFavs"
  | "rejects";
```

- [ ] **Step 3: `src/utils/filterModes.ts`.** Widen `TopFilter` (`:10`) and add its cycle (`:13-18`); `topOf`'s `default: return filter;` (`:29-31`) already covers the new value and must not change:

```ts
/**
 * The five footer tabs. Every {@link Filter} value belongs to exactly one via
 * {@link topOf} — "keeps"/"keepsFavs" both belong to `"keeps"`,
 * "suggested"/"suggestedRejects"/"suggestedKeeps"/"suggestedFavs" all belong
 * to `"suggested"`. `"all"`, `"unrated"` and `"rejects"` have no sub-modes, so
 * they ARE their own top.
 */
export type TopFilter = "all" | "unrated" | "keeps" | "suggested" | "rejects";

/** Ordered sub-mode cycle for each top, base mode first. */
const CYCLES: Record<TopFilter, Filter[]> = {
  all: ["all"],
  unrated: ["unrated"],
  keeps: ["keeps", "keepsFavs"],
  suggested: ["suggested", "suggestedRejects", "suggestedKeeps", "suggestedFavs"],
  rejects: ["rejects"],
};
```

- [ ] **Step 4: `src/utils/filter.ts`.** Add the arm to the exhaustive switch (`:9-29`), directly after the `keepsFavs` case:

```ts
    case "rejects":
      // The pile "move rejects" will take. NOT `suggestedRejects` (an unrated
      // frame the smart pass flagged) — this is the user's own verdict.
      return rating === "reject";
```

- [ ] **Step 5:** gate green — `pnpm typecheck` in particular: nothing outside these files should break. `useSettings.ts:13`'s `FILTERS: readonly Filter[]` still compiles unchanged (widening the element type is fine), and `SettingsDialog.tsx:88-110`'s `SegmentToggle<Filter>` passes its options explicitly, so neither offers the new value. Commit: `feat(filter): a rejects filter value, with its cycle and membership test`

### Task 4: The Rejects tab, key `5`, and the empty state

**Files:** Modify `src/components/StatusBar.tsx`, `src/app/useCullKeymap.ts`, `src/components/EmptyFilter.tsx`.

**Interfaces — Consumes:** `Filter` / `TopFilter` / `CYCLES` / `cycleFilter` (Task 3), the `pageStep` / `cycleChallenger` keymap props (Task 2 — this task edits the same switch). **Produces:** a fifth `<button>` in `.cull-filter-tabs`, keyed `5`; a `<span className="cull-statusbar__smart-count">` inside the Smart tab holding its count/percent suffix (Task 5's CSS hides it below 1360). **No new props on `StatusBarProps`.**

**Ruling (no `stats.rejects`):** the spec asks for one "so the tab can be disabled-looking at zero exactly as the others are (follow whatever the existing tabs do at zero — do not invent a treatment)". Read against the code, the four existing tabs do **nothing** at zero: `StatusBar.tsx:296-446` renders every tab unconditionally, with no `disabled`, no dimming and no count except Smart's. So following them means adding no treatment — and the reject count is **already** in `StatusBar`, as `session.rejectedCount` (`StatusBarSession`, `StatusBar.tsx:80`; fed from the same `rejectedPaths` memo at `App.tsx:592-595` → `:1486`; consumed at `:448`). A second copy on `stats` would be a dead field duplicating a live one. **`stats` is left alone, `App.tsx` is not touched by this task, and the two `StatusBar` test fixtures (`StatusBar.shed.test.tsx:46`, `StatusBar.saveChip.test.tsx:40`) need no edit.** If a zero treatment is ever wanted, `session.rejectedCount` is where it reads from.

**Ruling (no `defaultFilter: "rejects"`):** `useSettings.ts:13`'s `FILTERS` allowlist is `["all", "unrated", "keeps", "keepsFavs"]` — `"suggested"` is not offered as a start-of-cull default either, and starting a cull inside the reject pile is not a thing anyone wants. The validator needs **no change**: a hand-edited `"rejects"` in localStorage falls back to `"all"`, which is correct.

**Ruling (the tabs carry no `role="tab"` / `aria-selected` today).** `.cull-filter-tabs` has `role="tablist"` but its children are plain `<button type="button">` with no `role="tab"`, no `aria-selected` and no roving tabindex (`StatusBar.tsx:296-312`). That is a pre-existing gap; the Rejects tab copies its siblings exactly and does **not** fix it. Report it, do not widen scope.

- [ ] **Step 1: failing test.** Append to `src/components/StatusBar.shed.test.tsx` (jsdom, `it` — the file imports `afterEach, describe, expect, it, vi`). Its `props()` helper already supplies everything (`filter.filter` is `"all"`, so no tab is active and no sub-mode tooltip renders); the third test spreads a new `suggestionCount` over `props().filter` rather than changing the helper:

```tsx
describe("the Rejects tab", () => {
  it("is the fifth tab, last, labelled in sentence case", () => {
    const { container } = render(<StatusBar {...props()} />);
    const tabs = container.querySelector(".cull-filter-tabs");
    if (!tabs) throw new Error("no .cull-filter-tabs");
    const labels = [...tabs.querySelectorAll(":scope > button, :scope > span > button")].map(
      (b) => b.textContent,
    );
    expect(labels).toEqual(["All", "Unrated", "Keeps", "Smart", "Rejects"]);
  });

  it("offers its key in the hover tip while inactive, and drops it while active", () => {
    const { container } = render(<StatusBar {...props()} />);
    const rejects = container.querySelector<HTMLElement>(".cull-filter-tabs > button:last-child");
    if (!rejects) throw new Error("no Rejects tab");
    expect(rejects.getAttribute("data-tip")).toBe("5 · show rejects");
  });

  it("splits Smart's count suffix into its own element, leaving the name whole", () => {
    const base = props();
    const { container } = render(
      <StatusBar {...base} filter={{ ...base.filter, suggestionCount: 4194 }} />,
    );
    const smart = screen.getByRole("button", { name: "Smart · 4194" });
    const count = smart.querySelector(".cull-statusbar__smart-count");
    expect(count?.textContent).toBe("· 4194");
  });
});
```

Run it: the labels assertion fails (four tabs), the `data-tip` lookup throws, and `getByRole` finds no `"Smart · 4194"` split.

- [ ] **Step 2: the fifth tab.** In `src/components/StatusBar.tsx`, insert directly after the Smart `<span className="cull-filter-tab-group">…</span>` closes (`:445`) and before `</div>` (`:446`). Markup copied verbatim from the All / Unrated tabs (`:297-312`) — a bare `<button>`, no group wrapper (there are no sub-modes), no `chipsTooltip.pulse()` (that call exists only for the two tabs that cycle):

```tsx
            {/* The pile "move rejects" will take, so it can be checked before
                it is moved. Last, key 5 — position equals key for all five, so
                no muscle memory moves. No count: All / Unrated / Keeps carry
                none either, and a five-digit one would cost the footer 130px
                (see statusbar.css's arithmetic). */}
            <button
              type="button"
              className={filter.filter === "rejects" ? "is-active" : ""}
              onClick={() => filter.setFilter((f) => cycleFilter(f, "rejects"))}
              data-tip={filter.filter === "rejects" ? undefined : "5 · show rejects"}
            >
              Rejects
            </button>
```

- [ ] **Step 3: split Smart's suffix.** Replace the Smart button's children (`StatusBar.tsx:385-389`) with:

```tsx
                {/* The count / percent rides its own span so the narrow footer
                    can shed it (statusbar.css's < 1360 tier) — clipped, not
                    `display: none`, which would shorten the button's
                    accessible name. The separating space is OUTSIDE the span
                    for the same reason the save chip's is (see the comment on
                    .cull-statusbar__unsaved-tail below): the accessible-name
                    algorithm trims each subtree's own leading whitespace
                    before joining, so a leading space living only inside the
                    span would silently drop out of the name. */}
                Smart
                {filter.qualityAnalyzing && filter.qualityProgress ? (
                  <>
                    {" "}
                    <span className="cull-statusbar__smart-count">
                      {`${Math.round((filter.qualityProgress.done / Math.max(filter.qualityProgress.total, 1)) * 100)}%`}
                    </span>
                  </>
                ) : filter.suggestionCount > 0 ? (
                  <>
                    {" "}
                    <span className="cull-statusbar__smart-count">
                      {`· ${filter.suggestionCount}`}
                    </span>
                  </>
                ) : null}
```

The three accessible names stay character-identical to today's template literals: `"Smart 42%"`, `"Smart · 4194"`, `"Smart"`.

- [ ] **Step 4: the `5` key.** In `src/app/useCullKeymap.ts`, insert directly after the `case "4":` block (`:480-489`) and before `case "i":`:

```ts
        case "5":
          // No chipsTooltip.pulse(): Rejects has no sub-modes, so there is no
          // sub-chip tooltip to show (same as 1 and 2).
          setFilter((f) => cycleFilter(f, "rejects"));
          break;
```

- [ ] **Step 5: the empty state.** In `src/components/EmptyFilter.tsx`, add the arm to the label ternary (`:154-161`) and give the filter its own hint. Replace `:152-176` with:

```tsx
  // Label the user-facing filter name. "All" can never actually be empty (it
  // includes unrated), so falling back to "this" covers the impossible-case.
  const label =
    filter === "keepsFavs"
      ? "Favorites"
      : filter === "keeps"
        ? "Keeps"
        : filter === "unrated"
          ? "Unrated"
          : filter === "rejects"
            ? "Rejects"
            : "this"; // "suggested*" fully handled (and narrowed away) above
  return (
    <NoMatchEmptyState
      eyebrow="No matches"
      title={
        <>
          No images in the <em>{label}</em> filter
        </>
      }
      hint={
        filter === "rejects" ? (
          <>
            Rejected frames show up here until you finish the cull ·{" "}
            <kbd className="kbd">1</kbd> for all
          </>
        ) : (
          <>
            <kbd className="kbd">1</kbd> for all
          </>
        )
      }
    />
  );
```

(The `1 for all` escape hatch stays on both arms — every other empty state in this file offers it.)

- [ ] **Step 6:** gate green. `HelpOverlay.test.tsx:41-46` still asserts `["1", "4"]` and still passes — the help sheet is Task 11's. Commit: `feat(filter): a Rejects tab on 5, with its own empty state`

### Task 5: The footer pays for the fifth tab

**Files:** Modify `src/styles/statusbar.css`, `src/styles/chrome.css`, `src/styles/layout.test.ts`.

**Interfaces — Consumes:** `.cull-statusbar__smart-count` and the fifth `.cull-filter-tabs > button` (Task 4). `ruleBody` (exported from `layout.test.ts:25`) and the file's `sheet()` helper. **Produces:** two new rules inside the EXISTING `@media (width < 1360px)` block of `statusbar.css` (`:172-220`), and a corrected hover-tip alignment rule in `chrome.css`.

**The arithmetic, re-derived from the real CSS with every piece enumerated.** Mono advance at `--fs-2` (10 px, `tokens.css:42`) is `0.6em` = 6.0 px, plus `.cull-filter-tabs button`'s `letter-spacing: 0.16em` = 1.6 px applied per character **including the last** → **7.6 px per character**. Tab labels are `text-transform: uppercase` (`chrome.css:397-412`). Container chrome of `.cull-filter-tabs` (`chrome.css:384-395`): `padding-left 18 + padding-right 18 + border-left 1 + border-right 1 + margin-left 4 + margin-right 4` = **46**, `gap: 0`.

| tabs, today (4) | chars | px |
| --- | --- | --- |
| `ALL` | 3 | 22.8 + 24 padding |
| `UNRATED` | 7 | 53.2 + 24 |
| `KEEPS` | 5 | 38.0 + 24 |
| `SMART · 4194` | 12 | 91.2 + 24 |
| container chrome | | 46 |
| **total** | **27** | **347.2** — the 347 the current comment uses, side margins included |

A fifth tab, `REJECTS`, 7 chars, no count: `53.2 + 24` = **77.2** → **424.4**. That turns all three binding slacks negative (−63 / −58 / −57). Two rules inside the existing `< 1360` tier buy it back:

1. Smart's count/percent suffix sheds (clipped, out of flow) — `" · 4194"` is 7 characters = **−53.2**;
2. `.cull-filter-tabs button` padding `12 → 8` — 8 px off each of five buttons = **−40.0**.

Tabs below 1360 = 424.4 − 93.2 = **331.2**, which is 15.8 px *narrower* than today's four-tab 347.2. Re-running the current comment's six pinned widths with `R-ordinary = 79 + 14 + 331.2 + 14 + 163 = 601.2`, `R-short = 79 + 14 + 331.2 + 14 + 66 = 504.2`, `L-full = 537`, `L-shrunk = 412`, overhead `72`:

| width | state | needed | slack (today) |
| --- | --- | --- | --- |
| 1359 | cosmetic shown, finish ordinary | 1210.2 | **+148.8** (133) |
| 1240 | same, this tier's tightest | 1210.2 | **+29.8** (14) |
| 1239 | cosmetic hidden, finish ordinary | 1085.2 | **+153.8** (138) |
| 1120 | same, this tier's tightest | 1085.2 | **+34.8** (19) |
| 1119 | cosmetic hidden, finish short | 988.2 | **+130.8** (115) |
| 1024 | the minimum window width | 988.2 | **+35.8** (20) |

Every pinned width clears with more room than it has today.

**Ruling (≥ 1360 is not fixed here, and gets wider).** Above the shed tier nothing is hidden, so the right cluster additionally carries the key hint — `.cull-statusbar__keyhint` renders unconditionally (`StatusBar.tsx:271-273`) and only sheds below 1360, and it is mono at `--fs-1` 9 px (`stage.css:298-303`, beating `.eyebrow`'s `--fs-2` on source order) with `letter-spacing: var(--track-eyebrow)` 0.2em, so `0.6em + 0.2em = 7.2 px` × the 10 characters of `TAB · KEYS` = **72**, plus one more 14 px gap. The absolute worst case is therefore `L = 68 (verdict) + 137 (scrub + ×10, its chip's own 8 px margin included) + 133 (overlay cluster) + 236 (all-missing chip WITH its tail) + 27 (.CR3) + 56 (four gaps) = 657` and `R = 72 + 14 + 79 + 14 + 424.4 + 14 + 244 (the all-rated finish label) = 861.4`, so `657 + 861.4 + 72 = 1590.4` is needed — against **1513.2** today. That band (every frame rated AND every photo missing AND scrubbing at ×10 AND the overlay cluster up, all at once) already overflows between 1360 and 1513 on `main`; the fifth tab widens it to 1590. Closing it would mean firing the tier at `< 1620px`, which puts Oliver's default 1600 px window permanently inside the shed tier — losing the key hint, `.CR3`, the save chip's tail, the all-rated finish label and Smart's count every day, to guard four rare states that must all be true at once. The spec ruled the other way explicitly — "At 1360 px and wider the footer simply has a fifth tab" — and the structural guarantee is unchanged: the filename stem is still the only shrinkable child, so it ellipses to zero first. Recorded, not fixed.

**Ruling (the padding override needs a specificity bump, and must not reach the sub-mode chips).** `index.css` imports `statusbar.css` **before** `chrome.css` (`index.css:12-13`), and a media query adds no specificity — so a plain `.cull-filter-tabs button { padding: 4px 8px }` inside `statusbar.css`'s `< 1360` block would LOSE to `chrome.css:397`'s `.cull-filter-tabs button { padding: 4px 12px }` on source order and do nothing. But a bare `.cull-statusbar .cull-filter-tabs button` (0,2,1) would over-reach the other way: the Keeps / Smart sub-mode tooltip buttons are descendants of `.cull-filter-tabs` too, and their own `.cull-filter-tab-tooltip button { padding: 3px 7px }` (`chrome.css:508-511`) is only (0,1,1) — it wins today on source order alone, so a (0,2,1) ancestor selector would silently resize the sub-mode chips. The rule is therefore written as a two-member child-combinator list — `.cull-statusbar .cull-filter-tabs > button` (All / Unrated / Rejects) and `.cull-statusbar .cull-filter-tab-group > button` (Keeps / Smart), both (0,2,1), both beating `chrome.css:397`, neither matching a tooltip button. The tabs are always inside `<footer className="cull-statusbar">` (`StatusBar.tsx:127` → `:270` → `:296`). None of the tier's existing rules has this problem: their competing declarations in `chrome.css` / `stage.css` set other properties, never `display`.

- [ ] **Step 1: failing test.** Append to the existing `describe("the footer's breakpoints", …)` in `src/styles/layout.test.ts` (it already binds `const statusbar = sheet("./statusbar.css");` at `:62`):

```ts
  test("the fifth tab is paid for inside the 1360 tier, not with a new breakpoint", () => {
    // Both rules use ruleBody (a line-anchored `selector {` match), not
    // toContain, so a comment naming the class cannot fake a pass.
    const tier = statusbar.slice(
      statusbar.indexOf("@media (width < 1360px) {"),
      statusbar.indexOf("@media (width < 1240px) {"),
    );
    // Smart's count is CLIPPED, never `display: none` — the button's
    // accessible name is "Smart · 4194" at every width.
    const count = ruleBody(tier, ".cull-statusbar__smart-count");
    expect(count).toMatch(/clip-path:\s*inset\(50%\)/);
    expect(count).not.toMatch(/display:\s*none/);
    // The padding override must out-specify chrome.css's own
    // `.cull-filter-tabs button` rule (index.css imports statusbar.css FIRST,
    // and a media query adds no specificity) WITHOUT reaching the sub-mode
    // tooltip's buttons, whose own padding rule is only (0,1,1). Hence the
    // two-member child-combinator list; ruleBody can only be asked for its
    // last member, so the first is pinned by a line-anchored regex.
    expect(tier).toMatch(/^ *\.cull-statusbar \.cull-filter-tabs > button,$/m);
    expect(ruleBody(tier, ".cull-statusbar .cull-filter-tab-group > button")).toMatch(
      /padding:\s*4px 8px/,
    );
    expect(tier, "the sub-mode chips keep their own 3px 7px").not.toMatch(
      /\.cull-filter-tab-tooltip/,
    );
    // No fourth breakpoint: layout.test's tier slices are keyed to exactly
    // these three widths. Matched on a LINE START so a width merely named in
    // the arithmetic comment above cannot add a phantom entry.
    const widths = [...statusbar.matchAll(/^@media \(width < (\d+)px\)/gm)].map((m) => m[1]);
    expect([...new Set(widths)]).toEqual(["1360", "1240", "1120"]);
  });

  test("the hover tip still right-aligns at the tab strip's edge, now that Rejects is last", () => {
    const chrome = sheet("./chrome.css");
    // `.cull-filter-tab-group:last-child` stopped matching Smart the moment a
    // bare <button> became the last child of .cull-filter-tabs.
    expect(chrome, "the stale :last-child rule must be gone").not.toContain(
      ".cull-filter-tab-group:last-child",
    );
    // ruleBody matches a selector that sits directly before ` {`, so it can
    // only be asked for the LAST member of a selector list; the first member
    // is pinned by its own line-anchored match instead.
    expect(chrome, "Smart's group is right-aligned at its new position").toMatch(
      /^\.cull-filter-tabs \.cull-filter-tab-group:nth-last-child\(2\) button\[data-tip\]:hover::after,$/m,
    );
    const tip = ruleBody(chrome, ".cull-filter-tabs > button[data-tip]:last-child:hover::after");
    expect(tip).toMatch(/right:\s*0/);
    expect(tip).toMatch(/left:\s*auto/);
    expect(tip).toMatch(/transform:\s*none/);
  });
```

- [ ] **Step 2: the two rules.** In `src/styles/statusbar.css`, inside the existing `@media (width < 1360px) {` block (`:172-220`), after the `.cull-statusbar__filename-ext` rule (`:217-219`) and before the block's closing brace:

```css
  /* ── the fifth tab, paid for inside this tier ────────────────
     A REJECTS tab is 7 chars × 7.6px + 24px padding = 77.2px, which turns
     all three binding slacks below negative. Two rules buy 93.2px back:

     1. Smart's count / percent suffix sheds — " · 4194" is 7 characters =
        53.2px. CLIPPED, not `display: none`: the span is inside the tab
        BUTTON, so removing it would shorten the button's accessible name
        from "Smart · 4194" to "Smart". Same recipe as the save chip's tail
        above (a media query cannot add a class, so it is inlined again).
     2. The five TABS' horizontal padding goes 12 → 8 = 8px × 5 = 40px. The
        sub-mode tooltip's own chips are deliberately untouched (see the
        child combinators below).

     Tabs below 1360 are then 331.2px — 15.8px NARROWER than today's
     four-tab 347.2px — so every pinned width in the arithmetic above gains
     rather than loses: 1240 +29.8 (was +14), 1120 +34.8 (was +19), 1024
     +35.8 (was +20). At 1360 and wider the footer simply has a fifth tab. */
  .cull-statusbar__smart-count {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
    border: 0;
  }

  /* Both halves of this selector are load-bearing. `.cull-statusbar`:
     index.css imports statusbar.css BEFORE chrome.css and a media query adds
     no specificity, so a bare `.cull-filter-tabs button` here would lose to
     chrome.css's `padding: 4px 12px` on source order and do nothing at all.
     The CHILD combinators: the Keeps / Smart sub-mode tooltip buttons are
     descendants of .cull-filter-tabs too, and their own `padding: 3px 7px`
     (chrome.css) is only one class deep — a descendant selector here would
     out-specify it and silently resize the sub-mode chips. These two cover
     exactly the five tabs: All / Unrated / Rejects are direct children of the
     strip, Keeps / Smart of their tooltip-anchoring group wrapper. */
  .cull-statusbar .cull-filter-tabs > button,
  .cull-statusbar .cull-filter-tab-group > button {
    padding: 4px 8px;
  }
```

- [ ] **Step 3: restate the arithmetic comment.** In the big comment above the `@media` block (`statusbar.css:75-171`), make the tab figure five tabs everywhere. Three edits, value for value:
  - the `right cluster` paragraph (`:117-121`): replace
    `filter tabs at their widest ("SMART · 4194") 347, and the finish button` / the two `R-` lines with

    ```
     right cluster — pos counter (12ch mono) 79, two 14px gaps, the FIVE
     filter tabs (ALL 3 + UNRATED 7 + KEEPS 5 + SMART 5 + REJECTS 7 = 27
     chars × 7.6px = 205.2, + 5 × 16px padding = 80, + 46 container chrome
     [18+18 padding, 1+1 border, 4+4 margin]) 331.2 — Smart's count and 4px
     of each tab's padding have both shed in this tier; see the rules below
     — and the finish button: ordinary long "Ctrl+E · 4194 keeps" 163, short
     "Finish" 66.
       R-ordinary = 79 + 14 + 331.2 + 14 + 163 = 601.2
       R-short    = 79 + 14 + 331.2 + 14 +  66 = 504.2

     Above this tier nothing sheds: the tabs are 424.4 (the five full
     labels, "SMART · 4194" included, at 12px padding = 258.4 + 120 + 46)
     and the right cluster ALSO carries the key hint, which only sheds
     below 1360 — mono 9px at 0.2em tracking = 7.2px × the 10 chars of
     "TAB · KEYS" = 72, plus its own 14px gap. So
       R(>=1360) = 72 + 14 + 79 + 14 + 424.4 + 14 + 244 = 861.4
     and the absolute worst case there — every frame rated AND every photo
     missing AND scrubbing at ×10 AND the overlay cluster up, with the
     all-missing chip still wearing its tail (236) and the extension still
     shown (27), so L = 657 — needs 657 + 861.4 + 72 = 1590.4 and
     therefore overflows from 1360 up to that width. It already did before
     the fifth tab (1513.2). Closing the band would mean firing this tier
     at <1620px, which puts the default 1600px window permanently inside
     it; the spec ruled the other way: "At 1360px and wider the footer
     simply has a fifth tab."
    ```
  - delete the stale hedge at `:123-125` ("The 347 above is the tabs' measured advance; if it excludes their own 4px side margins, take 8 off every slack figure below"): the 46 above enumerates the margins, so there is nothing left to hedge.
  - the six pinned widths (`:150-165`): replace each `needed` figure and slack with the table above — 1359 → `537 + 0 + 601.2 + 72 = 1210.2 needed, 1359 available → 148.8px slack`; 1240 → `1210.2 needed, 1240 available → 29.8px slack`; 1239 → `412 + 0 + 601.2 + 72 = 1085.2 needed, 1239 available → 153.8px slack`; 1120 → `1085.2 needed, 1120 available → 34.8px slack`; 1119 → `412 + 0 + 504.2 + 72 = 988.2 needed, 1119 available → 130.8px slack`; 1024 → `988.2 needed, 1024 available → 35.8px slack`. Keep the closing paragraph's point (every pinned width clears) and drop the sentence about the ~1220–1245 band, which the extension shed already closed and which these numbers restate.
  - add one sentence where the shed list for 1360 is described (`:82-95`): `Since 3C the tier also sheds Smart's count suffix and 4px of each tab's horizontal padding, which is what pays for the fifth (Rejects) tab.`
- [ ] **Step 4: the hover tip.** In `src/styles/chrome.css`, replace the comment at `:441` and the rule at `:443-447`:

```css
/* The last group's tab (Smart) sits near the window edge — right-align its
   tip so it can't clip offscreen. */
.cull-filter-tabs .cull-filter-tab-group:last-child button[data-tip]:hover::after {
  left: auto;
  right: 0;
  transform: none;
}
```

with:

```css
/* The two rightmost tabs sit near the window edge — right-align their tips so
   they can't clip offscreen. Two selectors because the two are shaped
   differently: Smart is a `.cull-filter-tab-group` wrapper (it has sub-modes)
   and is now the SECOND-to-last child, while Rejects is a bare button and is
   the last. `:last-child` alone silently stopped matching anything the moment
   Rejects was added. */
.cull-filter-tabs .cull-filter-tab-group:nth-last-child(2) button[data-tip]:hover::after,
.cull-filter-tabs > button[data-tip]:last-child:hover::after {
  left: auto;
  right: 0;
  transform: none;
}
```

Both out-specify the base rule at `:422` (`.cull-filter-tabs button[data-tip]:hover::after`, (0,3,2)): the first is (0,5,2), the second (0,4,2).

- [ ] **Step 5:** gate green, `pnpm lint:css` included. Commit: `feat(ui): the footer sheds Smart's count and tab padding to fit a fifth tab`

### Task 6: [RUST] `cr3::read_capture_time`

**Files:** Modify `src-tauri/src/cr3.rs`.

**Interfaces — Produces:**

```rust
pub fn read_capture_time(path: &str) -> std::io::Result<(Option<String>, Option<u16>)>
```

— `(DateTimeOriginal normalised to "YYYY-MM-DDTHH:MM:SS", SubSecTimeOriginal in ms)`, i.e. exactly the two fields `Cr3Meta.captured_at` / `Cr3Meta.sub_sec_ms` carry, so `analyze::captured_at_ms` combines them unchanged. `Err` only when the file cannot be opened/read or holds no `moov`; a CR3 with a `moov` but no CMT2 (or no tags) answers `Ok((None, None))`.

**Ruling (nothing becomes `pub(crate)` — the scout is wrong here).** The scout says `read_head` / `grow` / `metadata_from_prefix` "need `pub(crate)`". They do not: `read_capture_time` lives in `cr3.rs` itself, alongside `read_head` (`:499`), `grow` (`:511`), `moov_range` (`:413`), `cmt_in_uuid_range` (`:125`), `Tiff` (`:150`), `normalize_datetime` (`:956`), `sub_sec_to_ms` (`:941`) and `io_err` (`:379`) — all module-private and all reachable from inside the module. `mod cr3;` is private in `lib.rs:53`, so `pub fn` here already means crate-visible, matching `read_thumbnail` (`:821`). **No visibility change anywhere.** The flip side of that same privacy is that a `pub fn` with no lib-build caller IS dead code to rustc, so this task's own `clippy -D warnings` gate needs `#[cfg_attr(not(test), allow(dead_code))]` until Task 7 supplies the caller — the house pattern (`phash.rs:50`, `embed.rs:59`, `ml_models.rs:46`), and the same 8 → 10 dance Phase 3B ran on `gridthumb.rs`.

**Ruling (1 MiB head, not 256 KiB).** `moov` carries the 160×120 THMB JPEG as well as the four CMT boxes, which is why `read_thumbnail` uses `HEAD = 1 << 20` with the comment "moov (with THMB) virtually always fits in 1 MiB" (`:822`). Reusing that proven constant (and its `2 << 20` grow, and its `64 << 20` scan cap) costs one read where the scout's 256 KiB would usually cost two, and on the benchmarked NAS the per-open round-trip (~37 ms) dominates the byte count anyway.

**Ruling (an UNGATED whole-function test is possible).** No synthetic-CR3 helper exists in `test_util.rs` today, but one is ~40 lines of plain byte pushing: `cmt_in_uuid_range` does not check the uuid's value (`:125-136`), and `Tiff` only needs `"II"` + 42 + an IFD offset. So the whole function is tested end to end on a temp file, with **no** `CULL_TEST_CR3_DIR` gate — strictly better than the spec's fallback of "gate the whole-file test".

- [ ] **Step 1: failing test.** Append to `cr3.rs`'s `#[cfg(test)] mod tests` (`:1049`). It uses only `std`:

```rust
    /// Write bytes to a uniquely-named temp file and hand back its path. One
    /// per test name + pid, mirroring scan.rs's `tmp_dir` idiom.
    fn tmp_cr3(name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("cull-cr3-{}-{}.CR3", name, std::process::id()));
        std::fs::write(&p, bytes).expect("write synthetic cr3");
        p
    }

    /// The smallest head `read_capture_time` can read, in the layout documented
    /// at the top of this file: ftyp, then a moov holding one uuid box whose
    /// CMT2 child is a little-endian TIFF with DateTimeOriginal (0x9003) and
    /// SubSecTimeOriginal (0x9291). `cmt_in_uuid_range` never inspects the
    /// uuid's value, so 16 zero bytes stand in for Canon's 85c0b687….
    fn synth_cr3_head(datetime: Option<&str>, sub_sec: Option<&str>) -> Vec<u8> {
        let boxed = |fourcc: &[u8; 4], payload: &[u8]| -> Vec<u8> {
            let mut b = Vec::with_capacity(8 + payload.len());
            b.extend_from_slice(&((8 + payload.len()) as u32).to_be_bytes());
            b.extend_from_slice(fourcc);
            b.extend_from_slice(payload);
            b
        };
        // ── the CMT2 TIFF ───────────────────────────────────────────────
        let dt: Vec<u8> = datetime
            .map(|s| s.bytes().chain(std::iter::once(0u8)).collect())
            .unwrap_or_default();
        let ss: Vec<u8> = sub_sec
            .map(|s| s.bytes().chain(std::iter::once(0u8)).collect())
            .unwrap_or_default();
        assert!(ss.len() <= 4, "the SubSec value must fit inline");
        let mut entries: Vec<[u8; 12]> = Vec::new();
        // 2 (entry count) + 12 per entry + 4 (next-IFD pointer), from IFD0 at 8.
        let value_off = 8u32 + 2 + 12 * (datetime.is_some() as u32 + sub_sec.is_some() as u32) + 4;
        if !dt.is_empty() {
            // ASCII, longer than 4 bytes -> stored at an offset (Tiff::find_entry).
            let mut e = [0u8; 12];
            e[0..2].copy_from_slice(&0x9003u16.to_le_bytes());
            e[2..4].copy_from_slice(&2u16.to_le_bytes());
            e[4..8].copy_from_slice(&(dt.len() as u32).to_le_bytes());
            e[8..12].copy_from_slice(&value_off.to_le_bytes());
            entries.push(e);
        }
        if !ss.is_empty() {
            // ASCII, <= 4 bytes -> inline in the value field.
            let mut e = [0u8; 12];
            e[0..2].copy_from_slice(&0x9291u16.to_le_bytes());
            e[2..4].copy_from_slice(&2u16.to_le_bytes());
            e[4..8].copy_from_slice(&(ss.len() as u32).to_le_bytes());
            e[8..8 + ss.len()].copy_from_slice(&ss);
            entries.push(e);
        }
        let mut t: Vec<u8> = Vec::new();
        t.extend_from_slice(b"II");
        t.extend_from_slice(&42u16.to_le_bytes());
        t.extend_from_slice(&8u32.to_le_bytes()); // IFD0 offset
        t.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        for e in &entries {
            t.extend_from_slice(e);
        }
        t.extend_from_slice(&0u32.to_le_bytes()); // no next IFD
        assert_eq!(t.len() as u32, value_off);
        t.extend_from_slice(&dt);
        // ── box it ──────────────────────────────────────────────────────
        let mut uuid_payload = vec![0u8; 16];
        uuid_payload.extend_from_slice(&boxed(b"CMT2", &t));
        let mut out = boxed(b"ftyp", b"crx isom");
        out.extend_from_slice(&boxed(b"moov", &boxed(b"uuid", &uuid_payload)));
        out
    }

    /// The whole read, on a synthetic file — UNGATED, so CI (which has no CR3
    /// corpus) actually covers it.
    #[test]
    fn read_capture_time_parses_datetime_and_subsec_from_a_moov_head() {
        let p = tmp_cr3(
            "capture-both",
            &synth_cr3_head(Some("2026:09:20 14:02:11"), Some("47")),
        );
        let (dt, ss) = read_capture_time(p.to_str().unwrap()).expect("read");
        assert_eq!(dt.as_deref(), Some("2026-09-20T14:02:11"), "normalized");
        assert_eq!(ss, Some(470), "two digits = hundredths");
        let _ = std::fs::remove_file(&p);
    }

    /// A moov whose CMT2 carries neither tag is NOT an error — the frame just
    /// has no capture time and falls back to its mtime in the sort.
    #[test]
    fn read_capture_time_is_none_not_an_error_when_the_tags_are_absent() {
        let p = tmp_cr3("capture-none", &synth_cr3_head(None, None));
        assert_eq!(read_capture_time(p.to_str().unwrap()).expect("read"), (None, None));
        let _ = std::fs::remove_file(&p);
    }

    /// No moov at all (a truncated or non-CR3 file) IS an error: the caller
    /// must be able to tell "this file has no time" from "this file is not
    /// readable as a CR3".
    #[test]
    fn read_capture_time_errors_without_a_moov() {
        let p = tmp_cr3("capture-nomoov", b"not a cr3 at all, not even close");
        assert!(read_capture_time(p.to_str().unwrap()).is_err());
        let _ = std::fs::remove_file(&p);
    }
```

Run `cargo test` from `src-tauri/`: all three fail to compile (`read_capture_time` does not exist). Right failure.

- [ ] **Step 2: implement.** In `src/cr3.rs`, directly after `read_thumbnail` (`:842`) and before the `// ── Native EXIF + AF metadata` banner (`:844`):

```rust
/// Just the capture clock: EXIF `DateTimeOriginal` (0x9003) and
/// `SubSecTimeOriginal` (0x9291), from the CMT2 Exif IFD. Reads only enough of
/// the head to hold the whole `moov` box — no THMB extraction, no decode, no
/// mdat — which is what makes a whole-shoot capture-time pass affordable at
/// Begin culling (scan.rs). The two values are returned in exactly the shape
/// `Cr3Meta` carries them, so `analyze::captured_at_ms` combines them unchanged.
///
/// `Ok((None, None))` when the moov is there but the tags are not: that frame
/// has no capture time and the sort falls back to its mtime. `Err` is reserved
/// for a file that cannot be read, or that holds no `moov` at all.
///
/// HEAD / GROW / the scan cap are `read_thumbnail`'s, deliberately: `moov`
/// carries the 160×120 THMB as well as the CMT boxes, so a smaller first read
/// would usually cost a second round-trip — and on the benchmarked NAS the
/// open, not the byte count, is what costs 37 ms.
// `mod cr3;` is private (lib.rs:53), so in the non-test lib build a `pub fn`
// with no caller is dead code and `clippy -D warnings` fails. Nothing calls
// this until scan.rs's capture pass lands; Task 7 deletes this attribute when
// `exif_ms_for` becomes its lib-build caller. Precedent: phash.rs:50.
#[cfg_attr(not(test), allow(dead_code))]
pub fn read_capture_time(path: &str) -> std::io::Result<(Option<String>, Option<u16>)> {
    const HEAD: usize = 1 << 20;
    const GROW: usize = 2 << 20;
    const MOOV_SCAN_CAP: usize = 64 << 20; // bound the hunt on malformed input
    let (mut buf, mut f, flen) = read_head(path, HEAD)?;
    while moov_range(&buf).is_none()
        && buf.len() < MOOV_SCAN_CAP
        && grow(&mut f, &mut buf, GROW, flen)?
    {}
    let Some((ms, me)) = moov_range(&buf) else {
        return Err(io_err("no moov box"));
    };
    let Some(t) = cmt_in_uuid_range(&buf, ms, me, b"CMT2").and_then(Tiff::new) else {
        return Ok((None, None));
    };
    let Some(ifd) = t.ifd0() else {
        return Ok((None, None));
    };
    Ok((
        t.ascii(ifd, 0x9003).map(|s| normalize_datetime(&s)),
        t.ascii(ifd, 0x9291).as_deref().and_then(sub_sec_to_ms),
    ))
}
```

- [ ] **Step 3:** from `src-tauri/`: `cargo fmt`, then `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test`. The clippy run is the one that needs the `allow(dead_code)` attribute above — drop the attribute and it fails with `function \`read_capture_time\` is never used`. Then the JS gate from the repo root (nothing JS changed, but the branch must stay green). Commit: `feat(cr3): read_capture_time — DateTimeOriginal + SubSec from the moov head`

### Task 7: [RUST] `analyze_folder` sorts on capture time, and a stage-time probe

**Files:** Modify `src-tauri/src/scan.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/cr3.rs` (one deletion — see Step 3b).

**Interfaces — Consumes:** `cr3::read_capture_time` (Task 6), `analyze::captured_at_ms` (`analyze.rs:389`, already `pub(crate)`), `tier_cache::{CacheTier, TierCache}` (both `pub`, `tier_cache.rs:61`, `:415`). **Produces:**

```rust
// src-tauri/src/scan.rs — the command gains two params and one State
pub(crate) async fn analyze_folder(
    window: tauri::Window,
    paths: Vec<String>,
    concurrent_restore: Option<bool>,
    by_capture_time: Option<bool>,
    offsets_ms: Option<Vec<i64>>,
    session: tauri::State<'_, std::sync::Arc<crate::io_gate::SessionGate>>,
    cache: tauri::State<'_, std::sync::Arc<crate::tier_cache::TierCache>>,
) -> Result<AnalyzeResult, String>

// a new command, registered in lib.rs
pub(crate) async fn read_capture_times(paths: Vec<String>) -> Result<Vec<Option<i64>>, String>

// the pure pieces, unit-tested
fn capture_epoch(exif_ms: Option<i64>, mtime_ms: Option<i64>, offset_ms: i64) -> Option<i64>
fn capture_from_thumb_header(header_json: &[u8]) -> Option<i64>
```

The TS wire keys are `byCaptureTime` and `offsetsMs` (Tauri v2 converts camelCase invoke args to snake_case params — the same mechanism `concurrentRestore` → `concurrent_restore` already relies on, `useSessionLifecycle.ts:419`). `read_capture_times` answers one epoch (or `null`) **per input path, in order**. `AnalyzeResult` is unchanged.

**Ruling (offsets arrive per FRAME, not keyed by folder).** The scout proposes `folder_offsets: HashMap<String, i64>` keyed on "the image's parent directory". That is wrong twice over: the walk is recursive (`walk_folder`, `scan.rs:37-73`), so `Path::new(p).parent()` is the subdirectory a frame was found in, **not** the `srcFolder` the user picked and the offsets are keyed by (`useSessionLifecycle.ts:249`); and matching Windows path strings across the IPC boundary invites a separator/normalisation mismatch that would silently zero every offset. TS already owns `srcFolder` per image, so it resolves the lookup before the call and sends a **parallel `Vec<i64>`, one per input path**. No string matching in Rust, no normalisation to get wrong, nothing to test for drift. A short or absent vector reads as 0 per index (`offsets.get(i)`), so a length mismatch degrades to "no offset" rather than a panic or a wrong key.

**Ruling (the offset applies to whichever epoch a frame got, EXIF or mtime).** The spec says "added to that folder's EXIF times". Applying it only to the EXIF frames would split one folder across two clock spaces — a frame whose EXIF is missing would sort against an uncorrected number while its neighbours sort against corrected ones. The offset is a per-body clock correction, so it applies to that body's frames, full stop. The pure `capture_epoch` makes the rule one line and one test.

**Ruling (a cache hit that yields no time falls through to the source).** A cached thumb header is an accelerator, never a source of absence: a v1 header (`meta: null`) or a CR3 with no `DateTimeOriginal` must not permanently deny the time. `capture_from_thumb_header` returning `None` means "ask the file".

- [ ] **Step 1: failing tests.** Append to `scan.rs`'s `#[cfg(test)] mod tests` (`:526`):

```rust
    /// capture_epoch: EXIF wins, the file's mtime is the fallback, and the
    /// folder's clock offset rides whichever one won — a folder must never be
    /// split across two clock spaces just because one frame lost its EXIF.
    #[test]
    fn capture_epoch_prefers_exif_then_mtime_and_always_offsets() {
        assert_eq!(capture_epoch(Some(1_000), Some(9_000), 0), Some(1_000));
        assert_eq!(capture_epoch(None, Some(9_000), 0), Some(9_000));
        assert_eq!(capture_epoch(None, None, 5_000), None);
        assert_eq!(capture_epoch(Some(1_000), None, 300_000), Some(301_000));
        assert_eq!(capture_epoch(None, Some(9_000), -1_500), Some(7_500));
    }

    /// A pathological offset must not wrap the sort key into the past.
    #[test]
    fn capture_epoch_saturates_instead_of_overflowing() {
        assert_eq!(capture_epoch(Some(i64::MAX), None, 1), Some(i64::MAX));
        assert_eq!(capture_epoch(Some(i64::MIN), None, -1), Some(i64::MIN));
    }

    /// capture_from_thumb_header: the two fields are read out of a stored
    /// ThumbHeader without re-opening the CR3, and every degraded shape
    /// (a v1 `meta: null`, an empty object, a frame with no DateTimeOriginal,
    /// outright garbage) answers None so the caller falls through to the file.
    #[test]
    fn capture_from_thumb_header_reads_a_cached_header_and_tolerates_old_ones() {
        let full = br#"{"width":160,"height":120,"jpegLen":9000,"meta":{"capturedAt":"2026-09-20T14:02:11","subSecMs":470,"camera":"Canon EOS R6m3","iso":400}}"#;
        let ms = capture_from_thumb_header(full).expect("a full header carries the time");
        assert_eq!(
            ms,
            crate::analyze::captured_at_ms(Some("2026-09-20T14:02:11"), Some(470)).unwrap()
        );
        assert_eq!(capture_from_thumb_header(br#"{"meta":null}"#), None, "v1 header");
        assert_eq!(capture_from_thumb_header(b"{}"), None, "no meta key at all");
        assert_eq!(
            capture_from_thumb_header(br#"{"meta":{"subSecMs":470}}"#),
            None,
            "SubSec alone is not a time"
        );
        assert_eq!(capture_from_thumb_header(b"not json"), None);
    }
```

`cargo test` fails to compile — neither function exists.

- [ ] **Step 2: the pure pieces.** In `src/scan.rs`, after `order_by_capture` (`:102`):

```rust
/// One frame's sort key. EXIF capture time when the frame has one, else the
/// file's own mtime (written in shoot order for an in-camera write), else
/// `None` — which `order_by_capture` sinks to the end, in path order.
///
/// `offset_ms` is that FOLDER's clock correction and rides whichever source
/// won: the offset describes a body's clock, so applying it only to the EXIF
/// frames would split one folder across two clock spaces the moment a single
/// frame lost its `DateTimeOriginal`. Saturating, so a pathological offset
/// cannot wrap a sort key into the past.
fn capture_epoch(exif_ms: Option<i64>, mtime_ms: Option<i64>, offset_ms: i64) -> Option<i64> {
    exif_ms.or(mtime_ms).map(|t| t.saturating_add(offset_ms))
}

/// The two capture fields of a CACHED thumb-tier header (`bundle::ThumbHeader`),
/// combined into an epoch. Minimal-struct parse in the house style of
/// `bundle::OrientationOnly`: only the fields this pass needs, every one
/// `serde(default)`, so a v1 header (`meta: null`), a header written before a
/// field existed, or one written after a field is added all parse instead of
/// erroring. `None` means "the cache cannot answer" — never "this frame has no
/// time" — so the caller falls through to the source file.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedCapture {
    #[serde(default)]
    captured_at: Option<String>,
    #[serde(default)]
    sub_sec_ms: Option<u16>,
}

#[derive(serde::Deserialize)]
struct CachedThumbHeader {
    #[serde(default)]
    meta: Option<CachedCapture>,
}

fn capture_from_thumb_header(header_json: &[u8]) -> Option<i64> {
    let h: CachedThumbHeader = serde_json::from_slice(header_json).ok()?;
    let m = h.meta?;
    crate::analyze::captured_at_ms(m.captured_at.as_deref(), m.sub_sec_ms)
}
```

- [ ] **Step 3: one frame's EXIF, cache first.** Directly below, still in `scan.rs`:

```rust
/// EXIF capture time for one frame, cheapest source first: the thumb tier's
/// stored header (validated by the listing's own mtime + size, so a hit costs
/// ZERO source-file round-trips and re-opening a shoot is free), then a
/// `moov`-head read of the CR3 itself. Any read failure is `None` — a frame
/// that cannot be opened here still sorts, on its mtime.
fn exif_ms_for(cache: &TierCache, path: &str, stat: Option<(i64, u64)>) -> Option<i64> {
    if let Some((ms, size)) = stat {
        if let Some((header, _payload)) = cache.get(CacheTier::Thumb, path, ms, size) {
            if let Some(t) = capture_from_thumb_header(&header) {
                return Some(t);
            }
        }
    }
    let (captured_at, sub_sec) = crate::cr3::read_capture_time(path).ok()?;
    crate::analyze::captured_at_ms(captured_at.as_deref(), sub_sec)
}
```

and add the import at the top of the file, beside `use crate::xmp::read_ratings;` (`:19`):

```rust
use crate::tier_cache::{CacheTier, TierCache};
```

- [ ] **Step 3b: give `read_capture_time` its lib-build caller.** In `src-tauri/src/cr3.rs`, delete the `#[cfg_attr(not(test), allow(dead_code))]` line Task 6 added above `read_capture_time`, together with its four-line `//` comment. `exif_ms_for` above is now that caller, so the attribute would itself become a lint. This is the only edit Task 7 makes to `cr3.rs`, and it is why Tasks 6 and 7 are strictly serial rather than merely ordered.

- [ ] **Step 4: the pass.** Still in `scan.rs`, after `restore_ratings` (`:379`), the whole-set pass on the same scoped-thread pattern `restore_ratings` uses:

```rust
/// Read every frame's EXIF capture time, on `RESTORE_WORKERS` threads when the
/// storage hint says local (same rule and same pool shape as `restore_ratings`
/// — the benchmarked NAS punishes concurrent opens hard). `on_progress(done)`
/// fires once per frame, from worker threads on the concurrent path.
fn read_capture_epochs(
    cache: &TierCache,
    paths: &[String],
    stats: &[Option<(i64, u64)>],
    concurrent: bool,
    on_progress: &(dyn Fn(usize) + Sync),
) -> Vec<Option<i64>> {
    let n = paths.len();
    let mut out: Vec<Option<i64>> = vec![None; n];
    if concurrent && n > RESTORE_WORKERS {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let done_counter = AtomicUsize::new(0);
        let chunk_size = n.div_ceil(RESTORE_WORKERS);
        let done_ref = &done_counter;
        let all: Vec<usize> = (0..n).collect();
        let parts: Vec<Vec<(usize, Option<i64>)>> = std::thread::scope(|s| {
            let mut handles = Vec::with_capacity(RESTORE_WORKERS);
            for chunk in all.chunks(chunk_size) {
                handles.push(s.spawn(move || {
                    let mut part = Vec::with_capacity(chunk.len());
                    for &i in chunk {
                        part.push((i, exif_ms_for(cache, &paths[i], stats[i])));
                        on_progress(done_ref.fetch_add(1, Ordering::Relaxed) + 1);
                    }
                    part
                }));
            }
            handles
                .into_iter()
                .map(|h| {
                    h.join().unwrap_or_else(|_| {
                        // A panicked worker must not poison the whole analyze:
                        // its chunk reads back with no EXIF and sorts on mtime.
                        dlog!("[cull] analyze_folder: capture worker panicked; its chunk sorts on mtime");
                        Vec::new()
                    })
                })
                .collect()
        });
        for part in parts {
            for (i, t) in part {
                out[i] = t;
            }
        }
    } else {
        for i in 0..n {
            out[i] = exif_ms_for(cache, &paths[i], stats[i]);
            on_progress(i + 1);
        }
    }
    out
}
```

- [ ] **Step 5: wire it into `analyze_folder`.** Four edits in `scan.rs`:
  - the command (`:384-400`) gains the two params and the `TierCache` State, and clones the Arc across into the blocking closure exactly as it already does for `SessionGate`:

    ```rust
    /// `concurrent_restore` is a storage hint forwarded from frontend settings.
    /// `Some(true)` parallelises sidecar reads AND the capture-time pass (fine
    /// on local SSD); defaults to sequential — safe on a NAS that punishes
    /// concurrent opens.
    ///
    /// `by_capture_time` (default false) swaps the sort key from each file's
    /// mtime to its EXIF `DateTimeOriginal` + `SubSecTimeOriginal`, per frame,
    /// falling back to that frame's mtime where the EXIF is absent.
    /// `offsets_ms` is a per-INPUT-PATH clock correction in milliseconds (the
    /// frontend resolves its own folder → offset map before calling, because
    /// the folder a frame belongs to is the folder the USER picked, not the
    /// subdirectory the recursive walk found it in). Ignored when
    /// `by_capture_time` is off; a short or absent vector reads as 0.
    #[tauri::command]
    pub(crate) async fn analyze_folder(
        window: tauri::Window,
        paths: Vec<String>,
        concurrent_restore: Option<bool>,
        by_capture_time: Option<bool>,
        offsets_ms: Option<Vec<i64>>,
        session: tauri::State<'_, std::sync::Arc<crate::io_gate::SessionGate>>,
        cache: tauri::State<'_, std::sync::Arc<crate::tier_cache::TierCache>>,
    ) -> Result<AnalyzeResult, String> {
        // Spawn-blocking: directory listings + sequential sidecar restore are sync
        // fs I/O sized in NAS round-trips — off the async runtime, like scan_folder.
        // The State borrows can't cross into the 'static closure; the Arcs can.
        let session = session.inner().clone();
        let cache = cache.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            analyze_folder_sync(
                window,
                paths,
                concurrent_restore,
                by_capture_time,
                offsets_ms,
                &session,
                &cache,
            )
        })
        .await
        .map_err(|e| format!("analyze task failed: {e}"))?
    }
    ```
  - `analyze_folder_sync` (`:402-407`) takes the same two extras plus `cache: &TierCache`, and `let concurrent_restore = concurrent_restore.unwrap_or(false);` gains `let by_capture_time = by_capture_time.unwrap_or(false);` beside it, plus one loud-on-drift check (a wrong-length vector is memory-safe — `.get(i)` just reads 0 past the end — but silently wrong, which is worse):

    ```rust
        if let Some(v) = offsets_ms.as_ref() {
            if v.len() != n {
                dlog!(
                    "[cull] analyze_folder: {} offsets for {} paths; extras read as 0",
                    v.len(),
                    n
                );
            }
        }
    ```
  - replace the `epoch` build (`:458-461`) with:

    ```rust
    // The sort key. Default: each file's mtime, from the directory listings
    // above — no file is opened. With `by_capture_time`, each frame's EXIF
    // capture time instead (thumb-cache hit first, else a moov-head read),
    // with that frame's folder offset, falling back to its mtime.
    let epoch: Vec<Option<i64>> = if by_capture_time {
        let stats: Vec<Option<(i64, u64)>> = paths
            .iter()
            .map(|p| match (listing.mtime.get(p), listing.sizes.get(p)) {
                (Some(&ms), Some(&size)) => Some((ms, size)),
                _ => None,
            })
            .collect();
        let step_cap = (n / 100).max(1); // ≤ ~100 progress events
        let exif = read_capture_epochs(cache, &paths, &stats, concurrent_restore, &|done| {
            if done.is_multiple_of(step_cap) || done == n {
                let _ = window.emit(
                    "analyze-progress",
                    AnalyzeProgress {
                        done,
                        total: n,
                        phase: "capturing".into(),
                    },
                );
            }
        });
        // One terminal tick, for the same reason the listing pass emits one.
        let _ = window.emit(
            "analyze-progress",
            AnalyzeProgress {
                done: n,
                total: n,
                phase: "capturing".into(),
            },
        );
        (0..n)
            .map(|i| {
                // Pre-formatted as rustfmt wants it: the one-line chain is 84
                // columns and past the default chain_width of 60.
                let offset = offsets_ms
                    .as_ref()
                    .and_then(|v| v.get(i).copied())
                    .unwrap_or(0);
                capture_epoch(exif[i], listing.mtime.get(&paths[i]).copied(), offset)
            })
            .collect()
    } else {
        paths.iter().map(|p| listing.mtime.get(p).copied()).collect()
    };
    ```
  - the `dlog!` at `:511-515` becomes `"[cull] analyze_folder: {} images in {:?} ({})", n, start.elapsed(), if by_capture_time { "EXIF capture time" } else { "mtime fast path" }`, and the comment at `:500` becomes `// Sort by the epoch built above; missing times sort last, tiebreak on path.`
- [ ] **Step 6: update the two module doc blocks that now lie.** `scan.rs:5-8` (the module header's description of `analyze_folder`) and `AnalyzeResult.order`'s doc (`:164-166`, "mtime, sub-second … precise EXIF DateTimeOriginal is read lazily per image and is not used for ordering") both claim mtime is the only key. Replace `:164-166` with:

```rust
    /// Input indices in session order. The key is each file's EXIF
    /// `DateTimeOriginal` + `SubSecTimeOriginal` when `by_capture_time` is on
    /// (falling back per frame to that file's mtime), otherwise the mtime
    /// alone; path is the tiebreak either way, and a frame with neither sorts
    /// last.
```

and `:5-8` with `- [`analyze_folder`] orders them chronologically (EXIF capture time when the frontend asks for it, otherwise each file's mtime) and restores any existing CULL ratings from their `.xmp` sidecars.`

- [ ] **Step 7: the stage-time probe.** In `scan.rs`, after `analyze_folder_sync`, a small standalone command:

```rust
/// Capture time (epoch ms, camera local clock) for a handful of paths — the
/// staged screen's per-folder probe, called with the FIRST STAGED (i.e.
/// lexicographically first, `scan.rs`'s `paths.sort()`) frame of each staged
/// folder, so the row can print THAT frame's capture time and the signed
/// difference from the first folder's. Not necessarily the folder's earliest
/// frame — a 9999→0001 counter wrap reverses the two. Deliberately cache-free and
/// sequential: N is the number of staged folders (one or two in practice), so
/// wiring the tier cache in would cost more than the reads it saves.
/// A per-path failure is `None`, never an error: a row with no time just shows
/// a dash.
#[tauri::command]
pub(crate) async fn read_capture_times(paths: Vec<String>) -> Result<Vec<Option<i64>>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        paths
            .iter()
            .map(|p| {
                let (captured_at, sub_sec) = crate::cr3::read_capture_time(p).ok()?;
                crate::analyze::captured_at_ms(captured_at.as_deref(), sub_sec)
            })
            .collect()
    })
    .await
    .map_err(|e| format!("capture-time task failed: {e}"))
}
```

- [ ] **Step 8: register it.** In `src-tauri/src/lib.rs`, add `scan::read_capture_times,` directly after `scan::analyze_folder,` (`:217`). Also extend the module table row for `scan` (`:12`) to `| [`scan`] | `scan_folder` + `analyze_folder` + `read_capture_times` Tauri commands. |`.
- [ ] **Step 9:** from `src-tauri/`: `cargo fmt`, then `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test`. Clippy must be clean with Task 6's `allow(dead_code)` now deleted. The two existing `order_by_capture` tests (`:576-598`) must still pass untouched — the comparator did not change. Then the JS gate from the repo root: `pnpm typecheck` will now FAIL at `useSessionLifecycle.ts:417` only if the TS call was already changed; it has not been (Task 9 does that), and adding optional Rust params breaks nothing on the wire, so the JS gate must be green here. Commit: `feat(scan): analyze_folder can sort on EXIF capture time, with a per-frame clock offset`

### Task 8: The two settings, and the staged rows' pure helpers

**Files:** Modify `src/types/settings.ts`, `src/hooks/useSettings.ts`, `src/hooks/useSettings.test.ts`. Create `src/utils/stagedFolders.ts`, `src/utils/stagedFolders.test.ts`.

**Interfaces — Produces:**

```ts
// src/types/settings.ts
export type Settings = {
  // …
  /** Sort the staged set by EXIF capture time at Begin culling. */
  sortByCaptureTime: boolean;
  /** Per-folder capture-clock corrections in ms, keyed by `Img.srcFolder`. */
  captureOffsets: Record<string, number>;
};
export const CAPTURE_OFFSET_LIMIT_MS = 24 * 60 * 60 * 1000;
export function coerceCaptureOffsets(raw: unknown): Record<string, number>;
```

```ts
// src/utils/stagedFolders.ts
export type StagedFolder = { path: string; name: string; count: number; firstPath: string };
export function groupStagedFolders(images: readonly Img[]): StagedFolder[];
export function formatCaptureClock(ms: number): string;
export function formatSignedDuration(ms: number): string;
export function stepOffset(current: number, dir: 1 | -1, mods: { shift: boolean; reset: boolean }): number;
export const OFFSET_STEP_MS: 1000;
export const OFFSET_STEP_SHIFT_MS: 60000;
```

**Ruling (`sortByCaptureTime` defaults to ON, and gets NO Settings-dialog row).** Default on, per spec §C ("Oliver's shoots are on a local SSD, where the pass is seconds for 4,000 frames"). The toggle lives on the staged screen only — that is the one moment it matters and the one screen that can also show what it costs. Adding a Settings row would put the same switch in two places and pull `SettingsDialog.tsx` into this phase for nothing.

**Ruling (capture times are read back in UTC).** `analyze::captured_at_ms` parses the TZ-less EXIF string with `NaiveDateTime … and_utc()` (`analyze.rs:389-392`), i.e. it encodes the camera's local wall clock **as** UTC. Reading it back with `toLocaleTimeString` would shift every row by the machine's own offset. `formatCaptureClock` goes through `toISOString`, and its test pins that with a `Date.UTC` input so it passes in any timezone.

- [ ] **Step 1: failing tests for the pure helpers** — create `src/utils/stagedFolders.test.ts` (node env):

```ts
import { describe, expect, it } from "vitest";
import {
  formatCaptureClock,
  formatSignedDuration,
  groupStagedFolders,
  OFFSET_STEP_MS,
  OFFSET_STEP_SHIFT_MS,
  stepOffset,
} from "./stagedFolders";
import { CAPTURE_OFFSET_LIMIT_MS } from "../types/settings";
import type { Img } from "../types";

const img = (id: number, srcFolder: string, name: string): Img => ({
  id,
  path: `${srcFolder}\\${name}`,
  filename: name,
  srcFolder,
});

describe("groupStagedFolders", () => {
  it("groups by srcFolder in FIRST-STAGED order, counting and naming each", () => {
    const groups = groupStagedFolders([
      img(0, "C:\\shoot\\bodyA", "A1.CR3"),
      img(1, "C:\\shoot\\bodyA", "A2.CR3"),
      img(2, "C:\\shoot\\bodyB", "B1.CR3"),
    ]);
    expect(groups.map((g) => g.path)).toEqual(["C:\\shoot\\bodyA", "C:\\shoot\\bodyB"]);
    expect(groups.map((g) => g.name)).toEqual(["bodyA", "bodyB"]);
    expect(groups.map((g) => g.count)).toEqual([2, 1]);
  });

  it("remembers each folder's FIRST staged frame — the row's capture-time probe", () => {
    const groups = groupStagedFolders([
      img(0, "C:\\shoot\\bodyA", "A1.CR3"),
      img(1, "C:\\shoot\\bodyA", "A2.CR3"),
    ]);
    expect(groups[0].firstPath).toBe("C:\\shoot\\bodyA\\A1.CR3");
  });

  it("is empty for an empty set", () => {
    expect(groupStagedFolders([])).toEqual([]);
  });
});

describe("formatCaptureClock", () => {
  it("prints the CAMERA's wall clock, never the machine's", () => {
    // captured_at_ms encodes the TZ-less EXIF string as UTC (analyze.rs), so
    // reading it back in local time would shift every row by the machine's
    // offset. This assertion has to hold in every timezone.
    expect(formatCaptureClock(Date.UTC(2026, 8, 20, 14, 2, 11))).toBe("14:02:11");
    expect(formatCaptureClock(Date.UTC(2026, 8, 20, 0, 0, 0, 470))).toBe("00:00:00");
  });
});

describe("formatSignedDuration", () => {
  it("always carries a sign, and a real minus, never a hyphen", () => {
    expect(formatSignedDuration(0)).toBe("+0 s");
    expect(formatSignedDuration(1000)).toBe("+1 s");
    expect(formatSignedDuration(-72_000)).toBe("\u22121 min 12 s");
    expect(formatSignedDuration(-72_000).startsWith("\u2212")).toBe(true);
  });

  it("drops the empty units and keeps the biggest one that fits", () => {
    expect(formatSignedDuration(60_000)).toBe("+1 min");
    expect(formatSignedDuration(3_600_000)).toBe("+1 h");
    expect(formatSignedDuration(3_912_000)).toBe("+1 h 5 min 12 s");
    expect(formatSignedDuration(3_660_000)).toBe("+1 h 1 min");
  });

  it("rounds to whole seconds — sub-second clock skew is noise", () => {
    expect(formatSignedDuration(1_400)).toBe("+1 s");
    expect(formatSignedDuration(-1_600)).toBe("\u22122 s");
    expect(formatSignedDuration(400)).toBe("+0 s");
  });
});

describe("stepOffset", () => {
  it("steps a second, a minute with Shift, and resets with Ctrl", () => {
    expect(stepOffset(0, 1, { shift: false, reset: false })).toBe(OFFSET_STEP_MS);
    expect(stepOffset(0, -1, { shift: true, reset: false })).toBe(-OFFSET_STEP_SHIFT_MS);
    expect(stepOffset(123_456, 1, { shift: false, reset: true })).toBe(0);
    // Reset wins over the direction and over Shift — one click, one meaning.
    expect(stepOffset(123_456, -1, { shift: true, reset: true })).toBe(0);
  });

  it("clamps at a day in each direction", () => {
    expect(stepOffset(CAPTURE_OFFSET_LIMIT_MS, 1, { shift: true, reset: false })).toBe(
      CAPTURE_OFFSET_LIMIT_MS,
    );
    expect(stepOffset(-CAPTURE_OFFSET_LIMIT_MS, -1, { shift: true, reset: false })).toBe(
      -CAPTURE_OFFSET_LIMIT_MS,
    );
  });
});
```

- [ ] **Step 2: failing tests for the settings** — append to `src/hooks/useSettings.test.ts` (it imports `describe, expect, it`):

```ts
describe("coerceSettings — capture-time sort (Phase 3C)", () => {
  it("defaults sortByCaptureTime ON for a blob that predates the field", () => {
    expect(coerceSettings({}).sortByCaptureTime).toBe(true);
  });

  it("keeps an explicit stored value and rejects a wrong-typed one", () => {
    expect(coerceSettings({ sortByCaptureTime: false }).sortByCaptureTime).toBe(false);
    expect(coerceSettings({ sortByCaptureTime: "yes" }).sortByCaptureTime).toBe(true);
  });

  it("defaults captureOffsets to an empty map", () => {
    expect(coerceSettings({}).captureOffsets).toEqual({});
  });

  it("keeps the finite numeric entries of a stored offsets map and drops the rest", () => {
    // A hand-edited or half-written blob must not reach the sort: a NaN offset
    // would poison every comparison in that folder.
    const s = coerceSettings({
      captureOffsets: {
        "C:\\shoot\\bodyB": -72000,
        "C:\\shoot\\bodyC": "300",
        "C:\\shoot\\bodyD": Number.NaN,
        "C:\\shoot\\bodyE": null,
      },
    });
    expect(s.captureOffsets).toEqual({ "C:\\shoot\\bodyB": -72000 });
  });

  it("rounds a fractional stored offset — the wire type is Rust i64", () => {
    // serde refuses to deserialize 1500.7 into i64, which would fail the whole
    // analyze_folder call rather than degrade the sort.
    expect(coerceSettings({ captureOffsets: { a: 1500.7 } }).captureOffsets).toEqual({ a: 1501 });
  });

  it("clamps a stored offset to a day and falls back on a non-object", () => {
    expect(coerceSettings({ captureOffsets: { a: 1e12 } }).captureOffsets).toEqual({
      a: CAPTURE_OFFSET_LIMIT_MS,
    });
    expect(coerceSettings({ captureOffsets: "nope" }).captureOffsets).toEqual({});
    expect(coerceSettings({ captureOffsets: [1, 2] }).captureOffsets).toEqual({});
  });
});
```

(add `CAPTURE_OFFSET_LIMIT_MS` to that file's existing `import { DEFAULT_SETTINGS } from "../types/settings";`.)

- [ ] **Step 3: the settings fields.** In `src/types/settings.ts`, add to `Settings` after `gridSize` (`:66`):

```ts
  /**
   * Sort the staged set by EXIF `DateTimeOriginal` (+ SubSec) at Begin
   * culling, instead of by each file's write time. ON by default: on a local
   * SSD the pass is seconds for 4,000 frames, and the thumb tier caches every
   * read, so re-opening a shoot is free. The one place it is worth turning
   * off is a slow network share on its FIRST open — which is exactly where
   * the toggle lives, on the staged screen.
   */
  sortByCaptureTime: boolean;
  /**
   * Per-folder clock corrections in MILLISECONDS, keyed by `Img.srcFolder`
   * (the folder the user picked, not the subdirectory a recursive walk found
   * a frame in). Added to that folder's frames for ORDERING only — nothing is
   * ever written to a file and the info rail keeps showing the camera's own
   * time. Lives here rather than in recents because recents expire after 14
   * days and are capped at 5, so an offset would silently evaporate.
   *
   * Keyed by the VERBATIM `srcFolder` string the picker returned — no
   * normalisation beyond the NFC pass every folder path already gets
   * (`useSessionLifecycle.ts`), so re-picking the same folder with a
   * different spelling (a trailing separator, different case) starts it at 0
   * rather than mis-keying someone else's correction onto it.
   */
  captureOffsets: Record<string, number>;
```

to `DEFAULT_SETTINGS` after `gridSize: "medium",` (`:111`):

```ts
  sortByCaptureTime: true,
  captureOffsets: {},
```

and, beside `normalizeRejectedSubfolder` (`:134-138`):

```ts
/** The largest clock correction the staged screen will hold or store. A day
 *  covers every real case (a body left on the wrong date, a timezone, a dead
 *  clock battery) and keeps a hand-edited blob from reaching the sort with a
 *  number that swamps it. */
export const CAPTURE_OFFSET_LIMIT_MS = 24 * 60 * 60 * 1000;

/** Validate a stored `captureOffsets` blob: an object of finite numbers, each
 *  clamped to ±{@link CAPTURE_OFFSET_LIMIT_MS} and rounded to a whole
 *  millisecond. Anything else — a non-object, an array, a string value, a
 *  NaN — is dropped entry by entry rather than failing the whole settings
 *  load. A NaN reaching the sort would poison every comparison in that
 *  folder, and a FRACTION is worse than useless: the wire type is Rust
 *  `i64`, so serde rejects the whole `analyze_folder` call rather than
 *  degrading the sort. `stepOffset` only ever produces integers, so storage
 *  is the one source of either — which is exactly what this distrusts. */
export const coerceCaptureOffsets = (raw: unknown): Record<string, number> => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const out: Record<string, number> = {};
  for (const [folder, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    const clamped = Math.max(-CAPTURE_OFFSET_LIMIT_MS, Math.min(CAPTURE_OFFSET_LIMIT_MS, value));
    out[folder] = Math.round(clamped);
  }
  return out;
};
```

- [ ] **Step 4: the validator.** In `src/hooks/useSettings.ts`, extend the import from `../types/settings` with `coerceCaptureOffsets`, and add two entries to `coerceSettings`'s returned object (`:39-78`), directly after `gridSize:` (`:60`):

```ts
    sortByCaptureTime: bool(p.sortByCaptureTime, d.sortByCaptureTime),
    captureOffsets: coerceCaptureOffsets(p.captureOffsets),
```

- [ ] **Step 5: the pure helpers** — create `src/utils/stagedFolders.ts`:

```ts
import type { Img } from "../types/image";
import { CAPTURE_OFFSET_LIMIT_MS } from "../types/settings";
import { basename } from "./path";

/**
 * What the staged screen's per-folder rows are built from, and the arithmetic
 * behind their capture-time hint and their ± stepper. Pure — the component
 * only fetches and renders.
 */

/** One staged source folder, in first-staged order. */
export type StagedFolder = {
  /** Absolute `Img.srcFolder` — the `captureOffsets` key. */
  path: string;
  /** Basename, the row's label. */
  name: string;
  count: number;
  /**
   * The folder's FIRST staged frame — the row's capture-time probe. Within a
   * folder the staged order is the backend walk's `paths.sort()` (scan.rs), so
   * this is its lexicographically first CR3.
   */
  firstPath: string;
};

/** Group the staged set by source folder, in the order the folders were
 *  staged. One pass, no sorting: the order IS the append order. */
export function groupStagedFolders(images: readonly Img[]): StagedFolder[] {
  const byPath = new Map<string, StagedFolder>();
  for (const im of images) {
    const seen = byPath.get(im.srcFolder);
    if (seen) seen.count += 1;
    else
      byPath.set(im.srcFolder, {
        path: im.srcFolder,
        name: basename(im.srcFolder),
        count: 1,
        firstPath: im.path,
      });
  }
  return [...byPath.values()];
}

/**
 * A capture time as the CAMERA's wall clock, "14:02:11".
 *
 * UTC in, UTC out, deliberately: the backend's `captured_at_ms` parses the
 * timezone-less EXIF string as UTC (`analyze.rs`), so the epoch it hands back
 * IS the camera's local clock wearing a UTC label. Any local-time formatter
 * here would shift every row by this machine's offset.
 */
export function formatCaptureClock(ms: number): string {
  return new Date(ms).toISOString().slice(11, 19);
}

/**
 * A signed clock difference, as the offset stepper and the delta hint print
 * it: `+0 s`, `−1 min 12 s`, `+1 h 5 min 12 s`. Always signed (an unsigned 0
 * would read as "unset" rather than "no correction"), rounded to whole
 * seconds (sub-second skew between two bodies is noise), and the minus is
 * U+2212 MINUS SIGN, not a hyphen — it has to line up under a plus.
 */
export function formatSignedDuration(ms: number): string {
  const total = Math.round(Math.abs(ms) / 1000);
  const sign = ms < 0 && total > 0 ? "\u2212" : "+";
  const h = Math.floor(total / 3600);
  const min = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h} h`);
  if (min > 0) parts.push(`${min} min`);
  if (s > 0 || parts.length === 0) parts.push(`${s} s`);
  return `${sign}${parts.join(" ")}`;
}

/** One click of the stepper: ±1 s. */
export const OFFSET_STEP_MS = 1000;
/** Shift-click: ±1 min. */
export const OFFSET_STEP_SHIFT_MS = 60_000;

/** One stepper click. Ctrl/Cmd resets to 0 and wins over everything else, so
 *  one click has exactly one meaning; every other result is clamped to
 *  ±CAPTURE_OFFSET_LIMIT_MS, the same bound the settings validator applies. */
export function stepOffset(
  current: number,
  dir: 1 | -1,
  mods: { shift: boolean; reset: boolean },
): number {
  if (mods.reset) return 0;
  const next = current + dir * (mods.shift ? OFFSET_STEP_SHIFT_MS : OFFSET_STEP_MS);
  return Math.max(-CAPTURE_OFFSET_LIMIT_MS, Math.min(CAPTURE_OFFSET_LIMIT_MS, next));
}
```

- [ ] **Step 6:** gate green. Commit: `feat(settings): sortByCaptureTime + per-folder captureOffsets, and the staged rows' maths`

### Task 9: The staged screen — the toggle, the folder rows, and the invoke

**Files:** Create `src/components/StagedFolders.tsx`, `src/components/StagedFolders.test.tsx`, `src/styles/staged-sort.css`. Modify `src/App.tsx`, `src/app/useSessionLifecycle.ts`, `src/styles/index.css`.

**Ruling (a new stylesheet, named `staged-sort.css`, not `staged.css` and not folded into an existing sheet).** The staged screen's existing classes (`.cull-staged__check` / `__count` / `__folder` / `__ignored` / `__actions` / `__hint`) live in **`chrome.css`** (`:685-733`), not in `stage.css` — `stage.css` is the loupe's photo stage (`.cull-stage`, `.cull-loupe-body`, `.cull-image-area`), a different surface entirely. Folding ~60 lines into `chrome.css` would take it from 778 to about 838 lines, past the repo's 800-line ceiling, **and** hand Task 5 and Task 9 a shared file, serialising two tasks that are otherwise disjoint. A separate sheet is therefore right; it is named `staged-sort.css` (not `staged.css`) so it cannot be confused at a glance with the existing `stage.css` — one letter apart is a maintenance trap.

**Interfaces — Consumes:** `groupStagedFolders` / `formatCaptureClock` / `formatSignedDuration` / `stepOffset` / `StagedFolder` (Task 8), `Settings.sortByCaptureTime` / `Settings.captureOffsets` (Task 8), the `analyze_folder` params and the `read_capture_times` command (Task 7). **Produces:**

```tsx
// src/components/StagedFolders.tsx
export function StagedFolders({
  images,
  sortByCaptureTime,
  onToggleSort,
  offsets,
  onOffsetChange,
}: {
  images: readonly Img[];
  sortByCaptureTime: boolean;
  onToggleSort: (next: boolean) => void;
  offsets: Readonly<Record<string, number>>;
  /** Absolute srcFolder → new offset in ms. */
  onOffsetChange: (folderPath: string, ms: number) => void;
}): React.JSX.Element;
```

**Ruling (the component owns its own probe).** `read_capture_times` is fetched inside `StagedFolders` in an effect keyed on the probe paths, not lifted into a hook or into `App`. Precedent: `SettingsDialog.tsx:522-538` owns its `thumb_cache_size` / `clear_thumb_cache` invokes the same way. Lifting it would add a file and put a staged-screen-only fetch into the component that is already 2,123 lines long.

**Ruling (no toggle primitive to reuse).** `SettingsDialog`'s `Toggle` and `SegmentToggle` are module-private function components in `SettingsDialog.tsx:358-435`, not shared primitives — `src/styles/primitives/` has `btn / chip / kbd / dialog / note / progress / shimmer / spinner / eyebrow` and no toggle. The staged toggle is therefore a `.btn.btn--sm` with `aria-pressed`, which is the shared primitive, and it takes `--ring` from `btn.css:63-67` for free.

- [ ] **Step 1: failing test** — create `src/components/StagedFolders.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { StagedFolders } from "./StagedFolders";
import type { Img } from "../types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const img = (id: number, srcFolder: string, name: string): Img => ({
  id,
  path: `${srcFolder}\\${name}`,
  filename: name,
  srcFolder,
});

const twoFolders: Img[] = [
  img(0, "C:\\shoot\\bodyA", "A1.CR3"),
  img(1, "C:\\shoot\\bodyA", "A2.CR3"),
  img(2, "C:\\shoot\\bodyB", "B1.CR3"),
];

beforeEach(() => vi.mocked(invoke).mockReset());
afterEach(cleanup);

const noop = (): void => {};

describe("the staged screen's capture-time controls", () => {
  it("offers the sort as one pressed-state button", () => {
    render(
      <StagedFolders
        images={twoFolders}
        sortByCaptureTime
        onToggleSort={noop}
        offsets={{}}
        onOffsetChange={noop}
      />,
    );
    const toggle = screen.getByRole("button", { name: "Sort by capture time" });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
  });

  it("shows no folder rows when the sort is off, and probes nothing", () => {
    render(
      <StagedFolders
        images={twoFolders}
        sortByCaptureTime={false}
        onToggleSort={noop}
        offsets={{}}
        onOffsetChange={noop}
      />,
    );
    expect(screen.queryByRole("list", { name: "Staged folders" })).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("shows no folder rows for a single staged folder — there is nothing to offset against", () => {
    render(
      <StagedFolders
        images={[img(0, "C:\\shoot\\bodyA", "A1.CR3")]}
        sortByCaptureTime
        onToggleSort={noop}
        offsets={{}}
        onOffsetChange={noop}
      />,
    );
    expect(screen.queryByRole("list", { name: "Staged folders" })).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("probes ONE frame per folder and prints each folder's first capture time", async () => {
    vi.mocked(invoke).mockResolvedValue([
      Date.UTC(2026, 8, 20, 14, 2, 11),
      Date.UTC(2026, 8, 20, 14, 1, 0),
    ]);
    render(
      <StagedFolders
        images={twoFolders}
        sortByCaptureTime
        onToggleSort={noop}
        offsets={{}}
        onOffsetChange={noop}
      />,
    );
    await waitFor(() => expect(screen.getByText("14:02:11")).toBeTruthy());
    expect(invoke).toHaveBeenCalledWith("read_capture_times", {
      paths: ["C:\\shoot\\bodyA\\A1.CR3", "C:\\shoot\\bodyB\\B1.CR3"],
    });
    // The second folder's hint is its signed difference from the first's.
    expect(screen.getByText("\u22121 min 11 s")).toBeTruthy();
  });

  it("steps the offset by a second, a minute with Shift, and back to 0 with Ctrl", async () => {
    vi.mocked(invoke).mockResolvedValue([null, null]);
    const onOffsetChange = vi.fn((_folder: string, _ms: number): void => {});
    render(
      <StagedFolders
        images={twoFolders}
        sortByCaptureTime
        onToggleSort={noop}
        offsets={{ "C:\\shoot\\bodyB": 5000 }}
        onOffsetChange={onOffsetChange}
      />,
    );
    const later = await screen.findByRole("button", { name: "bodyB · later" });
    // fireEvent, not a raw dispatchEvent: it wraps the dispatch in act(), and
    // its init carries the modifier flags the stepper reads.
    fireEvent.click(later);
    expect(onOffsetChange).toHaveBeenLastCalledWith("C:\\shoot\\bodyB", 6000);
    fireEvent.click(later, { shiftKey: true });
    expect(onOffsetChange).toHaveBeenLastCalledWith("C:\\shoot\\bodyB", 65000);
    fireEvent.click(later, { ctrlKey: true });
    expect(onOffsetChange).toHaveBeenLastCalledWith("C:\\shoot\\bodyB", 0);
  });
});
```

- [ ] **Step 2: the component** — create `src/components/StagedFolders.tsx`:

```tsx
import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Img } from "../types";
import {
  formatCaptureClock,
  formatSignedDuration,
  groupStagedFolders,
  stepOffset,
} from "../utils/stagedFolders";

/**
 * The staged screen's capture-time controls: the sort toggle, and — only when
 * the sort is on and two or more folders are staged — one row per folder with
 * its frame count, its first frame's capture time, the signed difference from
 * the FIRST folder's first frame (which usually IS the offset between two
 * bodies), and a stepper.
 *
 * Presentational apart from one probe: it invokes `read_capture_times` with a
 * single representative frame per folder when the rows become visible. Same
 * shape as SettingsDialog's own cache-size read — one screen, one small fetch,
 * no hook to thread through App.
 *
 * Offsets are ORDERING ONLY. Nothing is written to any file, and the info rail
 * keeps showing the camera's own time.
 */
export function StagedFolders({
  images,
  sortByCaptureTime,
  onToggleSort,
  offsets,
  onOffsetChange,
}: {
  images: readonly Img[];
  sortByCaptureTime: boolean;
  onToggleSort: (next: boolean) => void;
  offsets: Readonly<Record<string, number>>;
  /** Absolute srcFolder → the folder's new offset in ms. */
  onOffsetChange: (folderPath: string, ms: number) => void;
}) {
  const folders = useMemo(() => groupStagedFolders(images), [images]);
  // Rows exist only for the two-bodies case: with one folder there is nothing
  // to offset against, and the delta hint would be "+0 s" against itself.
  const showRows = sortByCaptureTime && folders.length >= 2;
  const probePaths = useMemo(
    () => (showRows ? folders.map((f) => f.firstPath) : []),
    [showRows, folders],
  );
  const [firstTimes, setFirstTimes] = useState<readonly (number | null)[]>([]);

  useEffect(() => {
    if (probePaths.length === 0) {
      setFirstTimes([]);
      return;
    }
    let live = true;
    invoke<(number | null)[]>("read_capture_times", { paths: [...probePaths] })
      .then((times) => {
        if (live) setFirstTimes(times);
      })
      .catch(() => {
        // A probe that fails just leaves the rows without their hint — the
        // sort itself does not depend on it.
        if (live) setFirstTimes([]);
      });
    return () => {
      live = false;
    };
  }, [probePaths]);

  const reference = firstTimes[0] ?? null;

  return (
    <div className="cull-staged-sort">
      <button
        type="button"
        className="btn btn--sm cull-staged-sort__toggle"
        aria-pressed={sortByCaptureTime}
        onClick={() => onToggleSort(!sortByCaptureTime)}
        title="Order the shoot by the time each frame was taken, not the time the card wrote it"
      >
        Sort by capture time
      </button>
      {showRows && (
        <ul className="cull-staged-sort__folders" aria-label="Staged folders">
          {folders.map((f, i) => {
            const offset = offsets[f.path] ?? 0;
            const first = firstTimes[i] ?? null;
            const delta = first !== null && reference !== null && i > 0 ? first - reference : null;
            const step = (dir: 1 | -1) => (e: React.MouseEvent) =>
              onOffsetChange(
                f.path,
                stepOffset(offset, dir, { shift: e.shiftKey, reset: e.ctrlKey || e.metaKey }),
              );
            return (
              <li key={f.path} className="cull-staged-sort__row">
                <span className="cull-staged-sort__name" title={f.path}>
                  {f.name}
                </span>
                <span className="cull-staged-sort__count">{f.count}</span>
                <span className="cull-staged-sort__time">
                  {first !== null ? formatCaptureClock(first) : "—"}
                </span>
                <span className="cull-staged-sort__delta">
                  {delta !== null ? formatSignedDuration(delta) : ""}
                </span>
                <span className="cull-staged-sort__stepper">
                  <button
                    type="button"
                    className="btn btn--sm cull-staged-sort__step"
                    onClick={step(-1)}
                    aria-label={`${f.name} · earlier`}
                    title="Click −1 s · Shift-click −1 min · Ctrl-click resets"
                  >
                    −
                  </button>
                  <span className="cull-staged-sort__offset">{formatSignedDuration(offset)}</span>
                  <button
                    type="button"
                    className="btn btn--sm cull-staged-sort__step"
                    onClick={step(1)}
                    aria-label={`${f.name} · later`}
                    title="Click +1 s · Shift-click +1 min · Ctrl-click resets"
                  >
                    +
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 3: its stylesheet** — create `src/styles/staged-sort.css`, per-surface like `home.css` / `grid.css` / `help.css`, tokens only, no keyframes, no class ending in `-key` / `__kbd` (`src/styles/keycap.test.ts:38-44` matches any selector containing those and would start policing this file's typography). The name carries the `-sort` suffix deliberately — `src/styles/stage.css` already exists and is a different surface; see the ruling above:

```css
/* ── staged screen · capture-time sort ────────────────────────
   The toggle and, for two bodies, one row per staged folder. The rows are a
   grid rather than a flex row so the times and offsets line up in columns
   down the list — the whole point of the hint is comparing two numbers. */
.cull-staged-sort {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-4);
  margin-top: var(--sp-5);
}

.cull-staged-sort__folders {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 520px;
  margin: 0;
  padding: 0;
  list-style: none;
  border-top: 1px solid var(--border-soft);
}

.cull-staged-sort__row {
  display: grid;
  grid-template-columns: 1fr 52px 78px 96px auto;
  gap: var(--sp-4);
  align-items: center;
  padding: var(--sp-3) 0;
  border-bottom: 1px solid var(--border-soft);
}

.cull-staged-sort__name {
  overflow: hidden;
  min-width: 0;
  color: var(--text);
  font-size: var(--fs-5);
  white-space: nowrap;
  text-overflow: ellipsis;
}

.cull-staged-sort__count,
.cull-staged-sort__time,
.cull-staged-sort__delta,
.cull-staged-sort__offset {
  color: var(--text-2);
  font-family: var(--font-mono);
  font-size: var(--fs-3);
  font-variant-numeric: tabular-nums;
  text-align: right;
  white-space: nowrap;
}

/* The delta is a HINT at what the offset should be, not a value the user set —
   quieter than the offset it suggests. */
.cull-staged-sort__delta {
  color: var(--muted);
}

.cull-staged-sort__stepper {
  display: inline-flex;
  gap: var(--sp-2);
  align-items: center;
}

/* Square, so a row of two of them reads as one control rather than two
   buttons that happen to sit together. */
.cull-staged-sort__step {
  width: 26px;
  padding: 0;
  font-family: var(--font-mono);
}

.cull-staged-sort__offset {
  min-width: 84px;
  color: var(--text);
}
```

and register it in `src/styles/index.css` — one line, directly after `@import url("./chrome.css");` (`:13`), which is where the rest of the staged screen's styling is imported from, and never after `motion.css` (its reduced-motion overrides must stay last):

```css
@import url("./staged-sort.css");
```

- [ ] **Step 4: App renders it.** In `src/App.tsx`, add `import { StagedFolders } from "./components/StagedFolders";` to the component imports, then insert into the `phase === "staged"` branch (`:1612-1659`), directly after the `{lastIgnored > 0 && …}` block (`:1634-1638`) and before `{scanFailures && …}` (`:1639`):

```tsx
              {images.length > 0 && (
                <StagedFolders
                  images={images}
                  sortByCaptureTime={settings.sortByCaptureTime}
                  onToggleSort={(next) => setSettings({ ...settings, sortByCaptureTime: next })}
                  offsets={settings.captureOffsets}
                  onOffsetChange={(folderPath, ms) =>
                    setSettings({
                      ...settings,
                      captureOffsets: { ...settings.captureOffsets, [folderPath]: ms },
                    })
                  }
                />
              )}
```

- [ ] **Step 5: the analyzing screen stops lying.** Still in `App.tsx`, the `phase === "analyzing"` block's status line (`:1588-1592`) currently prints "reading capture times…" for the DIRECTORY-LISTING pass, which opened no files at all. Now that there is a real capture-time pass, give each phase its own words:

```tsx
                {progress.phase === "restoring"
                  ? "restoring ratings…"
                  : progress.phase === "done"
                    ? "sorting…"
                    : progress.phase === "capturing"
                      ? "reading capture times…"
                      : "listing folders…"}
```

- [ ] **Step 6: pass the sort through.** In `src/app/useSessionLifecycle.ts`, replace the `analyze_folder` invoke (`:417-420`):

```ts
      const result = await invoke<AnalyzeResult>("analyze_folder", {
        paths: images.map((im) => im.path),
        concurrentRestore: profile.concurrentRestore,
        byCaptureTime: settings.sortByCaptureTime,
        // Resolved HERE, per frame, not keyed by folder on the wire: a frame's
        // folder is the folder the USER picked (`srcFolder`), which the
        // recursive walk's parent directory is not, and matching Windows path
        // strings across the IPC boundary would fail silently.
        offsetsMs: settings.sortByCaptureTime
          ? images.map((im) => settings.captureOffsets[im.srcFolder] ?? 0)
          : null,
      });
```

`beginCulling`'s dependency array already lists `settings` whole (`:499`), so nothing changes there. Update the callback's own comment at `:402-403` to `// Begin culling: sort the staged set (EXIF capture time, or each file's write time), restore ratings, then enter the cull view.`

- [ ] **Step 7:** gate green, `pnpm lint:css` included. Commit: `feat(staged): a capture-time sort toggle and per-folder clock offsets`

### Task 10a: Bursts and similar sets survive two interleaved bodies

**Files:** Modify `src/smart/groupBursts.ts`, `src/smart/groupBursts.test.ts`, `src/smart/groupSimilar.ts`, `src/smart/groupSimilar.test.ts`, `src/components/strip/burstSegments.ts` (doc only).

**Interfaces:** none change. `groupBursts`' and `groupSimilar`'s signatures, `BurstCtx` / `SimilarCtx`, and the group ids' meaning (session-global, 0-based, assigned in flush order) are all as they are. **What DOES change is an unwritten invariant: a group's members are no longer guaranteed contiguous in session order.** Task 10b fixes the one consumer that assumed they were.

**Why:** `groupBursts` walks the session order with ONE `prev` and ONE `run`, and `extendsRun` refuses a folder change (`groupBursts.ts:62`). `groupSimilar` has the identical shape — one shared `prev`, and a `prev.img.srcFolder === img.srcFolder` gate inlined in its link test (`groupSimilar.ts:135-155`). Today the session order is mtime-concatenated per folder, so runs never meet a foreign frame. The moment the order is true capture time, two bodies shooting the same moment interleave A,B,A,B — and every switch breaks both runs, collapsing two simultaneous bursts (and two simultaneous look-alike sets) into singletons. Both walks become per-folder over the global order: a run continues across foreign frames, group ids stay session-global.

- [ ] **Step 1: failing tests.** Append to `src/smart/groupBursts.test.ts`, inside the existing `describe("groupBursts", …)` (its `input()` and `img()` helpers are already in scope):

```ts
  test("two bodies interleaved by capture time keep BOTH their bursts", () => {
    // A,B,A,B — what a true capture-time sort produces when two cameras shoot
    // the same moment. Before the per-folder walk this collapsed to nothing.
    const images = [
      img(1, "/shoot/a"),
      img(2, "/shoot/b"),
      img(3, "/shoot/a"),
      img(4, "/shoot/b"),
    ];
    const inputs = {
      1: input(0),
      2: input(0, { srcFolder: "/shoot/b" }),
      3: input(1),
      4: input(1, { srcFolder: "/shoot/b" }),
    };
    const ctx = groupBursts(images, inputs);
    expect(ctx.get(1)!.len).toBe(2);
    expect(ctx.get(3)!.len).toBe(2);
    expect(ctx.get(2)!.len).toBe(2);
    expect(ctx.get(4)!.len).toBe(2);
    expect(ctx.get(1)!.group).toBe(ctx.get(3)!.group);
    expect(ctx.get(2)!.group).toBe(ctx.get(4)!.group);
    // Group ids stay session-global: two runs, two distinct ids.
    expect(ctx.get(1)!.group).not.toBe(ctx.get(2)!.group);
  });

  test("the cadence gate measures between SAME-FOLDER neighbours, not list neighbours", () => {
    // The foreign frame in the middle carries a cadence that would look like a
    // burst against either of its list neighbours; the gate must ignore it and
    // compare frames 1 and 3, which are 83ms apart.
    const images = [img(1, "/shoot/a"), img(2, "/shoot/b"), img(3, "/shoot/a")];
    const inputs = {
      1: input(0),
      2: input(0, { srcFolder: "/shoot/b", capturedAtMs: 1_000_040 }),
      3: input(1),
    };
    const ctx = groupBursts(images, inputs);
    expect(ctx.get(1)!.len).toBe(2);
    expect(ctx.get(3)!.len).toBe(2);
    expect(ctx.get(2)).toBeUndefined(); // lone frame in its own folder
  });

  test("a foreign frame does NOT weld two same-folder frames that are not a burst", () => {
    // Skipping over the foreign frame must not also skip the cadence check:
    // frames 1 and 3 are 5 seconds apart and stay two lone frames.
    const images = [img(1, "/shoot/a"), img(2, "/shoot/b"), img(3, "/shoot/a")];
    const inputs = {
      1: input(0),
      2: input(0, { srcFolder: "/shoot/b" }),
      3: input(0, { capturedAtMs: 1_005_000, mtimeMs: 2_005_000 }),
    };
    expect(groupBursts(images, inputs).size).toBe(0);
  });

  test("a frame with no input walls off ITS OWN folder's run, not the other body's", () => {
    const images = [
      img(1, "/shoot/a"),
      img(2, "/shoot/b"),
      img(3, "/shoot/b"),
      img(4, "/shoot/a"),
    ];
    // Frame 2 (folder b) has no input; a and b are both cadence-tight.
    const inputs = {
      1: input(0),
      3: input(1, { srcFolder: "/shoot/b" }),
      4: input(1),
    };
    const ctx = groupBursts(images, inputs);
    // Vitest's message goes in `expect`, never in the matcher — `toBe` takes
    // exactly one argument (@vitest/expect), so a second one is TS2554.
    expect(ctx.get(1)!.len, "folder a's run survives the foreign gap").toBe(2);
    expect(ctx.get(4)!.len).toBe(2);
    expect(ctx.get(3)).toBeUndefined(); // folder b's run was walled off
  });
```

Run them: the first three fail (every run collapses at a folder switch).

- [ ] **Step 2: implement.** Replace `groupBursts`'s body (`src/smart/groupBursts.ts:99-141`) with the per-folder walk. `extendsRun` and every gate in it are untouched:

```ts
  const out = new Map<number, BurstCtx>();
  let groupId = 0;

  /**
   * Walk state PER SOURCE FOLDER. The session order is capture time, so two
   * bodies shooting the same moment interleave frame by frame — with one
   * shared `prev` every switch broke both runs and two simultaneous bursts
   * collapsed into singletons. A run now continues across foreign-folder
   * frames; the gates (including the srcFolder one, which can no longer fire)
   * are unchanged, and group ids stay session-global.
   */
  type Walk = { run: { id: number }[]; prev: { img: Img; input: BurstInput } | null };
  const walks = new Map<string, Walk>();

  const flush = (w: Walk) => {
    if (w.run.length >= 2) {
      const ids = w.run.map((r) => r.id);
      const { winnerIdx: wi, winnerAf } = pickWinner(ids, sharp, eligible);
      w.run.forEach((r, i) => {
        out.set(r.id, {
          group: groupId,
          pos: i + 1,
          len: w.run.length,
          isWinner: i === wi,
          marginToWinner: wi >= 0 && i !== wi ? winnerAf - sharp![r.id].afSharpness : 0,
        });
      });
      groupId += 1;
    }
    w.run = [];
  };

  for (const img of images) {
    let w = walks.get(img.srcFolder);
    if (!w) {
      w = { run: [], prev: null };
      walks.set(img.srcFolder, w);
    }
    const input = inputs[img.id];
    if (!input) {
      // A frame without usable inputs is a transparent wall for ITS OWN
      // folder only — the other body's run is none of its business.
      flush(w);
      w.prev = null;
      continue;
    }
    const cur = { img, input };
    if (w.prev && extendsRun(w.prev, cur)) {
      w.run.push({ id: img.id });
    } else {
      flush(w);
      w.run = [{ id: img.id }];
    }
    w.prev = cur;
  }
  // Map iteration is insertion order, so the trailing flushes are
  // deterministic: folders get their last group ids in first-seen order.
  for (const w of walks.values()) flush(w);
  return out;
```

Add one line to `extendsRun`'s `srcFolder` gate (`:62`) so the next reader knows it is now an invariant rather than a live branch:

```ts
  // Invariant since the per-folder walk below: prev and cur always share a
  // folder. Kept as a gate so the function stays correct on its own terms.
  if (prev.img.srcFolder !== cur.img.srcFolder) return false;
```

- [ ] **Step 3: failing tests for `groupSimilar`.** Append to `src/smart/groupSimilar.test.ts`, inside its existing `describe("groupSimilar", …)` (the `input(t, over)`, `img`, `NO_BURSTS` and `NO_SCORES` helpers are already in scope; the file imports `describe, expect, test`):

```ts
  test("two bodies interleaved by capture time keep BOTH their similar sets", () => {
    const images = [
      img(1, "/shoot/a"),
      img(2, "/shoot/b"),
      img(3, "/shoot/a"),
      img(4, "/shoot/b"),
    ];
    const inputs = {
      1: input(0, { phash: "0000000000000000" }),
      2: input(0, { phash: "ffffffffffffffff" }),
      3: input(1000, { phash: "0000000000000003" }), // hamming 2 from #1
      4: input(1000, { phash: "ffffffffffffffff" }), // identical to #2
    };
    const out = groupSimilar(images, inputs, NO_SCORES, NO_BURSTS, {}, {});
    expect(out.get(1)?.group).toBe(out.get(3)?.group);
    expect(out.get(2)?.group).toBe(out.get(4)?.group);
    expect(out.get(1)?.group).not.toBe(out.get(2)?.group);
    expect(out.get(1)?.len).toBe(2);
    expect(out.get(2)?.len).toBe(2);
  });

  test("a foreign frame does NOT weld two same-folder frames that are not alike", () => {
    // Skipping the foreign frame must not also skip the link test.
    const images = [img(1, "/shoot/a"), img(2, "/shoot/b"), img(3, "/shoot/a")];
    const inputs = {
      1: input(0, { phash: "0000000000000000" }),
      2: input(0, { phash: "0000000000000001" }),
      3: input(1000, { phash: "ffffffffffffffff" }), // far from #1
    };
    expect(groupSimilar(images, inputs, NO_SCORES, NO_BURSTS, {}, {}).size).toBe(0);
  });

  test("a burst member still walls off ITS OWN folder's run, not the other body's", () => {
    const images = [
      img(1, "/shoot/a"),
      img(2, "/shoot/b"),
      img(3, "/shoot/b"),
      img(4, "/shoot/a"),
    ];
    const inputs = {
      1: input(0, { phash: "0000000000000000" }),
      2: input(0, { phash: "ffffffffffffffff" }),
      3: input(1000, { phash: "ffffffffffffffff" }),
      4: input(1000, { phash: "0000000000000003" }),
    };
    // Frame 3 is a burst member -> folder b's run is walled; folder a's is not.
    const bursts: ReadonlyMap<number, BurstCtx> = new Map([
      [3, { group: 0, pos: 1, len: 2, isWinner: false, marginToWinner: 0 }],
    ]);
    const out = groupSimilar(images, inputs, NO_SCORES, bursts, {}, {});
    expect(out.get(1)?.len, "folder a's run survives the foreign gap").toBe(2);
    expect(out.get(4)?.len).toBe(2);
    expect(out.has(2)).toBe(false);
    expect(out.has(3)).toBe(false);
  });
```

- [ ] **Step 4: the same walk in `groupSimilar`.** Replace `src/smart/groupSimilar.ts:114-158` (from `const out = …` to the closing `return out;`) with the per-folder form. `linked`, `SIMILAR_WINDOW_MS` and every gate are untouched:

```ts
  const out = new Map<number, SimilarCtx>();
  let groupId = 0;

  /**
   * Walk state PER SOURCE FOLDER — the same shape, and for the same reason,
   * as groupBursts': a capture-time session order interleaves two bodies
   * frame by frame, and one shared `prev` made every switch break both runs.
   */
  type Walk = { run: number[]; prev: { img: Img; input: SimilarInput } | null };
  const walks = new Map<string, Walk>();

  const flush = (w: Walk) => {
    if (w.run.length >= 2) {
      const { winnerIdx: wi, winnerAf } = pickWinner(w.run, sharp, eligible);
      w.run.forEach((id, i) => {
        out.set(id, {
          group: groupId,
          pos: i + 1,
          len: w.run.length,
          isWinner: i === wi,
          marginToWinner: wi >= 0 && i !== wi ? winnerAf - sharp[id].afSharpness : 0,
        });
      });
      groupId += 1;
    }
    w.run = [];
  };

  for (const img of images) {
    let w = walks.get(img.srcFolder);
    if (!w) {
      w = { run: [], prev: null };
      walks.set(img.srcFolder, w);
    }
    const input = inputs[img.id];
    // Transparent walls: no standing input yet, and burst members, both split
    // — but ONLY their own folder's run.
    if (!input || bursts.has(img.id)) {
      flush(w);
      w.prev = null;
      continue;
    }
    const embCur = scores[img.id]?.embedding ?? null;
    if (
      w.prev &&
      // Invariant since the per-folder walk: prev and img always share a
      // folder. Kept so the condition stays correct on its own terms.
      w.prev.img.srcFolder === img.srcFolder &&
      linked(w.prev.input, input, scores[w.prev.img.id]?.embedding ?? null, embCur)
    ) {
      if (w.run.length === 0) w.run = [w.prev.img.id];
      w.run.push(img.id);
    } else {
      flush(w);
    }
    w.prev = { img, input };
  }
  // Map iteration is insertion order, so the trailing flushes are
  // deterministic: folders get their last group ids in first-seen order.
  for (const w of walks.values()) flush(w);
  return out;
```

- [ ] **Step 5: the strip's doc stops claiming contiguity.** In `src/components/strip/burstSegments.ts`, replace the doc paragraph at `:27-34`'s middle clause — "the loupe strip passes every image (runs come out contiguous), the compare strip passes the candidate SUBSET, where a run interrupted by filtered-out frames yields one segment per contiguous stretch (the first labeled)" — with:

```
 * items in display order. A run can be interrupted in BOTH strips now: the
 * compare strip passes the candidate SUBSET, and since the per-folder burst
 * walk (groupBursts) a group's members need not be contiguous in session
 * order at all — two bodies interleaved by capture time put another body's
 * frames between them. Either way the group yields one segment per
 * contiguous stretch, the first labeled. Also builds the gap prefix
```

No code changes here: `computeBurstSegments` already splits on contiguity (`:55-78`), `BurstBoxes.tsx:18`'s `${kind}-${group}-${start}` key stays unique, and the `BURST_BREATH` prefix maths just inserts more air.

- [ ] **Step 6:** run `pnpm test src/smart` and confirm **every** pre-existing `groupBursts` and `groupSimilar` test is still green, unedited — in particular `groupBursts`' "same cadence in a DIFFERENT srcFolder never groups" and "a frame with no input splits the run" (all four frames share `/shoot/a`, so that walk is identical to today's), and `groupSimilar`'s "different srcFolder never groups" (`:143`) and "adjacency chaining: a stray frame splits the group in two" (`:80`, one folder throughout).
- [ ] **Step 7:** gate green. Commit: `fix(smart): walk bursts and similar sets per source folder so interleaved bodies keep their runs`

### Task 10b: The grid's group brackets follow contiguity, not min-to-max

**Files:** Create `src/components/gridBurstSegments.ts`, `src/components/gridBurstSegments.test.ts`. Modify `src/components/GridView.tsx`.

**Interfaces — Produces:**

```ts
// src/components/gridBurstSegments.ts
export type GridCell = { idx: number; row: number; col: number };
export type GridGroupHit = { c: BurstCtx; kind: "burst" | "similar" };
export type GridBurstSegment = {
  key: string;
  row: number;
  /** Inclusive column span of ONE contiguous stretch. */
  c0: number;
  c1: number;
  label: number | null;
  openLeft: boolean;
  openRight: boolean;
  kind: "burst" | "similar";
};
export function computeGridBurstSegments(
  cells: readonly GridCell[],
  hitFor: (idx: number) => GridGroupHit | undefined,
): GridBurstSegment[];
```

**Consumes:** `BurstCtx` from `../smart/groupBursts`. Nothing else in 3C owns `GridView.tsx` — Tasks 2 and 9 own `App.tsx`, which is a different file.

**Why:** `GridView.tsx:275-321` keys its segments `${kind}:${group}:${row}` and then accumulates `c0 = Math.min(c0, col)` / `c1 = Math.max(c1, col)`, drawing ONE box from the group's leftmost to its rightmost column in that row. That was exact while a group's members were contiguous. After Task 10a they need not be: with two bodies interleaved by capture time, body A's members sit at columns 0 and 2, and A's bracket visually encloses column 1 — a frame from body B. Two groups in the same row also overlap. The membership itself (`pos` / `len` / winner) is right; only the span lies.

**Ruling (the label rule does NOT change).** `strip/burstSegments.ts:69` labels the group's first segment *in display order*; the grid labels the stretch containing the run's **first frame** (`c.pos === 1`). Matching the strip would change what a single-folder shoot draws whenever a burst's first frame is filtered out of the grid, and the brief's own requirement is that nothing changes for single-folder shoots. The grid keeps its rule; the difference is recorded in the new module's doc comment.

- [ ] **Step 1: failing test** — create `src/components/gridBurstSegments.test.ts` (node env):

```ts
import { describe, expect, it } from "vitest";
import { computeGridBurstSegments, type GridCell, type GridGroupHit } from "./gridBurstSegments";
import type { BurstCtx } from "../smart/groupBursts";

const ctx = (group: number, pos: number, len: number): BurstCtx => ({
  group,
  pos,
  len,
  isWinner: false,
  marginToWinner: 0,
});
/** Cells of one row, left to right — what GridView generates. */
const row = (r: number, n: number, from = 0): GridCell[] =>
  Array.from({ length: n }, (_, i) => ({ idx: from + i, row: r, col: i }));
/** Look a cell's group up from a plain idx -> hit map. */
const hits =
  (m: Record<number, GridGroupHit>) =>
  (idx: number): GridGroupHit | undefined =>
    m[idx];

describe("computeGridBurstSegments", () => {
  it("draws ONE box for a contiguous run — today's output, unchanged", () => {
    const segs = computeGridBurstSegments(
      row(0, 4),
      hits({
        1: { c: ctx(0, 1, 3), kind: "burst" },
        2: { c: ctx(0, 2, 3), kind: "burst" },
        3: { c: ctx(0, 3, 3), kind: "burst" },
      }),
    );
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({
      row: 0,
      c0: 1,
      c1: 3,
      label: 3,
      openLeft: false,
      openRight: false,
      kind: "burst",
    });
  });

  it("splits two interleaved bodies into one box per contiguous stretch", () => {
    // A,B,A,B in one row: neither group may span the other's cell.
    const segs = computeGridBurstSegments(
      row(0, 4),
      hits({
        0: { c: ctx(0, 1, 2), kind: "burst" },
        1: { c: ctx(1, 1, 2), kind: "burst" },
        2: { c: ctx(0, 2, 2), kind: "burst" },
        3: { c: ctx(1, 2, 2), kind: "burst" },
      }),
    );
    expect(segs).toHaveLength(4);
    for (const s of segs) expect(s.c0).toBe(s.c1);
    expect(segs.map((s) => s.c0)).toEqual([0, 1, 2, 3]);
    // No two boxes overlap, and each group's ends are open where its run
    // continues elsewhere.
    expect(segs[0]).toMatchObject({ label: 2, openLeft: false, openRight: true });
    expect(segs[2]).toMatchObject({ label: null, openLeft: true, openRight: false });
    // Keys stay unique, or React renders one box and drops the rest.
    expect(new Set(segs.map((s) => s.key)).size).toBe(4);
  });

  it("keeps a run that wraps a row as one box per row, each open at the seam", () => {
    const cells = [...row(0, 2, 0), ...row(1, 2, 2)];
    const segs = computeGridBurstSegments(
      cells,
      hits({
        0: { c: ctx(0, 1, 4), kind: "burst" },
        1: { c: ctx(0, 2, 4), kind: "burst" },
        2: { c: ctx(0, 3, 4), kind: "burst" },
        3: { c: ctx(0, 4, 4), kind: "burst" },
      }),
    );
    expect(segs).toHaveLength(2);
    expect(segs[0]).toMatchObject({ row: 0, c0: 0, c1: 1, openLeft: false, openRight: true });
    expect(segs[1]).toMatchObject({ row: 1, c0: 0, c1: 1, openLeft: true, openRight: false });
  });

  it("separates a burst from a similar set that happen to share a group number", () => {
    const segs = computeGridBurstSegments(
      row(0, 2),
      hits({
        0: { c: ctx(0, 1, 1), kind: "burst" },
        1: { c: ctx(0, 1, 1), kind: "similar" },
      }),
    );
    expect(segs.map((s) => s.kind)).toEqual(["burst", "similar"]);
    expect(new Set(segs.map((s) => s.key)).size).toBe(2);
  });

  it("is empty when nothing is grouped", () => {
    expect(computeGridBurstSegments(row(0, 3), hits({}))).toEqual([]);
  });
});
```

- [ ] **Step 2: the pure module** — create `src/components/gridBurstSegments.ts`:

```ts
import type { BurstCtx } from "../smart/groupBursts";

/**
 * Where the grid draws its burst / similar brackets — the vertical sibling of
 * `strip/burstSegments.ts` (same contract: pure, no DOM, unit-tested).
 *
 * ONE BOX PER CONTIGUOUS STRETCH, never min-to-max. A group's members used to
 * be contiguous in session order, so a row's leftmost and rightmost member
 * bounded a solid block; since the per-folder walk in `groupBursts` /
 * `groupSimilar` two bodies interleaved by capture time put another body's
 * frames between them, and a min-to-max box would enclose frames that are not
 * in the group.
 *
 * The LEGEND rule is the grid's own and deliberately differs from the strip's:
 * the strip labels a group's first segment in display order, the grid labels
 * the stretch containing the run's FIRST FRAME (`pos === 1`), so a run whose
 * opening frame the filter hides draws no ×N at all. Unchanged here — the
 * point of this module is the span, not the label.
 */

/** One rendered cell, as GridView generates them: row-major, columns 0..n-1
 *  with no gaps within a row. */
export type GridCell = { idx: number; row: number; col: number };

/** A cell's group membership, already resolved by kind (bursts win). */
export type GridGroupHit = { c: BurstCtx; kind: "burst" | "similar" };

export type GridBurstSegment = {
  /** React key. Carries `c0` because one (kind, group, row) can now yield
   *  several stretches — without it React renders one box and drops the rest. */
  key: string;
  row: number;
  /** Inclusive column span of ONE contiguous stretch. */
  c0: number;
  c1: number;
  /** The run's total length, on the stretch holding its first frame; else null. */
  label: number | null;
  /** The run continues before / after this stretch (another row, another
   *  stretch, or off-screen): that edge renders OPEN. */
  openLeft: boolean;
  openRight: boolean;
  kind: "burst" | "similar";
};

export function computeGridBurstSegments(
  cells: readonly GridCell[],
  hitFor: (idx: number) => GridGroupHit | undefined,
): GridBurstSegment[] {
  const out: GridBurstSegment[] = [];
  let open: (GridBurstSegment & { firstPos: number; lastPos: number; len: number }) | null = null;
  let openKey: string | null = null;

  const close = () => {
    if (!open) return;
    out.push({
      key: open.key,
      row: open.row,
      c0: open.c0,
      c1: open.c1,
      label: open.label,
      openLeft: open.firstPos > 1,
      openRight: open.lastPos < open.len,
      kind: open.kind,
    });
    open = null;
    openKey = null;
  };

  for (const cell of cells) {
    const hit = hitFor(cell.idx);
    if (!hit) {
      close();
      continue;
    }
    const key = `${hit.kind}:${hit.c.group}`;
    // Contiguous means: same row, same group, and the very next column. Cells
    // arrive row-major with no gaps inside a row, so the column test is what
    // catches a foreign frame sitting between two members.
    const extends_ = open !== null && openKey === key && open.row === cell.row && cell.col === open.c1 + 1;
    if (!extends_) close();
    if (open === null) {
      open = {
        key: `${key}:${cell.row}:${cell.col}`,
        row: cell.row,
        c0: cell.col,
        c1: cell.col,
        label: hit.c.pos === 1 ? hit.c.len : null,
        firstPos: hit.c.pos,
        lastPos: hit.c.pos,
        len: hit.c.len,
        openLeft: false,
        openRight: false,
        kind: hit.kind,
      };
      openKey = key;
    } else {
      open.c1 = cell.col;
      if (hit.c.pos === 1) open.label = hit.c.len;
      open.firstPos = Math.min(open.firstPos, hit.c.pos);
      open.lastPos = Math.max(open.lastPos, hit.c.pos);
    }
  }
  close();
  return out;
}
```

- [ ] **Step 3: GridView calls it.** In `src/components/GridView.tsx`, delete the whole `type Seg = {…}` declaration and the `const burstSegs … if (bursts || similar) {…}` block (`:257-322`, from the `// Burst run boxes` comment down to the closing brace before `return (`) and replace it with:

```tsx
  // Burst / similar boxes, one per CONTIGUOUS stretch of a group's cells in a
  // row (see components/gridBurstSegments — a group's members need not be
  // adjacent since the per-folder walk). The ×N legend rides the stretch
  // holding the run's first frame.
  const burstSegs =
    bursts || similar
      ? computeGridBurstSegments(cells, (idx) => {
          const id = images[idx].id;
          const b = bursts?.get(id);
          if (b) return { c: b, kind: "burst" as const };
          const s = similar?.get(id);
          return s ? { c: s, kind: "similar" as const } : undefined;
        })
      : [];
```

and add the import beside the existing `./gridWindow` one (`GridView.tsx:11`):

```ts
import { computeGridBurstSegments } from "./gridBurstSegments";
```

The render block at `:357-…` is untouched: it reads `s.key`, `s.row`, `s.c0`, `s.c1`, `s.label`, `s.openLeft`, `s.openRight`, `s.kind`, all of which the new type carries with the same meaning. `key={`burst-${s.key}`}` stays as it is — the key's *shape* changed (it gained the start column), but it is a React key and nothing else reads it.

- [ ] **Step 4:** gate green, and confirm `src/components/gridWindow.test.ts` and `src/components/GridCell.layers.test.tsx` are untouched and still pass. Commit: `fix(ui): the grid's group brackets follow contiguity instead of spanning min to max`

### Task 11: The help sheet, the docs, and the final gate

**Files:** Modify `src/components/HelpOverlay.tsx`, `src/components/HelpOverlay.test.tsx`, `README.md`, `ARCHITECTURE.md`, `TESTING.md`.

**Interfaces — Consumes:** everything. This is the one task that owns `HelpOverlay.tsx` and `README.md`, so the new navigation keys and the `1`–`5` filter row land together and neither file has two owners.

- [ ] **Step 1: failing test.** Edit the existing assertion in `src/components/HelpOverlay.test.tsx:41-46` — `["1", "4"]` becomes `["1", "5"]` — and append:

```tsx
  test("the loupe teaches the new jump keys", () => {
    const { container } = render(<HelpOverlay mode="loupe" />);
    expect(caps(rowFor(container, "First / last"))).toEqual(["Home", "End"]);
    expect(caps(rowFor(container, "Jump one strip"))).toEqual(["PgUp", "PgDn"]);
  });

  test("the grid teaches the screenful and both extend forms", () => {
    const { container } = render(<HelpOverlay mode="grid" />);
    expect(caps(rowFor(container, "First / last"))).toEqual(["Home", "End"]);
    expect(caps(rowFor(container, "One screen"))).toEqual(["PgUp", "PgDn"]);
    expect(caps(rowFor(container, "Extend selection to edge"))).toEqual(["Shift", "Home", "End"]);
    expect(caps(rowFor(container, "Extend selection one screen"))).toEqual([
      "Shift",
      "PgUp",
      "PgDn",
    ]);
  });

  test("compare gets the page keys only — Home / End are loupe and grid", () => {
    const { container } = render(<HelpOverlay mode="compare" />);
    expect(caps(rowFor(container, "Jump one strip"))).toEqual(["PgUp", "PgDn"]);
    expect(() => rowFor(container, "First / last")).toThrow();
  });
```

- [ ] **Step 2: the rows.** In `src/components/HelpOverlay.tsx`, three edits. Loupe's `navigate` group (`:36-52`) — insert after the `Shift`+`Space` row (`:46`) and before the filter row:

```tsx
          { keys: ["Home", "End"], desc: "First / last in the filter" },
          { keys: ["PgUp", "PgDn"], desc: "Jump one strip-width" },
```

and change the filter row's `keys` and `desc` (`:47-51`):

```tsx
          {
            keys: ["1", "5"],
            range: true,
            desc: "Filter: all / unrated / keeps / smart / rejects  (repeat to cycle sub-modes)",
          },
```

Compare's `navigate` group (`:86-92`) — insert after the `Shift`+`Space` row (`:90`):

```tsx
          { keys: ["PgUp", "PgDn"], desc: "Jump one strip-width" },
```

Grid's `navigate` group (`:124-142`) — insert after the `mod`+`0` row (`:130`) and before the filter row:

```tsx
        { keys: ["Home", "End"], desc: "First / last in the filter" },
        { keys: ["PgUp", "PgDn"], desc: "One screen" },
```

change the grid filter row the same way as the loupe's (`:131-135`), and insert after the existing `Shift`+arrows "Grow selection" row (`:138`):

```tsx
        { keys: ["Shift", "Home", "End"], desc: "Extend selection to edge" },
        { keys: ["Shift", "PgUp", "PgDn"], desc: "Extend selection one screen" },
```

`KeyCombo` renders raw labels, so `"Home"` / `"End"` / `"PgUp"` / `"PgDn"` need no mapping. Both new Shift rows are three caps, under `HelpOverlay.tsx:197`'s `> 3` split threshold, so each renders as one combo.

- [ ] **Step 3: `README.md` → the cheat sheet.** Insert four rows after line 188 (`| \`↑ ↓\` …`) and before the `+` / `−` row:

```
| `home` `end` | first / last in filter | —         | first / last in filter |
| `pgup` `pgdn` | jump one strip-width | jump one strip-width | one screen        |
| `shift+home` / `shift+end` | — | —                | extend selection to edge |
| `shift+pgup` / `shift+pgdn` | — | —               | extend selection one screen |
```

and change line 200's filter row to:

```
| `1 – 5`    | filter tabs (all / unrated / keeps / smart / rejects); re-press cycles sub-modes (keeps→★, smart→rejects/keeps/favs) | — | same |
```

- [ ] **Step 4: `README.md` → Settings.** In the `## Settings` list (`:227-244`), add one bullet after the **Grid size** one (`:239-240`):

```
- **Capture-time order** — the staged screen's "Sort by capture time" toggle
  (on by default) puts the shoot in EXIF `DateTimeOriginal` order instead of
  file-write order, and, when two or more folders are staged, gives each
  folder a ± clock offset for a second body whose clock is off. Ordering only
  — nothing is written to any file.
```

- [ ] **Step 5: `ARCHITECTURE.md` → a session-order section.** Add a new `## Session order` section directly before `## Read pipeline` (`:18`), covering: the set is concatenated folder by folder at stage time (`openFoldersByPaths`, ids assigned at append and stable for the session — `types/image.ts:1-5`), and re-sorted **globally once**, at Begin culling, by `analyze_folder`; the key is each frame's EXIF `DateTimeOriginal` + `SubSecTimeOriginal` when `sortByCaptureTime` is on, falling back per frame to that file's mtime and then to path order (`scan.rs`'s `capture_epoch` → the unchanged `order_by_capture`); a thumb-tier cache hit answers the time with zero source round-trips, so re-opening a shoot is free; per-folder offsets are resolved on the TS side into a per-frame vector, apply to whichever epoch a frame got, and are ordering-only; and **why the sort never runs mid-cull** — `currentIndex`, `championIndex`, `challengerIndex`, `selectedIndices`, `selectionAnchor`, `visibleIndices`, `NavEntry`, GridView's window math and `imageStore`'s ordered `paths` + `pathIndex` are all index-keyed, and Begin culling is the one moment `setImages` + `imageStore.reset` + `overlayService.reset` already happen together.
- [ ] **Step 6: `ARCHITECTURE.md` → filters, groups and keys.** Three smaller edits: in the smart-culling section (`:356-393`), one sentence distinguishing the `rejects` filter (the user's own verdict, the pile "move rejects" takes) from `suggestedRejects` (an unrated frame the pass flagged), and one recording the invariant 3C broke — `groupBursts` / `groupSimilar` walk **per source folder** over the global order, so a group's members are no longer contiguous in session order, and every consumer that draws a bracket (the two strips' `burstSegments.ts`, the grid's `gridBurstSegments.ts`) segments by contiguity; and, in the **Design language** section's modifier-key bullet neighbourhood (`:505-543`), one sentence that `Home` / `End` / `PgUp` / `PgDn` move the cursor within the ACTIVE FILTER, that Shift extends the grid selection to the same target, and that a page is a measured screenful of the surface under the cursor (`src/utils/pageStep.ts`), never a burst.
- [ ] **Step 7: `TESTING.md`.** Two additions. Under **Stylesheet guards** (`:49`), one sentence that `layout.test.ts`'s tier slices are keyed to exactly three footer breakpoints, so a new one breaks them and 3C therefore added rules to the existing `< 1360` tier instead. Under **Env-var-gated corpus tests** (`:85`), one sentence that `cr3::read_capture_time` is covered by a SYNTHETIC CR3 head assembled in `cr3.rs`'s own test module (ftyp + moov > uuid > CMT2 with a hand-built little-endian TIFF), so the parser's whole path runs in CI with no corpus — the pattern to copy for any future head-only reader. If nothing else in either section changed, say so and leave it.
- [ ] **Step 8: the implementation note.** Append an `## Implementation note (2026-09-20)` section to THIS plan file, in the shape Phase 3B's has (what shipped · where the spec or the plan was wrong and what was ruled instead · verification · Oliver's walk · left for later). Move the `## Pre-flight corrections (2026-09-20)` section's opening paragraph into the note verbatim and add one line per further correction the implementers hit. Oliver's walk must include: `Home` / `End` / `PgUp` / `PgDn` in loupe and grid, `Shift` with each in the grid, the empty Rejects tab on `5`, and Begin culling with the sort on plus the staged-folder rows for two scratch folders.
- [ ] **Step 9: final gate** — `pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm lint:css && pnpm test && pnpm build && pnpm css:census`, plus the Rust three from `src-tauri/`. `css:census` is a starting list, not a verdict: reconcile the new `cull-staged-sort*` names by hand and report the result.
- [ ] **Step 10:** commit: `docs: Phase 3C — navigation keys, the Rejects filter, capture-time order`

---

## Pre-flight corrections (2026-09-20)

Two fresh checkers fact-checked this plan against the code before any of it was executed; every finding below was applied here, so an implementer reads only corrected text. Recorded so the record survives even if the session is interrupted — Task 11 moves this paragraph into the implementation note.

- **The ≥ 1360 footer sums omitted the key hint and its gap, by 86 px.** `.cull-statusbar__keyhint` renders unconditionally (`StatusBar.tsx:271-273`) and only sheds below 1360; it is mono 9 px at 0.2em tracking = 7.2 px × the 10 characters of `TAB · KEYS` = 72, plus one 14 px flex gap. The worst case is **1590.4** with the fifth tab, **1513.2** today — not 1504.4 / 1427.2. Corrected in Task 5's ruling, in its CSS comment and in "Not in this plan". **Ruled: the tier stays at `< 1360px`.** Closing the band needs `< 1620px`, which puts the default 1600 px window inside the shed tier every day to guard four rare states that must all be true at once.
- **The tab-padding override would have resized the sub-mode chips.** `.cull-filter-tab-tooltip button { padding: 3px 7px }` (`chrome.css:508-511`) is only (0,1,1) and wins today on source order alone, so the planned `.cull-statusbar .cull-filter-tabs button` (0,2,1) would have silently beaten it. Replaced with a two-member CHILD-combinator list (`… .cull-filter-tabs > button`, `… .cull-filter-tab-group > button`), which covers exactly the five tabs and no tooltip chip; the guard test pins both members and asserts the tier never names the tooltip class.
- **Task 6 could not pass its own clippy gate.** `mod cr3;` is private, so a `pub fn` with no lib-build caller is dead code under `-D warnings`. Task 6 now adds `#[cfg_attr(not(test), allow(dead_code))]` (precedent `phash.rs:50`) and Task 7 gains a Step 3b that deletes it — the `gridthumb.rs` 8 → 10 dance from Phase 3B. `cr3.rs` is now a Task 7 file, and 6/7 are strictly serial rather than merely ordered.
- **`toBe` takes one argument.** `expect(x).toBe(2, "message")` is TS2554; Vitest's message belongs in `expect`. Fixed in Task 10a's interleaving test.
- **The per-folder walk broke an unwritten invariant, and the plan was silent about it.** Group members are no longer contiguous in session order. `GridView.tsx:275-321` spans a bracket from a group's min to its max column in a row, so two interleaved bodies would each draw a box enclosing the other's frames. Now fixed rather than accepted: **Task 10b** extracts the row segmentation into a pure, tested `components/gridBurstSegments.ts` that emits one box per contiguous stretch (a contiguous run is byte-identical to today's output, pinned by a test). `groupSimilar.ts:135-155` had the identical one-`prev`-plus-`srcFolder`-wall shape and gets the same per-folder walk in **Task 10a**, with the same three kinds of test. `strip/burstSegments.ts`'s "runs come out contiguous" doc is corrected. Task 10 is split 10a / 10b; neither shares a file with the other or with any other task.
- **A fractional stored offset would have failed the whole `analyze_folder` call.** The wire type is Rust `i64`, and serde refuses `1500.7`. `coerceCaptureOffsets` now `Math.round`s after clamping, with a test.
- **`cargo fmt --check` fails on hand-written plan code.** The Global Constraints' Rust gate now runs `cargo fmt` FIRST, and Task 7's one over-long chain (rustfmt's `chain_width` is 60) is pre-wrapped in the plan.
- **The new stylesheet was one letter from an existing one** — and the checker's suggested home was wrong. `.cull-staged__*` live in **`chrome.css:685-733`**, not `stage.css` (which is the loupe photo stage). Folding into `chrome.css` would push it from 778 past the 800-line ceiling AND give Tasks 5 and 9 a shared file. Ruled: a separate sheet, renamed **`staged-sort.css`**, with the reasoning recorded in Task 9.
- **Task 3's "right failure" was wrong for two of its three blocks.** `topOf("rejects")` and `cycleFilter("rejects", <other top>)` already pass at runtime through existing `default` arms; only `typecheck:tests` fails on every line. Reworded so nobody "fixes" `passesFilter` with a `default`.
- **Shift+PgUp / PgDn would have cleared a grid selection** by falling through to the plain branch. They now extend it by a screenful through `growGridSelection(±pageStep())`, mirroring Shift+arrow; help sheet and README rows added, and the `e.repeat` ruling split (guarded for Shift+Home/End, whose step never changes; unguarded for Shift+page, whose every repeat grows).
- **A wrong-length `offsets_ms` vector degraded silently.** `.get(i)` is memory-safe, but nobody would ever learn; Task 7 now logs the mismatch once via `dlog!`.
- **Smaller:** the `stopGridVertHold()` call inside the new Shift cases was dead (`:238-239` has already stopped any held row-jump) and is dropped with a comment saying why; the grid's `clientHeight` includes its own 40 px of vertical padding and the comment now says so; `read_capture_times`' doc says "first STAGED (lexicographically first)" rather than implying earliest; `captureOffsets`' doc records that the key is the verbatim `srcFolder` with no normalisation; Task 4's fixture note no longer claims a test overrides `filter.filter`; README gains four rows, not two; and four line references were off by one or two (`base.css:47-62`, `useSiteNavigation.ts:245-266`, `chrome.css:441` comment + `:443-447` rule, `grid.css:14`) — name-wins per the Global Constraints, corrected anyway.
- **One checker finding rejected:** preflight-b's SHOULD-FIX 6 said `src/styles/stage.css` "already owns `.cull-staged__*`". It does not — `chrome.css` does. The intent (no near-duplicate filename, no maintenance trap) was applied; the named destination was not.

## Not in this plan

- **`stats.rejects`.** Ruled out in Task 4: the four existing tabs have no zero treatment to copy, and the count already reaches `StatusBar` as `session.rejectedCount`. A second copy would be a dead field.
- **`rejects` as a `defaultFilter`.** `useSettings.ts:13`'s allowlist offers neither `suggested` nor `rejects`; starting a cull inside the reject pile is not a thing anyone wants. The validator is unchanged.
- **A Settings-dialog row for `sortByCaptureTime`.** The toggle lives on the staged screen only — the one moment it matters. `SettingsDialog.tsx` is untouched by 3C.
- **`role="tab"` / `aria-selected` / a roving tabindex on the filter tabs.** A pre-existing gap (`StatusBar.tsx:296-446` renders plain buttons inside a `role="tablist"`). The fifth tab copies its siblings exactly; fixing the pattern is its own change.
- **Home / End in compare.** `cycleChallenger` walks `findUnrated` once per step, so a whole-list step is O(n²) — 17.6 M scans on a 4,194-frame shoot. The two keys are swallowed there and bound in loupe and grid only, which is what the spec's "first / last frame of the active filter" means anyway (the tablist is hidden in compare).
- **PgUp / PgDn as a burst hop.** Spec §A: burst groups are advisory, often absent, and upgrade as scores land, so the same key would move a different distance at different moments. `↓` in the grid and the burst brackets still do that job.
- **A keymap test harness.** `useCullKeymap.ts` has none; the step arithmetic is pure and tested, and the wiring is verified by review (spec §Testing). Building the harness is Phase 4.
- **The footer's ≥ 1360 worst case.** The absolute worst state (all rated + every photo missing + scrubbing at ×10 + the overlay cluster) already overflows from 1360 to **1513.2** on `main`; the fifth tab widens that to **1590.4**. Closing it would mean firing the shed tier at `< 1620px`, which puts the default 1600 px window permanently inside it — losing the key hint, `.CR3`, the save chip's tail, the all-rated finish label and Smart's count every day to guard four rare states that must all be true at once. Priced in Task 5's comment, ruled by the spec ("At 1360 px and wider the footer simply has a fifth tab"), not fixed here.
- **The grid's legend rule is not aligned with the strip's.** `strip/burstSegments.ts` labels a group's first segment in display order; the grid labels the stretch holding the run's first frame, so a burst whose opening frame the filter hides draws no ×N in the contact sheet. Pre-existing, left alone deliberately in Task 10b: changing it would alter what a single-folder shoot draws, which is the one thing that task must not do.
- **Live re-sorting, and sort modes other than capture time.** Everything cursor-shaped is index-keyed; Begin culling is the one safe moment (spec §C, "Out of scope").
- **Automatic clock matching.** It needs content matching to be trustworthy, and a wrong automatic offset is worse than a manual one (spec §C). The staged rows show the signed delta as a *hint*; the user applies it.
- **`OffsetTimeOriginal` / any timezone handling.** Not parsed anywhere in the backend, not needed: all times are the cameras' local wall clocks compared with each other, and the sort lives in Rust, never in `Date.parse`.
- **Cancelling the capture pass.** `analyze_folder` holds a `SessionGate` but has never used it for cancellation; the capture pass follows the existing behaviour. A user who wants out closes the dialog after it finishes.
- **A tier-cache read inside `read_capture_times`.** N is the number of staged folders (one or two), so wiring the cache into the probe would cost more than the reads it saves.
- **Stars and colour labels** (Phase 5), **installers and CI work** (Phase 4).

## Parallelism map

The controller runs implementers in parallel **only** on disjoint file sets. Wave = everything in the row may run concurrently.

| Wave | Task | Files it owns | May run with | Must follow |
| --- | --- | --- | --- | --- |
| 1 | **1** Page-step maths | `utils/pageStep.ts`(new)+test, `components/strip/useStripMetrics.ts`, `components/strip/PhotoStrip.metrics.test.tsx` | 3, 6, 8, 10 | — |
| 1 | **3** The `rejects` value | `types/rating.ts`, `utils/filterModes.ts`+test, `utils/filter.ts`+test | 1, 6, 8, 10 | — |
| 1 | **6** Rust `read_capture_time` | `src-tauri/src/cr3.rs` | 1, 3, 8, 10 | — |
| 1 | **8** Settings + staged maths | `types/settings.ts`, `hooks/useSettings.ts`+test, `utils/stagedFolders.ts`(new)+test | 1, 3, 6, 10 | — |
| 1 | **10a** Per-folder burst + similar walks | `smart/groupBursts.ts`+test, `smart/groupSimilar.ts`+test, `components/strip/burstSegments.ts` (doc) | 1, 3, 6, 8, 10b | — |
| 1 | **10b** Grid brackets by contiguity | `components/gridBurstSegments.ts`(new)+test, `components/GridView.tsx` | 1, 3, 6, 8, 10a | — (no shared file with 10a; ships correct for today's data too) |
| 2 | **2** The four keys | `App.tsx`, `app/useCullKeymap.ts` | 5, 7 | 1 |
| 2 | **7** Rust `analyze_folder` | `src-tauri/src/scan.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/cr3.rs`‡ | 2, 4, 5 | 6 |
| 2 | **4** Rejects tab + key `5` | `components/StatusBar.tsx`, `components/StatusBar.shed.test.tsx`, `components/EmptyFilter.tsx`, `app/useCullKeymap.ts`† | 7 | 3, **2** (`useCullKeymap.ts`) |
| 3 | **5** The footer budget | `styles/statusbar.css`, `styles/chrome.css`, `styles/layout.test.ts` | 2, 7, 9 | 4 |
| 3 | **9** The staged screen | `components/StagedFolders.tsx`(new)+test, `styles/staged-sort.css`(new), `styles/index.css`, `App.tsx`, `app/useSessionLifecycle.ts` | 5 | 7, 8, **2** (`App.tsx`) |
| 4 | **11** Help, README, docs, final gate | `components/HelpOverlay.tsx`, `components/HelpOverlay.test.tsx`, `README.md`, `ARCHITECTURE.md`, `TESTING.md` | — | everything |

† Task 4 edits `useCullKeymap.ts` only to add the `case "5":` block, in the same switch Task 2 adds four cases to. If the controller would rather keep those two apart, hand Task 4's Step 4 to Task 2 instead and say so — but Task 2 then also has to follow Task 3, because `cycleFilter(f, "rejects")` does not compile until the union is widened.

‡ Task 7's only edit to `cr3.rs` is deleting the `#[cfg_attr(not(test), allow(dead_code))]` Task 6 added (Step 3b). Task 6 needs it (a `pub fn` in a private module with no lib caller fails `clippy -D warnings`); Task 7 must remove it (the attribute itself lints once `exif_ms_for` calls the function). Exactly the `gridthumb.rs` 8 → 10 dance from Phase 3B, and the reason the two are strictly serial rather than merely ordered.

**Serial chains to respect:** 1 → 2; 3 → 4; 2 → 4 (shared `useCullKeymap.ts`); 4 → 5; 6 → 7; {7, 8} → 9; 2 → 9 (shared `App.tsx`); everything → 11. **10a and 10b are independent of everything else and of each other** — disjoint files, and each leaves the app working alone (10b's contiguity split is a no-op on today's contiguous groups).

**Never parallel:**
- **2, 4** — both edit `src/app/useCullKeymap.ts`.
- **2, 9** — both edit `src/App.tsx`. These are the only two tasks that touch it; Task 4 deliberately does not (see its `stats.rejects` ruling).
- **4, 5** — Task 5's CSS targets markup Task 4 creates (`.cull-statusbar__smart-count`, the fifth tab), and running 5 alone would point the tip-alignment rule at the wrong tab.
- **6, 7** — 7 deletes the `allow(dead_code)` 6 adds, in the same file (see ‡), and both are Rust gates that must be green on their own.
- **8, 9** — 9's component imports the helpers and settings fields 8 creates.
- **11 and anything** — it edits the help sheet, the README keys table and the docs against the finished branch, and runs the final gate.

Task 5 is the only owner of `src/styles/layout.test.ts`, `statusbar.css` and `chrome.css`; Task 9 is the only owner of `src/styles/index.css` and of the new `staged-sort.css`. No stylesheet has two owners in this phase. Task 10b is the only owner of `src/components/GridView.tsx` — Tasks 2 and 9 own `App.tsx`, which is a different file — and Task 10a the only owner of the three `smart/` + `strip/` files it lists.

---

## Implementation note (2026-09-20)

Executed with subagent-driven development, under Oliver's standing instruction of the same day to make the calls and keep moving (no design board; every choice is a ruling). Before any code, two fresh checkers fact-checked this plan against the repository (3 blockers, 6 should-fixes, 10 nits — see "Pre-flight corrections"). Then a fresh implementer and a fresh reviewer per task, up to six tasks in parallel on disjoint files; fix rounds on Tasks 2, 7 and 9; a whole-branch review on the strongest model split in two (keys / filters / footer / docs; the capture-time pipeline end to end); ONE fix wave by five implementers; ONE scoped re-review; one live-evidence correction. Gates at the tip: 801 tests in 80 files (736 before), lint, lint:css, typecheck, typecheck:tests, build; `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, 154 Rust tests (136 before).

### What shipped

- **Home / End** — first / last frame of the active filter. **PgUp / PgDn** — one screenful (grid: rows × cols; loupe and compare: one filmstrip screenful). **Shift+Home / End / PgUp / PgDn** extend the grid selection. One step per press; the keys rest while zoomed.
- **Rejects** — a fifth filter tab, key `5`, no count, with its own empty state. The footer pays for it inside the existing `< 1360px` tier (Smart's count is clipped, the button keeps its full accessible name; tab padding 12 → 8 px); slack is positive at every pinned width (+30 to +154 px).
- **Capture-time order** — `analyze_folder` keys on EXIF `DateTimeOriginal` + `SubSecTimeOriginal`, read by a new head-only reader (128 KiB first, then grow) or taken from a cached thumbnail header with no source read. Setting `sortByCaptureTime` (default on) with a toggle on the staged screen; with two or more folders staged, one row per folder — name, count, first capture time, the difference from the first folder INCLUDING the offsets (so the goal reads `+0 s`), and a ± stepper (click 1 s, Shift-click 1 min, Ctrl-click reset) persisted as `captureOffsets`.
- **Two bodies interleaved** — bursts and similar sets are walked per parent DIRECTORY over the global order, so runs survive interleaving; the grid draws one bracket per contiguous stretch instead of one min-to-max box.

### Where the spec or the plan was wrong, and what was ruled instead

- **The fallback clock.** EXIF times are the camera's wall clock treated as UTC; a file's mtime is a true UTC epoch. The first implementation mixed the two, so any frame that fell back to mtime would have sorted hours away (7 h in Los Angeles). Oliver then asked the right question — what if the camera is on Tokyo time? — which the PC-timezone conversion also gets wrong. Shipped: a frame without EXIF takes its mtime shifted by the MEDIAN (EXIF − mtime) of its parent directory, else of the whole shoot, else the PC-timezone conversion as a last resort. A median needs no timezone, absorbs DST and the card's write lag, and tolerates up to half the mtimes being rewritten by a copy tool.
- **Cancellation.** The plan sent the frontend's session generation with the invoke. The two sides keep separate counters, synchronised only by `begin_session`; after a webview reload the frontend would send 0, the backend would treat the pass as already cancelled, and the whole shoot would silently sort on mtime. The wire value was removed; the backend snapshots its own generation and stops when it changes.
- **Page keys do not auto-repeat** (the plan allowed it): a held page key never sets the scrub state that gates full-resolution reads and prefetch, so a two-second hold would have queued 200+ reads for frames flown past. Holding an arrow is still how to fly.
- **Page keys rest while zoomed**: in compare, a frame change under a held-Space zoom bypassed the memory-budgeted swap — three ~130 MB rasters at once, the class of the 2026-07-07 gray-window crash.
- **Offsets travel per frame, not per folder**: the folder walk is recursive, so a file's parent is not the staged folder.
- **`stats.rejects` was not added** — the count already reaches the footer as `session.rejectedCount`, and no tab has a zero treatment to mirror.
- **Enter on the staged sort block** took three rounds: the window keymap's Enter swallowed a keyboard-focused stepper (round 1: stop propagation); then Enter after a MOUSE click re-activated the clicked button and never began culling (round 2: `:focus-visible` — abandoned: it is a UA heuristic and unverifiable in jsdom); shipped: the block tracks pointer-versus-keyboard focus itself. Verified live.
- The first footer tier stays `< 1360px`. At 1360 px and wider the worst-of-worst combination (all rated + every photo missing + scrubbing + the overlay cluster) needs about 1590 px (1513 px before this phase); raising the tier would have put the default 1600-px window in the shed state every day.

### Verification

Tests, static gates, and live runs with the PC idle on scratch folders only (navigation and filter keys, no rating key; 0 sidecars before and after): two folders staged, the toggle's two states, first capture times and the offset-aware delta, Begin culling, End / Home / PgDn in the loupe, End in the grid, key `5` and the Rejects empty state with five tabs at 1600 px, a Similar set drawn as two one-cell stretches across interleaved bodies, and Enter-after-mouse-click beginning the cull. Earlier the same day, also live: the Phase 0 Move-rejects check (no orphaned sidecar after undo) and the Phase 3B check (grid sizes, sharp thumbnails, strip steps, footer at 1024 px). Screenshots: `~/.claude/plans/cull-audit-2026-09-13/phase-3c-shots/`.
Not seen live: PgUp/PgDn in compare; the zoom guard; a shoot large enough to show the capture pass's progress line; a real two-body shoot.

### Oliver's walk

1. Stage two bodies' folders: nudge the second until its delta reads `+0 s`, Begin culling, and check a moment both bodies caught — the frames should alternate correctly.
2. In each folder row the `−` button sits far from the value and `+`; say if the stepper should be tight.
3. `End`, `Home`, `PgDn` in the loupe and the grid; `5` for the reject pile before Move rejects.
4. With both bodies bursting at the same moment the filmstrip draws a row of one-frame burst boxes — uglier, not wrong; say if it bothers you.

### Left for later

- The filmstrip's one-cell burst "fence" for simultaneous bursts on two bodies.
- A user-facing Cancel during "analyzing" (the backend can already stop).
- A directory whose ONLY EXIF-bearing frame has a reset clock gives its fallback frames that one wrong delta (doubly rare).
- `C` from the Rejects filter is a silent no-op (a reject cannot champion — pre-existing rule); the help sheet does not say so.
- The filter tabs still lack `role="tab"` / `aria-selected` (pre-existing).
- Phase 4: `App.tsx` and `useCullKeymap.ts` have no test harness — every key-wiring change in this phase was verified by reading and by the live run.
