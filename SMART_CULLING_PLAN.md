# Smart Culling for CULL — Implementation Plan

## Context

CULL is a keyboard-fast culling app for Canon CR3 RAW files (Tauri 2: pure-Rust backend + React 19/TS frontend). Today the user keeps/rejects every frame by hand. We add **advisory, fully-local smart culling**: after a folder loads, a background pass scores each image and surfaces a *suggested* verdict that pre-empts the obvious calls (soft focus, motion blur, bad exposure, "not the best frame of this burst"). The user still confirms every verdict with the existing keys. **Nothing the AI computes is ever written to an XMP sidecar.** This preserves two documented invariants: CR3 files are never modified, and CULL never auto-rates.

User-chosen direction (firm):
- **Signals (all four):** technical misses, best-of-burst, faces & eyes, quality ranking.
- **Approach: classical-first MVP** — ship technical-misses + best-of-burst with **zero ML models** (pixels + EXIF, deterministic, offline). Faces/eyes + aesthetic layer on later as local ONNX onto the *same* pass.
- **Autonomy: advisory only.**

**Architecture decisions (resolved):**
- **Batch pass runs in the Rust backend** (`analyze.rs`), not the JS overlay worker — the metadata it needs (AF point, drive mode, ms timestamps) lives in Rust, a 500-image pass must not fight the webview display-decode pipeline, and Tier-2 ONNX must run natively anyway. We **port the gradient math** from `src/overlays/maskScans.ts` to Rust; the JS worker keeps doing its interactive single-image overlays.
- **Two layers — this is the key to mid-cull settings changes:** the *expensive* layer (decode + raw metrics) runs once in Rust and is cached; the *cheap* layer (verdict from `metrics + settings`) is a **pure TS function**. So toggling a signal or the confidence level re-derives verdicts **instantly with no re-decode**. Only enabling Tier-2 ML triggers a real re-pass.

## UI / interaction design (pinned)

**Suggestion badge — reuses the committed-verdict slot.** Verified cell layout (`ThumbCell.tsx`, `GridView.tsx`): top-left = LrC star badge; **bottom-right = committed verdict dot** (`cull-thumb__dot` / `cull-grid__dot`); grid bottom-left = hover filename; top-right free. The suggestion is itself a verdict, so it renders **in the same bottom-right slot**, styled provisional: **dashed outline + ~55% opacity + hollow glyph** (outline ✓/✕, vs the solid filled committed dot). It renders **only when the frame is unrated** (`rating === undefined`); the existing dot renders only when rated — they are temporally mutually exclusive and never collide. Pressing Enter/Backspace sets `rating`, the solid dot renders, and the suggestion's `!rating` guard stops rendering it — visually superseded in place; nothing is overwritten in storage (the suggestion was never persisted). **No confidence number on the cell** (clutter at thumbnail scale) — confidence lives in the loupe/ExifRail. Top-right stays free.

**Burst visuals (separate from the dot):** consecutive burst frames get a **shared faint background tint** across their run + a **"Burst · N" count pill on the first cell**; the **winner gets a bright solid border**, losers carry the ghost-reject dot. *Killed:* auto-routing bursts into Compare view (bends an A/B tool, forces a mode switch); connecting brackets between cells (breaks on grid row-wrap + virtualization).

**Loupe / ExifRail:** a "Suggestion" row — glyph + confidence bar + `reasons.join(", ")`, e.g. `Reject · 82% · soft focus, not best of burst (3 of 7)`. This is the only place confidence shows.

**Compare mode:** **suppress suggestion ghosts entirely** in compare panes — compare is a deliberate A/B and suggestions are noise there (the committed dot already self-suppresses during the feedback flash, `CompareView.tsx:377`).

**`5` filter = "suggested":** jumps to frames with a live suggestion that are still unrated. During the progressive fill, if empty/partial, show an "Analyzing…" empty state, not "no photos".

## Lifecycle & correctness (verified against real code — the bulletproofing core)

