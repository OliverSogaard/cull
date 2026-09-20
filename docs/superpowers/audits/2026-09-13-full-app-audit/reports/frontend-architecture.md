# CULL Frontend Architecture Review

Repo: `C:\Users\OSA\Developer\cull` (git, branch `main`, clean except one unrelated
unstaged change to `src-tauri/Cargo.toml`). Review is read-only; nothing in the
repo was modified.

## Summary verdict

The frontend is unusually disciplined for its size: `tsc --noEmit`, `eslint src`,
and `vitest run` (44 files / 487 tests) all pass clean with zero `any`, zero
unexplained `eslint-disable`, zero `TODO`/`FIXME`/`HACK`, and essentially no
unguarded non-null assertions. The claimed layering (App to app/ to components/
to image+smart+overlays+hooks to utils to types) is real and enforced by import
discipline, not just documentation. The two headline weaknesses are size, not
correctness: `App.tsx` (2,501 lines) still carries roughly 350 to 700 lines of
mechanically-extractable JSX that has not been moved into `components/` despite
several documented "grand cleanup" phases doing exactly that to everything else,
and the `app/` orchestration hooks, the most behaviorally load-bearing code in
the app (undo/redo, rating decisions, the keymap), have almost no direct unit
tests, unlike the very well-tested pure core (imageStore, stage, present,
smart/, utils/).

## What is genuinely excellent

- Schema-validated localStorage boundaries. `src/hooks/useSettings.ts`
  (coerceSettings, lines 23-77) and `src/hooks/useRecents.ts`
  (parseStoredRecents, lines 89-128) treat every persisted blob as untrusted:
  every field is type or enum checked with an explicit fallback, migrations are
  versioned (cull:recents:v1 to v2), and both validators are pure functions
  with dedicated unit tests. This is exactly the "never trust external data"
  discipline the house rules ask for, applied consistently.
- IPC error handling is a real state machine, not try/catch-and-forget.
  `src/image/imageStore.ts` per-tier fetch methods (fetchThumbInto,
  fetchNavInto, fetchZoomInto, fetchMidInto) catch every invoke() rejection,
  record a capped-backoff TierError (src/image/tierErrors.ts), retry on a
  schedule, and latch a folder-unreachable banner after repeated terminal
  failures, all generation-scoped so a superseded folder-open cannot corrupt
  the new session's counters. `src/app/useRatingPersistence.ts` mirrors this
  for writes: a per-path serial write queue, a monotonic per-path sequence
  number so a stale retry cannot resurrect a cleared failure flag, and
  synchronous ref mirrors (savingRef / failedCountRef) so the quit-guard can
  never read a lagged "0 in flight" and let the window close mid-write.
- Pure-core extraction pattern. Rather than "no component tests" being an
  excuse, hot logic is pulled out of components into pure, unit-tested modules:
  src/image/stage.ts (resolveStage), src/components/pane/paneGeometry.ts,
  src/components/pane/zoomTransition.ts, src/components/gridWindow.ts,
  src/components/strip/computeWindow.ts, src/components/strip/burstSegments.ts.
  Each has a co-located .test.ts file. This is a legitimately good way to get
  behavioral coverage on view logic without asserting on JSX shape.
- Layering is real. A Grep sweep found zero imports from components/, image/,
  smart/, hooks/, or utils/ reaching back up into app/ or App.tsx, and no
  cycle between image/ and smart/ (only smart/useSmartCulling.ts imports
  image/imageStore.ts, one direction only). The documented "strict layering,
  no circular deps" claim in ARCHITECTURE.md holds up under inspection.
- Type safety hygiene. No `any` anywhere in src/. The handful of non-null
  assertions (groupBursts.ts line 69, burstSegments.ts lines 69 and 73, plus a
  few in test files) are all locally guarded by a preceding truthy check, not
  blind casts. Every eslint-disable-next-line (12 total, all
  react-hooks/exhaustive-deps except two no-console and one
  react-refresh/only-export-components) carries an explanatory comment,
  matching the house rule.
- React hook cleanup discipline. Every addEventListener, ResizeObserver,
  setTimeout, and listen() subscription found during this review has a
  matching teardown (for example App.tsx lines 407-409, PhotoPane.tsx lines
  211-213, GridView.tsx lines 157-163). Stable keys are used throughout lists
  (images[idx].id, never array index) in GridView.tsx line 402, ThumbStrip,
  and CompareStrip.

## Findings

