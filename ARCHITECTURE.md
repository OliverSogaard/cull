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

Two bounded pools — one for previews, one for thumbnails — sit between the
UI and disk:

```
UI (loadThumbnail / scheduleBundles)
  ↓ enqueue
bounded queue (deduped by path)
  ↓ pump picks by priority
spawn_blocking → cr3::read_bundle / cr3::read_thumbnail
  ↓ JPEG bytes + parsed EXIF
React state (previews / thumbnails / metadata records keyed by path)
```

### Why bounded

A naïve folder-open would hit storage with ~200 simultaneous reads (one per
visible filmstrip cell). On a fast local drive that's fine; on a NAS it
triggers slow-path heuristics and stalls everything. The pools cap
concurrency at numbers tuned empirically per storage mode (see settings).

### Why two pools

Thumbnails are cheap, and the user wants them *now* for the placeholder blur.
Preview bundles are heavy and prefetched. One shared pool would let a fat
preview block a dozen instant thumbnails.

### Priority

`bundleQueue` is a slice of explicit `{ path, prio }` entries. `prio 0` is
the on-screen image. Prefetch entries take `prio = distance` from the
cursor, asymmetric (ahead is cheaper than behind). The pump picks the
lowest `prio` each iteration. One extra rule: prefetch reads are held while
any `prio 0` read is in flight, so the on-screen frame always gets storage
to itself.

`thumbQueue` picks by:

- **Loupe / compare:** nearest-to-cursor first. In compare the "cursor" is
  the challenger, not the loupe cursor.
- **Grid:** *book order within the visible viewport*. The viewport range is
  reported into a ref by `GridView` after every layout; `pumpThumbs` prefers
  in-viewport cells (lowest-index first) before falling back to out-of-
  viewport entries left over from a scroll. Without this priority, a
  scroll-to-row-80 starves visible cells while the queue churns through
  rows 0–10 left from the initial mount.

### Eviction

Memory is bounded by a sliding window around the cursor. We revoke blob URLs
for paths outside the window so a 10k-image session doesn't grow forever.

Three windows coexist:

- **Image-order window** (`THUMB_KEEP` ±N of `currentIndex`). The loupe
  filmstrip renders cells in image-index order, so this protects what's on
  screen.
- **Compare candidates window** (`STRIP_RADIUS` ±N around the challenger in
  candidate-index space). The candidate strip's order isn't image order, so
  the image-window above doesn't protect it.
- **Grid filter-relative window** (`THUMB_KEEP_GRID` ±N of the cursor in
  `visibleIndices`). With a sparse filter (e.g. favorites scattered across
  a 5k-image shoot), the image-order window keeps the wrong neighbours —
  jumping fav→fav would thrash just-loaded cells.

All three apply additively when relevant. `gridVisible && compareMode` can't
happen — sites are mutually exclusive (see "Site navigation" below).

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
image's native pixel size after `HIRES_SETTLE_MS` (150 ms) of cursor rest.
The browser forces a full-resolution raster for that copy; zooming
composites from already-sharp pixels.

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
| Bundle pool concurrency | 3 | 12 |
| Thumb pool concurrency | 4 | 16 |
| Prefetch ahead / behind | 10 / 5 | 20 / 10 |
| Preview keep window (each side) | 18 | 30 |
| Thumb keep — image space / grid space | 160 / 600 | 320 / 1200 |
| Compare candidate prefetch (each side) | 3 | 6 |
| Hi-res zoom warm-up | 150 ms | 50 ms |
| XMP-restore on analyze | sequential | 4-thread scoped pool |

The whole profile is held in one ref (`profileRef`) so the pump functions
and effect-level consumers see live values when the storage setting
flips — in-flight reads finish at the old numbers; the new numbers apply
on the next pumped pick. The backend takes the same hint as
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
