# Phase 3 Loose Ends Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the small defects carried forward from Phases 0–3A before Phase 3B starts moving layout around the same files.

**Architecture:** Four independent work packages on disjoint file sets. No new subsystems; each is a guard, a narrower test, or a control that stays mounted. Every item was fact-checked against the code on 2026-09-20 before this plan was written (file:line below are from that check, on main `053064e`).

**Tech Stack:** React 19, TypeScript 5.8 strict, Vitest 4 (node environment; jsdom per file via a `// @vitest-environment jsdom` docblock), `@testing-library/react` 16, pnpm 10.

**Spec:** none — this plan closes items listed under "Left for later phases" in `docs/superpowers/plans/2026-09-19-phase-3a-see-and-feel.md` and the carry-forward in `docs/superpowers/plans/2026-09-19-phase-2-optimize.md`. Rulings made without a spec are recorded in the ledger.

## Global Constraints

- Scope is these items only. No refactors, no renames, no drive-by fixes; report anything else you find instead of fixing it.
- `@types/node` is NOT installed: no `node:fs`, no `process`, no `__dirname` in tests. Read sources with `import.meta.glob<string>(pattern, { query: "?raw", eager: true, import: "default" })` if you must.
- Test files are linted with type-aware rules: spies need typed implementations (`vi.fn((_x: T) => {})`), and anything a `vi.mock` factory references must come from `vi.hoisted`.
- Component tests opt in to the DOM with a first-line `// @vitest-environment jsdom` docblock. There is no global setup file.
- TDD: write the failing test first, watch it fail, then implement.
- Immutable updates only. No `console.log`. Match the surrounding comment density and voice (comments explain why, in full sentences).
- User-visible wording is Sentence case and comes from `src/utils/saveStatusCopy.ts` where that module already owns the phrase.
- Commit in pathspec form only: `git commit -m "<type>: <description>" -- <files>`. Conventional commit types. NO `Co-Authored-By`, no session trailers, no attribution of any kind.
- Other implementers are working in this same working tree on other files at the same time. Never `git add -A`, never `git stash`, never `git checkout`/`restore` a file you do not own, never touch a file outside your task's **Files** list. If the full test run fails in a file you do not own, say so in your report and move on.
- A prettier hook may re-format a file after you commit. If `git status` shows your own file modified after the commit, commit it as `style: prettier`, pathspec form.
- Never run the app, never open a real photo folder, never write under `C:\Canon Media`.
- Gate before reporting DONE: `pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test` (plus `pnpm lint:css` if you touched CSS).

---

### Task 1: imageStore guards — tombstones at the entry points, a narrower mid-tier latch, and a pending-metadata peek

**Files:**
- Modify: `src/image/imageStore.ts`
- Modify: `src/image/imageStore.test.ts`
- Modify: `src/image/metaBatcher.ts`
- Modify: `src/image/metaBatcher.test.ts`
- Modify: `src/App.tsx` (the zoom-origin read only, near line 1575)
- Modify: `src/components/CompareView.tsx` (the zoom-origin read only, near line 85)