### MEDIUM -- App.tsx still carries mechanically-extractable JSX
src/App.tsx lines 1236-1286 (quit-guard overlay), 2121-2147 (confirm-home
dialog), 2199-2361 (NoMatchEmptyState + EmptyFilter), 2373-2445
(RecentFolders + RecentRow), 2461-2501 (SaveStatusPill), and 1637-1926 (the
roughly 290-line bottomStatusBar JSX literal) are self-contained enough to
move into src/components/ with no state-ownership change -- they already only
read primitives and callbacks passed in, exactly like every sibling component
in that directory. The project's own history (several "grand cleanup" phases,
visible in git log) already did this for logic; the leftover mass is now
almost entirely presentational JSX, not orchestration. Given ARCHITECTURE.md
explicitly frames App.tsx as "composition root: state + JSX wiring," a strict
800-line cap is not the right bar here -- but leaving 350 to 700 lines of
already-decoupled JSX inline is inconsistent with the project's own stated
discipline elsewhere. See the extraction map below for specifics.
Fix: extract items 1-7 in the extraction map; expect App.tsx to land around
1,800 to 1,900 lines afterward (still large, but the remainder is
irreducible composition-root wiring: 14 hook calls plus roughly 35 state
atoms plus the loupe/compare/grid switch).

### MEDIUM -- onKey handler in the cull keymap is roughly 360 lines in one function
src/app/useCullKeymap.ts lines 202-560. One function handles: modal
precedence (settings, quit-guard, confirm-home, actions-open -- lines
206-255), undo/redo/finish/select-all/help (256-330), the Space-zoom arm
(315-330), ESC (332-339), the entire compare-mode key switch (341-419), and
the entire single-mode key switch (421-559). The house rule is functions
under 50 lines; this is roughly seven times that. The three natural sections
(modal guards, compare-mode switch, single-mode switch) are already visually
separated by comments and could become handleModalKeys, handleCompareKey,
and handleSingleModeKey without changing behavior or the dispatch-through-a-
ref, bind-once contract the file's own top comment insists on preserving.
Fix: split along the three existing comment boundaries into named functions
called from onKey; no change to the once-bound-listener contract.

### MEDIUM -- Real duplication across the three compare decide callbacks
src/app/useDecideCallbacks.ts: challengerLoses (lines 236-300),
challengerKeptBoth (lines 305-366), and challengerWins (lines 369-446) repeat
the same seven-step shape almost verbatim -- compute the next rating map,
find nearestUnrated, build cursorBefore and cursorAfter for undo, call
recordAction, persistRating, setRatings, conditionally setZoomSwapInstant,
then imageStore.dropZoomFullsExcept(keep) in the same after-the-last-setState
position. The file's own header comment warns that the setState-then-
dropZoomFullsExcept sequencing inside each decide is load-bearing and should
not be simplified, which argues for caution, not for leaving three copies of
a sequencing bug waiting to diverge. A shared resolveCompareDecide helper
(taking champion verdict, challenger verdict, and next challenger) could
preserve the exact sequencing in one place instead of three.
Fix: extract the common shape into one internal helper; keep the ordering
comment on the helper instead of copy-pasted three times. Treat this as a
verify-carefully refactor given the explicit crash history cited in the
comments (a 2026-07-07 compare-strip crash) -- not urgent, but the current
shape guarantees the next behavioral change has to be applied three times
correctly.

### MEDIUM -- The safety-critical orchestration layer has almost no direct tests
Of the 14 non-test files in src/app/ (the hooks that own rating decisions,
undo/redo, site navigation, the keymap, and session lifecycle), only
useHeldRepeat.ts has a companion .test.ts file. useDecideCallbacks.ts,
useUndoRedo.ts, useRatingPersistence.ts, useSiteNavigation.ts, and
useCullKeymap.ts -- the code whose comments repeatedly cite specific past
production incidents (a jetsam gray-window crash, a 2026-07-07 compare-strip
crash from a setState-ordering bug) -- have zero unit coverage.
ARCHITECTURE.md's explanation that there are no component tests because the
components are presentational does not apply here: these are plain hooks
with substantial branching logic, not JSX. The 487 passing tests are real
and thorough for the pure layers (imageStore.test.ts alone is 1,531 lines;
smart/deriveVerdict.test.ts is 429), but the layer most likely to regress
silently -- exact setState sequencing across undo/redo and compare decisions
-- is currently protected only by code comments telling the next person not
to touch it.
Fix: at minimum, add regression tests for useDecideCallbacks's three
compare-decide paths and useUndoRedo's undo/redo of a compound action --
these are the functions the comments say are the most fragile, which makes
them the highest-value tests to add.

