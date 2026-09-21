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

## Session order

The staged set is built incrementally — each folder the user picks is
scanned and its files are APPENDED to whatever is already staged
(`openFoldersByPaths`, `src/app/useSessionLifecycle.ts`). `Img.id` is
assigned at that append (`startId = prev.length`) and stays stable for the
rest of the session no matter how the visible order changes afterward
(`types/image.ts:1-5`).

That set is re-sorted **globally once**, at Begin culling, by
`analyze_folder`. The key is each frame's EXIF `DateTimeOriginal` +
`SubSecTimeOriginal` when the `sortByCaptureTime` setting is on; a frame
without a usable EXIF tag falls back to that file's mtime (rebased into the
same clock frame the EXIF times live in — `mtime_in_capture_frame`,
`scan.rs`), and a frame with neither falls back to path order last. The
comparator itself (`order_by_capture`) is unchanged by any of this — only
the epoch each frame is sorted by changed. A thumb-tier cache hit answers a
frame's capture time with zero source-file round-trips (its header already
carries it), so re-opening an already-analyzed shoot costs nothing extra.
Per-folder clock offsets (`captureOffsets`, the staged screen's steppers) are
resolved on the TS side into one per-frame millisecond vector before the
call, and apply to whichever epoch a frame actually got — EXIF or the
mtime fallback — since the offset describes a body's clock, not a tag.
They are ordering-only: nothing is ever written to a file.

The sort never runs mid-cull, only at that one moment. `currentIndex`,
`championIndex`, `challengerIndex`, `selectedIndices`, `selectionAnchor`,
`visibleIndices`, `NavEntry`, GridView's window math, and imageStore's
ordered `paths` + `pathIndex` are all index-keyed against the current
order — re-sorting underneath any of them mid-session would invalidate
every one at once. Begin culling is the one moment `setImages`,
`imageStore.reset`, and `overlayService.reset` already happen together, so
it is the only safe place a new order can land.

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

The **grid tier** (Phase 3B) is NOT a fourth display stage — `resolveStage`
never sees it. It exists only inside the contact sheet: a second `<img>`
layered, absolutely positioned, over the cell's THMB and faded in on `load`
once it decodes, so a soft THMB never flashes to blank while the sharper
frame loads. Loupe and compare never request it. The sharp layer is requested
only while its cell is mounted, and only when the measured cell width times
DPR beats the THMB — so closing the grid, or narrowing the cells past the
rule, stops the tier entirely.
`src/image/stage.ts` is the pure heart of this: `resolveStage(ImageState) →
Resolved { stage, url, dims, error, full, mid }` (`full`/`mid` = the ready
zoom/mid blobs, whatever the nav stage). It has no I/O and no React, so the
rule set is unit-tested in isolation.

`src/image/imageStore.ts` is a framework-agnostic subscription store, consumed
via `useSyncExternalStore` in `src/image/useImage.ts`:

```
view → useImage(path, { wantFull })
  ↓ subscribe + request
imageStore (priority queues, bounded lanes: preview / zoom-full / mid / thumb / grid / bg)
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
- **Grid-windowed thumb cache** — the sixth lane, `gridThumbLane`, is the one
  window that does NOT follow the cursor: the grid scrolls independently of
  the loupe cursor, so its blobs are kept within `gridThumbKeep` cells of the
  reported grid RANGE (start/end of what's visible) and evicted outside it.
  Leaving the grid sets the range to none, which frees every grid blob no
  cell still displays. Requests enter through ONE path,
  `requestGridThumbsInRange`, driven by the reported range and nothing else:
  the lane's queue is REBUILT on every range report rather than appended to
  (a scrollbar drag would otherwise spend the lane on the thousand cells the
  user flew past), and only paths with a mounted display ref are asked for —
  the reported range is the min..max ABSOLUTE index of the rendered cells,
  so under a filter it spans every hidden frame in between. Queued paths
  carry no request marker (the lane marks a path when it STARTS it), so
  emptying the queue leaks nothing and a read already in flight still
  finishes. Leaving the grid clears the queue and disarms the pending
  self-retry. A `pending` bounce — the backend's shared generation claim
  already held — is pure backoff, never an error: it never feeds the
  folder-trouble latch and is capped one below the terminal attempt count,
  so such a cell is always askable again; a single deduped timer re-arms for
  the soonest cell still in cooldown and re-runs the visible range, so a
  cell that lost a race never waits for the user to scroll.
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
NEVER fetches a full solely to generate. `grid/` (512 MB, Phase 3B) sits
behind `read_grid_thumb`, the sharp 512 px contact-sheet tier, filled on a
miss from the already-cached PRVW preview — a new tier byte (`Grid` = 3) in
its own disjoint subdir, so it left the shared `VERSION` byte unchanged; that
byte is shared across all tiers, so any bump regenerates every tier's entries
once; v2 → v3
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

A write is refused outright when the CR3 is no longer at its path
(`xmp::require_source`, error prefix `source missing:`) — after "Move rejects"
the moved frames are pruned from the session (see "Finishing a cull" below),
so this only fires for a file deleted outside CULL. The frontend recognises
the prefix and records the failure without retrying (`utils/writeFailure.ts`).
An unrate with no sidecar to touch stays a no-op regardless.

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

## Finishing a cull (move / copy / trash)

`file_ops.rs` batches are idempotent and never overwrite. Every result carries
`completed`, `skipped`, an error list capped at 20 with the exact `errorCount`,
and `gone` — the sources no longer at their original location (completed moves
plus sources already missing; empty for a copy). A sidecar that fails to
follow its CR3 is an error in that count, so "N moved · 0 errors" means the
ratings travelled too.

After a move, `pruneMoved` (`useSessionLifecycle`) takes the `gone` frames out
of the live session: `images`, ratings and metadata drop them, and every
index-based cursor (current, champion, challenger, nav stack) is remapped
through functional setState off its live value (`utils/pruneSession.ts`) —
this runs after an await, so a closure value could otherwise be stale. The
undo/redo history loses the moved frames' changes, and `imageStore.forget()`
revokes their blobs without a generation bump so the mounted panes keep their
registrations; `overlayService.forget()` drops their cached overlays the same
way. The session's recents entry is not written immediately from that same
closure; it's refreshed by the debounced effect that already watches
`images`/`ratings` while culling.

A prune is not a new session. `isPrunedSubset` (`smart/sessionIdentity.ts`)
recognises the shorter array as the same staged set — matching by id AND path,
since ids restart at 0 per folder and a different folder must never pass — so
smart-culling keeps the survivors' scores and the pass stays latched instead
of re-inferring the whole remaining shoot. A pass dispatched before the prune
still lands: its scores map back through the frozen dispatch array and are
inserted only for ids still live, so a frame moved mid-pass leaves no ghost
entry behind. Reads already in flight for a moved path are dropped when they
land — success and error alike — by the store's `forgotten` tombstones: the
blob is revoked, nothing is cached, no failure is recorded and no retry is
scheduled, so a moved file can neither re-create a record nor have its "not
found" mistaken for a missing backend command that dormants a whole tier.

Two consequences of treating a prune as the same session are deliberate. A
main pass that landed ZERO scores (drive hiccup, every chunk skipped) is
retryable — but a Move carries the latch onto the survivors rather than
re-opening the auto-start, so after a prune only the manual `4` / Smart tab
start re-runs it. And the catch-up pass's `attempted` set survives the prune,
so a frame whose catch-up attempt already failed gets no second shot within
the session.

The analyze pass reports what it could not read — parent folders that failed
to list, sidecars that exist but failed to read — on `AnalyzeResult`; the
status bar shows a dismissible chip (`utils/analyzeWarnings.ts`) instead of
silently sorting those frames last and unrated.

## Site navigation and ESC

CULL has three "sites" — LOUPE, COMPARE, GRID — and they're mutually
exclusive. The keyboard maps:

- `l`, `c`, `g` — switch site. Pressing the current site's key is a no-op.
- `esc` — clear a grid multi-selection if one exists; otherwise open the
  leave-to-home confirm (Enter leaves, Esc stays) from any site.

An earlier version had ESC pop a navigation stack, one site at a time.
That was tried and felt wrong, so ESC now always offers to leave (after
clearing a selection, if there is one).

The nav stack (`{site}` or, for compare, `{site: "compare", champ,
chall}`) is still recorded on every `l`/`c`/`g` transition, but the only
thing that still pops it is `goBack`, called exclusively by the compare
auto-exit flows: when the last unrated challenger is decided, `goBack`
returns to the site the user came from, landing on the freshly crowned
champion. Popping re-validates the saved compare entry — if its champion
is no longer a keeper (rejected since — a champion re-rated to keep or
favorite still restores), the restore is abandoned and the app falls through
to LOUPE at the current champion instead of reseating a rejected frame.

Undo (`Ctrl+Z`) restores the rating state and the cursor — the compare
pair or the loupe index — plus, for a compare-origin action, the nav-stack
snapshot that action recorded (so a later compare auto-exit pops the entry you
actually came from). It never navigates on its own.

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
cursor moved recently — the grid tier counts as on-demand, since its cells
are what the user is looking at and the sweep holds the same generation
permits in ~450 ms jobs; draining the last grid cell is what lets the sweep
run again); the network profile only ever serves the cache —
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

The `rejects` filter is not the same thing as `suggestedRejects`: `rejects`
is the user's OWN verdict — the pile "move rejects" acts on — while
`suggestedRejects` is an unrated frame the smart pass merely flagged, still
awaiting a keystroke.

`groupBursts` and `groupSimilar` walk the session order PER SOURCE FOLDER
(Phase 3C), so when two bodies interleave by capture time a group's members
are no longer necessarily contiguous in session order; every consumer that
draws a bracket around a group — the two filmstrips' `strip/burstSegments.ts`
and the grid's `gridBurstSegments.ts` — accounts for this by drawing one
segment per contiguous stretch instead of assuming the whole group is one
solid run.

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

## Content Security Policy

Production ships a real CSP (`app.security.csp` in `tauri.conf.json`); it is
NOT `null`. The policy is blob-aware because CULL's image tiers ARE blob URLs
— every thumb / preview / zoom-full / mid frame is handed to the webview as a
`blob:` object URL, and the composition masks + histogram render the same way:

```
default-src 'self';
img-src    'self' blob: data:;
media-src  'self' blob:;
font-src   'self';                      /* the two self-hosted woff2 (offline app) */
style-src  'self' 'unsafe-inline';      /* React inline styles + index.html <style> */
script-src 'self';
worker-src 'self' blob:;                /* the overlay mask worker (Vite-emitted file; blob: covers the ESM fallback) */
connect-src 'self' ipc: http://ipc.localhost;   /* Tauri IPC */
object-src 'none'; base-uri 'self';
```

Fonts are self-hosted (`src/assets/fonts/*.woff2`, latin subset, one variable
file per family) rather than fetched from Google at every launch — an offline
desktop app must not depend on the network to render text. `'unsafe-inline'`
stays on `style-src` only (React writes inline styles; there is no inline
script). If a future feature needs a new origin, widen the specific directive
— never fall back to `null`.

## Design language

Phase 3A ("see and feel") gave the chrome a handful of small, load-bearing
conventions instead of per-component one-offs:

- **Favourite is its own colour.** `--fav` (lilac `#b9a2dc`, `src/styles/
  tokens.css`) marks a favourite verdict everywhere it appears — the
  statusbar glyph, the strip/grid dots, the EXIF-rail suggestion — and stays
  visually distinct from `--accent` (champagne), which keeps the cursor
  ring, selection tint, brand mark, and progress fills. A favourite reads as
  "a kind of keep", never as "extra emphasis on the accent".
- **One focus ring.** `--ring` (`0 0 0 2px var(--bg), 0 0 0 4px var(--accent)`,
  `tokens.css`) is the one focus treatment in the app; a
  `:where(button, a, summary, [role="button"][tabindex], [tabindex]:not(
  [tabindex="-1"]))` rule at the bottom of `src/styles/base.css` applies it at
  **zero specificity**, so it only fires as a fallback for a focusable
  control a component author forgot to ring explicitly — any component's
  own `:focus-visible` rule, however weak, still wins. `--ring` extends 4px past
  the element's own edge, so any control with less than 4px to a neighbour
  (or a window edge) takes the inset form, `--ring-inset` (`inset 0 0 0 2px
  var(--accent), inset 0 0 0 4px var(--bg)`), instead — the accent line and
  `--bg` buffer just point inward, so the ring still reads against a dark
  surface or an accent-filled one alike.
- **Two button sizes, one keycap.** `src/styles/primitives/btn.css` defines
  `.btn` (32px, dialog actions and screen CTAs) and `.btn--sm` (26px, footer
  and settings rows); `.btn--cta` is the one deliberate exception, the home
  hero's own larger size. `src/styles/primitives/kbd.css` defines the single
  `.kbd` keycap (20px tall, 11px mono, 20px min-width, `0 5px` padding, 2px
  radius) used everywhere a shortcut is shown, plus `.keycombo` for stacking
  keycaps side by side without doubling their gutters.
- **One icon scale.** `src/components/icons.ts`'s `ICON` gives every Lucide
  icon in the chrome one of three steps — `sm` 12px, `md` 14px (both stroke
  1.75), `lg` 16px (stroke 1.5) — so a row of unrelated icons reads as one
  set. Four families stay off-scale, for two different reasons. Three are
  drawn into a container far smaller than any scale step, so both their size
  *and* their stroke are tuned heavier than the scale to stay legible: the
  verdict glyphs inside rating dots (`verdictGlyph.tsx`, stroke 3 for
  keep/reject, 2.6 for favorite), the LrC star badges pinned to a thumbnail
  corner (`GridView.tsx` / `ThumbCell.tsx`, stroke 2.4), and the 22px glyph
  inside the 48px rating-feedback pop (`App.tsx`, stroke 3). The
  window-control icons (`WindowControls.tsx`) are the one family that keeps
  only its *size* off-scale — sized to the Windows caption-button metric so
  the title bar matches the rest of the desktop — while its stroke takes the
  scale's lightest step verbatim (`ICON.lg.strokeWidth`, 1.5), so it still
  weighs the same as the icons in the app below it.
- **Reduced motion.** `src/styles/motion.css` is the one stylesheet that
  answers `prefers-reduced-motion: reduce`. The policy: motion that is purely
  decorative or attention-grabbing (a pulse beside a word that already says
  what's happening, an entrance, a sweep) stops outright, while motion that
  is the *only* signal that something is working (spinners, the
  indeterminate progress bar) keeps moving, just slower. `motion.test.ts`
  enforces the discipline mechanically: every `@keyframes` under `src/styles`
  must be named in a `reviewed:` comment in `motion.css`, so a newly added
  keyframe fails the test until someone has ruled on what it does under
  reduced motion.
- **One modifier-key spelling.** `src/utils/platform.ts` exports `modLabel`
  (`"Ctrl"` on Windows, `"⌘"` on macOS) for keycaps and `modCombo(key)` for
  inline prose (`"Ctrl+E"` vs `"⌘E"`). `src/components/KeyCombo.tsx` renders
  the modifier and the following key as two separate keycaps side by side —
  the app's answer to "how is a shortcut shown", used by the home hero, the
  staged-screen hint, the empty-filter hint, recents, and the settings
  dialog.
- **A page is a measured screenful, never a burst.** `Home` / `End` /
  `PgUp` / `PgDn` (Phase 3C) move the cursor within the ACTIVE FILTER, not
  index 0 or the raw end of the session; in the grid, Shift extends the
  selection to that same target instead of just moving the cursor. A "page"
  for `PgUp` / `PgDn` is a screenful measured live at keypress time
  (`src/utils/pageStep.ts`) — rows × cols in the grid, filmstrip cells across
  the strip in loupe/compare — deliberately not "the next burst", since burst
  groups are advisory, often absent, and change size as smart scores land.
- **Write failures come in two kinds, and only one blocks finishing.**
  `useRatingPersistence` (`src/app/useRatingPersistence.ts`) records each
  exhausted write with a boolean `missing`: true when the backend refused
  because the CR3 was not at its path, false when the write itself kept
  failing. `missing` buys one thing — no AUTOMATIC retry schedule, since
  hammering a `source missing:` refusal on a 400/1500/4000 ms timer only
  delays the honest "didn't save" by six seconds. It does **not** exclude the
  write from `retryFailed()`: a drive or NAS dropping out is what usually
  produces it, so a deliberate re-check re-attempts every failure the hook
  holds (once each for the missing ones, fail fast). Skipping them used to
  strand every rating made during an outage with no way to save it after the
  drive returned. `src/utils/saveStatusCopy.ts`'s `saveFailureKind` turns
  `failedCount`/`missingCount` into `"none" | "missing" | "retry"` for the
  status-bar chip, the save-status pill, the quit guard and the leave-to-home
  warning; the finish dialog derives its own note priority (retryable, then
  saving, then missing) but takes its sentences from the same module, so all
  five surfaces tell the same story instead of drifting into slightly
  different wording — the all-missing
  chip and pill offer "check again" rather than a plain "retry", because that
  is what the click is worth once the drive is back. `FinishDialog`'s
  `retryableFailedCount` (`Math.max(0, failedCount - missingCount)`) is the
  only count that disables the move/copy actions — a missing photo is warned
  about but never blocks finishing the cull, since blocking on a failure the
  session cannot clear would leave no way out of it at all.

### Scale and layout (Phase 3B)

The app had one `@media` rule (reduced motion) and no responsive behaviour
otherwise. This phase wired the layout tokens that already existed but were
never referenced — `--bar-h`, `--winbtn-w`, `--rail-w`, `--rail-w-compare`,
`--strip-h`, `--cell-w`, `--cell-h` — to their use sites, and added the
responsive steps on top of that wiring. That wiring takes two different
forms, not one: the info rail's breakpoint redefines its tokens (plus a
literal `padding`/`gap`) inside `:root`; the strip's `--cell-w` / `--cell-h`
/ `--strip-h` are never touched by a media query at all — they are set
INLINE on `.cull-strip-wrap` by `PhotoStrip`, straight from `StripMetrics`,
and the strip's own breakpoint lives in JS (`useStripMetrics`'s `matchMedia`
query), not CSS; and the footer's three breakpoints redefine no token at
all — they hide spans (`display: none`) or clip a tail (`clip-path`) on
plain classes. The rule that survives it: **a responsive step never touches
a scattered literal in the layout it doesn't own** — every consumer already
reads a token or a class, so nothing needs to know a breakpoint exists.

Six breakpoints, on two independent axes (window width and window height —
there is still no DPR-driven layout, no `zoom`, no user font-size setting):

- **1120 px window width** — the footer's ORDINARY finish label ("Ctrl+E ·
  N keeps") sheds to "Finish" — the tighter of the footer's two finish
  breakpoints, since the ordinary label is shorter than the all-rated one.
- **1200 px window width** — the info rail's own, unrelated breakpoint
  (`exif-rail.css`): the loupe rail narrows 290 → 232 px and the compare
  rail 340 → 288 px (its fixed key column 90 → 76 in proportion), through
  the `--rail-w` / `--rail-w-compare` / `--rail-col-k` tokens.
- **1240 px window width** — the footer's three remaining cosmetic words go:
  the zoom/scrub chip's word ("zoom 1:1" → "1:1") and the verdict pill's
  word. This was 1220 through fix round 3; fix round 4 moved it to 1240 for
  margin, since the sums it rests on are estimated glyph advances rather
  than a measured render. It is deliberately NOT the info rail's 1200 — the
  footer's own worst-case arithmetic (below) needs the extra margin before
  this shed can help it fit, and the two breakpoints are unrelated decisions
  that happen to live near each other.
- **1360 px window width** — the footer's key hint disappears, the save
  chip's action tail sheds (the largest single item on the left; the
  button's own title still says what the click does), the filename
  extension sheds (fix round 4 — every file in a cull is a .CR3, so the
  1240 tier above never has to price it in), and (only when the finish
  button already carries `is-done`) the ALL-RATED finish label sheds from
  "All N rated · Ctrl+E finish" to "Finish"; the button's brightened fill
  and one-time breathe animation (`stage.css`) still carry the moment
  without the longest label.
- **2000 px window width** — the home screen scales up: hero/recents column
  620 → 780 px, title 56 → 72 px, sub 17 → 19 px (its own max-width 500 →
  620 px), recents path 14 → 15 px with deeper row padding. Below 2000 the
  default 1600 × 1000 window is untouched — the same left-aligned editorial
  layout just grows.
- **1200 px window height** — the filmstrip steps from its standard cell
  (76 × 54) to a larger one (104 × 74) on a tall window (a maximized 1440p
  or 4K screen); see `StripMetrics` below.

Stylelint enforces range notation for every one of these (`@media (width <
1360px)`, never `max-width`) — a leftover `max-width` rule fails lint,
which is what keeps a future breakpoint from silently drifting out of this
convention.

**`StripMetrics`** (`src/components/strip/metrics.ts`) is the filmstrip's
single source of truth, read by FilmStrip, the virtualizer math, the burst
overlays, AND the stylesheet: `PhotoStrip` pushes `cellW` / `cellH` /
`stripH` onto the strip wrapper as `--cell-w` / `--cell-h` / `--strip-h`
custom properties, so JS and CSS can never disagree about a cell's size.
One `matchMedia("(min-height: 1200px)")` subscription (`useStripMetrics.ts`,
its `MediaQueryList` created lazily on first use and cached for the module's
lifetime) picks between two plain module-level objects, `STRIP_SMALL`
(76×54) and `STRIP_LARGE` (104×74) — nothing freezes them; they are handed
out by reference and stay identity-stable simply because nothing ever
constructs a new one — never a resize listener, since this machine paints
at 240 Hz and a per-frame listener would fire hundreds of times for one
drag. `metrics.test.ts` reads `strip.css` raw and fails if its numbers ever
drift from `metrics.ts`'s. The scrub-speed chip that rides the strip's
position bar is anchored at `bottom: calc(var(--cell-h) + 7px)`
(`strip.css`) — expressed in `--cell-h` rather than a literal — so it clears
the cells' top edge by 2 px at both steps instead of sitting on the
thumbnails' lower edge, over the rating dots and badges, as it did at the
strip's real (83/103 px) box before fix round 4.

The footer's guiding contract is **nothing is ever clipped — the filename
stem ellipses last**: at the 1024 px minimum window, with every shed
already applied, the worst realistic combination (an all-missing save chip,
mid-scrub, an active overlay cluster) still leaves the filename stem ~28 px
to render before it ellipses; ordinary states get its full 240 px
max-width. The arithmetic behind every breakpoint above — including why the
cosmetic shed sits at 1240 and not 1200 — is worked in full in
`src/styles/statusbar.css`'s comment above the `@media (width < 1360px)`
rule; `layout.test.ts` pins the breakpoints themselves and the shrink
guards (min-width/flex-shrink), not the paddings, gaps or glyph-advance
sums the arithmetic is built from.

## Modules

The frontend follows a strict layering — no circular deps:

```
App.tsx (composition root: state + JSX wiring)
  ↓ imports
app/         — App's own hooks, one concern each (grand cleanup Phases 6-9):
               session lifecycle, site navigation, decide callbacks, keymap,
               pane zoom, held-repeat scrub engine, store wiring, rating
               persistence, quit guard, undo/redo, smart derivations,
               drag-and-drop, folder trouble, overlay-kind upkeep
components/  — presentational; receive callbacks + state via props
  ├─ pane/   — PhotoPane: the one loupe/compare pane recipe (presenter layers, zoom)
  └─ strip/  — PhotoStrip family: film strip, virtualizer, burst boxes
  ↓ imports
image/       — imageStore (TierLane quad mechanics, eviction, generations) +
               its satellites (midSweep, tierErrors, devStats), presenter,
               decode pool
smart/       — burst/similar grouping + verdict derivation (pure TS, no React)
overlays/    — clipping/peaking mask scans + histogram (inline + worker paths)
hooks/       — component-shared hooks: useSettings, useRecents, focus trap,
               armed confirm
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