- **Generation guard (mandatory).** `imageStore` keeps a `generation` counter bumped on `reset()`/`hardReset()` (folder change / session end); in-flight reads capture `const gen = getGeneration()` before `await` and bail if it changed (`imageStore.ts:111,140-144,471-474,574-577`). The quality pass **must do the same**: capture `imageStore.getGeneration()` at dispatch, and after each result chunk **drop the results if the generation changed** (folder switched mid-analysis). Without this, a stale folder's scores land on the new folder — there is no other guard.
- **Own progress channel.** `beginCulling` registers `listen("analyze-progress")` per-invoke and **unlistens in `finally`** (`App.tsx:632,700`), so that listener is gone by the time our background pass runs. The pass emits on its **own channel `quality-progress`** (same `{done,total,phase}` shape) with its own listener mounted for the cull session and torn down on exit/folder-change.
- **Double-run guard.** Mirror `analyzingRef` (`App.tsx:134,627`) with a `qualityRef` so a re-trigger can't start two passes.
- **Keying by `Img.id`.** Backend returns scores in input order; map `scores[i] → dispatchedImages[i].id` (same pattern as the ratings remap at `App.tsx:643`). `id` is stable from append (`App.tsx:507`); images are frozen after the `beginCulling` sort, so index→id is valid as long as we capture the dispatched array and gen-guard. State holds `scores: Record<number, ImageScore>` keyed by id.
- **Suppress ghosts on already-rated frames.** `analyze_folder` restores keep/reject/favorite into `ratings` **before** our pass runs; the badge checks `!ratings[id]` so restored frames show their real dot, never a ghost.
- **Read-pool contention (the NAS bullet).** A separate Rust decode batch **bypasses imageStore's bounded-concurrency pools and shares Tauri's blocking pool**, which will **starve interactive reads on a NAS** (`imageStore.ts:712-731` priority model; profiles in `types/settings.ts:118-156`). Mitigation: the pass is **storage-aware and cooperative** — concurrency cap **1 on `network`, a few on `local`**; it **starts only after the first screenful of thumbs has settled**; it runs in **small chunks** and between chunks **backs off while the user is actively loading full-res** (read `imageStore` backpressure, e.g. `fullInFlightPaths.size`). Plus a settings escape hatch: "Analyze on open" can be turned off for a manual **Analyze** button. On NAS it simply fills in slowly in the background without harming interaction — acceptable because it's advisory.

## Scoring model (`src-tauri/src/analyze.rs`, new)

Backend returns **raw metrics only** (verdict is derived in TS). camelCase wire (mirrors `meta.rs`):

```rust
#[derive(Clone, serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImageScore {
    pub index: usize,            // input-order index of the dispatched batch
    // Tier 1 (classical, MVP)
    pub af_sharpness: f32,       // variance-of-Laplacian over AF-region crop, normalized 0..1
    pub af_valid: bool,          // false when AF point absent → TS halves its weight
    pub global_sharpness: f32,
    pub blown_pct: f32,          // % pixels all-3-channels >= CLIP_HIGH
    pub crushed_pct: f32,        // % pixels all-3-channels <= CLIP_LOW
    pub exposure_score: f32,     // 0..1
    pub motion_blur_likelihood: f32,
    pub burst_group: Option<u32>,
    pub burst_pos: Option<u32>,  // 1-based position within group (for "3 of 7")
    pub burst_len: Option<u32>,
    pub is_burst_winner: bool,
    // Tier 2 (ML, later) — present now so the wire contract is stable
    pub faces: Vec<FaceScore>,   // empty in MVP
    pub aesthetic: Option<f32>,  // None in MVP
    pub decode_ok: bool,         // false if preview missing/corrupt → TS shows no suggestion
}

#[derive(Clone, serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FaceScore { pub bbox: [f32;4], pub eyes_open: f32, pub face_sharpness: f32 }
```

Named thresholds (no magic numbers; calibrated against the 1620×1080 PRVW — starting values, tuned in Phase 1):

