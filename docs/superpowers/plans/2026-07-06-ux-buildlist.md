# UX Build List (12 approved items) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the 12 approved items from the 2026-07-06 whole-app UX review (decision board final).

**Architecture:** All frontend work lands in the existing `src/App.tsx` monolith + focused components, following current patterns (pure helpers extracted to `src/utils/` where testable). Two Rust changes: `scan_folder` gains an ignored-file count, `file_ops.rs` gains a trash command via the `trash` crate.

**Tech Stack:** Tauri 2, React 19 + TS (vitest), Rust (cargo test). Suites must stay green: `pnpm test` (389), `pnpm tsc --noEmit`, `cargo test` in `src-tauri` (95).

## Global Constraints

- NO em-dashes in any user-facing string (Oliver's copy rule). Terse, professional copy; no over-explaining.
- Advisory-only invariant: nothing in the smart layer ever writes ratings/files.
- Never permanent-delete: trash = OS Trash/Recycle Bin only.
- Old sidecars say `CreatorTool="Cull 1.0"`; detection must keep matching them after the rebrand to `CULL`.
- App is Windows (primary) + macOS. No Linux handling.
- Commit after each task, conventional commits, no attribution footer.

---

### Task 1: Identity cleanup (item 9)

**Files:**
- Modify: `index.html:6` (title), `src-tauri/tauri.conf.json:30-31` (publisher/copyright), `src-tauri/src/xmp.rs` fresh_xmp + detection, `src/components/SettingsDialog.tsx:56` (header meta).

**Steps:**
- [ ] `index.html`: `<title>CULL · spike</title>` → `<title>CULL</title>`.
- [ ] `tauri.conf.json`: `"publisher": "Olive"` → `"Oliver Søgaard-Andersen"`, `"copyright": "© 2026 Olive"` → `"© 2026 Oliver Søgaard-Andersen"`.
- [ ] `SettingsDialog.tsx`: `<span className="cull-settings__head-meta">CULL 1.0</span>` → `CULL` (no version).
- [ ] `xmp.rs` TDD: add test `detects_both_old_and_new_creator_tool` asserting `is_cull_authored`-style check matches `CreatorTool="Cull 1.0"` AND `CreatorTool="CULL"`. Change line 295 `xmp.contains("CreatorTool=\"Cull")` to also match new casing: `xmp.contains("CreatorTool=\"Cull") || xmp.contains("CreatorTool=\"CULL")`. Change `fresh_xmp` to `x:xmptk="CULL"` / `xmp:CreatorTool="CULL"`. Update existing tests that assert the literal.
- [ ] Run `cargo test` + commit `chore: identity cleanup (title, publisher, CreatorTool=CULL)`.

### Task 2: Copy sweep (item 7)

**Files:** `src/App.tsx`, `src/components/SettingsDialog.tsx`, `src/components/FinishDialog.tsx`, any other user-facing strings with em-dashes.

**Steps:**
- [ ] Grep all user-facing strings (JSX text, `title=`, help copy) for `—`; rewrite each without it, terser. Known sites: overlay chip titles (`"i — info"` → `"i · info"` etc.), multi-select title, unsaved titles (footer + SaveStatusPill), finish button title, trouble-chip tooltips, smart empty states (`"Analysis done — no suggestions left here (N scored)"` → `"Analysis done. No suggestions left here (N scored)"`; `"Looking for obvious calls — X of Y scored"` → `"Looking for obvious calls · X of Y scored"`; hint `"fills in as frames are scored — culling always takes priority"` → `"fills in as frames are scored · culling comes first"`), FinishDialog pending line.
- [ ] Code comments keep their em-dashes (not user-facing).
- [ ] `pnpm test` + tsc + commit `copy: no em-dashes in UI strings, terser wording`.

### Task 3: One name for favorites (item 8)

**Files:** `src/components/SettingsDialog.tsx:97`.

**Steps:**
- [ ] `{ value: "keepsFavs", label: "Favorites" }` → `{ value: "keepsFavs", label: "Keeps · ★" }`.
- [ ] Commit `copy: default-filter option matches the footer name (Keeps · ★)`.

### Task 4: Deep analysis default ON (item 4)

**Files:**
- Modify: `src/types/settings.ts` (rename field `smartCullingML` → `deepAnalysis`, default `true`), `src/hooks/useSettings.ts` coerce (read `deepAnalysis`, fall back to legacy `smartCullingML` value? NO: board decision = force ON for existing users; legacy key ignored), `src/components/SettingsDialog.tsx` (label "Deep analysis", help copy), `src/App.tsx:207` (`ml: settings.deepAnalysis`).
- Test: `src/hooks/useSettings.test.ts`.

**Interfaces:** Produces `Settings.deepAnalysis: boolean` (default true). `useSmartCulling` input `ml` unchanged.

**Steps:**
- [ ] TDD in `useSettings.test.ts`: coerce of `{}` yields `deepAnalysis: true`; coerce of `{ smartCullingML: false }` (legacy blob) yields `deepAnalysis: true` (legacy key deliberately dropped); coerce of `{ deepAnalysis: false }` yields `false`.
- [ ] Rename field; SettingsDialog row label **Deep analysis**, help ON: `"Face and eye checks, look-alike grouping, starred picks. Runs locally."` (unchanged text is fine, already em-dash-free) / OFF: `"Sharpness, exposure, and burst analysis only."`; toggle aria-label "Deep analysis".
- [ ] Commit `feat: deep analysis (ML) on by default, renamed from Face analysis`.

### Task 5: Non-CR3 ignored line (item 5)

**Files:**
- Modify: `src-tauri/src/scan.rs` (return `ScanResult { paths: Vec<String>, ignored: u32 }`, count non-CR3 *files* the walk sees), `src/App.tsx:745,847` (both `invoke` call sites), staged screen line 3128-3141, new state `lastIgnored`.
- Test: scan.rs unit test.

**Interfaces:** Wire: `scan_folder` now returns `{ paths: string[], ignored: number }` (serde camelCase).

**Steps:**
- [ ] TDD Rust: folder with 2 `.cr3` + 3 other files → `paths.len()==2, ignored==3`. Change collect to partition on extension.
- [ ] Frontend: type `ScanResult = { paths: string[]; ignored: number }`; retry probe uses `.paths` (just needs success); open loop sums `ignored` into new `lastIgnored` state (reset per batch alongside `lastAdded`).
- [ ] Staged screen: after the `+N from …` line add, when `lastIgnored > 0`: `<div className="cull-staged__ignored">{lastIgnored.toLocaleString()} non-CR3 file{s} ignored</div>` (muted styling, new small CSS rule).
- [ ] `cargo test` + `pnpm test` + commit `feat: staged screen counts ignored non-CR3 files`.

### Task 6: Finish moment (item 6)

**Files:** `src/App.tsx` footer right side (~3698), `src/App.css` (pulse-accent class).

**Steps:**
- [ ] When `stats.unrated === 0 && stats.total > 0 && !actionsOpen`, the finish button upgrades: className gains `is-done`, label becomes `All {stats.total} rated · {modGlyph}E finish` (keeps count already in dialog). CSS: `.cull-statusbar__finish.is-done` gets accent border/glow.
- [ ] Commit `feat: finish moment when every frame is rated`.

### Task 7: Save indicator split (item 11)

**Files:** `src/App.tsx:3765-3769` (remove SaveStatusPill from cull top bar; chrome screens keep theirs at 3034).

**Steps:**
- [ ] Delete the `<SaveStatusPill …/>` in the culling-phase header. Footer already shows `saving N…` / `⚠ N unsaved · retry` (lines 3531-3541).
- [ ] Commit `feat: footer owns the save indicator while culling; top pill is home-only`.

### Task 8: Teach the keyboard (item 1)

**Files:**
- Modify: `src/App.tsx` (footer chip + first-run auto-help), `src/components/ThumbCell.tsx` (ghost dot title), `src/components/GridView.tsx` (same), `src/components/verdictGlyph.tsx` if needed, `src/App.css`.

**Steps:**
- [ ] Footer chip: in `.cull-statusbar__right`, before position counter, a muted mono chip `tab · keys` (non-interactive, `aria-hidden`, hidden in compare? No: show everywhere culling).
- [ ] First-run: `localStorage["cull:helpSeen"]`; on entering culling phase the first time ever (`!localStorage.getItem("cull:helpSeen")`), `setHelpVisible(true)` + set the key; ANY keydown or 6s timer dismisses (Tab-release path already dismisses; add a one-shot effect).
- [ ] Ghost tooltips: ThumbCell + GridView ghost dot get `title={`suggested ${verdictWord} · ${Math.round(confidence*100)}% · ${reasons.join(", ")}`}` from the `suggestion` prop (needs `pointer-events` NOT none on the dot; check CSS).
- [ ] Commit `feat: keyboard discoverability (tab chip, first-cull help, ghost tooltips)`.

### Task 9: Select all + Smart count (item 2)

**Files:**
- Modify: `src/App.tsx` keymap (⌘A in grid; shift+arrows in grid extend selection), Smart tab label (~3640), HelpOverlay grid section.
- Test: extract pure helper `src/utils/gridSelection.ts` with `extendSelection(visible, anchor, from, dir)` + tests.

**Steps:**
- [ ] TDD `gridSelection.ts`: pure function for shift+arrow range growth over `visibleIndices` (anchor-based, mirrors shift-click semantics).
- [ ] Keymap: before the generic ctrl/meta swallow (line 2663) add: `if ((e.ctrlKey||e.metaKey) && (e.key==="a"||e.key==="A") && gridVisible) { e.preventDefault(); setSelectedIndices(new Set(visibleIndices)); setSelectionAnchor(visibleIndices[0] ?? null); return; }`.
- [ ] Shift+Arrow in grid: in Arrow cases, when `e.shiftKey && gridVisible`, extend selection by one cell (or one row for up/down) from anchor and move cursor, instead of `clearMultiSelection()`.
- [ ] Smart tab count: when NOT analyzing and suggestions exist, label `Smart · {liveCount}` where `liveCount = visible count under 'suggested'` (memo: `Object.keys(suggestions).filter(id => !ratings[id]).length`). Falls back to `Smart` at 0.
- [ ] HelpOverlay grid: add `⌘+a select all` + `⇧+←→↑↓ grow selection` rows.
- [ ] Commit `feat: grid select-all + keyboard selection; Smart tab shows live count`.

### Task 10: Keep both in compare (item 3)

**Files:** `src/App.tsx` (new `challengerKeptBoth(favorite: boolean)` callback modeled on `challengerLoses`, keymap `k`/`f` in compare), `src/components/HelpOverlay.tsx` compare "decide" group.

**Steps:**
- [ ] New callback: challenger → `favorite ? "favorite" : "keep"`, champion untouched, champion STAYS champion, advance to next unrated; single undo entry with cursor snapshots exactly like `challengerLoses` (auto-exit via `goBack(championIndex)` when none left).
- [ ] Keymap compare block: `case "k": case "K":` → `challengerKeptBoth(false)`; replace the disabled-`f` comment with `case "f": case "F":` → `challengerKeptBoth(true)` (both `!e.repeat && !isZoomingRef.current`).
- [ ] HelpOverlay compare decide: add `["k", "keep both"]`, `["f", "keep both + favorite"]`.
- [ ] Commit `feat: compare gains keep-both (k) and favorite-challenger (f)`.

### Task 11: Trash rejects (item 12)

**Files:**
- Modify: `src-tauri/Cargo.toml` (add `trash = "5"`), `src-tauri/src/file_ops.rs` (new command `move_rejects_to_trash`), `src-tauri/src/lib.rs` (register), `src/components/FinishDialog.tsx` (destination radio in MoveRejectsRow), `src/App.tsx` (handler passes destination).
- Test: file_ops.rs (batch mechanics via injected op — real trash not testable in CI; test the batch path with a rename-op stub).

**Interfaces:** `move_rejects_to_trash(paths: Vec<String>) -> FileOpResult`. Reuses `batch_files`-style iteration but destination-less: for each path, trash CR3 then its sidecar; skipped = source gone.

**Steps:**
- [ ] Rust TDD: `trash_batch(paths, trash_fn)` helper — completed/skipped/error semantics mirror `batch_files` (source missing → skipped; error capped). Command wraps with `trash::delete`.
- [ ] FinishDialog MoveRejectsRow: radio pair above the button: `◉ Move to {sub}/` (default) / `○ Move to system Trash` (help: "Recoverable from the Trash."); armed copy switches (`"Sure? This moves N files to the Trash."`); button label `Move rejects`.
- [ ] App: `handleMoveRejects(dest: "subfolder" | "trash")` → existing invoke or new one.
- [ ] `cargo test` + commit `feat: rejects can move to the system Trash (never permanent delete)`.

### Task 12: Contrast pass (item 10)

**Files:** `src/App.css`.

**Steps:**
- [ ] Bump `--muted: #6c6c74` → `#7c7c86` (≈4.5:1 on #0c0c0d). Visually verify nothing washes out (muted is used for hints/eyebrows).
- [ ] Commit `style: muted text one step brighter (readable info, dim hints)`.

### Final gate
- [ ] `pnpm test` + `pnpm tsc --noEmit` + `cargo test` + `pnpm build` green; update SMART_CULLING_PLAN.md? No — this is post-plan polish; add a dated note to the decision-board memory instead. Ask Oliver before any push.
