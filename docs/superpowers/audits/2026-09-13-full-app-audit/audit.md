# CULL — full app audit (2026-09-13 → 14)

> Screenshots referenced as `shots/` are not in the repo (1.3 MB); they live with the original at `~/.claude/plans/cull-audit-2026-09-13/` on the Windows PC.

**Scope.** Everything: architecture, cleanliness, performance, robustness, UX, accessibility, copy, design language, tests/CI/release, Rust backend, product gaps. Read-only; nothing in the repo was changed (one line-ending-only rewrite of `src-tauri/Cargo.toml` by the Tauri CLI was reverted).

**Method.** Eight fresh-context reviewers, one lens each, all read-only, each writing a full report (folder `reports/` next to this file: `frontend-architecture.md`, `performance.md`, `silent-failures.md`, `ux-a11y-copy.md`, `design-system.md`, `tests-ci-release.md`, `rust-backend.md`, `product-gaps.md`). In parallel I drove the running app on the Windows PC through every screen (40+ window captures at 4K, 1000 px and 800 px widths, folder `shots/`), ran a load test on the real 2,726-frame 2026-04-20 shoot, and spot-verified every headline claim in the source before accepting it. Oliver's rule "audit by provenance, fresh eyes" applied.

**Baseline.** `main` at `f0e6ce7`; 23,357 lines TS/TSX in 149 files, 8,589 lines Rust in 19 files, 3,858 lines CSS in one file; 487 Vitest + 109 cargo tests green; tsc, eslint, stylelint, clippy `-D warnings` all clean; bundle 118 KB gzip JS + 9.4 KB CSS.

---

## 1. Verdict

CULL is a genuinely professional piece of software with an unusually well-engineered core. The image pipeline, the rating-save path and the smart-culling scheduler are better than most commercial tools in this category. The measured speed on a real 2,726-frame shoot is excellent. The taste of the design is consistent and distinctive.

What holds it back is not the core but the seams and the system: (1) a small number of robustness gaps at the edges of the save path, one of which can silently orphan a rating; (2) the design is a *style* but not yet a *system*, so the same button exists twelve times and two verdict palettes ship at once; (3) the composition root and the keymap are large and the orchestration hooks are untested; (4) accessibility and reduced-motion are missing; (5) CI does not compile the macOS half or run the production build.

None of it is deep surgery. It is a clean-up and hardening pass, then visible design polish.

## 2. Scorecard

| Lens | Grade | One line |
|---|---|---|
| Speed (measured) | A | 2,726 frames staged in 0.5 s; first frame + strip in 2 s; deep analysis ≈ 20 frames/s; memory flat ≈ 600 MB |
| Pipeline architecture | A | store / presenter / decode pool read like a systems case study; blob lifecycle airtight; IPC is raw ArrayBuffer |
| Code cleanliness | B+ | layering is real, zero `any`/TODO, but App.tsx 2,501 lines, a 360-line key handler, three copies of the compare-decide sequence, one 3,858-line CSS file |
| Robustness | B- | one CRITICAL (orphaned sidecars after "move rejects"), sidecar moves untracked, full-res failures invisible, a failed `read_dir` reads as "unrated" |
| UX | B+ | fast, calm, one vocabulary; ESC model contradicts docs; no Home/End/PgUp; footer clips at 800 px; grid/strip cells fixed-size on 4K |
| Design language | B+ product / C system | taste consistent; two verdict palettes, 21 font sizes, 12 button recipes, `--fav` == `--accent`, Unicode glyph leaks |
| Accessibility | C+ | focus ring ≈ 1.3:1, no `prefers-reduced-motion`, no live regions, muted text 4.25:1 on surfaces |
| Tests & CI | B | 596 green tests with excellent hygiene; macOS never compiled in CI, no production build in CI, orchestration hooks untested, no branch protection |
| Rust backend | A− | Parser treats every byte as hostile, zero unwrap on user data, clippy clean. One narrow panic path, no fuzz harness, one undocumented hash-collision assumption. |
| Product / features | B− | Photo Mechanic speed and Aftershoot signals for free, but CR3-only, unsigned with no updater, no Rejects filter, and path-sorted instead of capture-time. |