```rust
const CLIP_HIGH: u8 = 250; const CLIP_LOW: u8 = 5;            // ported from clipScan all-3-channel test
const BLOWN_REJECT_PCT: f32 = 0.25; const CRUSHED_REJECT_PCT: f32 = 0.35;
const SHARP_REJECT: f32 = 0.15; const SHARP_STRONG: f32 = 0.55;
const SLOW_SHUTTER_S: f64 = 1.0/60.0; const HANDHELD_RECIPROCAL_K: f64 = 1.0; // blur thresh ≈ 1/(K·focal)
const BURST_GAP_MS: i64 = 700; const AF_CROP_FRAC: f32 = 0.20;
```
TS-side (so they live with the verdict function): `REJECT_MIN_CONFIDENCE = 0.6` and the confidence-level → threshold map (Low/Med/High).

Formulas:
- **Sharpness** = variance of the 4-neighbour Laplacian over the region (Welford one-pass), normalized + clamped; **Tenengrad** (Sobel) computed alongside as a cross-check (large disagreement lowers TS confidence). Reuse the central-difference loop shape from `peakScan` (`maskScans.ts:50`).
- **AF-region crop:** AF percentages are in *display* coords (orientation-applied, `meta.rs:29-34`) but the decoded PRVW is the *un-rotated* sensor frame — **map display-% back through the inverse of `orientation`** before cropping (for orientations 6/8 width/height swap — a real correctness trap). Crop centred at the mapped point, size `AF_CROP_FRAC·min(w,h)`. AF absent → centre crop + `af_valid=false`.
- **Clipping %** = faithful all-three-channel port of `clipScan` (needs RGB).
- **Exposure score** from a 64-bin luma histogram; `exposure_bias` only annotates a reason, never penalizes.
- **Motion-blur vs focus-miss** (`shutter_seconds`): `blur_thresh = HANDHELD_RECIPROCAL_K / focal_length_mm`. Slow shutter + low global & AF sharpness → motion blur. Fast shutter + low AF but ok global → missed focus. `motion_blur_likelihood = clamp(shutter/blur_thresh)·(1−global_sharpness)`.

**Verdict derivation lives in TS** (`src/smart/deriveVerdict.ts`, pure): `deriveVerdict(score, settings) → {verdict: Rating|null, confidence, reasons[]}`. Cascade: (1) blown/crushed past threshold → reject; (2) `af_sharpness < SHARP_REJECT` (weighted by `af_valid`) → reject ("soft focus"/"motion blur"); (3) in a burst and `!is_burst_winner` → reject ("not best of burst (pos of len)"); (4) none fire + sharp + well-exposed → low-confidence keep. Confidence `= 1 − Π(1−cᵢ)`; reject below the level threshold → `verdict: null` (stay silent). `decode_ok===false` → null. **Never emit `favorite` in Tier 1.**

## Burst grouping (`analyze.rs`)

