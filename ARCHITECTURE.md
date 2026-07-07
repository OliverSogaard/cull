# Architecture

Design notes for the non-obvious parts of CULL. Source comments cover the
*what*; this file covers the *why*.

## Invariants

- **CR3 files are never modified.** Every CR3 read goes through the pure-Rust
  parser in `cr3.rs`. The only writes go to a `{basename}.xmp` sidecar.
- **EXIF orientation is applied by splicing a tag into the embedded JPEG
  bytes.** No decode, no re-encode. The embedded preview's quality is
  preserved bit-for-bit; orientation is effectively free.
- **One open per file.** A single open reads CR3 metadata and the embedded
  preview JPEG together. This matters most on slow / high-latency storage
  (NAS, SMB, SSHFS), where opens dominate timing — see the storage-mode
  setting below.

## Read pipeline

Each image resolves through three display stages — **shimmer → thumb → full**
— with precedence full > thumb > shimmer. Since the image-pipeline overhaul,
stage "full" means **the navigation tier is ready**, and that tier is the
CR3's embedded 1620×1080 PRVW preview (one ~2 MiB read), NOT the 32 MP mdat
JPEG — the 32 MP **zoom tier** is fetched only on cursor settle or zoom, via
an exact byte range computed from moov's sample tables. On high-DPI displays
a generated **mid tier** (≤2560 px long edge, q80, Phase 8) additionally
serves the SETTLED fit view: the store requests it only when the measured
display demand (`needPx` = stage rect height × devicePixelRatio, evaluated
fresh per request with ~100 px of hysteresis around ~1700) exceeds what the
preview can show sharply; the fallback chain mid → preview always renders.
An evicted nav blob falls back to its thumb, never back to shimmer.
`src/image/stage.ts` is the pure heart of this: `resolveStage(ImageState) →
Resolved { stage, url, dims, error, full, mid }` (`full`/`mid` = the ready
zoom/mid blobs, whatever the nav stage). It has no I/O and no React, so the
rule set is unit-tested in isolation.

`src/image/imageStore.ts` is a framework-agnostic subscription store, consumed
via `useSyncExternalStore` in `src/image/useImage.ts`:

```
view → useImage(path, { wantFull })
  ↓ subscribe + request
imageStore (priority queues, bounded lanes: preview / zoom-full / thumb / bg)
  ↓ on-demand reads preempt book-order background fill
fetchThumbnail / fetchNav / fetchFullres → IoGate permit + timeout
  → spawn_blocking → cr3 / tier_cache
  ↓ blob URL + dims + EXIF (+ the zoom tier's exact-range hint)
per-path ImageState → resolveStage → stable Resolved snapshot
```

A component calls `useImage(path, { wantFull })` and gets back the current
`Resolved` for that path; the store handles fetching, caching, eviction,
retry/backoff, and blob-URL lifecycle. `wantFull: false` (grid + strips)
requests only the thumb; `wantFull: true` (loupe + compare panes) also drives
the navigation preview. The zoom tier is pulled separately
(`requestZoomFull`) by the settle timer and zoom engage.

What actually paints — in the loupe AND each compare pane, all rendered by
the one `PhotoPane` (`src/components/pane/`) — is decided by the **presenter**
(`src/image/present.ts` + `usePresent`): a decode-gated,
double-buffered state machine over two `<img>` layers. The visible frame
never swaps to undecoded pixels; offers only ever upgrade (a late thumb can
never replace a shown preview); a nav token drops stale decode completions;
cached navigations snap (≤48 ms) while cold ones crossfade over the blurred
thumb; mid-scrub an offer is accepted only if its decode wins a one-frame
race, which makes scrubbing through prefetched neighbourhoods SHARP.

### What the store owns

- **All-session in-memory THMB cache** — thumb blob URLs persist for the whole
  session (a ~15 000-entry LRU is only a safety cap for monster shoots), so
  revisiting any frame is instant.