## 3. Measured (Windows PC, local NVMe, 2026-04-20 shoot, 2,726 CR3, deep analysis on)

| Measurement | Result |
|---|---|
| Folder scan → staged screen | 0.5 s |
| Begin culling → first frame + full strip painted | ≤ 2 s |
| Deep-analysis progress | 13 % at 15 s, 34 % at ~40 s, 68 % at ~90 s → ≈ 20 frames/s → whole shoot ≈ 2.3 min |
| Working set (cull.exe) | 456 MB idle (19-frame session), 691 MB peak at t=2 s, 530–670 MB steady |
| CPU during analysis | 220 CPU-s in ~95 s wall ≈ 2.3 cores average, UI stayed responsive |
| On-disk cache growth | 58 MB → 1.4 GB in 90 s (preview warm-up on the local profile) |
| Sidecars written during the whole audit | 0 |
| Frontend bundle | 118.5 KB gzip JS, 9.4 KB gzip CSS, two woff2, two backdrop JPEGs |

Notes: the local profile warms the 1620 px preview of every frame into the 2 GB `prvw/` cache, so one big shoot fills it and a second big shoot evicts the first. Fine as a default, worth a conscious cap decision.

## 4. What is genuinely excellent (keep, and copy the pattern)

- `imageStore.ts`: priority lanes, bounded concurrency, generation guards, one documented eviction predicate, every `createObjectURL` paired with one revoke.
- `present.ts`: decode-gated, double-buffered, upgrade-only presenter with a one-frame decode race for scrubbing.
- `decodePool.ts`: documented WKWebView knowledge (no `createImageBitmap`, deferred `src=""` clear). Do not "simplify" it.
- IPC framing in `bundle.rs`: `u32 LE header + JSON + bytes` via `tauri::ipc::Response`, no base64.
- `xmp.rs` + `useRatingPersistence.ts` + `useQuitGuard.ts`: atomic temp+rename, per-path serial queue, retry schedule, exact per-path failure set, quit guard that reads live refs.
- `tier_cache.rs`: every corruption class refused, dropped and regenerated silently, with tests.
- `useFocusTrap.ts`, `RatingDot` (documented WCAG 1.4.1 decision), the five-state Smart empty state, the NAS-unreachable state machine.
- Schema-validated localStorage (`coerceSettings`, `parseStoredRecents`) with versioned migrations.
- The verdict-glyph system (solid = committed, dashed = suggested), `<fieldset>/<legend>` burst boxes, the single sourced zoom glide, tabular numerals everywhere, the champagne/sage/rose palette.
- Tests that cite the production bug they pin; injectable clocks; corpus tests that skip cleanly.

## 5. Findings

Severity: CRITICAL = user believes something saved that did not, or wrong data; HIGH = wrong or hidden state; MEDIUM = quality/maintainability; LOW = polish. "Verified" = I confirmed it in the source or on screen myself.

### 5.1 Robustness (silent failures)

- **CRITICAL, verified.** After "Move rejects" (subfolder or Trash) or "Copy keeps", nothing prunes or marks the moved frames in `images`; `write_xmp_rating_sync` / `clear_xmp_rating_sync` (`xmp.rs:84-170`) never check that the CR3 still exists. Re-rating a moved frame (stale grid cell, undo/redo replay) writes a real, orphaned `.xmp` in the old folder and reports "saved". Fix: prune/mark entries after a successful move, and have the write commands refuse when the source CR3 is missing.
- **HIGH, verified.** `file_ops.rs:112` and `:184`: the sidecar ride-along on move/copy/trash is `let _ = ...`, not counted in `errors`/`error_count`. A keeper can be exported without its rating with a 100 % success report. Fix: fold the sidecar result into the batch accounting.
- **HIGH.** `scan.rs:243-246`: a failed `read_dir` on one parent silently skips the folder; every frame in it reads back unrated and sinks to the end of the sort. `xmp.rs:187-193` folds all I/O errors into "no rating". Fix: report per-directory failures (ScanFailureCard-style), distinguish NotFound from other errors.
- **HIGH.** `stage.ts:50-71`: the 32 MP zoom tier's `error` status never reaches the UI; a failed full-res read is indistinguishable from "not loaded yet" in an app whose job is judging sharpness. Fix: a subtle "full-res failed, retry" affordance on the pane.
- **MEDIUM.** `useSessionLifecycle.ts:249`: the `cull:lastDir` localStorage write sits inside the scan's try/catch; a quota error is reported as a scan failure and the folder never stages. Fix: separate try.
- **MEDIUM.** Settings/recents `localStorage` write failures are swallowed with no signal; smart-culling chunk failures are logged only behind `cull:devhud`. Fix: one-time non-blocking notice; "N frames could not be scored" in the Smart empty state.