### MEDIUM -- imageStore reset() and hardReset() duplicate their revoke loops
src/image/imageStore.ts lines 525-620 (reset) and 626-678 (hardReset) each
contain four nearly-identical loops of the shape: iterate a tier map, and if
the entry status is ready, call URL.revokeObjectURL on it (zoom, mid, full,
and -- in hardReset only -- thumb). The file is otherwise very well factored
(four tiers pushed into shared TierLane instances), so this stands out as
the one place the DRY discipline lapsed. A private revokeReadyBlobs(map)
helper would collapse roughly eight loops into one, called eight times.
Fix: extract a private generic revokeReadyBlobs helper and call it from both
methods.

### LOW -- Non-null assertions without a type guard (stylistic, not a bug)
src/smart/groupBursts.ts line 69 (b.capturedAtMs minus a.capturedAtMs, both
asserted non-null) and src/components/strip/burstSegments.ts lines 69 and 73
(labeledGroups.has on an asserted-non-null key). Both are provably safe at
the point of use (the enclosing condition already guarantees non-null), but
a narrowed local variable (assigning capturedAtMs to a const with an early
return, or deriving key after a null check) would let the compiler verify it
instead of the comment or reviewer.
Fix: optional; narrow instead of assert. Not worth doing as a standalone
change, only if touching these lines anyway.

### LOW -- Manual (not tooled) Rust to TS wire-type sync
src-tauri/src/meta.rs's ImageMetadata and src/types/image.ts's ImageMetadata
are kept in sync by hand, field-for-field, with heavy cross-referencing
comments on both sides noting that the wire shape mirrors the Rust struct,
plus a Rust-side exhaustiveness comment noting that a new Cr3Meta field
silently will not reach the UI unless someone remembers to add it to
ImageMetadata too. Today the two structs match exactly (19 fields, same
names camelCase versus snake_case, same nullability) -- the discipline is
working -- but there is no compiler- or codegen-enforced guarantee (for
example ts-rs or specta) that a future edit on one side is caught on the
other; the safety net is comments and manual review.
Fix: not urgent given the demonstrated discipline; if the wire surface grows
further, consider generating the TS types from the Rust structs (ts-rs or
specta) to convert this from a discipline problem into a compiler problem.

### LOW -- console.error as the only signal on analyze_folder failure
src/app/useSessionLifecycle.ts line 496 logs to console.error in addition to
setting analyzeError (which the UI does display on the staged screen -- this
is not a swallowed error). Flagging only because a structured logger would
let this survive into a future crash-reporting pipeline; today it is
harmless since the user-facing path is intact.

## Extraction map for App.tsx

Ordered by ease and impact. None require new state -- every candidate already
receives everything it needs as arguments from the surrounding scope.

| # | Lines | Extract to | Notes |
|---|-------|-----------|-------|
| 1 | 2199-2215 | components/EmptyFilter.tsx (NoMatchEmptyState) | Pure, 3 props |
| 2 | 2223-2361 | components/EmptyFilter.tsx (EmptyFilter) | Needs Filter, pickSmartEmptyState, modGlyph -- already imported at top of App.tsx |
| 3 | 2373-2399 | components/RecentFolders.tsx (RecentFolders) | Needs RecentEntry, recentKey, modGlyph |
| 4 | 2401-2445 | components/RecentFolders.tsx (RecentRow) | Needs formatFolderSet, formatRelativeTime |
| 5 | 2461-2501 | components/SaveStatusPill.tsx | 3 props, zero App-internal coupling |
| 6 | 1236-1286 | components/QuitGuardOverlay.tsx | Needs failedCount, savingCount, retryFailed, setQuitGuard, destroyedRef, getCurrentWindow (already imported) |
| 7 | 2121-2147 | components/ConfirmHomeDialog.tsx | 3 props (failedCount, leaveToHome, setConfirmHome); shares the cull-quitguard markup pattern with #6, so consider one shared ConfirmOverlay primitive both use |
| 8 | 1637-1926 | components/StatusBar.tsx | Biggest win (about 290 lines) but roughly 30 inputs -- group into 2-3 sub-objects (filterState, overlayState, compareState) rather than 30 flat props |
| 9 | 1512-1610 | components/LoupeStage.tsx | Optional, lower priority -- tightly coupled to about 15 local values (cur, positionInFilter, zoom state); worth doing only after 1-8 |

