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
— with precedence full > thumb > shimmer. An evicted full falls back to its
thumb, never back to shimmer. `src/image/stage.ts` is the pure heart of this:
`resolveStage(ImageState) → Resolved { stage, url, dims, error }`. It has no
I/O and no React — given which of {thumb, full} are present it returns what to
paint, so the rule set is unit-tested in isolation.

`src/image/imageStore.ts` is a framework-agnostic subscription store, consumed
via `useSyncExternalStore` in `src/image/useImage.ts`:

```
view → useImage(path, { wantFull })
  ↓ subscribe + request
imageStore (priority queue, bounded concurrency)
  ↓ on-demand thumb/full preempt book-order background fill
fetchThumbnail / fetchBundle → spawn_blocking → cr3 / thumb_cache
  ↓ blob URL + dims + EXIF
per-path ImageState → resolveStage → stable Resolved snapshot
```

A component calls `useImage(path, { wantFull })` and gets back the current
`Resolved` for that path; the store handles fetching, caching, eviction, and
blob-URL lifecycle. `wantFull: false` (grid + strips) requests only the thumb;
`wantFull: true` (loupe + compare panes) also drives the full-res preview.

### What the store owns

- **All-session in-memory THMB cache** — thumb blob URLs persist for the whole
  session (a ~15 000-entry LRU is only a safety cap for monster shoots), so
  revisiting any frame is instant.
- **Windowed full-res cache** — full-res blobs are heavy, so they're kept only
  within `previewKeep` of the cursor and revoked outside it; memory stays flat
  across an arbitrarily long session. Eviction is cursor-driven, so parking on
  a frame recenters the window even when nothing new loads.
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

### On-disk thumbnail cache

`src-tauri/src/thumb_cache.rs` sits behind `extract_thumbnail`: a 500 MB LRU
on-disk cache in the OS cache dir. Each cache file stores the source mtime in
its header, so a hit survives an app relaunch (a new `ThumbCache` over the same
dir re-serves it) yet still misses if the source CR3 changed. This is what
makes a close-and-reopen of a folder shimmer once and then paint instantly. The
`clear_thumb_cache` / `thumb_cache_size` commands back the Settings "Thumbnail
cache" control.

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

The XMP schema mirrors what Lightroom Classic writes (see the table in
README). User 2–5★ ratings (LrC's edit-pass column) are never touched —
favorite-demote on a 3★ keep keeps the 3★ intact.

`unrate` ("u") strips CULL's pick + good + 1★ from the sidecar; if the
remaining sidecar carries no other user data and was authored by CULL
originally, the whole file is removed so unrating leaves no litter.

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

While scrubbing, the loupe renders the cheap thumbnail with a heavy blur
instead of the full-res preview, so scrub speed isn't bottlenecked by JPEG
decode. Full-res returns the instant the held key is released.

Grid is different — single-tap = one cell, hold = OS auto-repeat (~30 Hz).
Using the rAF loop in grid overshot quick taps: a tap fires keydown
immediately *and* gets an extra rAF tick before keyup, advancing 2–3
cells. The single-cell-per-event model fixes that.

## Deferred full-res zoom

The on-screen image renders at fit-to-stage size, so the browser keeps the
JPEG at that resolution. CSS `transform: scale()` upscales those pixels
during zoom — looks soft for ~0.2 s while the browser re-decodes at the
new size. To make zoom sharp instantly we mount a *second* `<img>` at the
image's native pixel size after `profile.hiResSettleMs` of cursor rest
(50 ms on local storage, 150 ms on network). The browser forces a
full-resolution raster for that copy; zooming composites from already-sharp
pixels.

The settle delay means rapid arrow-through never pays the heavy native-
resolution decode. The layer drops on every navigation and on thumb-strip
toggle (which resizes the stage; without the drop, the layer lingers at
the old size and overlaps the reflowed base image).

## Composition overlays

Three are precomputed from the on-screen JPEG and cached per path:

- **Clipping mask.** Diagonal stripes (red 45° highlights / blue −45°
  shadows) painted where all three channels are within 5 of 255 / 0.
  All-three-channel detection avoids false positives on saturated colours
  (a yellow flower would trip a single-channel test).
- **Focus peaking.** Luminance gradient (central differences,
  `(R + 2G + B)/4` cheap luma) thresholded → yellow stipple on
  high-contrast edges.
- **RGB histogram.** Computed from the *thumbnail*, not the preview — a
  histogram is a distribution, so the tiny sample is plenty, and it
  avoids decoding the 32 MP preview just to paint a 256×64 chart.

All three are downscaled to a working size (~1600 px for masks, ~256 px
for the histogram), cached per path while their overlay is on, and
dropped when it's off so they don't bloat the session.

## Settings

User prefs live in `localStorage` under `cull:settings:v1`, exposed by
`useSettings()` and edited via `SettingsDialog` (Ctrl+, or the gear link
on the home screen).

The headline setting is **storage mode** (`local` | `network`), which
switches a whole performance profile rather than a single constant.
Defaults to `local`; flip to `network` for NAS / SMB / SSHFS.

| | `network` | `local` (default) |
| --- | --- | --- |
| Full-preview concurrency | 3 | 12 |
| Thumbnail concurrency | 4 | 16 |
| Background-fill concurrency | 2 | 8 |
| Full-res keep window (each side) | 18 | 30 |
| Hi-res zoom warm-up | 150 ms | 50 ms |
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
  ↓ imports
utils/       — pure helpers (format, filter, path, snap, bundle)
  ↓ imports
types/       — shared TypeScript types
```

The backend follows the same shape:

```
lib.rs (run() + Tauri command wiring)
  ↓ uses
bundle / scan / xmp / file_ops (Tauri command modules)
  ↓ use
meta / cr3       (data + parser)
```

`cr3.rs` is the parser and stays untouched by everything except
`bundle.rs` and `scan.rs`. `meta.rs` owns the IPC-facing `ImageMetadata`
struct and the conversion from `cr3::Cr3Meta`.

## Test surface

- **Backend (`cargo test`).** XMP encode/decode round-trip + idempotency,
  flag-encoding-matches-LrC checks against real LrC sidecars in
  `sample_cr3s/sample_LrCFlaggedCR3s/`, batch_files idempotency +
  non-overwrite + error cap, plus CR3-parser tests env-var-gated against
  real CR3 fixtures in `sample_cr3s/`.
- **Frontend (`pnpm test`, Vitest).** Pure-helper unit tests:
  `passesFilter`, all `format*` helpers, `snapToFilter`, `basename` /
  `stripExt`. No component tests — the components are presentational, and
  testing them would test JSX shape, not behaviour.
