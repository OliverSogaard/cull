# Grand Cleanup Plan — the final production pass

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans.
> Execute ONE PHASE PER SESSION, Oliver gating between phases (his dev app
> hot-reloads for live visual gates). Approved scope decisions by Oliver
> 2026-07-07 (see Decisions). Never push without his say-so. Dated
> implementation notes get appended to this doc as phases complete.

**Goal:** Take the feature-complete CULL repo (origin/main `89bd192`) through
its final production pass — dead/stale code out, remaining parallel code
blocks unified, App.tsx and imageStore decomposed, professional tooling and
CI added, docs rewritten — without regressing a single timing-sensitive path.

**Architecture of the work:** Ten phases ordered safest-first (docs/config →
tooling → dead code → mechanical backend fixes → legacy excision → structure
→ behavior-risk unifications last). Every phase ends suites-green
(`pnpm test` 414+, `cargo test` 103+, `tsc` clean) and independently gated;
phases 6–9 additionally carry Oliver's live visual gates.

**Tech stack:** React 19 + TS 5.8 (strict) + Vite 7 + Vitest; Tauri 2 pure-Rust
backend; pnpm. Windows (primary) + macOS ONLY — Linux is compile-blocked.

## Decisions (Oliver, 2026-07-07)

1. **Legacy `read_bundle`/`navLegacy` path: REMOVE** (Phase 5).
2. **License: MIT + third-party model attribution** (Phase 1).
3. **`dinov2s.onnx` (43 MB in git): offload forward-only** to the `models-v1`
   release via `fetch-models.sh`; NO history rewrite (Phase 10).
4. **All three behavior-risk refactors in scope** — imageStore TierLane
   collapse, held-scrub hook, zoom+keymap extraction — sequenced last,
   individually gated, each skippable if its gate wobbles. Claude's honest
   ranking: TierLane and held-scrub are clearly worth it; the zoom-choreography
   extraction is the first to drop if a gate misbehaves (Phase 7 marks it).

## Global constraints (from the brief — non-negotiable)

- **Analysis session changed no code.** Execution happens in later sessions, one phase at a time, Oliver gating.
- **War-story comments are load-bearing.** WKWebView paint bugs, jetsam, decode races, macOS key quirks stay documented in place. Stale/lying comments go; institutional memory stays.
- **Timing-sensitive paths need proof, not confidence:** presenter double-buffer (mid-scrub offers sequenced best-first), zoom choreography, io_gate/decode pool, tier cache VERSION contract. Every step touching them is flagged **[LIVE GATE]**.
- **Windows + macOS only.** Never add Linux handling.
- Each phase: suites green + `tsc` clean before hand-back. Prefer skipping a low-value risky cleanup over chasing "minimal" into a regression.
- Copy rule (2026-07-06 buildlist): no em-dashes in user-facing strings.

---

# Findings inventory (2026-07-07 analysis session)

Six parallel read-only explorers + tooling (knip, ts-prune, depcheck, cargo
clippy/machete/audit, rustfmt, clippy-pedantic triage). Summary with evidence;
each finding is picked up by a numbered phase or listed as no-action.

## Already clean (verified — no action)

- **depcheck: zero unused npm deps. cargo-machete: zero unused crates.** Dependency diet already done; every Cargo dep carries a justifying comment.
- **Test suites verified exactly**: 414 TS (413 static + `test.each` at `groupBursts.test.ts:81`) and 103 Rust. **Zero** skipped/only/todo/ignored tests, zero dead tests, low implementation-detail coupling.
- **TS strictness: `strict: true`, and the non-test code is literally `any`-free** — 0 `: any`, 0 `as any`, 0 `@ts-ignore`/`@ts-expect-error`; 5 justified `eslint-disable` comments.
- **`[profile.release]` fully tuned** (`Cargo.toml:76-81`): opt-level 3, `lto = true`, `codegen-units = 1`, `strip = true`, deliberate **no** `panic="abort"` (documented at `Cargo.toml:73-75` — decode panics must unwind out of `spawn_blocking`). Brief item "release build profile" is already done.
- **Tauri capabilities minimal and tight** (`capabilities/default.json`): core window perms + dialog only; no fs/shell/http exposure to the webview — all fs goes through typed commands.
- **XMP write safety exemplary**: temp sibling + `sync_all` + rename (`xmp.rs:50-71`), process-wide temp seq (`xmp.rs:46`), orphan sweep exact-shape-matched (`scan.rs:186-200`), destructive paths gated on `authored_by_cull` (`xmp.rs:299-308`, regression-tested).
- **No production `unwrap`/`expect` in Rust hot paths** (two documented-unreachable semaphore expects: `io_gate.rs:104`, `midtier.rs:167`; one real gap at `scan.rs:307`, fixed in Phase 4).
- **Unification already done, hold as reference (do-not-touch):** the strip family (`PhotoStrip.tsx` is THE strip; Thumb/CompareStrip are thin `renderCell` wrappers — `ThumbStrip.tsx:49-71`, `CompareStrip.tsx:57-84`), spinners/shimmer/error surfaces (PhotoPane owns them for loupe+compare, `PhotoPane.tsx:382-416`), settings knob primitives (`SettingsDialog.tsx:314-408`), empty states (`NoMatchEmptyState` + `pickSmartEmptyState`).
- **`smart-ml` IS a default feature** (`Cargo.toml:22`, Oliver's 2026-07-06 decision) — releases ship with ML active; the "release builds have no ML" caveat inside SMART_CULLING_PLAN.md is stale doc, fixed in Phase 1.
- **No zombie feature flags, no dead localStorage keys** (8 keys, all paired or intentionally one-directional: `cull:lastError` write-only by design for the crash screen, `cull:recents:v1` read-only migration key — keep, `cull:devhud`/`cull:devlog` dev flags).
- **dlog probe families stay.** All 14 sites gated on `cull:devlog` (one cached boolean when off). `present`/`pool` probes belong to the mid-dims WKWebView blob-poisoning investigation whose **remedy A is still open** (`usePresent.ts:13`); `thumb-flash` is left armed for the paint-level variant "only live confirmation can catch". Rust `dlog!` compiles to a no-op in release (`lib.rs:36-45`).
- **Frontend bundle ~116 KB gzip** — under the 150 KB landing budget; lucide-react tree-shakes; no lazy-load candidate is worth the seam. No action.
- **Re-render/efficiency**: nothing measured-bad. `positionInFilter` already memoized against per-scrub O(n) (`App.tsx:573`); presenter hot path deliberately allocation-lean (`present.ts:219`). Two bounded curiosities noted as optional (Phase 10): `pickMidSweep` O(n) rescans (idle+local-gated, `imageStore.ts:1591`), `invalidate` allocation on eviction loops (`imageStore.ts:892-918`).

## Findings by brief area (→ phase)

1. **Dead & stale** → Phases 3, 5. Confirmed dead: `EYES_OPEN_MIN` re-export (`groupBursts.ts:4` — defined in `pickWinner.ts:4`); 4 unused CSS selectors (`App.css:245, 250, 1816, 2048`); duplicate `.cull-grid__placeholder-name` rule (`App.css:3262` + `3267`). knip's 21 "unused exports" are mostly over-exported in-module constants (export-keyword sweep, not deletions). Stale comments: `App.tsx:96-99` (describes measure work that moved to PhotoPane), orphaned JSDoc stack `App.tsx:4276-4302`, dangling burst-membership JSDoc `ThumbCell.tsx:29-31` + doubled block `:21-24`, two eviction paths both labeled "REVOKE SITE 2" (`imageStore.ts:1191` vs `1636`), Rust plan-relative comments ("mid/ reserved for Phase 8" `tier_cache.rs:5`; `read_bundle` "dies in Phase 3" `bundle.rs:19-20,122` — resolved by Phase 5's excision). Misplaced fixture: `src/smart/testScores.ts` (test-only, sits in prod tree). **`isLegacyNav` is NOT statically dead** — but flips only on unknown-command version skew (`bundle.ts:52-60,95-97`), impossible in a bundled build → Phase 5 excision per decision 1.
2. **Unification** → Phases 3 (trivial), 8, 9. Real candidates: the four imageStore tier lanes (~85% duplicated pump/load/evict quads: `imageStore.ts:926/1071/1246/1419`, `:944/1095/1261/1434`, `:1197/1322/1510`), held-scrub twin rAF loops (`App.tsx:2478-2536` vs `:2562-2624`, only the step call differs), `decode_rgb` ritual ×4 (`bundle.rs:277-284`, `:703-710`, `midtier.rs:87-97` + test copies), tier_cache prelude validation ×2 (`tier_cache.rs:220-229` vs `:355-360`), verdict-glyph mapping ×3 (`verdictGlyph.tsx:12-23`, `RatingDot.tsx:29-35`, `App.tsx:3717-3721` byte-identical to `verdictGlyph(r, 9)`), `stripExtName` reimplements `stripExt` (`ExifRail.tsx:380-383` vs `utils/path.ts:23`), clip/peak overlay effect twins (`App.tsx:1532-1561` vs `:1564-1588`), armed-confirm ×3 (`FinishDialog.tsx:451-455` ≈ `SettingsDialog.tsx:559-563`), refcount trios + pendingZoom/pendingMid deferral twins in imageStore, Rust test fixtures (`synth_rgb`/`synth_jpeg` in `bundle.rs:784-803` + `midtier.rs:196-215`; `Lcg` in `phash.rs:116` + `analyze.rs:559`). **Intentional divergence — do-not-touch:** GridView's per-row burst segmentation (`GridView.tsx:272-334`; wrapping rows can't use the strip's linear segmenter), inline-vs-worker overlay paths (Canvas vs OffscreenCanvas, already share the scan kernels).
3. **Structure & size** → Phases 6, 7, 8. `App.tsx` 4,592 lines (component spans 129–4274) with clean seams mapped (see Phase 6); `imageStore.ts` 1,849 with four extractions mapped (Phase 8); `App.css` 3,826 (sectioned, fine after the dead-selector sweep); Rust modules all justified at size (optional `cr3/exif.rs` split listed under Phase 10 as skippable).
4. **Minimality & efficiency** → mostly already-clean (above); real items: clippy's 7 default warnings, `cargo update` for the transitive quick-xml advisories (RUSTSEC-2026-0194/0195 via plist←tauri, low exposure), Google Fonts fetched over the network at every launch (`index.html:8-10` — offline app), `backdrop.jpg` 519 KB shipped, `app-icon.png` 1.29 MB source art at root.
5. **Consistency & standards** → Phase 2. No eslint/prettier/stylelint configs exist; rustfmt is clean except `examples/decode_probe.rs`; clippy-pedantic triage: 73× `cast_possible_truncation` (image math — allow), small useful tail. Author is placeholder `"Olive"` in `package.json:6` + `Cargo.toml:4` while `tauri.conf.json` has the real publisher.
6. **Documentation** → Phase 1. README: no feature overview/screenshots, smart culling never mentioned, `scripts/` invisible, stale project-layout tree (lists 7 of 17 Rust modules, omits `src/image|smart|hooks|overlays`). ARCHITECTURE.md: same module-map gaps, no smart-culling section, tier-cache heading still "(v2)" while `VERSION = 3` (`tier_cache.rs:47`). Four root plan docs are completed history → archive. Calibration harness (`CULL_CALIB=1`, `CULL_TEST_CR3_DIR`, `CULL_TEST_CR3`, `CULL_BENCH=1`, LrC fixture path-gate `xmp.rs:705`) documented only inside plan docs → TESTING.md.
7. **Repo & CI hygiene** → Phases 1, 2, 10. **No LICENSE** (and bundled Apache-2.0/MIT models want attribution). **No CI on push/PR at all** — release.yml (tag-only) is the sole workflow; nothing runs the suites. No `.gitattributes`. `dinov2s.onnx` 43 MB tracked. `pnpm-workspace.yaml` is really pnpm build-approval config (fine, comment it). Untracked: this brief + this plan.
8. **Test-suite health** → Phase 4. Healthy (above). Cheap pure-logic gaps: `maskScans.ts`, `burstInputs.ts`, `utils/zoom.ts`, `zoomTransition.ts`, Rust `analyze_folder` sort comparator + orphan-temp sweep, `meta::From` round-trip. Tests are excluded from `tsc` (`tsconfig.json` exclude) — add a typecheck lane.
9. **Robustness/security** → Phase 4. **Blocking-in-async**: `write_xmp_rating` (`xmp.rs:75`), `clear_xmp_rating` (`xmp.rs:113`), `scan_folder` (`scan.rs:80`), `analyze_folder` (`scan.rs:158`) run sync fs (incl. fsync-over-SMB) on the async runtime — violates the crate's own invariant (`lib.rs:22-23`). `scan.rs:307` `join().unwrap()` can propagate a worker panic. CSP is `null` (`tauri.conf.json:26`) — set one (blob:-aware; the app lives on blob URLs). XMP path handling: app-originated paths only (walk has `follow_links(false)`), no traversal guard needed — documented as accepted trust model.