Metadata-only pass before pixel scoring. Walking capture order, extend the current group vs the previous frame when ALL hold: `drive_mode>0` on both, `|Δcaptured_at_ms| < BURST_GAP_MS`, `focal_length` equal (epsilon), **and same `srcFolder`** (multi-folder opens merge into one global mtime order — `scan.rs:290-297` — so without the folder key two different shoots with colliding mtimes would falsely group). `captured_at` (ms) when present, else mtime-ms. Size-1 → `burst_group=None`. Winner = max `af_sharpness`, tiebreak global sharpness, then lowest clipping, then earliest. `srcFolder` must be passed into the command (it's on `Img`, not in the CR3) or derived from each path's parent dir.

## Backend changes

- **New `src-tauri/src/analyze.rs`**:
  ```rust
  #[tauri::command]
  pub(crate) async fn analyze_quality(
      window: tauri::Window, paths: Vec<String>, folders: Vec<String>,
      concurrent: Option<bool>, chunk_start: usize, chunk_len: usize,
  ) -> Result<Vec<ImageScore>, String>
  ```
  Called in **chunks** from JS (cooperative backoff). Body in `spawn_blocking`. Phase A (metadata + burst grouping over the *full* path list, cached or recomputed cheaply) → Phase B (decode the chunk's PRVW via `cr3::preview_jpeg` `cr3.rs:108` + `zune-jpeg` → metrics) → emit `quality-progress`. Per-image decode failure → `decode_ok=false`, never fails the batch.
- **Concurrency mirrors `analyze_folder`:** sequential on `network`, small fixed pool on `local` (start with `std::thread::scope` like `scan.rs`, no new dep; add `rayon` only if profiling demands).
- **`Cargo.toml`:** add `zune-jpeg = "0.4"` (pure-Rust, baseline-SOF0, can decode luma-only). Keep `image` dev-only; do **not** promote it.
- **`lib.rs`:** `mod analyze;` + register `analyze::analyze_quality`.
- **No write path exists in this module — the never-modify-CR3 invariant is structural.**

## Frontend changes

- **`src/types/ipc.ts`:** add `ImageScore`, `FaceScore`. Reuse `AnalyzeProgress` shape for `quality-progress`.
- **`src/types/rating.ts`:** extend `Filter` with `"suggested"`.
- **`src/smart/deriveVerdict.ts`** (new, pure): `Suggestion` type + `deriveVerdict(score, settings)`. Unit-testable in isolation.
- **`src/smart/useSmartCulling.ts`** (new hook): owns the chunked, gen-guarded, backpressure-aware driver; the `quality-progress` listener; `scores` state keyed by `Img.id`; restart on folder change; abort via generation. Exposes `scores` + an `analyzing` flag.
- **`App.tsx`:** hold `scores: Record<number, ImageScore>`; `suggestions = useMemo(() => derive over scores + settings)` (instant re-derive on settings change); trigger the hook after `beginCulling` settles and first thumbs load; `qualityRef` guard. `visibleIndices` memo (`App.tsx:329`): special-case `filter==="suggested"` → ids with `suggestions[id]?.verdict && !ratings[id]`. Keyboard `case "5"` after `"4"` (`App.tsx:2472`) + status-bar button.
- **Badge:** `ThumbCell.tsx` / `GridView.tsx` take `suggestion?` + `burst?`; render the ghost dot in the bottom-right slot **only when `!rating`**, plus burst tint/count/winner-border. Suppress ghosts in compare panes.
- **`ExifRail.tsx`:** "Suggestion" row (glyph + confidence bar + reasons).
- **Settings (`types/settings.ts`, `hooks/useSettings.ts`, `SettingsDialog.tsx`):** add `smartCulling: boolean` (default **true**), `smartCullingConfidence: "low"|"medium"|"high"` (default `"medium"`), `smartCullingOnOpen: boolean` (default **true**). `coerceSettings()` is a per-field defensive merge (`useSettings.ts:25-64`) so new fields **auto-default with no key bump / no migration**. New "Smart Culling" `<Section>` reusing `<SettingRow>` + `<Toggle>` + `<SegmentToggle>` (use a 3-way SegmentToggle for confidence — **no slider needed**, reuses an existing control). **Per-signal toggles cut for the MVP** (only two cheap signals); Tier-2 ML gets its own toggle, default **false**.

## Tier-2 ML (later, outline)

Populates the already-present `faces`/`aesthetic` on the same decoded buffer in the same `analyze.rs` Phase B. YuNet (~300 KB ONNX) → `eyes_open` + face sharpness ("closed eyes" reason, sharpest-face burst tiebreak). NIMA (~5-15 MB ONNX) → `aesthetic` (tiebreak/sort; *enables* a conservative, capped `favorite` suggestion — the one verdict Tier 1 withholds). Add `ort = "2"` behind a cargo feature; EP: CoreML (macOS) / DirectML (Windows) / CPU. Bundle `.onnx` as Tauri `bundle.resources`, lazy-load, cache `ort::Session` in managed state. Advisory/no-sidecar invariant unchanged.

## Phasing

1. **Classical scoring backend (no UI):** `analyze.rs` metrics + burst grouping (incl. `srcFolder` key) + chunked `analyze_quality` + `zune-jpeg`; register; Cargo. Testable via `cargo test` + invoking and printing JSON.
2. **Verdict + advisory UI:** `deriveVerdict.ts`, `useSmartCulling.ts` (gen-guard, chunk/backoff, `quality-progress`), `scores`/`suggestions` in App, ghost badge, burst visuals, ExifRail row, `"suggested"` filter + `5`, settings section. Testable in `pnpm tauri dev`.
3. **Tier-2 ML:** `ort` + ONNX, faces/eyes + aesthetic, capped `favorite`, sharpest-face tiebreak. Feature-flagged.

## Verification

Per user rules: 80%+ coverage + visual checks.
- **Rust unit tests** (`#[cfg(test)]` in `analyze.rs`; `cargo llvm-cov --fail-under-lines 80`): sharp vs Gaussian-blurred synthetic buffers (`varLaplacian(sharp) > varLaplacian(blur)`, flat≈0); all-white→`blown_pct≈1`, all-black→`crushed_pct≈1`, saturated-yellow (R255 G210 B0)→`blown_pct≈0` (validates the all-3-channel port); exposure monotonicity; AF-crop orientation mapping for each of 1/3/6/8 (the swap trap); **burst grouping** — gap / focal change / `drive_mode==0` / **different `srcFolder`** each split a group; lone frame→None; winner + tiebreak chain; `decode_ok=false` path.
- **TS unit tests:** `deriveVerdict` table (each cascade rule, reject-below-threshold→null, favorite never in Tier 1, confidence-level changes flip verdicts); the `"suggested"` predicate; badge shown only when `!rating`; **gen-guard** (stale-generation chunk is dropped); settings auto-default merge.
- **End-to-end (the gate):** `pnpm tauri dev`, folder with known soft/sharp frames + a Canon burst. Confirm ghost dots appear in the verdict slot (dashed/hollow), supersede on rating, burst shows tint+count+one winner, ExifRail shows reasons+confidence, `5` filters suggested-only, settings toggle hides/shows instantly and confidence level re-derives instantly. **Advisory-only proof:** before any keypress, confirm **no `.xmp` was created/modified** by the pass (`ls -la` + mtime diff); then a keypress writes the sidecar as before. **Folder-switch race:** open folder A, immediately open folder B mid-analysis → confirm A's scores never appear on B. **NAS responsiveness:** on a network profile, confirm culling stays responsive while the pass fills in.

## Critical files

- **New:** `src-tauri/src/analyze.rs`; `src/smart/deriveVerdict.ts`; `src/smart/useSmartCulling.ts`.
- `src-tauri/src/cr3.rs` — `preview_jpeg` (:108), `Cr3Meta` (:621), orientation helpers; maybe `read_meta_only`.
- `src-tauri/src/scan.rs` — template: `analyze_folder` progress + NAS/local concurrency + mtime order (:130-309).
- `src-tauri/src/lib.rs` / `Cargo.toml` — register command / add `zune-jpeg`.
- `src/App.tsx` — `scores` state, `suggestions` memo, hook trigger in `beginCulling` (:625), index→id map (:643), `5` key (:2472), `visibleIndices` (:329); guards `analyzingRef`/`openBusyRef` (:132-134).
- `src/image/imageStore.ts` — `getGeneration()` (:140), backpressure (`fullInFlightPaths`, `:712-731`), profiles (`types/settings.ts:118-156`).
- `src/components/ThumbCell.tsx`, `GridView.tsx`, `verdictGlyph.tsx`, `ExifRail.tsx`, `CompareView.tsx` — ghost badge, burst visuals, suppress in compare.
- `src/hooks/useSettings.ts` (:25-64 merge), `src/types/settings.ts`, `src/components/SettingsDialog.tsx` — settings section.
- Port sharpness/clipping math from `src/overlays/maskScans.ts`.

## Risks / open questions

- **AF reliability:** not all bodies/modes populate AFInfo2 → centre-crop + `af_valid=false`, halved weight; never reject on AF alone when absent. Calibrate to the user's gear.
- **PRVW resolution:** 1620×1080 attenuates high-freq detail → thresholds are preview-calibrated (good for relative burst ranking + gross softness; a marginally-soft frame may pass). Fallback: full-res `read_bundle` preview for the AF crop only if precision falls short.
- **Threshold calibration is empirical:** run on a folder the user already culled; tune to minimize false-rejects (the costly error in an advisory tool).
- **NAS contention:** mitigated by storage-aware cap + start-after-thumbs + chunked backoff + manual-analyze escape hatch; still the main thing to watch in the E2E NAS test.
- **`zune-jpeg` on real previews:** validate against actual CR3s early (progressive-preview edge case).
- **Tier-2:** model bundle size + cross-platform ONNX packaging; feature-flag to keep the MVP installer small.