### 5.2 Performance

- **HIGH (measurable, not yet measured).** `useImageStoreWiring.ts:108-113`: the metadata sink calls `setMetadata` once per arriving thumbnail/preview, cloning the whole map each time, and `useSmartDerivations.ts:57-93` recomputes burst/similar/suggestions over the whole `images` array on every delivery. O(n²) across folder open; `ThumbStrip`, `CompareStrip`, `CompareView`, `ExifRail` are not memoized so they re-render per arrival. The measured open was still fast on this machine, so this is about headroom on slower machines and NAS. Fix: rAF-batched sink; `React.memo` the four components; verify with the React Profiler before/after (the codebase's own "cite numbers" rule).
- **LOW.** `midSweep.ts:127-144` rescans from index 0 per pick (already load-gated). `App.css:1522` animates `width` on the progress fill.
- Confirmed correct, leave alone: no `createImageBitmap`, `backdrop-filter` only on static modals, no code splitting at this bundle size.

### 5.3 Code cleanliness

- **MEDIUM.** `App.tsx` (2,501) still carries ~350 lines of decoupled JSX (quit-guard overlay 1236-1286, confirm-home 2121-2147, EmptyFilter family 2199-2361, RecentFolders 2373-2445, SaveStatusPill 2461-2501) plus the ~290-line status bar (1637-1926). Extraction map in `reports/frontend-architecture.md`. Realistic floor ≈ 1,800 lines of true composition-root wiring; do not force it under 800.
- **MEDIUM.** `useCullKeymap.ts:202-560`: one ~360-line `onKey`. Split into `handleModalKeys` / `handleCompareKey` / `handleSingleModeKey` along the existing comment boundaries, keeping the bind-once contract.
- **MEDIUM.** `useDecideCallbacks.ts:236-446`: `challengerLoses` / `challengerKeptBoth` / `challengerWins` repeat the same seven-step sequence whose ordering the file itself calls load-bearing. One helper, one comment.
- **MEDIUM.** `imageStore.ts:525-678`: `reset()` and `hardReset()` duplicate four revoke loops each. One `revokeReadyBlobs(map)`.
- **MEDIUM.** The safety-critical orchestration hooks (`useDecideCallbacks`, `useUndoRedo`, `useRatingPersistence`, `useSiteNavigation`, `useCullKeymap`) have zero direct tests; their comments cite real past crashes.
- **LOW.** Rust↔TS wire types (`meta.rs` ↔ `types/image.ts`, 19 fields) are synced by hand; consider `ts-rs`/`specta` if the surface grows. Three guarded non-null assertions could be narrowed.

### 5.4 UX and copy

- **HIGH, verified (deliberate, undocumented).** `useCullKeymap.ts:332-339`: ESC always opens "leave to home?" (comment: "stepping back site-by-site felt wrong"). README and ARCHITECTURE still describe the stack-based ESC. Side effect: no keyboard way to clear a grid multi-selection. Decide, then sync docs and add "ESC clears selection first" in grid.
- **MEDIUM, verified.** No Home / End / PageUp / PageDown in grid or strip (`{END}` did nothing in my run). Cheap, expected by every photographer.
- **MEDIUM, verified on screen.** At the app's own 800 px minimum width the footer clips ("SMART · 6" cut off) and the 290 px EXIF rail takes 36 % of the width with an inner scrollbar. `.cull-statusbar__left/right` are `nowrap` + `flex-shrink:0`. Fix: a collapse order (hide keyhint → icon-only finish → ellipsis filename), rail collapses to a compact mode below ~1100 px, or raise `minWidth` to 1024.
- **MEDIUM, verified on screen.** Grid cells (`GRID_CELL_TARGET = 168`) and strip cells (76×54) are fixed; on a 4K display at 150 % the loupe strip is a thin ribbon and the grid is a 14-column contact sheet with no way to enlarge. Fix: grid zoom (+/- or Ctrl+wheel, 3 sizes) and a strip height that scales with window height.
- **LOW, verified on screen.** Hold-Tab help dims the photo but leaves the focus-peaking stipple bright underneath (screenshot 30). Hide overlays under the help sheet.
- **LOW.** Ctrl+O only works on home/staged (by design); the only way to add a folder mid-cull is drag-drop. Worth a hint or enabling it in the cull view.
- **LOW.** Modifier glyph "⌃" on Windows (`utils/platform.ts:6`); Windows users read "Ctrl". README's Compare `f`/`k` rows do not describe the compound "keep both" action.
- Terminology is consistent (keep/reject/favorite/unrate; "folder" never "shoot" in UI); five near-synonyms for the smart feature (Smart / Suggestions / Deep analysis / analysis / analyzed) is the one glossary worth tightening.

### 5.5 Design language

- **HIGH, verified.** Two verdict palettes: `utils/ratingColor.ts:10-12` hardcodes Tailwind `#10b981 / #ef4444 / #f59e0b` (used by the compare `RatingDot` and the 48 px rating feedback pop) while every other verdict surface uses the tokens `#9ec5a4 / #c87f7f / #d4af6a`. Pressing Enter shows a saturated green pop next to a sage dot. 30-minute fix.
- **HIGH.** Zero `@media` blocks in 3,858 lines: no `prefers-reduced-motion` against 14 keyframes (6 infinite), including the 380 ms verdict flash on every rating keystroke.
- **HIGH.** Token layer is colour-only (15 properties). In practice: 21 font sizes (incl. 7, 8, 10.5, 11.5, 13.5 px), 18 letter-spacings, 33 spacing values, 11 radii (pill spelled `50%`/`999px`/`9999px`), 14 shadows, ~20 durations (`0.12s`/`120ms`/`150ms` for one intent), 16 z-index values, 39 distinct `rgba()` tints, 89 `font-family` declarations.
- **HIGH.** Per-screen re-styling: 12 button recipes, 11 chip/pill recipes, 6 keycaps, 2 dialogs + a hybrid patched with inline styles (`FinishDialog.tsx:405,412`), 3 identical shimmer blocks, 3 left-border notes, 2 progress bars, 2 spinners, 3 danger buttons. ≈ 600 lines fold into 8 primitives.
- **MEDIUM.** `--fav` and `--accent` are the same hex, so a favorite and "current" are the same colour; the accent also carries section labels, warnings and progress. `.cull-grid__multi-tint { inset: 3px }` vs cell padding 9 px: the selection tint overhangs by 6 px. Icons at 7 sizes / 5 strokes. Unicode ✓ ✕ ★ ⚠ ↓ ⟶ • still leak after the Lucide migration (staged tick, filter sub-chips, finish stat, warnings, EXIF stars).
- **MEDIUM.** Mono eyebrows use nine trackings; `#fff` on `--bad` is 3.1:1; the keyhint composites to 2.8:1; empty LrC stars at 1.16:1.
- **LOW.** File ordered by history, not surface. Backdrops: `desert.jpg` shipped in colour but always shown greyscale through a runtime `filter` on a fixed full-viewport pseudo-element; painterly meadow vs vector desert mismatch; no @2x; window `backgroundColor` `#000000` flashes before `#0c0c0d`. Dead: `.cull-pick-button--ghost`, `@keyframes cull-fade-in`, `.cull-statusbar__right span.is-active`, the invisible thumb-frame gradient. `user-select: none` on `html` blocks copying EXIF values and error text.
- Design walk (from the screenshots): home hero and meadow are strong; the recents row is tiny and left-of-centre on 4K. Staged screen is clear. Loupe chrome is the best surface in the app (instrument-panel rail, tabular EXIF, histogram). Grid on a big shoot with burst/similar boxes is informative but visually busy. Compare is clean. Settings is tidy but small at 4K (fixed 680 px) and its "CULL" wordmark in the dialog head is odd. Dialog title casing is inconsistent ("Settings" / "Finish session" / "leave to home?"; buttons "close", "stay", "Move rejects"). The keeps-empty illustration (birds over dunes) is lovely and in a different register from the meadow.

### 5.6 Accessibility

- **HIGH.** Focus ring `0 0 0 2px var(--accent-soft)` composites to ≈ 1.3:1; `.cull-winbtn:focus { outline: none }` with no replacement. Fix: `--ring: 0 0 0 2px var(--bg), 0 0 0 4px var(--accent)` once.
- **HIGH.** No `aria-live` anywhere except one `role="alert"`; rating/save/status changes are silent to assistive tech. Grid/strip cells are `role="button"` without `tabIndex`/Enter handling (name/role mismatch). Suggestion state is invisible to AT.
- **MEDIUM.** `--muted` on `--surface` 4.25:1 and on `--surface-2` 3.95:1 (settings help text, inactive tabs). Settings toggle 36×20 px hit target. Armed confirms ("Sure?") drop focus to the dialog root.

### 5.7 Tests, CI, release

- **HIGH.** `ci.yml` backend job runs on `windows-latest` only; the macOS-only code (`lib.rs:153`, `memory_pressure.rs:71`, `ml_models.rs:56`) first compiles at release-tag time.
- **HIGH.** CI never runs `pnpm build`, the command `release.yml` depends on.
- **HIGH.** `main` has no branch protection; CI is advisory.
- **MEDIUM.** `pnpm audit`: 23 dev-dependency findings; `pnpm update vite` (in range) clears the one on `vite@7.3.3`. `.dev-logs/` is ignored only via `.git/info/exclude` (I added that; belongs in `.gitignore`). One real-timer assertion (`imageStore.test.ts:1237`). No CHANGELOG. 43 MB dead ONNX blob in history ("forward-only" decision; only matters before a second clone).
- **MEDIUM.** No integration layer above the pure logic; the keyboard wiring in `App.tsx` is untested. Realistic path: Vitest + Testing Library + `@tauri-apps/api/mocks` `mockIPC` (the `invoke` seam already exists), not `tauri-driver`.
- Windows hygiene: `pnpm tauri dev`/`build` rewrites `src-tauri/Cargo.toml` with LF endings, so `git status` shows it modified after every run on Windows (`* text=auto` + `core.autocrlf=true`). Reverting it also restarts the dev app (the watcher sees the mtime change). Fix: `src-tauri/Cargo.toml text eol=lf` in `.gitattributes`.

### 5.8 Rust backend

**Verdict: A−, approve.** The parser treats every byte as hostile (bounds-checked accessors, `checked_add` on the 64-bit box size, scan caps on every grow loop); zero `unwrap`/`expect` on user data in `cr3.rs`, `xmp.rs`, `scan.rs`; clippy clean (two stylistic `as_chunks` hints); five `unsafe` blocks, all in `memory_pressure.rs` with SAFETY comments; release profile correct (no `panic=abort`, by design); 244 crates, all duplicates inside Tauri's own graph.

- **MEDIUM.** `analyze.rs:326` `af_crop`: `.clamp(1, w.min(h))` panics on a 0×0 decoded preview; today it is caught at the `spawn_blocking` boundary as a generic error. One-line guard.
- **MEDIUM.** No fuzz target for the CR3/JPEG parser. Cheap due diligence for hand-rolled offset arithmetic over untrusted bytes: a `cargo-fuzz` harness over `read_preview_bundle` / `full_jpeg_location`, seeded from the corpus.
- **MEDIUM.** `tier_cache.rs:95-102` keys entries by a 64-bit FNV-1a of the path with no collision defence and no comment. Store and verify the path on `get()`, or document the accepted risk.
- **MEDIUM (confirmed).** The two sidecar issues in 5.1: `let _ =` on sidecar ops in `file_ops.rs`, no existence check in `write_xmp_rating_sync`.
- **LOW.** `ort` pinned to `=2.0.0-rc.12` ships a native binary; watch it with `cargo-audit` or Dependabot. The leaked `Box<Ctx>` in `memory_pressure.rs` is deliberate and commented.
- Excellent and to be kept as the template: `bundle::gated` detach-and-self-heal for un-abortable reads; the tier cache's atomic publish with deletes outside the lock; `LazySession`'s silent-degrade advisory ML.

### 5.9 Product and feature gaps

**Verdict: B− as a product a stranger would install; A for the niche it serves today** (Oliver's exact profile: Canon-only, keyboard-first, high-volume, culls before Lightroom, no subscription, no cloud). Full matrix against Photo Mechanic, FastRawViewer, Narrative Select, Aftershoot, Imagen, FilterPixel, Lightroom Classic and Capture One in `reports/product-gaps.md`.

**Already better than every competitor:** time to first frame (no import, project or upload; only Photo Mechanic at $149/yr is in this class); free local ML with a hard advisory line (Narrative and Aftershoot charge $10–60/month, Imagen uploads to the cloud); XMP safety (never overwrites LrC stars, OS Trash only, compound undo); NAS honesty; keyboard craft.

**P0 misses (blockers for anyone who is not Oliver):**
- CR3-only. Every competitor opens every raw.
- Unsigned installers, no updater, no crash reporting; Apple Silicon only.
- **No Rejects filter, verified.** The `Filter` union is all / unrated / keeps / smart, so the reject pile cannot be reviewed before "Move rejects" or Trash acts on it. Every other tool has this; it is a safety expectation.
- **Path-sorted, not capture-time-sorted, verified.** `scan_folder` sorts lexicographically. Two bodies at one event interleave wrongly and burst grouping across folders suffers. Small fix (`captured_at + sub_sec_ms`, per-folder offset).

**P1 (expected on day one by anyone from PM, FRV, LrC, C1):** stars and colour labels as first-class verdicts (the private `cull:fav` marker is invisible in Lightroom); video rows that ride along on move/copy; Lightroom/Capture One handoff and "reveal in Explorer"; ingest; batch rename and IPTC/copyright stamping; dual monitor; custom keymap (keys hard-coded, non-US layouts partly handled); GPS parsed in `meta.rs` but never shown; N-up survey and a face close-ups panel from the existing YuNet boxes.

**Expansion routes for formats:** (a) hand-rolled TIFF/IFD preview extractors behind a `RawReader` trait, reusing the `Tiff` reader already in `cr3.rs` (CR2 S, Sony ARW S for the nav tier, DNG S–M, Nikon NEF M, Fujifilm RAF M), MIT-clean, no C dependencies, each with a corpus test; (b) `rawler` (pure Rust, LGPL, decodes rather than splices) behind a feature flag only for true 1:1 zoom on formats without a full-size embedded JPEG. Cost either way: the pipeline hard-codes PRVW assumptions (1620×1080 hysteresis, the ~2 MiB head read, the moov zoom range, tier-cache header v3).

**Risks:** CR3 baked into the invariants; the closed three-state `Rating` type through TS, XMP, filters, undo and smart verdicts (migrate before other people's sidecars exist); the singleton store makes a second window expensive; the parser is validated on one body (C-RAW, HDR PQ CR3 unverified); DNG's in-file metadata conflicts with "never touch the raw"; advisory-only reads as timid next to Aftershoot unless bulk acceptance is one keystroke; `ort` rc pin and 220 MB of models with no telemetry.

## 6. Plan (proposed, nothing started)

Ordered by Oliver's priority one, "clean and optimized", then what he sees.

**Phase 0 — Safety (S, ~1 day).** Prune/mark moved frames + existence check in the XMP writes; sidecar move accounting; surface zoom-tier and `read_dir` failures; `lastDir` write out of the scan try; guard `af_crop` against a 0×0 preview (the one real panic path); `.dev-logs/` + `Cargo.toml eol=lf` in the repo; `pnpm update vite`. Tests for each. Ship as one PR.

**Phase 1 — Clean (M, 3–4 days).** Extract the seven App.tsx pieces (~350 lines) and the status bar; split `onKey`; dedupe the compare-decide trio and the revoke loops; add the tier-2 token sheet; split `App.css` into `styles/` by surface; build the eight primitives and delete the copies; one verdict palette; delete dead CSS; stylelint guards so drift cannot return; sync README/ARCHITECTURE with the real ESC model. Each step is a separate, reviewable commit; behaviour unchanged; screenshots before/after.

**Phase 2 — Optimize (S, ~1 day).** Batch the metadata sink; memoize the four top-level components; measure with the dev HUD + React Profiler on the 2,726-frame shoot before and after; publish the numbers in the plan doc. Optional: `midSweep` pointer, progress-fill transform.

**Phase 3 — Visible polish (M, 3–4 days).** Reduced-motion; the focus ring; contrast lifts; grid zoom sizes and strip height scaling for 4K; footer collapse order and/or `minWidth` 1024 with a compact rail; Home/End/PgUp/PgDn; help sheet hides overlays; "Ctrl" on Windows; `--fav` distinct from `--accent`; icon size/stroke scale; finish the Unicode → Lucide migration; fix the grid tint inset; bake the backdrops (+ @2x, matching register) and set the window colour; a Rejects filter tab so the pile can be reviewed before it is moved; capture-time sort with a per-folder offset for two bodies; dialog casing consistency; small copy pass. Review each screen against the audit screenshots.

**Phase 4 — Tests & CI (M, 2 days).** Regression tests for the compare-decide trio and undo/redo; mocked-IPC keyboard-wiring tests; macOS `cargo check` leg; `pnpm build` in CI; audit step; a `cargo-fuzz` harness over the CR3 parser and property tests for the XMP string surgery; CHANGELOG; branch protection decision.

**Phase 5 — Expansion (needs decisions, see questions).** Candidates from the product review, in the order they compound: signed installers + updater + opt-in crash reporting (S–M); a `RawReader` trait with hand-rolled CR2 / ARW / DNG extractors reusing the TIFF reader in `cr3.rs` (M–L); stars and colour labels as first-class verdicts plus keymap presets (M); video rows that ride along on move/copy (M); dual monitor (M, the singleton store makes it real work); a one-key "accept all high-confidence reject suggestions" that keeps the advisory line (S).

Total for phases 0–4: roughly two focused weeks of sessions, each phase independently shippable.

## 7. Open questions for Oliver

1. Start order: Phase 0 + 1 first (safety, then the clean-up you asked for as priority one), or do you want a visible design phase early to keep it exciting?
2. ESC: keep your "always leave-to-home" choice and fix the docs (plus "clear grid selection first"), or bring back the site back-stack?
3. Expansion appetite: stay Canon CR3-only (your kit) or is broader RAW support on the table? Star ratings / colour labels as first-class verdicts, or keep the three-state model? The product review calls formats and signing the two P0 blockers for anyone who is not you.
4. Accessibility depth: full pass (live regions, operable cells) or the visible minimum (reduced motion, focus ring, contrast)?
5. Audit doc home: commit this document to `docs/superpowers/audits/` as the first commit of Phase 0?

## Appendix — verification log

Confirmed in source by me: ESC comment (`useCullKeymap.ts:332-339`), Ctrl+O phase gate (`:160-166`), no Home/End bindings, `write_xmp_rating_sync` has no existence check, `doMoveRejects` never prunes, `metaSink` per-delivery `setMetadata`, `let _ =` sidecar ops, `GRID_CELL_TARGET = 168`, strip `CELL_W/H = 76/54`. Confirmed on screen: footer clip at 800 px, rail overflow at 800/1000 px, peaking visible under the help sheet, fixed cell sizes at 4K, Smart progress in the tab label, no sidecars written (checked after every step).

## 8. Decisions (Oliver, 2026-09-14)

- Start order: Phase 0 Safety, then Phase 1 Clean; visible polish after.
- ESC: keep "always leave-to-home"; add "ESC clears a grid selection first"; rewrite README and ARCHITECTURE to match.
- Scope: stay Canon CR3-only. Phase 5 = signed installers + updater (+ opt-in crash reporting). Stars and colour labels: later, Phase 5, as an optional layer on top of keep/reject, only if the workflow uses them.
- Accessibility: visible minimum (reduced-motion, focus ring, contrast). No live regions or operable cells for now.
- This document is committed to `docs/superpowers/audits/` as the first commit of Phase 0.
- Formats, final: CR3 only. The cost of other cameras was discussed (previews route ≈ 2 weeks with a RawReader seam; true 1:1 for Sony/Fuji needs a raw decoder). CR2 declined too.