Doing 1-7 alone (all low-risk, no prop-grouping design needed) removes
roughly 350 lines with essentially zero judgment calls. Doing 8 as well
removes another roughly 290 but needs a deliberate prop-shape decision first.

## Metrics measured

- Frontend size: 137 TypeScript/TSX files, 23,357 lines total (src/).
- Largest files: App.tsx 2,501; image/imageStore.ts 1,621;
  image/imageStore.test.ts 1,531; app/useCullKeymap.ts 658;
  app/useSessionLifecycle.ts 605; components/SettingsDialog.tsx 564;
  components/FinishDialog.tsx 556; components/GridView.tsx 522;
  app/useDecideCallbacks.ts 449.
- app/ hooks: 14 non-test files (75 to 658 lines each); only 1
  (useHeldRepeat.ts) has a dedicated test file.
- Type check: pnpm typecheck (tsc --noEmit) -- clean, 0 errors.
- Lint: pnpm lint (eslint src) -- clean, 0 errors or warnings.
- Tests: pnpm test (Vitest) -- 44 files, 487 tests, all passing, 3.54s.
- any usage in src/: 0.
- eslint-disable comments: 12, all annotated (9 react-hooks/exhaustive-deps,
  2 no-console, 1 react-refresh/only-export-components).
- Non-null assertions (the ! operator) in non-test src/ code: 3 (all locally
  guarded; see LOW finding above). Roughly 5 more in .test.ts files
  (acceptable in tests).
- TODO, FIXME, HACK, or XXX markers: 0.
- console.log/debug/info/warn calls in src/: 2, both gated behind
  dlogEnabled() (an explicit opt-in dev flag) -- utils/dlog.ts line 38,
  smart/useSmartCulling.ts line 102. One console.error for a genuine failure
  path (app/useSessionLifecycle.ts line 496).
- dangerouslySetInnerHTML, eval, new Function, document.write: 0 occurrences.
- IPC (invoke()) call sites: 18, across utils/bundle.ts, imageStore.ts,
  useSessionLifecycle.ts, useRatingPersistence.ts, useFolderTrouble.ts,
  App.tsx, FinishDialog.tsx, SettingsDialog.tsx, useSmartCulling.ts -- every
  one is inside a try/catch (directly or via the caller's tier-error
  handling).
- Circular or upward imports from components/, image/, smart/, hooks/, or
  utils/ back into app/ or App.tsx: 0 found.

## Top 10 prioritized recommendations

1. Extract App.tsx items 1-7 from the extraction map (quit-guard overlay,
   confirm-home dialog, EmptyFilter family, RecentFolders family,
   SaveStatusPill) -- low-risk, about 350 lines, no design decisions needed.
2. Add regression tests for useDecideCallbacks's three compare-decide
   functions (challengerLoses, challengerKeptBoth, challengerWins) -- the
   code most explicitly flagged as fragile in its own comments, currently
   untested.
3. Add regression tests for useUndoRedo's undo/redo of a compound
   (multi-change) action, especially the compare-cursor restore path.
4. Split useCullKeymap.ts's roughly 360-line onKey handler into
   handleModalKeys, handleCompareKey, and handleSingleModeKey along its
   existing comment boundaries.
5. Design a grouped-props shape (2-3 sub-objects) for a StatusBar component
   and extract App.tsx's roughly 290-line bottomStatusBar JSX (extraction
   map item 8).
6. Extract the shared shape of challengerLoses, challengerKeptBoth, and
   challengerWins into one internal helper in useDecideCallbacks.ts,
   preserving the documented setState-then-dropZoomFullsExcept ordering in
   one place instead of three.
7. Add a revokeReadyBlobs() private helper in imageStore.ts and call it from
   both reset() and hardReset() instead of four duplicated loops.
8. Narrow instead of assert the three non-null uses in groupBursts.ts and
   burstSegments.ts if those files are touched again.
9. If the Rust to TS wire surface (ImageMetadata, ImageScore, etc.) keeps
   growing, evaluate ts-rs or specta to generate TS types from the Rust
   structs and remove the manual-sync risk entirely.
10. Once items 1 and 5 land, re-measure App.tsx; expect roughly 1,800 lines
    of irreducible composition-root wiring (14 hook calls, about 35 state
    atoms, the loupe/compare/grid switch) -- a reasonable place to stop
    rather than forcing it under 800.
