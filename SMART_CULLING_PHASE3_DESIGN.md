# Smart Culling — Phase 3d + 3c Design (near-duplicates + aesthetic/favorite)

**Date:** 2026-07-05 · **Status:** approved design, pre-implementation
**Scope:** the two remaining Tier-2 phases from `SMART_CULLING_PLAN.md` § Tier-2 roadmap — **3d near-duplicate grouping** and **3c aesthetic + capped favorite** — designed together, implemented in that order.
**Parent doc:** `SMART_CULLING_PLAN.md` (roadmap LOCKED 2026-07-05; sources vetted there). This doc settles the impl decisions the roadmap left open.

## Decisions (settled with Oliver, 2026-07-05)

1. **One combined design** covering 3d + 3c, phased inside one implementation plan.
2. **Self-export all models** from official weights via a one-off Python script; the export script doubles as the PyTorch-parity checker. (Kills the "VERIFY community ONNX" open question by not using community exports at all.)
3. **Bundle everything** — installer contains all models, fully offline out of the box. No download-on-enable UI.
4. **Time-local grouping only** — lookalikes group only within a capture-time window; no whole-folder clustering.
5. **One enriched pass** — pHash/embedding/aesthetic computed inside the existing `analyze_quality` chunk pass on the same single cache-routed read + decode per file; new fields ride `ImageScore`; all cross-frame derivation stays pure TS. (Honors the locked one-read-per-file and cross-frame-in-TS principles.)

## Models

| Model | Source | Export | Size | Output |
|---|---|---|---|---|
| DINOv2-small | facebook/dinov2-small (Apache-2.0) | `dinov2s.onnx` fp16, 224×224 | ~43 MB | 384-d CLS embedding |
| CLIP ViT-B/32 image tower | OpenAI weights (MIT) | `clip_vitb32_visual.onnx` fp16, 224×224 | ~175 MB | 512-d embedding |
| LAION improved-aesthetic-predictor head | Apache-2.0, 4-layer MLP | `laion_aesthetic.onnx` | <2 MB | scalar 1–10 |

**`scripts/export-models.py`** (uv-managed, dev-only, never shipped): exports all three from official weights and runs **parity checks** against the PyTorch originals on ≥5 real corpus previews — cosine ≥ 0.999 for embeddings, |Δ| < 0.05 for the aesthetic score — before anything is committed. Pinned sha256s recorded here and asserted by the corpus smoke test (same contract style as YuNet/OCEC).