---

# Do-not-touch list

Changing anything here requires its own brainstormed plan + live gates; this
cleanup does not touch them beyond verbatim moves explicitly listed in phases:

1. **Presenter double-buffer semantics** (`present.ts` + `usePresent.ts`): decode-gated offers, upgrade-only, nav-token stale-drop, mid-scrub one-frame race, no-`.finally` microtask discipline (`present.ts:219`).
2. **io_gate DETACH+IGNORE timeout philosophy** (`io_gate.rs:17-25`, `bundle.rs:64-70`), orphaned-permit self-heal (`bundle.rs:97-108`), wholesale semaphore swap (`io_gate.rs:82-94`).
3. **tier_cache VERSION contract + ACCEPTED RACE** (`tier_cache.rs:39,47,18-20,176-182`). Phase 4's `prelude_matches` helper unifies two *existing* checks byte-for-byte — no semantic change, no VERSION bump.
4. **memory_pressure thresholds & leaked Ctx** (`memory_pressure.rs:85/90/92/96`, `:103-106`) — jetsam defense.
5. **`cr3::is_cancelled` sentinel semantics** (`cr3.rs:712-714`).
6. **`read_fullres_scan` + hint-mismatch scan fallback** (`cr3.rs:793`, `bundle.rs:346-372`) — live validation net for future camera bodies. (Distinct from the `read_bundle` nav-legacy path, which IS removed in Phase 5.)
7. **The strip family** (`components/strip/*`) and **GridView's per-row burst segmentation** (`GridView.tsx:272-334`).
8. **NAV timing constants & scrub invariants**: `NAV_REPEAT_MS` 33, `NAV_HOLD_DELAY_MS` 280, one-call-step=speed (`App.tsx:2520-2523`), grid OS-auto-repeat model (ARCHITECTURE "Hold-to-scrub").
9. **macOS key quirks**: capture-phase ESC swallow (`App.tsx:3265-3270`), resumed-repeat keydown (`App.tsx:2957-2961`), `e.code` keyup fallback (`App.tsx:3208-3210`), the custom macOS menu + "do NOT remove default Edit roles" (`lib.rs:133-193`).
10. **`deriveVerdict.ts` calibrated thresholds** (`:20-64,118-150`) — every number cites a corpus frame; only the calibration harness may change them.
11. **dlog/doslog probe families and DevHud** — kept (open investigations, gated, free in release).
12. **XMP atomic-write scheme and pre-flag legacy sidecar parsing** (`xmp.rs:493-505`, `authored_by_cull` two-marker history).
13. **Windows console guard** `main.rs:2`, the Linux `compile_error!` (`lib.rs:27-28`), and `pnpm-workspace.yaml`'s esbuild approval.

---

# The phases

Per-phase footer applies to ALL phases: run `pnpm test` (414 pass), `pnpm exec tsc --noEmit` (clean), `cd src-tauri && cargo test` (103 pass), `cargo clippy --all-targets` (no new warnings); commit per task with conventional messages; append a dated implementation note to this doc; STOP for Oliver's gate before the next phase.

---

## Phase 1 — Docs, license, identity (zero code risk)

**ROI: high. Risk: none.** Everything here is docs/metadata.

### Task 1.1: License + attribution
- Create `LICENSE` — MIT, `Copyright (c) 2026 Oliver Søgaard-Andersen`.
- Create `THIRD_PARTY_NOTICES.md`: DINOv2-small (Apache-2.0, Meta), CLIP ViT-B/32 visual (MIT, OpenAI), LAION aesthetic head (MIT), YuNet 2023mar (MIT, OpenCV Zoo), OCEC (per its repo license — verify from `scripts/export-models.py` provenance comments before writing). One entry each: name, version/source URL, license, "bundled as ONNX in src-tauri/models/ or fetched by scripts/fetch-models.sh".
- Add `"license": "MIT"` to `package.json`, `license = "MIT"` to `Cargo.toml` `[package]`.
- Fix author placeholders: `package.json:6` `"author": "Oliver Søgaard-Andersen"`, `Cargo.toml:4` `authors = ["Oliver Søgaard-Andersen"]`.

### Task 1.2: Archive the root plan docs
- `git mv IMAGE_PIPELINE_PLAN.md SMART_CULLING_PLAN.md SMART_CULLING_PHASE3_DESIGN.md MACOS_SUPPORT_PLAN.md docs/history/`.
- Fix the stale caveat inside `docs/history/SMART_CULLING_PLAN.md`: append a dated note that `smart-ml` became a DEFAULT feature on 2026-07-06 (`Cargo.toml:22`) and releases ship with ML — superseding the "release builds do not pass --features smart-ml" line.
- Grep repo for references to the old root paths (`README.md`, `ARCHITECTURE.md`, `docs/superpowers/plans/*`, source comments) and update.
- Commit this plan + the brief (both currently untracked).