**Interfaces:**
- Produces: `MetaBatcher.peek(path: string): ImageMetadata | undefined` (whatever the batcher's entry type is — use the existing type, do not invent one) and `imageStore.pendingMetaFor(path: string)` with the same return type.
- Consumes: `afZoomOrigin(meta, panOffset)` in `src/utils/zoom.ts` — unchanged.

Three changes, in this order, one commit each.

**1a. Tombstones at the request entry points.** `forget()` (about `imageStore.ts:647`) tombstones moved paths in `this.forgotten`, and all four fetch landings drop a forgotten path. But `requestThumbFor` (~1009), `registerWantFull` (~873), `requestZoomFull` (~1344) and `requestMid` (~1467) never consult it, and `rearm()` (~986) iterates `this.wantFull.keys()` and unshifts each to the FRONT of the nav lane. Nothing corrupts, but a forgotten path can take a nav-lane slot ahead of the frame the user is looking at, right after a Move rejects and on every manual retry.

- [ ] Write failing tests in `imageStore.test.ts`, next to the existing `forget` tests (search for `forgotten` / `forget(`): after `forget([P])`, (i) `registerWantFull(P)` issues no `read_preview` invoke, (ii) `requestThumbFor(P)` issues no thumb invoke, (iii) `rearm()` does not queue `P` while it still re-queues a surviving path that is wanted.
- [ ] Run them, see them fail.
- [ ] Add `if (this.forgotten.has(path)) return;` at the top of the four entry points (keep whatever each currently returns — if one returns an unregister function, return the same no-op shape and keep the `wantFull` refcount behaviour intact so a later unmount's decrement stays balanced; read the function before choosing), and `if (this.forgotten.has(p)) continue;` in the `rearm()` loop. Do NOT delete from `wantFull` in `forget()` — the comment at `dropPath` documents that the cell owns that refcount.
- [ ] Confirm `reset()` and `hardReset()` still clear `forgotten` (they do today) so a re-staged folder can never be stranded; add one test asserting a path forgotten, then `reset()`, is requestable again if no such test exists.
- [ ] Commit: `fix: forgotten paths no longer start requests or re-arm`.

**1b. A narrower "mid tier unsupported" latch.** `imageStore.ts:~1526`: `/not found|unknown command|no handler/i.test(msg)` sets `this.midUnsupported = true` for the whole session. The latch exists for one case: the backend has no `read_mid` command (Tauri says `Command read_mid not found`). The Rust side never says "not found" for a file today (its strings are `source stat failed`, `mid uncached (…)`, `source not larger than mid tier (…)`, and raw io errors), so this is hardening, not a live bug: one future error string containing "not found" would turn the mid tier off for every frame.

- [ ] Failing tests: `read_mid` rejecting with `"read_mid(X): file not found"` for a live (not forgotten) path does NOT latch — a later `requestMid` for another path still invokes `read_mid`; rejecting with `"Command read_mid not found"` still latches (an existing test probably covers the latch — keep it green, add the first).
- [ ] Narrow the pattern to the command-missing shapes: `/command\s+\S*\s*not found|unknown command|no handler/i`. Everything else keeps going to the existing per-path error path.
- [ ] Commit: `fix: only a missing read_mid command latches the mid tier off`.

**1c. Zoom origin reads pending metadata.** Metadata reaches React through `MetaBatcher`, flushed on a fixed 100 ms window (`META_FLUSH_MS`, `metaBatcher.ts:~32`). `App.tsx:~1575` and `CompareView.tsx:~85` read `metadata[path]` and pass it to `afZoomOrigin`, which falls back to 50/50 without `afXPct`. Zooming inside that window centres instead of landing on the AF point.

- [ ] Failing tests in `metaBatcher.test.ts`: `peek(path)` returns the pending entry before a flush; returns `undefined` after the flush delivered it; returns `undefined` after `forget([path])`; returns `undefined` after `hardReset()`; still returns the entry after `reset()` (reset keeps the queue — that is existing, documented behaviour).
- [ ] Implement `peek` on `MetaBatcher` and a thin `pendingMetaFor(path)` on the image store that delegates to it. Doc comment on both: this is for the zoom-origin read only; it is not a general way around the batch window.
- [ ] In the two zoom-origin reads, fall back to the pending entry only when the committed one has no AF point: `const originMeta = currentMeta?.afXPct != null ? currentMeta : (imageStore.pendingMetaFor(path) ?? currentMeta)` (adapt names to the code; check how each file reaches the store — do not add a new prop chain if the store is already importable there). Do NOT flush on demand: the 100 ms window is what took folder-open from 1,833 React commits to 97.
- [ ] Commit: `fix: zoom origin uses AF metadata still waiting in the batch window`.

---

### Task 2: a re-staged frame keeps its Lightroom star

**Files:**
- Modify: `src/utils/mergeMeta.ts`
- Modify: `src/utils/mergeMeta.test.ts`
- Modify: `src/app/useSessionLifecycle.ts` (the seed at about line 446 only)

**Interfaces:**
- Produces: `seedLrcMeta(prev: Record<string, ImageMetadata>, seeded: Record<string, ImageMetadata>): Record<string, ImageMetadata>` exported from `src/utils/mergeMeta.ts` (use the metadata type the file already uses).

`useSessionLifecycle.ts:~446`: `setMetadata((prev) => ({ ...seededMeta, ...prev }));`. A whole-entry override: when `prev[path]` already exists with `lrcRating: null`, the seeded star is thrown away. On a first cull `prev` is empty and the seed wins; the loss needs a same-session re-stage (drag-drop or Open from a live cull) of a path that already has an entry, after the sidecar gained a star. The spread order exists for a reason — seeds are `EMPTY_METADATA` plus a star, so `{...prev, ...seededMeta}` would wipe camera and lens. Do not flip it.

- [ ] Failing tests in `mergeMeta.test.ts` for `seedLrcMeta`: (i) a `prev` entry with full EXIF and `lrcRating: null` gains the seed's star and keeps its camera, lens and every other field; (ii) a `prev` entry that already has a star keeps its own (read `mergeMeta`'s contract at the top of the file and follow it — do not invent a new precedence); (iii) a seeded path absent from `prev` is added as-is; (iv) a `prev` path absent from `seeded` is untouched; (v) neither input object is mutated.
- [ ] Implement it as a per-path fold through the existing `mergeMeta`, seed as the base and the existing entry as the incoming one, so EXIF still wins and only a null star is back-filled. Verify that argument order against `mergeMeta`'s own tests before relying on it.
- [ ] Replace the spread in `useSessionLifecycle.ts` with `setMetadata((prev) => seedLrcMeta(prev, seededMeta))`. Keep the neighbouring comments true.
- [ ] Commit: `fix: a re-staged frame keeps its Lightroom star`.

---

### Task 3: save-failure controls keep focus, and the quit guard can check again

**Files:**
- Modify: `src/components/StatusBar.tsx` (the save chip, about lines 219–233)
- Modify: `src/components/SaveStatusPill.tsx`
- Modify: `src/components/QuitGuardOverlay.tsx`
- Modify: `src/utils/saveStatusCopy.ts` and its test, only if a new shared phrase is needed
- Modify: the stylesheet(s) that style the chip and the pill, only if the busy state needs a rule (find them by class name)
- Create: `src/components/SaveStatusPill.test.tsx`
- Create: `src/components/QuitGuardOverlay.test.tsx`
- Test: add the StatusBar chip case to an existing StatusBar test file if one exists, else to `SaveStatusPill.test.tsx`'s sibling `src/components/StatusBar.saveChip.test.tsx`

**3a. The chip and the pill stay mounted through a retry.** `useRatingPersistence.ts:~79-88`: `persistRating` deletes the path from `failedWrites` and bumps `savingCount` in the same commit, and `retryFailed` does that for every failed path — so `failedCount` goes to 0 and `savingCount` above 0 together. `StatusBar.tsx:~219-233` renders the `<button>` only while `failureKind !== "none"` and otherwise a `<span className="cull-statusbar__saving">`; `SaveStatusPill.tsx:~36-68` returns a `<span>` for `saving`. The button unmounts under the keyboard, and `document.activeElement` falls to `<body>`.

- [ ] Failing tests (jsdom, Testing Library): render with a failure, focus the button, re-render with `failedCount: 0, savingCount: 1` — the SAME element is still in the document and still `document.activeElement`; clicking it while saving does not call `retryFailed`; re-render again with a failure and it is clickable again. One for the pill, one for the status-bar chip.
- [ ] Make the saving state render the same `<button>` element in the same position in the tree (same element type, same key-less slot — so React reuses the DOM node). Use `aria-disabled="true"` plus a guarded `onClick`, NOT the `disabled` attribute: a disabled button loses focus in Chromium. The saving label stays exactly what it is today. It must not look clickable while saving: no pointer cursor, no hover lift — add a rule keyed on `[aria-disabled="true"]` if the existing styles do not already cover it, and keep the focus ring.
- [ ] The plain "saving" state that was never preceded by a failure renders the same element too (one code path, not two) — check the visual result is unchanged apart from the element type: the button must carry the span's existing class or equivalent rules so colour, size and casing do not move. Chromium's UA sheet resets `text-transform` and `letter-spacing` on `<button>`; if the span inherited either, set `text-transform: inherit; letter-spacing: inherit;` on the button.
- [ ] Commit: `fix: the save chip and pill keep keyboard focus through a retry`.

**3b. "Check again" in the quit guard.** `QuitGuardOverlay.tsx`: the `retry` branch offers "Retry saving"; the `missing` branch (lines 38–59) offers only "Keep culling" / "Close anyway", and its header comment argues a retry from in here would fire against the same outage. That argument fails for the user who has just plugged the drive back in: the body text tells them to "check again", and the only control that does it is behind the dialog.

Ruling: add it. When the re-check succeeds, the guard's existing auto-close (`useQuitGuard`) closes the window — the same thing "Retry saving" does today, and what the user asked for when they pressed close. That is intended; do not change `useQuitGuard`.

- [ ] Failing tests: the missing branch renders a "Check again" button that calls `retryFailed` once; "Keep culling" is still the primary button and still first; the retry branch still renders exactly "Retry saving", "Keep culling", "Close anyway"; the saving branch is unchanged.
- [ ] Add `<button className="btn" onClick={retryFailed}>Check again</button>` between "Keep culling" and "Close anyway" in the missing branch. Rewrite the component's header comment and the inline comment at lines 44–47 so they are true again (the dialog now CAN clear the guard once the photos are reachable).
- [ ] Commit: `feat: the quit guard offers "Check again" for missing photos`.

---

### Task 4: reduced motion skips the un-zoom wait, and the compare "differs" dot is 4 px again

**Files:**
- Modify: `src/components/pane/paneGeometry.ts`
- Modify: `src/components/pane/paneGeometry.test.ts` (create it if it does not exist)
- Modify: `src/components/pane/PhotoPane.tsx` (the `UNZOOM_RETREAT_MS` timer, about lines 22 and 345)
- Modify: `src/components/ExifRail.tsx` (line ~382)
- Modify: `src/styles/exif-rail.css` (the `.cull-cr-rail__diff-dot` rule, ~177)

**4a.** `PhotoPane.tsx:22` `const UNZOOM_RETREAT_MS = 240;` holds `unzoomSettling` true (line ~345), which withholds the sharp raster while the release glide plays. `src/styles/motion.css:~132-145` removes exactly that glide under `prefers-reduced-motion: reduce`, so with the OS setting on, the sharp image is withheld 240 ms for nothing. No reduced-motion helper exists in `src/`.

- [ ] Failing tests for a new pure function `unzoomRetreatMs(prefersReducedMotion: boolean): number` in `paneGeometry.ts` — 0 when true, 240 when false — and for `prefersReducedMotion(): boolean`, which returns `false` when `window.matchMedia` is not a function and otherwise the query's `matches` (stub `matchMedia` in the test; jsdom docblock needed for that test file only if `window` is otherwise absent — check how the existing file is set up).
- [ ] Move the constant next to `ZOOM_UNSETTLE_MEASURE_DELAY_MS` in `paneGeometry.ts`, implement both functions, and read `prefersReducedMotion()` inside the effect at the moment the timer is armed (not at module load — the OS setting can change while the app runs). Keep the constant's explanatory comment.
- [ ] Commit: `fix: reduced motion no longer waits out the removed un-zoom glide`.

**4b.** `ExifRail.tsx:~382`: `<Dot className="cull-cr-rail__diff-dot" {...ICON.md} fill="currentColor" aria-hidden />`. Lucide's `Dot` is an r=1 circle in a 24 box; at 14 px it paints about 2.2 px, where the bullet it replaced in Phase 3A was about 4 px. Scaling the icon to reach 4 px would put a 40 px box in the row and leave the icon scale.

- [ ] Replace the icon with `<span className="cull-cr-rail__diff-dot" aria-hidden />` and give the existing CSS rule `width: 4px; height: 4px; border-radius: 50%; background: currentColor;` (keep its `align-self`, `flex-shrink` and `color`). Remove the `Dot` import if it is now unused, and the `ICON` import if that is now unused too. Check `src/components/icons.ts` / `icons.test.ts` for a mention of this dot in the documented off-scale families or allowlist and update it so it stays true.
- [ ] `pnpm lint:css` clean.
- [ ] Commit: `fix: the compare rail's "differs" mark is a 4 px dot`.

---

## Not in this plan

- The help sheet renders every shortcut as plain text while the rest of the chrome uses keycaps. Converting it changes the data shape (`[string, string]` rows with composite keys like `space (hold)` and `1 – 4`) and is a visual decision — it goes on the Phase 3B design board.
- `"source not larger than mid tier"` retries four times although it is permanent for that file — noted, not fixed here.
- The class ↔ rule CSS census (3B), test citation cleanup (Phase 4), `useStatusBarGroups()` extraction (refactor).

---

## Implementation note (2026-09-20)

Four fresh implementers ran in parallel on disjoint files, each followed by a fresh reviewer (two on the stronger model: the image store and the save controls). All four passed; two took a follow-up round from their reviewer's minors. A whole-branch review on the strongest model returned READY with no Critical or Important finding; its one actionable minor was fixed by the controller. Gates at the tip: 661 tests in 68 files (621 before), lint, lint:css, typecheck, typecheck:tests, build. No Rust changes.

### What shipped

- A re-staged frame keeps its Lightroom star (`seedLrcMeta`, a per-path fold through `mergeMeta`; the spread order was never flipped — that would wipe EXIF).
- Paths moved away by Move rejects no longer start requests or get re-armed to the front of the nav lane. Refcounts stay balanced: the `wantFull` increment still runs before the guard.
- Only a missing `read_mid` command turns the mid tier off for the session. Checked against Tauri 2.11.5's real strings (`Command read_mid not found`, and the ACL form); no per-file error matches.
- A zoom inside the 100 ms metadata window lands on the AF point: `MetaBatcher.peek` → `imageStore.pendingMetaFor` → `zoomOriginMeta` (`src/utils/zoom.ts`), used by the loupe origin, the compare origin and the mouse-zoom pan. It is read lazily and nothing flushes on demand.
- The save chip and the save pill are one `<button>` through failed → saving → failed (`aria-disabled`, not `disabled`), so pressing retry no longer drops keyboard focus.
- The quit guard offers "Check again" when photos are missing. Its buttons are keyed, and "Retry saving" / "Check again" hand focus to "Keep culling" before the write starts.
- With reduced motion on, un-zoom no longer waits 240 ms for a glide that is not played (`unzoomRetreatMs(prefersReducedMotion())`, read when the timer is armed).
- The compare rail's "differs" mark is a 4 px CSS dot again (the Lucide `Dot` painted about 2.2 px).

### Rulings

- The quit guard's "Check again": a successful re-check lets the guard close the window, exactly as "Retry saving" already did — the user had pressed close.
- The chip and pill still unmount when the save LANDS, so focus returns to the body then. Accepted: nothing is left to show, and body focus is the normal culling state.
- After "Retry saving" focus sits on "Keep culling", so a second Enter dismisses the guard rather than retrying again. Accepted as the safer default; on main the pressed button was silently re-labelled "Keep culling", so a second Enter already did this.
- The fix rounds got no separate re-review; the whole-branch review examined them by name.
- A focused footer button does not steal Space or Enter from culling: the window-level keymap prevents the default on keydown, which is what a button's activation depends on. Reasoned from the code, not run.

### Verification

Tests and static gates only. Nothing here was seen running. For Oliver's walk: press the footer's "unsaved · retry" chip with the keyboard (focus should stay put while it says saving); zoom with the mouse the instant a frame appears; with Windows animations off, un-zoom should sharpen at once; the compare rail's dot.

### Still open

- The help sheet renders shortcuts as plain text while the rest of the chrome uses keycaps — a data-shape and visual decision, on the Phase 3B design board.
- `"source not larger than mid tier"` is permanent for that file but retries four times.
- A focus ring may appear on the save chip after click-then-type (Chromium's `:focus-visible` heuristic); the other footer buttons already behave this way.
- `usePaneZoom` has no test of its own; its AF read is covered only through `zoomOriginMeta`.
- The Phase 0 live check on a scratch copy is still owed.