- **Windowed preview cache** — nav-tier blobs are kept within `previewKeep`
  of the cursor (60 network / 150 local — previews are ~15× lighter than the
  old full blobs) and revoked outside it; the 32 MP **zoom fulls** live in
  their own much smaller `fullKeep` window (2/3 per side; pins for the zoomed
  frame, compare pair, and histogram probe override), and the **mids** share
  that window (~1 MB blobs on the same settled-frame cadence; mounted
  consumers' displayRefs additionally protect a shown mid). Memory stays flat
  across an arbitrarily long session. Eviction is cursor-driven, so parking
  on a frame recenters the windows even when nothing new loads.
- **Generation-based cancellation** — `reset(paths)` (folder change) keeps
  thumbs but revokes all fulls and bumps a generation counter; `hardReset()`
  (session end) revokes everything. In-flight reads from a superseded
  generation can't write into the new session or leak a blob — every async
  completion is gen-guarded, and the in-flight counters are gen-scoped so an
  interrupted folder switch can't drive concurrency past the cap.
- **Blob-URL lifecycle** — every `createObjectURL` has exactly one
  `revokeObjectURL` (LRU eviction, window eviction, full-replaced-by-fresher,
  reset, hardReset, stale-generation arrival). The views never touch blob URLs.

### Why bounded, and the background fill

A naïve folder-open would hit storage with ~200 simultaneous reads (one per
visible filmstrip cell). On a fast local drive that's fine; on a NAS it
triggers slow-path heuristics and stalls everything. So the store runs one
priority order through bounded pools: on-demand thumb and full requests
(what's on screen) always preempt a **book-order background fill** that warms
the rest of the shoot's thumbnails. Background fill has its own small
concurrency knob (`backgroundFillConcurrency`, network = 2, local = 8) so it
stays NAS-polite and never starves on-screen reads. Cursor moves and grid
scrolling re-prioritize the queue toward the viewport; leaving the grid clears
its range so prefetch follows the loupe cursor.

### On-disk tier cache (format v3)

`src-tauri/src/tier_cache.rs` (pipeline Phase 7) is a per-tier LRU on-disk
cache in the OS cache dir: `thumb/` (500 MB) behind `extract_thumbnail`,
`prvw/` (2 GB) behind `read_preview` (filled by piggyback on misses only),
`mid/` (4 GB) behind `read_mid` (Phase 8) — filled opportunistically from
zoom reads' in-memory bytes on every profile, by `read_mid` misses on the
local profile, and by the local idle sweep (`generate_mid`); the NAS profile
NEVER fetches a full solely to generate. The format `VERSION` byte is shared
across all tiers, so any bump regenerates every tier's entries once; v2 → v3
(2026-07-06) happened when the perceptual hash started riding the thumbnail
pipeline — cached thumb headers now carry `phash`, so pre-change entries had
to regenerate. Each entry stores dual validators —
source mtime in MILLISECONDS plus file size, checked against the session stat
table fed by analyze's dir listings, so a hit costs zero source-file
round-trips — alongside the command's wire header (metadata included) and the
JPEG payload. Hits survive an app relaunch yet miss if the source CR3 changed;
corrupted, truncated, or oversized entries are refused and regenerate
silently. This is what makes a close-and-reopen of a folder paint thumbnails
AND previews instantly with zero NAS image reads. The `clear_thumb_cache` /
`thumb_cache_size` commands (v1 wire names) span all tiers and back the
Settings "Image cache" control.

## Rating writes (XMP sidecars)

`persistRating(path, rating)` queues a write through a *per-path serial
write queue* (`writeQueue: Map<path, Promise>`). The reason: an undo fired
immediately after a rating used to race the original write, sometimes
leaving disk and React state out of sync. With the queue, every write to a
given path waits for the prior one to settle, so the order on disk matches
the order of user actions.

Writes retry on schedule (`WRITE_RETRY_DELAYS = [400, 1500, 4000] ms`). A
write that exhausts every retry is recorded in `failedWrites`; the UI shows
an unsaved indicator and the close handler refuses to quit. Retry is one
click from the indicator or the quit guard.

Writes are atomic at the filesystem level — we write to a temp sibling and
rename. A unique process-wide sequence number on the temp filename
(`XMP_TMP_SEQ`) means two overlapping writes to the same sidecar never
share a temp name and never interleave into one corrupt temp; the last
rename wins with a valid file.

The XMP schema uses Lightroom-Classic-compatible pick/good/star flags plus a
CULL-private `cull:fav` marker (star vs flag) so CULL can tell its own courtesy
favorite 1★ from a user's LrC 1–5★ star (see the table in README). User 2–5★
ratings (LrC's edit-pass column) are never touched — favorite-demote on a 3★
keep keeps the 3★ intact.

`unrate` ("u") strips CULL's pick + good flags and removes the favorite 1★ only
when CULL owned it (`cull:fav="star"`); a user's own star — including a genuine
1★ — is preserved. If the remaining sidecar carries no other user data and was
authored by CULL originally, the whole file is removed so unrating leaves no
litter.

## Site navigation: stack-based ESC

CULL has three "sites" — LOUPE, COMPARE, GRID — and they're mutually
exclusive. The keyboard maps:

- `l`, `c`, `g` — switch site. Pressing the current site's key is a no-op.
- `esc` — pop the navigation stack.

The stack records *where you came from* on every transition. Compare
entries snapshot the champion + challenger pair, so ESC back into compare
resumes the same pair (with the saved challenger validated for still being
unrated — if you rated it from grid, the stack advances to the next
unrated).

Empty stack at LOUPE → home confirm. Empty stack at COMPARE / GRID falls
back to LOUPE (shouldn't normally happen; defends against undo-restored
states).

Why a stack instead of "ESC always returns to LOUPE" or a single-level
"last site you came from": the stack is the only model that doesn't
ping-pong on repeated ESCs. `L → C → G → C → ESC ESC ESC` walks
`G → C(snap) → L → home` — predictable and reversible.

Undo (`Ctrl+Z`) restores the rating state and the cursor (champion +
challenger for compare actions, current index for loupe actions) but does
**not** rewind the nav stack — undo is for ratings, not navigation. After
an undo that restores compare mode, the visible site can briefly diverge
from the stack's top; `goBack` still works, it just may surprise if you've
navigated a lot since.

## Hold-to-scrub

Held arrow keys drive a `requestAnimationFrame`-paced loop instead of OS
auto-repeat. OS repeat has a ~500 ms initial delay, an uneven rate, and
won't align to frame boundaries; the rAF loop fires one step per
`NAV_REPEAT_MS` (~33 ms ≈ 30 images/s), is frame-aligned, and self-
throttles when paint takes longer than the step interval.

While scrubbing, the presenter accepts only offers whose decode wins a
one-frame race: a frame whose preview is already warm snaps in SHARP; a cold
frame keeps the blurred thumbnail, so scrub speed is never bottlenecked by
JPEG decode. Nothing above the preview tier is even considered mid-scrub,
and zero fetches start. The full-quality view returns the instant the held
key is released.

Grid is different — single-tap = one cell, hold = OS auto-repeat (~30 Hz).
Using the rAF loop in grid overshot quick taps: a tap fires keydown
immediately *and* gets an extra rAF tick before keyup, advancing 2–3
cells. The single-cell-per-event model fixes that.

## Deferred full-res zoom

The on-screen image is the 1620 px preview at fit-to-stage size; CSS
`transform: scale()` alone would upscale those pixels softly. After
`profile.fullSettleMs` of cursor rest (150 ms local / 400 ms network) the
store FETCHES the 32 MP zoom-tier JPEG — one exact-range read via the moov
hint, no head scan — and a second `<img>` mounts at the image's native pixel
size, revealed only once `el.decode()` resolves (the preview-upscale beneath
never pops to a half-decoded full). Engaging zoom requests it immediately if
the settle hadn't already. The settle timer, measure discipline, and layer
all live in `PhotoPane`, so each compare pane runs the identical policy —
that pre-mounted sharp raster is why compare's reveal glides like the loupe's.

The settle delay means rapid arrow-through never pays the ~10 MB fetch or
the native-resolution decode. The layer drops on every navigation and on
thumb-strip toggle (which resizes the stage; without the drop, the layer
lingers at the old size and overlaps the reflowed base image).

### Display-adaptive mid tier (Phase 8)

On a 4K/Retina-class stage the 1620 px preview upscales ~1.6–1.8× in the fit
view — visibly soft. The same settle timer therefore also requests the
**mid tier**: a ≤2560-px-long-edge q80 JPEG generated in Rust (zune-jpeg
decode → fast_image_resize Lanczos3 → jpeg-encoder, the source's EXIF
orientation APP1 spliced — pixels are never rotated) and disk-cached under
`mid/`. The store decides per request from `needPx` = stage rect height ×
devicePixelRatio (fresh each time; re-evaluated on stage resizes and on DPR
flips via a matchMedia listener, so dragging the window between a 4K and a
1440p monitor flips the tier choice live, with ~100 px hysteresis against
jitter). On 1440p-class displays the mid is never requested. Generation is
profile-aware: the local profile generates on `read_mid` misses and runs a
budgeted idle sweep (paused whenever any on-demand lane has work or the
cursor moved recently); the network profile only ever serves the cache —
mids appear there as a free by-product of zoom reads (the bytes are already
in memory; CPU only). The presenter treats the mid as one more upgrade tier
between preview and full; mid-scrub it is never offered.

## Composition overlays

Three are precomputed from the on-screen JPEG and cached per path:

- **Clipping mask.** Diagonal stripes (red 45° highlights / blue −45°
  shadows) painted where all three channels are within 5 of 255 / 0.
  All-three-channel detection avoids false positives on saturated colours
  (a yellow flower would trip a single-channel test).
- **Focus peaking.** Luminance gradient (central differences,
  `(R + 2G + B)/4` cheap luma) thresholded → yellow stipple on
  high-contrast edges.
- **RGB histogram.** Computed from the on-screen NAVIGATION preview (the
  1620 px PRVW) — native 3:2 with no letterbox bars (Canon pads the THMB
  into a 4:3 frame with pure black, which used to poison the darks bin),
  and ~15× cheaper than the 32 MP decode it once cost.

All three are downscaled to a working size (~1600 px for masks, ~256 px
for the histogram), cached per path while their overlay is on, and
dropped when it's off so they don't bloat the session.

## Smart culling

Suggestions are **advisory only — the analysis never writes a rating, an
XMP, or anything else**; it surfaces ghost dots, burst / "Similar ×N"
groupings, and the Smart (`4`) filter, and every real verdict stays a user
keystroke. That invariant is structural, not policy: the smart layer's output
feeds rendering and filtering only, never `persistRating`.

The design is two-layer:

- **Rust computes cached per-image metrics.** `analyze_folder` streams
  `ImageScore` records — classical metrics from the embedded previews
  (AF-point sharpness with a noise-floor normalization, exposure, clipping,
  texture; `analyze.rs`), plus the always-on 64-bit DCT perceptual hash
  (`phash.rs`, computed on the thumbnail pipeline and persisted in the tier
  cache). Builds with the `smart-ml` feature (the default) add ONNX-backed
  signals through `ml_models.rs`'s lazy per-model sessions: YuNet face
  detection + OCEC eyes-open probability (`faces.rs`), DINOv2-small
  embeddings and the CLIP + LAION aesthetic score (`embed.rs`). Without the
  feature (`--no-default-features`), those fields stay empty on the wire and
  everything else still works.
- **Pure TS derives cross-frame verdicts.** `src/smart/` groups bursts from
  capture cadence (`groupBursts.ts`), chains near-duplicates by pHash +
  embedding cosine within a time window (`groupSimilar.ts`), picks group
  winners on one shared ladder (`pickWinner.ts`), cascades per-frame
  suggestion verdicts with margin-scaled confidence (`deriveVerdict.ts`),
  and caps aesthetic favorites per session (`capFavorites.ts`). All of it is
  pure and unit-tested; React only subscribes.

The in-app switches live in Settings: suggestions master switch, reject
confidence level, analyze-on-open, and **Deep analysis** (the ML tier's
user-facing toggle — inert on builds without the model runtime).

**Calibration provenance:** every threshold in `deriveVerdict.ts` cites a
corpus frame, and only the calibration harness — a confusion-matrix report
over an already-culled folder, comparing suggestions against the user's real
ratings — may change them. See [TESTING.md](TESTING.md) for the invocation.

## Settings

User prefs live in `localStorage` under `cull:settings:v1`, exposed by
`useSettings()` and edited via `SettingsDialog` (Ctrl+, or the gear link
on the home screen).

The headline setting is **storage mode** (`local` | `network`), which
switches a whole performance profile rather than a single constant.
Defaults to `local`; flip to `network` for NAS / SMB / SSHFS.

| | `network` | `local` (default) |
| --- | --- | --- |
| Preview (nav-tier) concurrency | 4 | 12 |
| Zoom full-res concurrency | 2 | 2 |
| Thumbnail concurrency | 4 | 16 |
| Background-fill concurrency | 2 | 8 |
| Preview keep window (each side) | 60 | 150 |
| Zoom-full keep window (each side) | 2 | 3 |
| Preview neighbour prefetch (each side) | 4 | 8 |
| Zoom-full settle warm-up | 400 ms | 150 ms |
| Mid-tier generation concurrency (Phase 8) | 1 | 2 |
| Mid-tier generation on `read_mid` miss / idle sweep | never (cache-only) | yes / yes |
| Backend IoGate read permits | 6 | 16 |
| XMP-restore on analyze | sequential | 4-thread scoped pool |

The whole profile is pushed into the imageStore via `setProfile` when the
storage setting flips — in-flight reads finish at the old numbers; new reads
use the new ones, no restart. The backend takes the same hint as
`concurrent_restore: bool` on `analyze_folder`; defaulted to `false` so an
older or missing frontend can't accidentally trigger parallel sidecar
reads on a NAS.

Other settings (filter / overlay defaults, rejected-subfolder name,
copy-keeps destination, open-last-folder-on-launch) are simple knobs —
the dialog UI is a stack of label / help / control rows and one row per
setting.

## Modules

The frontend follows a strict layering — no circular deps:

```
App.tsx (orchestration + state)
  ↓ imports
components/  — presentational; receive callbacks + state via props
  ├─ pane/   — PhotoPane: the one loupe/compare pane recipe (presenter layers, zoom)
  └─ strip/  — PhotoStrip family: film strip, virtualizer, burst boxes
  ↓ imports
image/       — imageStore (tier lanes, eviction, generations), presenter, decode pool
smart/       — burst/similar grouping + verdict derivation (pure TS, no React)
overlays/    — clipping/peaking mask scans + histogram (inline + worker paths)
hooks/       — useSettings, useRecents, focus trap
  ↓ imports
utils/       — pure helpers (format, filter, path, snap, bundle, dlog)
  ↓ imports
types/       — shared TypeScript types
```

The backend follows the same shape:

```
lib.rs (run() + Tauri command wiring + managed state)  /  main.rs (entry)
  ↓ uses
bundle / scan / xmp / file_ops / midtier   (Tauri command modules)
  ↓ use
analyze / faces / embed / phash / ml_models   (smart-culling metrics; ml behind `smart-ml`)
meta / cr3 / tier_cache / io_gate / memory_pressure   (data, parser, cache, infra)
```

`cr3.rs` is the parser and stays untouched by everything except
`bundle.rs` and `scan.rs`. `meta.rs` owns the IPC-facing `ImageMetadata`
struct and the conversion from `cr3::Cr3Meta`. `io_gate.rs` owns the
global read-permit backstop (IoGate), the tiered read timeouts, and the
session generation + mtime table (SessionGate). `memory_pressure.rs`
watches for jetsam-class pressure on macOS and tells the frontend to shed.

## Test surface

Two suites: **backend** (`cargo test`, XMP round-trips against real LrC
sidecars, CR3 parser, tier cache, analyze/faces/phash, io_gate) and
**frontend** (`pnpm test`, Vitest — the image-pipeline invariants in
`imageStore` / `stage` / `present`, the whole `smart/` verdict layer, and
the pure utils). No component tests — the components are presentational,
and testing them would test JSX shape, not behaviour. Corpus-dependent
tests are env-var-gated and skip cleanly when fixtures are absent.

Commands, the env-gated corpus tests, and the calibration harness are all
documented in [TESTING.md](TESTING.md).