### Task 1.3: README rewrite (production quality)
Keep the strong existing sections (run/build, keyboard table, XMP model, settings). Add/fix, in order: hero intro (what CULL is, who it's for) + 2–3 screenshots under `docs/media/` (Oliver supplies; loupe, compare, grid) + `app-icon.png` shown; a **Smart culling** section (advisory-only invariant, classical tier + optional ML tier, the in-app toggle, models bundled/fetched); a **`scripts/`** section (`fetch-models.sh` — sha256-pinned CLIP fetch, runs in CI; `export-models.py` — dev-only ONNX export + PyTorch parity gates); corrected project-layout tree (all 17 Rust modules, `src/image|smart|hooks|overlays|components/pane|components/strip`); License section. Remove version-pinned example paths or mark them `<version>`.

### Task 1.4: ARCHITECTURE.md accuracy sweep
- Update both module-map diagrams (lines 300-328) to the real trees (frontend: add `image/`, `smart/`, `overlays/`, `hooks/`; backend: add `analyze/embed/faces/phash/ml_models/midtier/memory_pressure`).
- Add a **Smart culling** section: two-layer design (Rust cached metrics per image; pure-TS cross-frame verdicts), advisory-only, `smart-ml` feature seam, calibration provenance.
- Retitle "On-disk tier cache (v2)" → "(format v3)" and note the v3 bump reason (pHash on thumbnails; VERSION shared across tiers).
- Expand the Test surface list to match reality (or replace the enumeration with a pointer to TESTING.md).

### Task 1.5: TESTING.md
Create `TESTING.md` documenting: the two suites + commands; the env-gated corpus tests (`CULL_TEST_CR3_DIR` — used at `analyze.rs:918`, `bundle.rs:834`, `faces.rs:536`, `cr3.rs:1186/1302/1344`, `midtier.rs:304`, `embed.rs:153`; `CULL_TEST_CR3` at `cr3.rs:1123`), the calibration harness invocation verbatim (`CULL_CALIB=1 CULL_TEST_CR3_DIR=<corpus> cargo test --features smart-ml calibration_report -- --nocapture`), `CULL_BENCH=1`, the LrC-sidecar path gate (`sample_cr3s/sample_LrCFlaggedCR3s`, skip-with-reason behavior), and `CULL_TEST_JPEG_DIR` for export-models parity. State the pass-by-skip philosophy (corpus tests never fail CI when fixtures are absent).

**Gate 1:** Oliver reads README/ARCHITECTURE/TESTING diffs. Suites green (nothing should have changed).

---

## Phase 2 — Tooling & CI (config only; zero-warning baseline)

**ROI: high. Risk: low** (config; the only code edits are the 7 clippy fixes).

### Task 2.1: ESLint (flat config) + Prettier + stylelint
- Dev-deps: `eslint`, `typescript-eslint`, `eslint-plugin-react-hooks`, `eslint-plugin-react-refresh`, `eslint-config-prettier`, `prettier`, `stylelint`, `stylelint-config-standard`.
- `eslint.config.js`: typescript-eslint recommended-type-checked on `src/**/*.{ts,tsx}`, react-hooks recommended, `no-console: ["warn", { allow: ["error", "warn"] }]` (the dlog forwarder keeps its existing disable comment). Verify the 5 existing `eslint-disable` comments now bind to real rules.
- `.prettierrc`: match dominant existing style — 2-space, double quotes, semicolons, trailing commas (confirm against `src/utils/format.ts` before setting; do NOT reformat-the-world: run `prettier --check` and only commit formatting diffs file-by-file where trivial, or scope Prettier to changed-files-only via lint-staged-style script if the diff is huge).
- `.stylelintrc.json`: `stylelint-config-standard` with sensible relaxations for the existing BEM-ish naming.
- `package.json` scripts: `"lint": "eslint src"`, `"lint:css": "stylelint \"src/**/*.css\""`, `"format": "prettier --write src"`, `"typecheck": "tsc --noEmit"`, `"typecheck:tests": "tsc --noEmit -p tsconfig.tests.json"` (new `tsconfig.tests.json` extending base, including `src/**/*.test.ts*` — closes the "tests aren't typechecked" gap).
- Fix whatever the initial `pnpm lint` run surfaces (expected near-zero given the `any`-free codebase); anything non-trivial gets an inline disable + comment rather than a behavior change.

### Task 2.2: Rust lint baseline
- Fix the 7 default clippy warnings: truncate the two `CLIP_STD` floats (`embed.rs:10` — value change is beyond f32 precision, harmless), `type` alias for the faces buffer tuple (`faces.rs:327`), `#[allow(clippy::too_many_arguments)]` with a one-line justification on the three bundle commands (`bundle.rs:381,529,611` — Tauri command signatures), `.is_multiple_of` in the phash test helper (`phash.rs:132`).
- `cargo fmt` the tree (only `examples/decode_probe.rs` is dirty).
- Add to `src-tauri/src/lib.rs` top: nothing — do NOT enable pedantic crate-wide. Instead add `[lints.clippy]` in Cargo.toml only if trivially clean; otherwise rely on CI running default clippy with `-D warnings`.
- Create `src-tauri/audit.toml` ignoring the Linux-only gtk-rs unmaintained advisories (RUSTSEC-2024-0411..0418 family) with a comment "Linux transitive deps of tauri; Linux is compile-blocked".
- `cargo update` (lockfile-only) and re-run `cargo audit`; note quick-xml status (transitive via plist←tauri; upgrade lands when tauri/plist bump — record, don't force).

### Task 2.3: CI workflow
Create `.github/workflows/ci.yml`:
```yaml
name: CI
on:
  push: { branches: [main] }
  pull_request:
jobs:
  frontend:
    runs-on: ubuntu-latest    # lint/typecheck/vitest are platform-neutral; keep CI cheap
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 10 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint && pnpm lint:css
      - run: pnpm typecheck && pnpm typecheck:tests
      - run: pnpm test
  backend:
    runs-on: windows-latest   # primary platform; Linux would not compile (by design)
    defaults: { run: { working-directory: src-tauri } }
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
        with: { components: "clippy, rustfmt" }
      - uses: swatinem/rust-cache@v2
        with: { workspaces: src-tauri }
      - run: cargo fmt --check
      - run: cargo clippy --all-targets -- -D warnings
      - run: cargo test
```
(Note: backend job needs no ONNX models — corpus/ML tests pass-by-skip. If `ort`'s download-binaries step is slow/flaky on CI, add `--no-default-features` to clippy/test and a comment.)
- Add `.gitattributes`: `* text=auto`, `*.sh text eol=lf`, `*.onnx -text linguist-generated`, `Cargo.lock linguist-generated`, `pnpm-lock.yaml linguist-generated`.
- Add a one-line comment header to `pnpm-workspace.yaml` ("not a workspace — pnpm 10 build-script approval for esbuild").

**Gate 2:** CI green on a test branch push. `pnpm lint`/`fmt --check`/clippy all zero-warning locally.

---

## Phase 3 — Dead & stale sweep (mechanical deletions)

**ROI: medium. Risk: very low** — every item is verified-dead or comment-only.

### Task 3.1: Dead code
- Delete the `export { EYES_OPEN_MIN }` re-export line `groupBursts.ts:4` (defined+exported in `pickWinner.ts:4`; no consumer imports it from groupBursts).
- knip export-keyword sweep: for each of the 21 knip hits + 2 unused types, check whether any test imports it; if yes keep (add `// exported for tests` where missing), if no drop the `export` keyword only (the constants stay, they're used in-module). Expected drops include `OverlayComputeFn`, `FaceScore`, `SCRUB_SPEEDS`, the deriveVerdict/groupBursts threshold consts, `ZOOM_ENGAGE/RELEASE_TRANSITION`, `THUMB_HOLDOFF_MS`, `RAPID_NAV_MS`, `OVERLAY_LRU_CAP`, `phashDistance`. Re-run `pnpm dlx knip` → zero unused exports.
- Move `src/smart/testScores.ts` → `src/smart/__fixtures__/testScores.ts`; update the 5 test imports.
- Delete 4 unused CSS selectors: `.cull-statusbar__filename-sep` (`App.css:245`), `.cull-statusbar__filename-meta` (`:250`), `.cull-settings__row-head` (`:1816`), `.cull-settings__export-pinned` (`:2048`). Merge the duplicate `.cull-grid__placeholder-name` blocks (`:3262` + `:3267`). Group the solid dot triples (`.cull-thumb__dot--keep/reject/fav` `:2987-2989` with `.cull-grid__dot--*` `:3311-3313`) the same way the ghost variants already are (`:3021-3038`).

### Task 3.2: Stale-comment sweep (war stories STAY)
- `App.tsx:96-99`: drop the JSDoc describing the unzoom re-measure App no longer performs (moved to PhotoPane; the pointer sentence "sizerSrc moved to utils/sizer.ts" may stay as a one-liner).
- `App.tsx:4276-4302`: move each orphaned JSDoc block to sit directly above its function (`SaveStatusPill` at `:4551`, `EmptyFilter` at `:4321`).
- `ThumbCell.tsx:29-31` delete the dangling burst-membership JSDoc; `:21-24` merge the doubled `roleVariant` blocks.
- `imageStore.ts:1636`: relabel `evictFull`'s revoke comment (currently a second "SITE 2") as "SITE 2b (test-only direct eviction)" and cross-check the header catalogue (`imageStore.ts:9-32`) counts.
- Rust plan-relative refresh: `tier_cache.rs:5` "reserved for the Phase 8 generated tier" → "the generated mid tier (Phase 8, shipped)". Leave `bundle.rs` legacy comments — Phase 5 deletes that code wholesale.
- Trivial dedupe rides along here (pure, zero-risk): `ExifRail.tsx:380-383` — delete `stripExtName`, import `stripExt` from `utils/path`; `App.tsx:3717-3721` — replace the inline `Record<Rating, ReactNode>` with `verdictGlyph(r, 9)` calls.

**Gate 3:** suites green; knip clean; Oliver eyeballs the comment diffs (guardrail: no war story removed).

---

## Phase 4 — Backend robustness + cheap tests

**ROI: high. Risk: low-medium** — mechanical Rust fixes with strong existing suites; one live NAS sanity lap because the XMP/scan paths are the NAS-facing ones.

### Task 4.1: Fix blocking-in-async (the one systemic gap)
- `xmp.rs:75` `write_xmp_rating` and `:113` `clear_xmp_rating`: move the read-modify-atomic-write body into `tauri::async_runtime::spawn_blocking` (mirror the pattern of `file_ops.rs` commands), preserving return types and the idempotent-skip fast path.
- `scan.rs:80` `scan_folder` and `:158` `analyze_folder`: wrap the WalkDir walk / dir listings + sequential restore in `spawn_blocking` the same way (the scoped-thread concurrent path stays as-is inside).
- TDD: the existing xmp round-trip + scan tests must stay green unchanged; add one test asserting `write_xmp_rating` still returns the same result shape (behavioral no-op refactor).
- `scan.rs:307`: replace `h.join().unwrap()` with a match that converts a worker panic into an error entry for that path batch (graceful, no process poison): `Err(_) => results.push(Err("restore worker panicked".into()))` — adapt to the actual aggregation shape at the site.

### Task 4.2: Shared helpers (Rust)
- New `src-tauri/src/jpeg_rgb.rs` (or a `decode_rgb` fn in `phash.rs`'s sibling position): `pub(crate) fn decode_rgb(jpeg: &[u8]) -> Result<(Vec<u8>, usize, usize), String>` — the zune-jpeg RGB8 + `len == w*h*3` validation ritual. Replace the four call sites (`bundle.rs:277-284`, `bundle.rs:703-710`, `midtier.rs:87-97`, and the test copies in `faces.rs:555-559`/`embed.rs:172-176`). Behavior-identical; existing tests prove it.
- `tier_cache.rs`: extract `fn prelude_matches(buf: &[u8], mtime_ms: i64, file_size: u64, tier: Tier) -> bool` used by both `get()` (`:220-229`) and `has_current()` (`:355-360`) — byte-for-byte the same checks, no semantic change, **no VERSION bump** (do-not-touch item 3 respected). The `stale_version_byte_is_refused_and_dropped` test (`:551-568`) must stay green.
- Test-fixture dedup: `#[cfg(test)] pub(crate) mod test_util` in `lib.rs` (or `src-tauri/src/test_util.rs` behind cfg(test)) hosting `synth_rgb`/`synth_jpeg` and `Lcg`; point `bundle.rs`/`midtier.rs`/`phash.rs`/`analyze.rs` tests at it.

### Task 4.3: Cheap pure-logic tests (close the gaps)
- TS: `src/overlays/maskScans.test.ts` (clipScan all-three-channel rule incl. the saturated-yellow non-trigger; peakScan threshold; runMaskScan geometry), `src/smart/burstInputs.test.ts` (`capturedAtToMs` formats, `decodeOk` fallback, the −1 eyesOpen sentinel at `burstInputs.ts:40`), `src/utils/zoom.test.ts` (`afZoomOrigin` geometry), `src/components/pane/zoomTransition.test.ts` (branch table).
- Rust: `analyze_folder` mtime sort comparator (missing-time-sorts-last + path tiebreak, `scan.rs:335-341`) via a fixed epoch vector; the orphan-temp sweep shape match (`scan.rs:186-200`) with decoy filenames; `meta::From<Cr3Meta>` round-trip pinning every field.

### Task 4.4: CSP + fonts (config with a live check)
- Self-host fonts: download the two families' woff2 subsets into `src/assets/fonts/`, add `@font-face` with `font-display: swap` to `App.css` root section, delete the Google Fonts links (`index.html:8-10`).
- Set CSP in `tauri.conf.json:26` (replace `null`):
  `"csp": "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src ipc: http://ipc.localhost"`
  **[LIVE GATE]** blob: URLs are the app's lifeblood — after setting, live-verify: thumbs, previews, zoom fulls, overlays (worker!), histogram, drag-drop, both platforms if possible. If the worker or IPC breaks under CSP, iterate on the directive rather than reverting to null; document the final policy in ARCHITECTURE.
- Optimize `src/assets/backdrop.jpg` (resize to max rendered size, target <150 KB, or WebP with jpg fallback) — quick visual glance at the home screen. Move `app-icon.png` → `docs/media/app-icon.png` (it's source art; `src-tauri/icons/` holds the generated set) and update any references (`tauri.conf.json` icon paths point at `src-tauri/icons/`, so likely none).

**Gate 4:** suites green; **live NAS-profile sanity lap** (open folder over network mode, rate, undo, quit-guard) because xmp/scan threading changed; CSP live check above.

---

## Phase 5 — Legacy nav excision (`read_bundle`/`navLegacy`)

**ROI: high (deletes a whole dual-path). Risk: medium** — dead in every bundled build (flips only on unknown-command version skew, `bundle.ts:52-60,95-97`), but it threads through the nav-read spine. **[LIVE GATE]**

### Task 5.1: Frontend excision
- `src/utils/bundle.ts`: delete `navCommand` state machine, `resetNavCommandForTests`, `isUnknownCommand`, the `for(;;)` retry loop and `legacy` field plumbing in `fetchNav` (`:52-102`) — `fetchNav` becomes a straight `read_preview` invoke. Remove `legacy` from `NavResult` (`:47-49`).
- `src/image/imageStore.ts`: remove `navLegacy` (`:186-188`), its set at `:1109`, `isLegacyNav()` (`:1242`), the guards at `:1218/:1395/:1554`, and the legacy memory-estimate branch (`:1842`).
- `src/image/stage.ts`: remove the legacy note at `:11-12`; **rename the stage value nowhere** — the `"full"`-means-nav naming stays (renaming would ripple through presenter tests; noted as a standing readability tax, accepted).
- `src/components/pane/PhotoPane.tsx:296`: `hiResSrc = img.full?.url` (drop the `?? (imageStore.isLegacyNav() ? img.url : undefined)` arm). `src/components/DevHud.tsx:21`: drop the "LEGACY full-nav" readout.
- `src/overlays/overlayService.ts:176`: update the comment referencing legacy.
- Update tests: `imageStore.test.ts` and any `bundle.ts` tests referencing legacy/`resetNavCommandForTests` — delete the legacy-path cases (they test removed behavior), keep everything else.

### Task 5.2: Backend excision
- `bundle.rs`: delete the `read_bundle` command + its header shape and helpers used only by it (the "legacy navigation path" block, `:122+`); keep `read_preview`/`preview_parts` untouched.
- `cr3.rs`: `read_bundle` parser entry (`pub fn read_bundle`) — delete if its only caller was the command; `read_preview_bundle` and everything else stays.
- `lib.rs`: remove `read_bundle` from the command registration list.
- `meta.rs` comment sweep for "read_bundle header lacks them" (`bundle.ts:29` FE-side too).

**Gate 5:** suites green (with legacy tests removed, count will drop slightly — record new totals). **Live lap:** cold open, scrub, zoom engage/release, compare pair, grid, folder switch, close/reopen (tier-cache hit path) — confirms the nav spine never needed the fallback.

---

## Phase 6 — App.tsx decomposition, safe seams

**ROI: high. Risk: low-medium** — verbatim moves of self-contained clusters into hooks; no logic edits. Two batches, each suites-green + a quick live smoke. Target: App.tsx under ~2,000 lines after this phase (under 800 after Phase 7).

New directory: `src/app/` (feature-organized hooks that exist only to serve App).

### Task 6.1: Batch A (pure plumbing)
Extract verbatim, preserving effect order within each hook and every dep array exactly:
- `src/app/useImageStoreWiring.ts` — profile derivation (`App.tsx:761`) + effects at `:764, :774, :786, :797, :820, :829, :835, :843` + `handleGridViewport` (`:917`).
- `src/app/useDragAndDrop.ts` — `:1745-1794`.
- `src/app/useQuitGuard.ts` — save/quit state cluster (`:383-394`), `retryFailed` (`:1708`), close-requested registration (`:1720`), auto-close-after-flush (`:1799` — 350 ms floor comment travels with it).
- `src/app/useRatingPersistence.ts` — `writeQueue`/`writeSeq` (`:1639-1644`), `persistRating` (`:1646`), `flashFeedback` (`:1623`) + feedback state (`:371-372`, cleanup `:3293`). The per-path-serial-queue war story comment (`:1629-1644`) moves with it.
- `src/app/useUndoRedo.ts` — `:1817-1893` + `applyChanges` (`:1829`).
- `src/app/useSmartDerivations.ts` — `:214-369` (already pure memo chains) returning `{suggestions, burstCtx, similarCtx, liveSuggestionCount, keepEligibleMap, qualityScores, qualityAnalyzing, qualityProgress, startAnalysis, ratedIds}`.
- `src/app/useFolderTrouble.ts` — `:478, :835-845, :885-913`.

### Task 6.2: Batch B (session + navigation + decides)
- `src/app/useSessionLifecycle.ts` — `openFoldersByPaths`/`pickFolder`/`beginCulling`/`resetSession`/`leaveToHome` + recents writers (`:925-1250, :1295-1344`). The NFC-normalization war story (`:980-983`) and go-straight-to-STAGED note (`:1093-1099`) travel with it.
- `src/app/useSiteNavigation.ts` — nav stack + `goToSite`/`goBack`/`snapToFilter`/`reviveChallenger`/`buildNavEntry`/`cycleChallenger` (`:2064-2229, :2232`).
- `src/app/useDecideCallbacks.ts` — `applyRating`/`unrateCurrent` (`:1895-2062`) + the three compare decides (`:2255-2451`). **The sync-flush ordering comments (`:1955-1974, :2292-2299, :2358-2360, :2431-2434`) are load-bearing and move verbatim — the setState-then-`dropZoomFullsExcept` sequencing must not be "simplified".**
- Rule for both batches: hooks receive their dependencies as parameters (no new context, no signature creativity); App.tsx becomes composition + JSX. If a cluster resists a clean parameter list, leave it in App and note it — do not force.

**Gate 6:** suites + tsc green after each batch; live smoke after each batch (open, rate, undo, compare decide, finish dialog, quit guard); bundle diff sanity (`pnpm build` — hash may change, size shouldn't move meaningfully).

---

## Phase 7 — App.tsx high-risk seams: keymap + zoom **[LIVE GATE each]**

**ROI: high (App.tsx to <800). Risk: HIGH — paint choreography + modal precedence.** One task per session if needed. Zoom extraction is the plan's most skippable item (Oliver pre-authorized dropping it if a gate wobbles).

### Task 7.1: `useCullKeymap`
- Extract the keymap builder effect (`App.tsx:2839-3263`) + chrome-screen keymap (`:2781-2829`) + the once-bound window listeners (`:3282`) + capture-phase ESC swallow (`:3271`) into `src/app/useCullKeymap.ts`.
- Contract: the once-bind + ref-dispatch pattern (`:3279-3291`) is preserved exactly (perf design — listeners registered once, dispatch through `cullKeyRef`); modal-precedence order (settings → quitGuard → confirmHome → actionsOpen → scrub-interrupt → Ctrl combos → Tab → Space → ESC → site switches) is preserved by verbatim move; the ~30-entry dep array is copied unaltered and eslint-verified.
- **Live gate:** every modal's key swallowing, Space-zoom arm/release, macOS resumed-repeat quirk (hold Space through a nav), Esc chain (L→C→G→C→ESC×3), Ctrl+Z/Y/E/A, keyup `e.code` fallback (scrub then release with a modifier held).

### Task 7.2: `usePaneZoom` (zoom choreography) — SKIPPABLE
- Extract `:396-452` state cluster + `pan`/`resetZoom`/`handleStageMouseDown` (`:492, :505, :728`) + mouse-drag effect (`:688`) + `zoomSwapInstant` two-rAF reset (`:408`) + index-change zoom reset/carry (`:536`) + render-derived `zoomZ`/`zoomGlide` (`:3547-3557`) into `src/app/usePaneZoom.ts`. The `advanceTo`/decide zoom-drop sequencing stays in `useDecideCallbacks` (calls into the hook only via `resetZoom`/`keepZoomOnAdvance`).
- Verbatim move only; the two-rAF commit-at-transition-none dance and the carried-advance reset must be untouched.
- **Live gate:** zoom engage/release glide (loupe + both compare panes), rate-while-zoomed carry (loupe and compare), mouse-drag pan + cursor-anchored engage, thumb/rail toggle while zoomed (the ResizeObserver case), memory-pressure critical → auto-unzoom.
- If this gate shows ANY paint artifact: revert the extraction (keep the cluster in App.tsx), record the attempt in the implementation note, move on. App.tsx lands ~1,100 lines in that case — accepted.

**Gate 7:** as embedded above + full suites; App.tsx line count recorded.

---

## Phase 8 — imageStore decomposition + TierLane collapse **[LIVE GATE]**

**ROI: highest LOC/maintenance win in the repo. Risk: HIGHEST** — the gen-scoped concurrency invariant lives here. Strong existing suite (41 imageStore tests incl. generation & concurrency) is the safety net; extend it before touching lanes.

### Task 8.1: Low-risk splits first (order matters)
- `src/image/devStats.ts` — `navTimings`/`zoomTimings`/`counts`/`noteNavTiming`/`noteZoomTiming`/`debugStats` (`imageStore.ts:1765-1846`). Fix the fragile basename double-slice (`:1767,:1774`) with a proper `basenameOf(path)` while moving (dev-HUD-only, test with mixed-separator paths).
- `src/image/midSweep.ts` — the idle sweep scheduler (`:1526-1625`), touchpoints injected (`paths`, `cursor`, `fullHints`, `profile`, `midEngaged`, `invokeGenerateMid`). Unit-test the pick/pause/budget logic standalone.
- `src/image/tierErrors.ts` — `TierError`/`backoffMs`/`inCooldown`/`recordTierError`/`scheduleFullRetry`/folderTrouble latch (`:83-118, :1018, :1341`). Pure logic; port existing backoff tests.
- Each split: suites green, no live gate needed yet (no scheduling semantics changed).

### Task 8.2: TierLane collapse **[LIVE GATE]**
- First, WRITE THE NET: extend `imageStore.test.ts` with lane-parity tests that pin current behavior per lane BEFORE refactoring — single-flight dedup, gen-scoped decrement on stale completion (the `:986-995` invariant), evict-respects-protection, error→backoff→rearm — parameterized to run against all four lanes.
- Then `src/image/tierLane.ts`: `class TierLane<T>` owning `{queue, requested: Set, inFlightPaths: Set, inFlight: number, errors}` with injected `{cap(), fetch(path, gen), onReady, onError, isProtected, evictPolicy}`; `pump()`, `load(path)`, `evictAround(cursor, keep)` reproducing the quads at `:926/:944/:1041` (thumb), `:1071/:1095/:1197` (nav full), `:1246/:1261/:1322` (zoom), `:1419/:1434/:1510` (mid). The refcount trios (`:689-756`) collapse to one `RefCountMap` helper; the byte-identical pendingZoom/pendingMid deferral blocks (`:1226-1235, :1405-1414`) become `deferUntilHint(path, set)`; `hintArgs(path)` dedups `:1266-1271/:1438-1443/:1611-1615`.
- Invariants that must survive BYTE-FOR-BYTE in behavior: every `inFlight--` is generation-scoped; single-flight per path; on-demand lanes preempt bg fill; `isProtected` (`:1006`) stays THE one predicate, central, not per-lane copies; revoke-site catalogue (`:9-32`) updated to the new file layout without losing any site.
- **Live gate (the big one):** cold folder open on local AND network profile (watch first-paint + book-order fill politeness), fast scrub through a cold region (thumb-only, zero fetches mid-scrub), settle → zoom full arrives, mid tier on the 4K display + DPR flip, folder switch mid-load (gen cancellation — no ghost images), close/reopen instant paint (tier cache), memory-pressure shed, 8927-class paint check, long-session memory watch (Activity Monitor on WebContent).

**Gate 8:** as embedded + full suites; `imageStore.ts` line count recorded (~900 expected).

---

## Phase 9 — Held-scrub unification + leftover small dedupes **[LIVE GATE]**

**ROI: medium-high. Risk: medium** — nav-timing path, but small surface and the invariants are documented at the sites.

### Task 9.1: `useHeldRepeat`
- `src/app/useHeldRepeat.ts`: one hook implementing hold-delay → rAF-paced repeat with `{onStep(dir, speed), holdDelayMs: NAV_HOLD_DELAY_MS, repeatMs: NAV_REPEAT_MS, onScrubChange(active, speed)}`; two instances replace `startHold`/`stopHold` (`App.tsx:2478-2536`) and `startGridVertHold`/`stopGridVertHold` (`:2562-2624`). The step call divergence stays at the call sites (`navStepRef` vs `advanceRef` with `gridCols` multiply, `:2524` vs `:2609-2612`).
- Invariants preserved: ONE step call per tick with step=speed (the "50× scrubbed at 1×" bug, `:2520-2523`); `scrubbing` flips only when moved-state changes; both instances independently cancelable (the isolation the old comment at `:2541-2547` wanted — now by construction); window-blur and settings-open stop both (`:2635, :2653`); grid keeps its OS-auto-repeat single-tap model — the hook serves ONLY the held loops that exist today, no behavior added to grid taps.
- Unit-test the hook with fake rAF/timers: delay before first repeat, step-per-interval pacing, speed escalation via `scrubSpeedForHeldMs`, cancel-on-stop.
- **Live gate:** loupe hold-scrub L/R at boundary + filter edges, compare scrub, grid vertical 10× hold at a filter boundary, tap-vs-hold in grid (no 2–3 cell overshoot), blur mid-hold (no stuck loop), scrub sharpness (prefetched neighborhood snaps SHARP).

### Task 9.2: Leftover micro-dedupes (ride-along, low risk)
- `useArmedConfirm(disarmMs = 4000)` hook replacing the three armed-confirm copies (`FinishDialog.tsx:445-455, :511-533`; `SettingsDialog.tsx:556-600`).
- Fold `RatingDot.tsx:29-35` onto `verdictGlyph` with a stroke-width param (visual: status pill + compare dot glance).
- Clip/peak overlay effect twins (`App.tsx:1532-1588`, post-Phase-6 location): fold into one `useOverlayKind(kind, enabled, deps)` invoked twice — dep-array semantics identical; histogram effect stays separate (single-view-only variant).
- Shared `<VerdictDot>` for the ghost-dot JSX overlap (`GridView.tsx:538-554` ≈ `ThumbCell.tsx:152-168`) — optional, skip if fiddly.

**Gate 9:** as embedded + full suites.

---

## Phase 10 — Final polish & release hygiene

**ROI: medium. Risk: low.** Needs Oliver for the GitHub release-asset upload.

### Task 10.1: dinov2 offload (forward-only, per decision 3)
- Oliver uploads `dinov2s.onnx` to the existing `models-v1` release (same flow as CLIP).
- Extend `scripts/fetch-models.sh` with the dinov2 entry (same sha256-pinned atomic pattern; compute the hash from the tracked file BEFORE deleting it).
- `git rm src-tauri/models/dinov2s.onnx`; add to `.gitignore` next to the CLIP line; update the `.gitignore` comment (no longer "over 100 MB limit" — "kept out of git; fetched from models-v1").
- Verify: fresh `./scripts/fetch-models.sh` → both models present, `cargo test --features smart-ml` ML smoke passes with corpus, release.yml unchanged (it already runs the script). Consider the same for `ocec_s.onnx` (495 KB) — NOT worth it; leave tracked.
- README/TESTING note: local ML builds need `./scripts/fetch-models.sh` once.

### Task 10.2: Optional/deferred items — decide-and-record, default SKIP
Each was found, weighed, and deliberately parked; record the verdicts in the implementation note so they stop resurfacing:
- `cr3.rs` split into `cr3/{container,exif}.rs` — module is well-sectioned, tests co-located; **skip**.
- `pickMidSweep` O(n) rescan (`imageStore.ts:1591`) — idle+local-gated; touch only if a monster-shoot sweep is ever observed slow; **skip**.
- `invalidate` allocation churn on eviction loops — bounded by cache size; **skip**.
- `.cull-photo-frame*` vs `.cull-cmp-*` CSS family unification (`App.css:653-796` vs `:3528-3577`) — visual-risk for pure aesthetics of the stylesheet; **skip** unless a later feature touches both.
- `stage.ts` `"full"`-means-nav rename — ripples through presenter tests for a naming win; **skip, with a trigger**: if the presenter is ever reopened for a real feature/bug, the rename rides along in that session under its live gate (documented as accepted tax in ARCHITECTURE until then).
- `evictFull` test-only public method (`imageStore.ts:1633`) — after Phase 8 it may fall out naturally; if not, mark `/** @internal test-only */`; revisit at Phase 8.
- `cull:recents:v1` migration read (`useRecents.ts:148-163`) — harmless; remove no earlier than 2027; **keep**.
- PhotoPane plan step-4 leftovers (NAS-profile lap, 8927 paint check, mixed-AR carry, memory watch) — **absorbed into Phase 8's live gate list**; record them done there.

### Task 10.3: Wrap-up
- Re-run the full tool sweep (knip, ts-prune, depcheck, clippy, machete, audit, fmt) — all clean; record outputs in the implementation note.
- Update README/ARCHITECTURE for anything the refactors moved (new `src/app/` + `src/image/` layout).
- Final suite counts + App.tsx/imageStore.ts line counts recorded. Version stays 0.1.0 (bump belongs to the next release decision, not the cleanup).

**Gate 10:** Oliver's final review; push say-so decides when any of this reaches origin.

---

# ROI / risk ranking (why this order)

| # | Phase | ROI | Risk | Gate |
|---|-------|-----|------|------|
| 1 | Docs/license/identity | High (public-repo blocking items) | None | Read diffs |
| 2 | Tooling & CI | High (locks every later phase in) | Low | CI green |
| 3 | Dead & stale sweep | Medium | Very low | Suites + comment diff |
| 4 | Backend robustness + tests | High (NAS-path correctness) | Low-med | Suites + NAS lap + CSP live |
| 5 | Legacy nav excision | High (deletes a dual path) | Medium | Suites + nav live lap |
| 6 | App.tsx safe seams | High | Low-med | Suites + smoke ×2 |
| 7 | Keymap + zoom extraction | High | HIGH | Live gates; zoom skippable |
| 8 | imageStore TierLane | Highest | HIGHEST | The big live gate |
| 9 | Held-scrub + micro-dedupes | Med-high | Medium | Scrub live gates |
| 10 | Polish & model offload | Medium | Low | Final review |

Rationale: Phases 1–4 build the safety floor (docs can't regress anything;
lint/CI catch what later phases break; dead code shrinks the refactor surface;
backend fixes are suite-proven). Phase 5 before 6–8 so the decompositions
never carry the legacy branches. The three behavior-risk unifications run
last, one per session, each individually revertible, TierLane after App.tsx
so the store's consumers are already stable when its internals move.

---

# Implementation notes

## Phase 1 — DONE 2026-07-07 (awaiting Gate 1)

All five tasks landed as five `docs:` commits on `main` (`d98c757`, `02a713c`,
`9ab7ac6`, `74bbb48`, `e4cffdf`); the plan + brief were already committed by
the analysis session (`321713c`), so that 1.2 sub-item was a no-op. Suites
verified unchanged after: **414 TS / 103 Rust / tsc clean / clippy exactly at
the known 7-warning baseline**.

- **1.1** `LICENSE` (MIT, Oliver Søgaard-Andersen) + `THIRD_PARTY_NOTICES.md`
  (DINOv2-small, CLIP ViT-B/32 visual, LAION aesthetic head, YuNet 2023mar,
  OCEC — each with source URL, license, bundled-vs-fetched). `license` +
  real-author fields in `package.json` and `Cargo.toml`. **Deviation:** the
  plan's task text said the LAION head is MIT, but the in-repo provenance it
  told us to verify against (`scripts/export-models.py` docstring) says
  Apache-2.0 — the notices follow the provenance. OCEC confirmed MIT from
  `faces.rs:130` (github.com/PINTO0309/OCEC).
- **1.2** Four root plan docs `git mv`'d to `docs/history/`; dated SUPERSEDED
  note appended to the stale "release builds ship WITHOUT ML" caveat inside
  `SMART_CULLING_PLAN.md`'s 2026-07-06 implementation note. Living-code
  references (comments in `bundle.rs`, `analyze.rs`, `cr3.rs`,
  `groupSimilar.ts`, `DevHud.tsx`, `present.ts`, `Cargo.toml`) updated to
  `docs/history/…` paths. **Judgment call:** references inside the dated docs
  under `docs/superpowers/plans/` (and the moved docs' references to each
  other) were left verbatim — they are historical record, the filenames stay
  unique and searchable, and rewriting them would falsify what those sessions
  actually did.
- **1.3** README rewritten: hero intro + icon, screenshot table referencing
  `docs/media/{loupe,compare,grid}.jpg` (Oliver's full-window captures,
  downscaled 3024→1600 px + JPEG q88: 14.5 MB of PNG → 1.2 MB total,
  UI text verified crisp; committed `fd5fcc1`), Smart culling section (advisory-only, two tiers, toggles),
  `scripts/` section, corrected 17-module layout tree, Tests pointer to
  TESTING.md, License section, `<version>`-genericized installer paths.
  Ride-along accuracy fix: the keyboard table's `1 – 4` row claimed
  all/unrated/keeps/★ — `4` is the Smart filter (sub-modes cycle on
  re-press; ★ is a sub-mode of `3`), verified against `App.tsx` +
  `filterModes.ts`. README still shows `app-icon.png` at root; Phase 4 moves
  it to `docs/media/` and updates the reference.
- **1.4** ARCHITECTURE.md: both module maps now match the real trees
  (frontend + pane/strip subdirs, image/smart/overlays/hooks; backend all 17
  modules incl. analyze/faces/embed/phash/ml_models/midtier/
  memory_pressure); new Smart culling section (two-layer design, structural
  advisory-only invariant, `smart-ml` seam, calibration provenance);
  tier-cache heading retitled "(format v3)" with the v3 bump reason (pHash on
  thumbnail headers; VERSION byte shared across tiers); Test-surface
  enumeration replaced with a summary + TESTING.md pointer.
- **1.5** TESTING.md created: both suite commands + tsc, pass-by-skip
  philosophy, the env-gate table (`CULL_TEST_CR3_DIR` — verified live at
  `analyze.rs:918`, `bundle.rs:834`, `faces.rs:536`, `cr3.rs:1186/1302/1344`,
  `midtier.rs:304`, `embed.rs:153`; `CULL_TEST_CR3` at `cr3.rs:1123`;
  `CULL_BENCH=1` at `midtier.rs:365`), the LrC sidecar path-gate
  (`xmp.rs:705`, skip-with-reason), the calibration invocation verbatim, and
  `CULL_TEST_JPEG_DIR` for the export parity gates.

**Gate 1 asks:** README/ARCHITECTURE/TESTING diff read (screenshots are in
as of `fd5fcc1`). Nothing pushed.

## Phase 2 — DONE 2026-07-07 (awaiting Gate 2)

Gate 1 passed same day (Oliver read the diffs, supplied the screenshots, said
go). Three `chore:` commits: `dedde94` (2.1), `c1efc3e` (2.2), `f416709`
(2.3). Full gate after: **414 TS / 103 Rust / both tsc lanes / eslint /
stylelint / clippy `-D warnings` / `cargo fmt --check` — ALL clean.**

- **2.1 Frontend toolchain.** eslint flat config (ts-eslint
  recommended-type-checked over src incl. tests, react-hooks, react-refresh,
  prettier-compat), `.prettierrc` (printWidth 100 measured as best house-style
  match: 52 drifting files vs 89@80/70@120), `.stylelintrc.json`, five new
  scripts, `tsconfig.tests.json`. **The new `typecheck:tests` lane immediately
  caught 5 real type errors in test files** (imageStore helper type, `.at()`
  on ES2020 lib, unused imports) — fixed. Initial lint: 96 problems → 0:
  ~25 auto-fixed (unnecessary assertions), fire-and-forgets `void`-marked,
  deliberate dep-array omissions inline-disabled with why-comments (the three
  compare decides' frozen `currentIndex`, the keymap's fresh-object
  `chipsTooltip`, PhotoPane's path-as-cache-key), crash-net narrowed via
  `unknown`, FileReader reject wrapped in Error (message-preserving).
  **Baseline decisions (documented in eslint.config.js):** react-hooks v7's
  new compiler-era rules (refs/set-state-in-effect/immutability/purity) OFF —
  they flag the codebase's deliberate render-mirror-ref and reset-on-input
  idioms at scale (20 hits), and adopting them means timing-path refactors out
  of a lint rollout's scope; classic rules-of-hooks + exhaustive-deps stay
  errors. Async JSX handlers allowed (React ignores handler returns);
  `_`-prefix = declared-unused; test-file relaxations per ts-eslint guidance
  (unbound-method etc.). **Ride-alongs:** dead `CompareExifRail`
  rating props removed (became provably dead once their only reference — a
  memo dep — was cleaned); the 5 pre-existing disables verified binding.
  **Prettier mass reformat deliberately NOT applied** (52-file drift recorded;
  `pnpm format` exists; prettier is not a CI gate). stylelint: standard config
  relaxed to house style (legacy `rgba()`, dense sectioned comments,
  load-bearing `-webkit-backdrop-filter`, deliberate `word-break:
  break-word`); the duplicate `.cull-grid__placeholder-name` merged (Phase 3.1
  pull-forward — the rule would otherwise hold the gate red).
- **2.2 Rust baseline.** 7 clippy warnings → 0 (CLIP_STD truncated to f32
  precision, `StridePlanes` type alias, 3 justified `too_many_arguments`
  allows on wire-contract commands, `is_multiple_of` in the phash test
  helper). **Deviation from findings:** `cargo fmt` reformatted the WHOLE tree
  (16 files, ~860 lines), not just `examples/decode_probe.rs` — the local
  stable rustfmt disagrees with whatever the analysis checked; accepted since
  CI enforces `fmt --check` (mechanical whitespace, comments untouched, suite
  re-verified green). `audit.toml` with the 17 real warn-level advisory IDs
  (Linux-only gtk stack + tauri-transitive unmaintained; comments per entry).
  `cargo update` (lockfile-only): **the quick-xml RUSTSEC-2026-0194/0195
  advisories are RESOLVED**; `cargo audit` exits clean of CVEs.
- **2.3 CI.** `.github/workflows/ci.yml` per the plan (frontend on ubuntu:
  lint, lint:css, both typechecks, vitest; backend on windows-latest:
  fmt --check, clippy -D warnings, cargo test; ort caveat documented inline).
  `.gitattributes` (LF-normalized — `git add --renormalize` confirmed the tree
  was already clean), `pnpm-workspace.yaml` comment header (pnpm still parses
  it, verified).

**Gate 2 PASSED (2026-07-07):** CI proven green via throwaway draft PR #1
(`ci-smoke` → main; run 28894003988): frontend 46 s, backend 14 m 51 s on
windows-latest (fmt --check + clippy -D warnings + cargo test all passed on
the platform where ort/DirectML paths actually compile). Branch push alone
did NOT trigger — the workflow fires on push-to-main and pull_request only,
so the PR lane was used (and thereby validated). PR closed, branch deleted;
main still unpushed. rust-cache is now warm → future backend runs should
drop to a few minutes. The Node-20 action
deprecation was fixed same-day rather than parked (`cbf2248`: checkout v7 /
setup-node v6 / pnpm-setup v6, in BOTH ci.yml and release.yml — release.yml's
bump is proven by proxy only, its real run is the next v* tag) and re-proven
green via smoke PR #2 (run 28895206181, zero annotations). CI-cache note:
PR-branch caches don't carry across deleted branches/PRs — the backend stays
~15-25 min until main itself is pushed and seeds the shared main-branch
cache. A `style:`
commit (`5161f0c`) rides along: Oliver's format-on-edit prettier hook caught
up with the 12 Phase-2-touched files after the 2.1 commit (scoped formatting,
suites re-verified).

## Phase 3 — DONE 2026-07-07 (awaiting Gate 3)

Two commits: `8f03a1c` (3.1 dead code), `0fbc22d` (3.2 stale comments).
Gate after: 414 TS / 103 Rust / both tsc lanes / eslint / stylelint /
clippy -D / fmt --check all green; **knip exits zero findings**. Main pushed
through Phase 2 earlier the same day (`817c452`); Phase 3 commits held local
pending Gate 3's comment-diff eyeball.

- **3.1** All 23 knip hits + 2 types resolved. Every test "hit" was a comment
  mention, not an import, so NO symbol earned an `// exported for tests` keep:
  export keyword dropped on 21 in-module-used symbols (incl. `EYES_OPEN_MIN`
  in pickWinner once the groupBursts re-export + import were deleted);
  `resetDlogForTests` deleted outright (zero consumers); `SCRUB_SPEEDS`
  replaced by an inline `1 | 3 | 10` union (the array existed only to derive
  the type — surfaced by eslint after the export drop). `testScores.ts` →
  `src/smart/__fixtures__/` (5 test imports + its own 2 imports repointed).
  CSS: the four dead selectors deleted (verified zero markup references);
  solid verdict-dot triples grouped strip+grid like the ghost variants (the
  duplicate placeholder-name rule was already merged in Phase 2's pull-forward).
- **3.2** Orphaned JSDoc stack rehomed (SaveStatusPill + EmptyFilter docs now
  sit on their functions; NoMatchEmptyState's already did); stale App.tsx
  unzoom-measure JSDoc dropped, sizerSrc pointer kept as the one-liner;
  ThumbCell doubled roleVariant docs merged + dangling burst-prop doc deleted;
  imageStore revoke-site 2b relabel + catalogue cross-checked (12 sites + 2b);
  tier_cache.rs header truth-restored (ride-along: its "format v2" claim also
  fixed to point at `VERSION`/v3 — same lying-comment class as the plan's
  "reserved for Phase 8" item); ExifRail `stripExtName` → shared `stripExt`
  (note: regex vs lastIndexOf differ only on leading-dot filenames, impossible
  for camera files); App.tsx inline glyph Record → `verdictGlyph(r, 9)` (the
  Lucide-vs-Unicode war story lives in verdictGlyph.tsx's doc, not duplicated).

**Gate 3 asks:** eyeball the comment diffs (`git show 0fbc22d`) — guardrail:
no war story removed. Push follows the nod.

## Phase 4 — DONE 2026-07-08 (awaiting Gate 4 — LIVE)

Four commits on `main`, held local pending Oliver's live gate: `cecb0c6`
(4.1), `a7f3ed1` (4.2), `99a78fd` (4.3), `a44fb8f` (4.4). Full gate after:
**TS 442 / Rust 111 / both tsc lanes / eslint / stylelint / clippy `-D
warnings` / `cargo fmt --check` / knip zero-findings — ALL green.** The plan
was written against the 414/103 baseline; the new baselines are **442 TS
(+28) and 111 Rust (+8)**. Line numbers in the plan were stale (Phase 2
cargo-fmt'd the whole tree); worked by content throughout.

- **4.1 Blocking-in-async.** `write_xmp_rating` / `clear_xmp_rating`
  (xmp.rs) and `scan_folder` / `analyze_folder` (scan.rs) each split into a
  sync body + a `spawn_blocking` wrapper (the file_ops pattern), moving the
  fsync-over-SMB writes and the NAS-priced directory walks off the async
  runtime — closing the `lib.rs:22-23` invariant violation. The
  scoped-thread concurrent restore stays as-is INSIDE the blocking task.
  **Note:** `analyze_folder`'s `tauri::State<SessionGate>` can't cross into
  the `'static` closure, so the wrapper clones the inner `Arc`
  (`session.inner().clone()`) and hands a `&SessionGate` to the sync fn. The
  restore-worker `join().unwrap()` (scan.rs) became a graceful match: a
  panicked worker's chunk degrades to unrated (dlog'd), the other workers'
  restores still land — no process poison. New pin test
  `command_wrappers_round_trip_on_disk` drives the real async commands
  (fresh write → idempotent-skip re-write → clear-removes-sidecar).
- **4.2 Shared helpers.** `jpeg_rgb::decode_rgb` (new module) is the one
  "JPEG → validated RGB8" ritual; replaced the four production copies
  (bundle `fetch_decoded_preview` + `thumb_phash`, midtier
  `generate_mid_jpeg`) and the two ML smoke-test copies (faces, embed).
  Removing the last decode from bundle.rs/midtier.rs left their top-level
  `zune_jpeg` imports unused — deleted (clippy would have failed otherwise).
  Error text keeps each tier's prefix ("prvw …", "mid …"). midtier's test
  `decode_rgb` helper stays as a thin `u32`-typed wrapper over the shared
  one (its dimension asserts want u32). `tier_cache::prelude_matches`
  extracts the magic/version/tier/mtime/size check byte-for-byte from `get()`
  and `has_current()` — **no VERSION bump** (do-not-touch item 3);
  `get()`'s header-length bound stays get-only (only it holds the full
  entry). `test_util` (cfg(test), registered `pub(crate)` in lib.rs) hosts
  `synth_rgb`/`synth_jpeg`/`Lcg`, replacing the private copies in bundle /
  midtier / phash / analyze. **Ride-along:** lib.rs's module-map row still
  said tier cache "format v2" — corrected to v3 (same lying-comment class as
  Phase 3's fixes). `stale_version_byte_is_refused_and_dropped` stayed green.
- **4.3 Cheap tests.** TS (vitest, +28): `maskScans` (clip all-three-channel
  rule + the saturated-yellow non-trigger, peak threshold + border guard,
  runMaskScan dispatch), `burstInputs` (capturedAtToMs formats, the
  decodeOk→metadata fallback, the −1 eyesOpen sentinel→null, primary-face
  selection, thumb-only phash source), `utils/zoom` afZoomOrigin geometry +
  clamp, `pane/zoomTransition` branch table. Rust (+5): two
  **behavior-preserving extractions** in scan.rs made the inline logic
  unit-testable — `order_by_capture` (mtime sort: missing-last + path
  tiebreak) and `is_orphan_xmp_temp` (the crash-temp shape match, tested
  against a decoy battery) — plus `meta::From<Cr3Meta>` round-trip pinning
  every field (orientation dropped; file_size/lrc_rating/phash stay None).
- **4.4 CSP + fonts + assets.** CSP set in `tauri.conf.json` (was `null`):
  blob:-aware because every image tier / mask / histogram is a blob URL;
  `worker-src 'self' blob:` for the overlay worker (Vite emits it as a real
  file — verified in the build output — so `blob:` is only the ESM-fallback
  belt); `connect-src 'self' ipc: http://ipc.localhost` for Tauri IPC;
  `object-src 'none'` + `base-uri 'self'` harden the rest. Documented in
  ARCHITECTURE.md ("Content Security Policy"). **Fonts self-hosted** —
  deviation worth recording: Google's css2 serves ONE variable woff2 per
  family for the latin subset (identical sha256 across the 400/500/600
  requests), so rather than three near-identical files I ship one
  `inter.woff2` + one `jetbrains-mono.woff2` (latin subset only, English app)
  and declare the SAME discrete `@font-face` weights the old `@import` did,
  each pointing at its family's variable file — so weight matching and
  synthetic bold (the `<h1>/<h2>/<b>` elements) are byte-identical to before.
  The Google `<link>`s left index.html. **backdrop.jpg 519 KB → 133 KB**
  (downscaled 2560→1440 px, q50): it renders `grayscale(1) brightness(0.85)`
  at `opacity: 0.11` behind a radial vignette, so the downscale is
  imperceptible. **Deviation:** the plan floated WebP-with-fallback, but no
  encoder was available (no cwebp / ImageMagick / sharp, and sips couldn't
  write webp here), and a grayscale source via sips didn't shrink meaningfully
  — a downscaled JPEG under the 150 KB target was the clean available win.
  `app-icon.png` (1.29 MB source art) moved root → `docs/media/`; README hero
  reference updated (the only reference; `src-tauri/icons/` holds the built
  set, unaffected). **Prettier note:** App.css carries the pre-existing
  Phase-2 whole-file drift (266 lines) that was deliberately not folded;
  my `@font-face` block is stylelint- AND prettier-clean in isolation, so I
  committed only the addition and left the drift alone — consistent with the
  Phase 2 decision (prettier is not a gate; stylelint is).

**Gate 4 asks (LIVE — the dev app hot-reloads):**
1. **NAS-profile sanity lap** (xmp/scan threading moved to spawn_blocking):
   open a folder in `network` storage mode, rate a few frames, undo, hit the
   quit guard — confirm ratings still write and the analyze/scan progress
   still ticks.
2. **CSP live check** (the [LIVE GATE] item): with the new non-null policy,
   verify thumbs, previews, zoom fulls, the overlays worker (clip/peak masks),
   the histogram, and drag-drop all still work — on both platforms if handy.
   If the worker or IPC breaks under CSP, the fix is to widen the specific
   directive (never revert to `null`); the current policy is recorded in
   ARCHITECTURE.md.

Standing push approval applies AFTER the live gate passes — nothing pushed yet.

## Phase 5 — DONE 2026-07-08 (awaiting Gate 5 — LIVE)

Two commits on `main`, held local pending Oliver's live lap: `4ba34fc`
(5.1 frontend), `b44f13d` (5.2 backend). Full gate after: **TS 441 / Rust
109 / both tsc lanes / eslint / stylelint / clippy `-D warnings` /
`cargo fmt --check` / knip zero-findings / `pnpm build` clean — ALL green.**
New baselines: **441 TS (−1, the legacy-flip case) and 109 Rust (−2, the two
read_bundle corpus tests)**. The bundle even shrank slightly (378.66 → 378.15
KB) from the dead-path removal. Line numbers in the plan were stale
(Phase 2/4 shifts) — worked by symbol/content.

**Why it was safe to remove:** `read_bundle`/`navLegacy` was the Phase-2/3-era
fallback that flipped nav reads to the old `read_bundle` command ONCE, on the
first unknown-command IPC error (old backend + new frontend shipped out of
order). In any bundled build the backend always has `read_preview`, so the
flip could never fire — the whole dual path was dead. Traced the full spine
before cutting (fetchNav → imageStore lanes → PhotoPane hi-res → DevHud →
overlay/stage docs) rather than trusting the plan's stale line numbers.

- **5.1 Frontend.** `utils/bundle.ts`: deleted the `navCommand` state machine,
  `resetNavCommandForTests`, `isUnknownCommand`, the `for(;;)` retry loop and
  the `legacy` field — `fetchNav` is now a straight `read_preview` invoke.
  `image/imageStore.ts`: removed the `navLegacy` flag, `isLegacyNav()`, the
  three short-circuit guards (`requestZoomFull` / `requestMid` /
  `pumpMidSweep` each dropped their `|| this.navLegacy` term), the
  `noteNavTiming` legacy arg + the `navTimings`/`debugStats` `legacy` fields,
  and the legacy branch of the decoded-memory estimate (always the preview
  estimate now). `PhotoPane` `hiResSrc` dropped the `isLegacyNav()` fallback
  arm (the zoom-tier full is the only hi-res source — confirmed via
  `Resolved.full` = the ready zoom full, undefined until fetched); `DevHud`
  dropped both LEGACY readouts. `stage.ts` + `overlayService.ts` comments
  de-legacy'd. **Kept, per the plan:** the `"full"`-means-nav stage naming (a
  rename would ripple through presenter tests — accepted readability tax).
  Tests: deleted the legacy-flip case; `makeBundleBuf` stays (it's a generic
  no-hints nav frame used by 7 other tests) with its comment corrected.
- **5.2 Backend.** `bundle.rs`: deleted the `read_bundle` command + its
  `BundleHeader` wire struct. `cr3.rs`: deleted the `read_bundle` parser entry
  + the `Bundle` struct it filled (both `read_bundle`-only) and the two
  corpus tests that exercised it. **Verified NOT orphaned:**
  `read_fullres_from` — the shared head+grow full-res reader — stays, because
  `read_fullres_scan` (do-not-touch item 6, the hint-mismatch fallback) still
  rides it; `read_fullres_scan`'s own corpus test covers the same extraction
  the deleted tests did. `lib.rs`: `read_bundle` dropped from the
  `invoke_handler` list + module-map doc. Comment truth-restoration:
  `cr3.rs`'s module doc now describes the split nav(preview)+zoom(fullres)
  reads; `read_fullres_scan`'s doc points at `read_fullres_from`; `scan.rs`'s
  lazy-EXIF doc-link retargeted to `read_preview`; `xmp.rs`'s historical
  "per-nav sidecar read removed" note de-references the deleted fn. Left
  untouched: `read_preview` / `preview_parts` / `read_fullres` /
  `read_fullres_scan` and the hint-mismatch fallback.

**Gate 5 asks (LIVE — the dev app hot-reloads):** confirm the nav spine never
needed the fallback — cold folder open, scrub through it, zoom engage/release
(loupe), a compare pair, grid, folder switch mid-session, and close/reopen the
same folder (the tier-cache instant-paint hit path). Standing push approval
applies AFTER this passes — nothing pushed yet.

---

## Phase 6 — DONE 2026-07-13 (awaiting Gate 6 — LIVE)

**Commits:** `755fe53` (6.1 Batch A), `34279a8` (6.2 Batch B).

### What landed

`src/app/` created; ten hooks extracted from App.tsx as verbatim moves, deps
as parameters, war-story comments traveling with their code. App.tsx:
**4,617 → 4,140 (Batch A) → 3,245 lines**; App is now composition + the
zoom/keymap/held-scrub clusters (Phases 7/9) + JSX.

Batch A (`755fe53`):
- `useSmartDerivations` — ratedIds + the useSmartCulling call + the whole
  burst/similar/verdict/favorites-cap memo chain. Returns the plan's full
  set; `ratedIds`/`keepEligibleMap` are returned but not destructured in App
  (no external consumers).
- `useImageStoreWiring` — profile derivation + setProfile/needPxProvider/
  stage-ResizeObserver/DPR-rearm/metaSink/cursor effects + handleGridViewport.
- `useFolderTrouble` — trouble-chip state + store sink + hidden-reset +
  `retryUnreachableFolders`. (The plan listed the two sink effects under both
  the wiring hook and this one; they live here, with the state they set.)
- `useRatingPersistence` — feedback flash (+ FEEDBACK_MS), savingCount/
  failedWrites/savingRef/failedCountRef, the per-path serial write queue
  (persistRating + WRITE_RETRY_DELAYS), retryFailed, unmount timer cleanup.
- `useQuitGuard` — quitGuard/destroyedRef/quitShownAtRef + close-request
  registration + auto-close-after-flush (350 ms floor comment intact).
- `useDragAndDrop` — isDragOver + phase/openFoldersByPaths ref mirrors + the
  once-registered drop listener.
- `useUndoRedo` — stacks + recordAction/applyChanges/undo/redo.

Batch B (`34279a8`):
- `useSessionLifecycle` — recents writers, openFoldersByPaths (NFC war story
  verbatim), pickFolder, launch auto-open, rated/done debounce, beginCulling
  (go-straight-to-STAGED note verbatim), resetSession, leaveToHome.
  EMPTY_METADATA + openBusyRef/analyzingRef/sessionRecentsKeyRef moved in
  (hook-exclusive).
- `useSiteNavigation` — snapToFilter/reviveChallenger/buildNavEntry
  (internal) + goToSite/goBack/cycleChallenger.
- `useDecideCallbacks` — applyRating/unrateCurrent + challengerLoses/
  KeptBoth/Wins. **The sync-flush ordering comments and the
  setState-then-`dropZoomFullsExcept` sequencing moved byte-for-byte** —
  each decide still drops zoom fulls only after its last setState.

### Effect-order accounting

Each hook is called at its cluster's original position, so global effect
order is preserved, with two knowing exceptions (both order-independent
listener registrations): useQuitGuard's close-request + auto-close effects
now register at the state cluster's position (early) instead of their old
mid-file spots, and useUndoRedo (zero effects) is called early so
resetSession's dep array can legally reference the stack refs (param objects
evaluate at render time — TS2448 caught the late-call version).

### Deviations from the plan text

1. **Save/quit state split** — the plan grouped savingCount/failedWrites
   under useQuitGuard, but persistRating (useRatingPersistence) is their
   only writer and retryFailed needs both → circular hook dependency.
   Resolution: useRatingPersistence owns the counts + retryFailed;
   useQuitGuard consumes them read-only. Behavior identical.
2. **Dep arrays**: copied verbatim, then identity-stable params (refs,
   setState setters) appended only where exhaustive-deps requires — inert at
   runtime since those identities never change. The three compare decides
   keep their original arrays under their existing eslint-disable (the
   deliberate currentIndex omission is untouched).
3. `metadata` state declaration moved above the useSmartDerivations call
   (it's a param); declaration order of useState calls is behavior-neutral.
4. Stayed in App per "do not force": compare-pair pin effect, zoom pin+fetch
   effect, grid-range-clear effect (the plan assigned none of them to a hook).
5. resetSession's "(Refs are stable; declared further down…)" parenthetical
   dropped — no longer true; the stacks arrive as hook returns above it.

### Line-count honesty

The plan's "under ~2,000 after this phase" doesn't fall out of its own task
list: the ten listed clusters total ~1,400 lines, and the rest of App.tsx is
the keymap/zoom/held-scrub clusters (~800, Phases 7/9) plus ~1,900 lines of
JSX + bottom-of-file helper components that no Phase 6 task touches. Every
cluster the plan names is extracted; 3,245 is the floor this phase's scope
reaches.

### Gate results (all green)

- `pnpm test` 441 passed (baseline unchanged — extraction only)
- `tsc --noEmit` + `tsc -p tsconfig.tests.json` clean
- `pnpm lint` (eslint) + `pnpm lint:css` (stylelint) clean; prettier clean
  over App.tsx + all ten hooks
- `cargo test` 109 passed; `clippy --all-targets -- -D warnings` clean;
  `cargo fmt --check` clean (Rust untouched this phase)
- Bundle diff sanity: `pnpm build` → index-*.js 383.53 kB (117.39 kB gzip) —
  hash moved, size unmoved from the Phase 5 ballpark.

**Gate 6 asks (LIVE — the dev app hot-reloads).** Both batches are in, so one
lap covers them: open folders (picker, drag-drop, a recents click, and the
launch auto-open if enabled), begin culling on a real folder (sort + rating
restore + resume-at-first-unrated), rate through a burst (feedback flash +
save pill), rate-while-zoomed carry, undo/redo incl. a compare compound
action, a compare session (Enter/Backspace/K/F + auto-exit on last unrated),
grid multi-select rate, finish dialog open, quit guard (close mid-save →
auto-close after flush), Esc chain back to home, folder-trouble chip if the
NAS is handy, and a second folder open after leave-to-home (session teardown).
Standing push approval applies AFTER this passes — nothing pushed yet.

---

## Phase 7 — DONE 2026-07-14 (awaiting Gate 7 — LIVE)

**Commits:** `e5876ff` (7.1 useCullKeymap), `e52d8e1` (7.2 usePaneZoom).
App.tsx: **3,245 → 2,792 (7.1) → 2,663 lines.** Both tasks landed; nothing
was skipped — 7.2's revert option stays open pending its live gate.

### 7.1 `useCullKeymap`

Verbatim move of the chrome-screen shortcuts, the big cull keymap, the
capture-phase ESC swallow, and the once-bound window listeners. Contract
held exactly:
- cullKeyRef once-bind + ref-dispatch — listeners register once, closures
  rebuild per render; the two `[]` listener effects moved untouched.
- Modal precedence (settings → quitGuard → confirmHome → actionsOpen →
  scrub-interrupt → Ctrl combos → Tab/help → Space → ESC → sites) is a
  byte-for-byte move.
- The 35-entry dep array copied unaltered under its existing
  exhaustive-deps disable (deliberate chipsTooltip omission intact); the
  macOS resumed-repeat Space guard and `e.code` keyup fallback untouched.
- PAN_STEP moved in (keymap-only); the chrome effect gained only
  `setSettingsOpen` in deps (stable setter, eslint requirement).

### 7.2 `usePaneZoom`

Verbatim move of the zoom state cluster (isZooming/zoomLevel/panOffset/
keepZoomOnAdvanceRef/zoomSwapInstant + mirrors + zoomZRef), pan (+PAN_LIMIT),
resetZoom, the two-rAF zoomSwapInstant reset, the index-change reset/carry,
the mouse-drag pan loop, and handleStageMouseDown. The decide-side
setState-then-drop sequencing stayed in useDecideCallbacks (reaches the hook
only via setPanOffset/setZoomSwapInstant/keepZoomOnAdvanceRef, per plan).

Deviations:
1. **zoomZ/zoomGlide stay in App's culling render.** They read the loupe's
   `cur` (useImage), which doesn't exist at any legal call position for the
   hook (resetZoom feeds useSessionLifecycle far above). App assigns
   `zoomZRef.current` at the same render spot as before; the derivation text
   is unchanged. This is the plan's own "don't force" rule applied to two
   pure derivations.
2. The memory-pressure listener stays App-owned (the plan never assigned it)
   but sits below the hook call now so resetZoom is initialized — a mount
   registration-order shift among independent listeners.
3. usePaneZoom is called after `positionInFilter` (handleStageMouseDown
   needs it), so the hook's five effects register after that memo instead of
   at the old scattered spots; all are self-contained (rAF, ref mirrors,
   window listeners keyed on mouseZooming) with no cross-effect ordering
   contract.
4. pickFromStrip/pickChallengerFromStrip list `isZoomingRef` in deps now
   (stable hook return, exhaustive-deps requirement) — identity never
   changes, so their memoization is unaffected.

### Gate results (all green)

441 TS / 109 Rust tests; tsc ×2, eslint, stylelint, prettier, clippy
`-D warnings`, `cargo fmt --check` all clean. Bundle: 385.96 kB
(118.12 kB gzip) vs 383.53 kB (117.39 kB) after Phase 6 — +0.7 kB gzip of
hook-parameter plumbing, within budget.

**Gate 7 asks (LIVE — the dev app hot-reloads).** The 7.1 keymap lap:
every modal's key swallowing (settings, quit guard, leave-confirm, act-on-cull),
Space-zoom arm/release, hold Space through a rating (macOS resumed-repeat
quirk — the phantom keydown must change nothing), ESC from each site opening
the leave-to-home confirm (Enter=leave, Esc=stay; the site-by-site "Esc
chain" in the plan's Task 7.1 gate text is stale — Oliver dropped that design,
and goBack survives only for the compare auto-exit landings),
Ctrl+Z/Y/E/A, scrub then release the arrow with Shift/Alt held (e.code keyup
fallback), Tab-hold help, digits 1-4 filter cycling. The 7.2 zoom lap —
watch for ANY paint artifact; if one shows, say so and 7.2 gets reverted
(pre-authorized): zoom engage/release glide in loupe AND both compare panes,
rate-while-zoomed carry (loupe + compare; the swap must land at scale with
no glide, then glides return), mouse-drag pan + cursor-anchored engage +
drag continuing across a carried advance, thumb/rail toggle while zoomed,
memory-pressure critical → auto-unzoom if reproducible. Standing push
approval applies AFTER this passes — nothing pushed yet.