**Export record (filled at export time):** run against 14 real preview JPEGs extracted from `sample_cr3s/` via `exiftool -b -PreviewImage` (5 sampled per model, per the script's `sample_images(n=5)`), 2026-07-05.

| File | Size | sha256 | Parity |
|---|---|---|---|
| `dinov2s.onnx` | 43,372,690 bytes (~41.4 MiB) | `bc2bbab71ee5fceee6220cc6efd56177b96f6b9ba93860f3508a2de2ba49afb2` | worst-cosine = 0.99999 (gate ≥ 0.999) |
| `clip_vitb32_visual.onnx` | 175,903,114 bytes (~167.7 MiB) | `92ee3ff3cf2333bd927d94a5bf2a79a08e24ae2c5162c8f35be5bd24038d322c` | worst-cosine = 1.00000 (gate ≥ 0.999) |
| `laion_aesthetic.onnx` | 2,275 bytes | `a6f75f3efc309de7e5ad50761e8fea15415a44c929df0e188b8a8c5c053479d4` | worst-delta = 0.00000 (gate < 0.05); raw scores sampled 3.81/4.01/3.85/3.81/3.92 |

Both DINOv2 and CLIP export as fp16 with fp32 I/O (`keep_io_types=True`); the LAION head is fp32 (tiny `nn.Linear(512,1)`, no benefit to fp16). All three graphs' input/output names, shapes, and dtypes were verified against the fixed contracts above (`pixel_values`/`embedding` f32, `[1,3,224,224]`/`[1,512]` in, `last_hidden_state [1,257,384]`/`embedding [1,512]`/`score [1,1]` out).

**Two export-script adaptations were required beyond the brief's starting point** (both documented inline in `scripts/export-models.py`):
1. `onnxconverter_common`'s `keep_io_types=True` fp16 conversion left several float32/float16 node-input type mismatches unresolved (e.g. the fp32 graph input wired directly into a Conv whose weights had converted to fp16; a Concat rejoining a fp32-kept Resize subgraph with an fp16 initializer) — onnxruntime rejected these at load. Added a generic post-conversion type-harmonizer pass (`harmonize_fp16_types`) that walks the topologically-ordered graph once, tracks each tensor's known element type, and inserts a `Cast(FLOAT→FLOAT16)` wherever a node mixes the two — plus drops now-stale `value_info` dtype annotations that no longer match post-conversion reality.
2. DINOv2-small's pretrained position embeddings are for a 518×518 (37×37-patch) grid, so for our fixed 224×224 (16×16-patch) contract, `transformers`'s DINOv2 implementation always traces a dynamic bicubic-interpolation subgraph — which hit a real onnxruntime CPU `Resize` kernel limitation (`ScalesValidation` rejects the dynamically-computed scale factors), independent of fp16. Since that interpolation depends only on the fixed target height/width and the frozen `position_embeddings` parameter (never on image content), it was precomputed once and monkey-patched in as a graph constant (`freeze_dinov2_pos_encoding`) — bit-exact vs. the reference model, which recomputes the same content-independent value on every call.

**Repo mechanics:** GitHub rejects >100 MB plain files. `dinov2s.onnx` and the LAION head commit normally to `src-tauri/models/`; the CLIP tower lives as an asset on a **`models-v1` GitHub release** and is pulled by **`scripts/fetch-models.sh`** (sha256-pinned) into `src-tauri/models/` (gitignored there). Run once per dev machine; `release.yml` runs it on both runners before `tauri build`, so the installer bundles everything (existing `bundle.resources: ["models/*"]` picks it up unchanged). `smart-ml` builds fail with a clear "run scripts/fetch-models.sh" message when the file is missing. Git LFS rejected: bandwidth quota bites every CI run.

**Independent re-verification (2026-07-05):** the original DINOv2 parity number above was computed with the PyTorch reference taken from the *same monkey-patched* model instance used for `freeze_dinov2_pos_encoding` (i.e. circular — it proved ONNX ≈ patched-model, not ONNX ≈ the true pretrained original). The **shipped** `src-tauri/models/dinov2s.onnx` was independently re-verified against a freshly loaded, completely unpatched `facebook/dinov2-small` on the same 5 preview JPEGs: **worst-cosine = 0.999994** (gate ≥ 0.999, PASS). Method: standalone script, no monkey-patch of any kind on the reference model. `scripts/export-models.py`'s `export_dinov2` was also fixed to compute references pre-patch and gate the ONNX parity check against those (plus a new bit-exactness assert between pre- and post-patch outputs), so future export runs are non-circular by construction.

## Backend (Rust)

- **pHash — always-on, pure Rust, no feature flag:** 64-bit DCT pHash from the already-decoded PRVW buffer (grayscale → 32×32 → DCT → 8×8 low-freq block → median threshold). New wire field `phash: Option<u64>` (`None` only on decode failure). ~free per frame; gives near-exact-dupe grouping even with ML off.
- **Embedding + aesthetic — behind the existing `smart-ml` cargo feature + `ml` request flag,** in the same enrich hook that runs YuNet→OCEC, on the same decoded buffer: bilinear resize to 224×224 (shared helper with OCEC preprocessing), then
  - DINOv2 → **L2-normalized** `embedding: Option<Vec<f32>>` (384-d) — new wire field;
  - CLIP tower → LAION head → rescale 1–10 → 0..1 into the **already-present** `aesthetic: Option<f32>`.
- **`ml_models.rs` (targeted refactor):** five lazy ONNX sessions exist after this. Extract the per-OS-EP (CoreML/DirectML/CPU) lazy-session pattern from `faces.rs` into one `LazySession` helper + registry; each model becomes a declaration. `lib.rs` setup registers the new model paths beside `init_eye_classifier`.
- **Chunk budget unchanged:** all work stays inside the one IoGate-permitted read per file; added cost is pure inference (~50–150 ms/frame on CoreML/DirectML), absorbed by the existing chunked backpressure-aware driver.
- **Wire size:** 384 f32 as JSON ≈ 4 KB/frame ≈ 32 KB per 8-file chunk — negligible; embeddings ride `ImageScore`, no side map.

## TS layer (pure derivation)

**`src/smart/groupSimilar.ts`** (new, pure — mirrors `groupBursts`):
- **Inputs:** accumulated `scores` map (phash, embedding, `capturedAtMs`/`mtimeMs`), burst membership from `groupBursts`, settings. **Output:** `SimilarGroup[]` with the burst shape (members, winner, per-loser margin).
- **Adjacency chaining, time-local:** frames sorted by capture time; frame *i* pair-tests against frame *i−1* only, link requires the gap ≤ `SIMILAR_WINDOW_MS` (start 5 min, calibration-tuned). Chain extends like burst gaps. A stray unrelated shot mid-scene splits the group in two — accepted MVP semantics; lookback-linking across a stray frame is a noted extension, not built. (Adjacency also guarantees groups are contiguous strip runs, which the fieldset box UI requires.)
- **Two-tier pair test** (either passing links the pair):
  - **pHash tier (always):** Hamming ≤ `PHASH_NEAR` (~10/64) → near-exact dupe. The whole story when ML is off.
  - **Embedding tier (ML on):** cosine ≥ `SIMILAR_COSINE` (~0.92, calibration-tuned) → lookalikes pHash misses (recompose, slight angle change).
- **Bursts take precedence:** frames inside a burst run never join a similar group (burst-as-single-node is a later extension). Groups form only over frames that have scores — the analyzed, unrated-first set; rated frames don't need advisory grouping.
- **Winner:** extract the burst winner/tiebreak ladder (keepEligible candidacy → eyes-open → face sharpness → af_sharpness…) from `groupBursts.ts` into a shared **`pickWinner.ts`** so the two group kinds structurally cannot drift. Same rules: no winner unless one clears the keep bar; winner is smart culling's call only.

**`deriveVerdict.ts` extensions:**
- **"similar loser"** reason: margin-scaled like burst-loser but with a **stricter margin floor** (a lookalike group is weaker evidence than a camera-clocked burst); near-ties stay silent. Confidence level (Chatty/Balanced/Strict) scales it the same way it scales burst-loser.
- **Favorite (the verdict Tier 1 withholds):** candidate = `aesthetic ≥ FAVORITE_AESTHETIC` (start ~0.55, calibration-tuned) ∧ keepEligible (the same sharpness bar winner candidacy uses) ∧ zero negative reasons. Then **`capFavorites()`** (pure): rank candidates by aesthetic, keep top `clamp(max(3, ceil(5% of analyzed)), 3, 15)`; only capped survivors get the favorite ghost.

**Settings:** no new controls. pHash grouping rides the existing smart-culling toggle; embeddings/aesthetic/favorites ride the existing `smartCullingML` toggle. The ML toggle's description text updates to name what it adds (eyes, lookalikes, favorites).

## UI

- **"Similar ×N" run-box:** the same native `<fieldset>`/`<legend>` machinery as bursts (reuse verbatim — it's hard-won), legend "SIMILAR ×N", a visually distinct tint so bursts and lookalikes read differently at a glance. Grid + strip + compare get it through the same shared components bursts use.
- **Winner border + ghost dots:** identical to bursts — winner border on the pick; similar-loser rejects ride the existing suggestion-driven ghost-dot slot, unrated-only, superseded in place. Compare panes suppress ghosts by construction, unchanged.
- **Favorite ghost:** distinct glyph (not a reject ghost) in the same slot; ExifRail Suggestion row shows "favorite" + aesthetic-driven confidence.
- **ExifRail:** the factual Burst section generalizes to show "Similar ×N" membership too.

## Verification

- **Rust:** pHash properties (self→0; blur/re-encode→small Hamming; distinct images→large; DCT vs reference values); 224×224 preprocess vs reference; `ml_models.rs` registry tests; corpus smoke extends to all three new graphs (input dims, output shapes, pinned sha256s); parity numbers from the export script recorded here.
- **TS:** `groupSimilar` table (window split, adjacency chain, phash-only mode, cosine link, burst exclusion, winner self-corrects on late chunk, no winner below keep bar); `capFavorites` (cap math, clamp, negative-reason gate); similar-loser margin + near-tie silence; confidence-level scaling.
- **Calibration harness extension:** near-dupe **false-group rate** (the costly error) + favorite alignment, run against folders Oliver already culled; every threshold cites the report, not feel.
- **E2E gate (Oliver, live, `--features smart-ml`):** similar boxes on a real worked scene; ML off → pHash groups still appear; favorites appear and are capped; advisory-only proof (no `.xmp` before keypress); NAS responsiveness with three extra models in the pass; folder-switch race. Rides together with the still-outstanding 3a/3b people-shoot validation.

## Risks

- **fp16 on DirectML:** CLIP/DINOv2 fp16 graphs may misbehave on some DirectML drivers — fallback is fp32 I/O with fp16 weights (export script can emit both; decide at impl if it bites).
- **CPU-only machines:** ~300–500 ms/frame for the three models; the chunked driver absorbs it (the pass just takes longer) — acceptable for an advisory tool.
- **LAION score compression:** aesthetic scores cluster mid-scale; `FAVORITE_AESTHETIC` is calibration-dependent, may need per-confidence-level values.
- **Memory:** 384-float embeddings on a 5000-frame folder ≈ 20 MB retained in the scores map — fine, noted.
- **Adjacency-chain splits:** a stray frame mid-scene splits a similar group; accepted for MVP, lookback is the extension if it annoys in practice (deferred-on-complaint).

## Out of scope / extensions (deliberately not built)

- Lookback-linking across stray frames; burst-as-single-node in similar groups.
- CLIP embeddings as a second near-dup signal (DINOv2 alone first).
- Whole-folder clustering; score/embedding persistence across reopens (same deferred-on-complaint stance as the parent plan).
- Any new settings controls beyond copy updates.
