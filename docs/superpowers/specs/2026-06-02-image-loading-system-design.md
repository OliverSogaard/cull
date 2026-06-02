# Image Loading & Display System — Design

Status: approved design, pending spec review
Date: 2026-06-02

## 1. Goal

Make image loading and display feel instant and consistent everywhere (grid,
loupe, compare, thumb strips), with one design language for "not loaded yet".
Optimized for the worst case (culling from a NAS over SMB); the local-SSD case
benefits for free. The headline experience: **the shimmer placeholder is seen
only on the very first load of a frame — after that, every surface shows either
a low-res or a full-res JPEG, never a shimmer again.**

This replaces the "real BlurHash" experiment (the placeholders looked poor and
added a backend image-decode dependency). We revert to the embedded thumbnail
("THMB") as the low-res asset, but — unlike before — we keep every loaded THMB
in memory for the session and back it with an on-disk cache, so it is available
instantly across the grid, the strips, and the main-view placeholder.

## 2. Core principles

1. **Three display stages**, in strict precedence (arrival-order independent):
   `shimmer` (nothing) < `thumb` (THMB loaded) < `full` (full-res loaded).
2. **One low-res asset serves all surfaces.** The embedded THMB is the grid
   image, the strip image, and — blurred — the main-view placeholder.
3. **Cache all low-res; window the full-res.** THMBs (≈8–15 KB each) are kept in
   memory for the whole session and persisted to a bounded on-disk cache.
   Full-res previews (multi-MB) stay windowed around the cursor and are evicted.
4. **Source-agnostic behavior.** The state machine, caches, placeholder, and disk
   cache behave identically on Network and Local modes. The only mode difference
   is numeric tuning carried by the existing storage profile (plus one new knob).
5. **Aspect is known before pixels.** The main frame's aspect ratio comes from
   the per-image EXIF display dimensions (orientation-adjusted), returned with the
   THMB read — so a placeholder is correctly shaped immediately (fixes the "too
   small while loading" bug).

## 3. Architecture

Two well-bounded units, replacing the loading logic currently scattered across
`App.tsx` (the load callbacks, the bundle/thumb queues, and the three eviction
effects).

```
App.tsx (thin orchestration)
  <GridView/Loupe/CompareView/ThumbStrip cells>  ──►  useImage(path, {wantFull})
                                                          │
                            ┌──────────────── imageStore (frontend) ───────────────┐
                            │  • in-memory THMB cache (no session eviction)         │
                            │  • windowed full-res cache (+ eviction)               │
                            │  • priority queues + bounded pumps (per profile)      │
                            │  • background "fill all THMBs" sweep                  │
                            │  • per-path stage resolution (shimmer|thumb|full)     │
                            │  • subscription store (useSyncExternalStore)          │
                            └───────────────────────────┬──────────────────────────┘
                                                        │ IPC
                            ┌──────────────── thumb_cache.rs (backend) ────────────┐
                            │  extract_thumbnail = disk-cache → CR3 → disk-cache    │
                            │  LRU disk cache (500 MB), keyed by pathHash + mtime   │
                            │  clear_thumb_cache(), thumb_cache_size()              │
                            └──────────────────────────────────────────────────────┘
```

### 3a. Backend: `thumb_cache.rs` (the disk side)

- `extract_thumbnail(path)` becomes: stat the file for mtime → look up the disk
  cache by `(hash(path), mtime)` → on **hit**, return the cached `{jpeg, w, h}`
  (no CR3 open); on **miss**, run the existing `cr3::read_thumbnail` (THMB JPEG +
  EXIF display dims), write the result to the disk cache, return it.
- **Cache layout:** OS app-cache dir (resolved via Tauri's path API),
  `…/cache/thumbs/`. Each entry is a small file containing a tiny header
  (display `w`,`h`) followed by the THMB JPEG bytes — self-contained, so a hit
  needs no CR3 read for dims. Filename encodes `hash(path)` and `mtime` so a
  changed/replaced file is a natural miss.
- **LRU + cap:** an in-memory index `{key → (sizeBytes, lastUsed)}` (rebuilt from
  the dir on startup, updated on access/write). Total cap **500 MB** for both
  modes. On a write that would exceed the cap, evict least-recently-used entries
  until under ~90 % of the cap (hysteresis to avoid thrash).
- **Commands:** `clear_thumb_cache()` (delete all entries, reset index) and
  `thumb_cache_size() -> u64` (current bytes) for the Settings control.
- **Concurrency:** the index is behind a `Mutex`; all file I/O runs on the
  blocking pool (commands already `spawn_blocking`). Cache state lives in a
  process-global (`OnceLock`) or Tauri managed state.
- **Invariant preserved:** the cache dir is the only thing written besides XMP
  sidecars; CR3s are never modified. The cache is in the disposable OS cache dir.

### 3b. Frontend: `imageStore` + `useImage`

A vanilla (non-React-state) store so a thumbnail arriving for one path re-renders
only the components consuming that path — not the whole app (the current
"every thumb load re-renders App.tsx" problem is designed out).

- **Public hook:**
  `useImage(path, { wantFull }: { wantFull: boolean }) → { stage, url, dims }`
  - `stage: "shimmer" | "thumb" | "full"`, `url: string | undefined`,
    `dims: { w: number; h: number } | undefined`.
  - Grid cells / strip cells call with `wantFull: false` (THMB only).
  - Loupe and each compare pane call with `wantFull: true` (full-res + THMB).
  - Implemented over `useSyncExternalStore(subscribe(path), snapshot(path))`,
    plus an effect that registers the path's load intent and (on the consumer's
    mount/visibility) bumps its priority.
- **Imperative inputs** (driven by App.tsx as the user navigates):
  `setCursor(view, index)`, `setGridViewport({first,last})`,
  `setCompareCursor(champ, challenger)`, `reset()` (on folder change /
  resetSession, revoking outstanding full-res blob URLs).
- **Internal state:**
  - `thumbs: Map<path, { url, dims }>` — all loaded THMBs; no eviction within a
    session (safety LRU cap ~15 000 entries for monster folders).
  - `previews: Map<path, { status: "loading"|"ready"|"error", url?, dims?, error? }>`
    — windowed full-res; evicted outside the keep window (blob URLs revoked).
  - Per-path subscriber sets for fine-grained notification.
  - Pool counters + queues (see §5).

## 4. Stage machine (per image)

Pure function of the per-path state; trivial to unit-test in isolation.

```
fullReady          → "full"   (full-res blob; crossfade in, blur off)
else thumbReady    → "thumb"  (THMB blob, blurred, object-fit: cover)
else               → "shimmer"
```

Rules:
- **Precedence is arrival-order independent.** A THMB that lands after the
  full-res never downgrades the display; a full-res always wins.
- **Evicted full-res falls back to `thumb`, never `shimmer`** (the THMB is still
  cached). This is what guarantees "no shimmer after first load".
- **No THMB available** (rare CR3 lacking a THMB box): `shimmer` → `full`
  directly (skip the thumb stage).
- **Full-res fails to decode:** stay on the blurred `thumb` if present, else a
  small "preview failed" affordance; do not blank the view.
- **Aspect:** the frame's `--photo-ar` comes from `dims` (EXIF display w/h) at all
  stages; the blurred THMB uses `object-fit: cover` so a THMB whose own aspect
  differs from the photo still fills the frame (the blur hides any crop).
- **Transitions:** quick cross-fade / blur-off between stages so swaps don't flash.

## 5. Loading priority + background fill

One global priority order, fed by the imperative inputs, across the bounded pools
(concurrency from the storage profile):

1. On-screen full-res — loupe current frame, or compare champion + challenger.
2. THMBs for the visible set — grid viewport cells, strip window cells.
3. Prefetch full-res — ahead/behind the cursor (profile radius).
4. **Background fill** — every remaining THMB, in book order, cursor-outward, at a
   separate **low** concurrency (new profile knob) so it always yields to 1–3.
   Re-targets to the grid viewport's neighborhood when the user is in grid.

The background fill is what populates the whole-shoot THMB cache so shimmers
disappear after warm-up. It skips paths already cached (memory or disk-hit) and
respects `reset()` (cancels on folder change).

## 6. Storage-mode profile

Structurally identical on both modes; only numbers differ. The new system
inherits the existing profile and adds one knob:

| Knob | network | local |
|---|---|---|
| Bundle (full-res) concurrency | 3 | 12 |
| Thumb (on-demand) concurrency | 4 | 16 |
| Prefetch ahead / behind | 10 / 5 | 20 / 10 |
| Full-res keep window (each side) | 18 | 30 |
| Hi-res zoom warm-up | 150 ms | 50 ms |
| **NEW: background-fill concurrency** | **2** | **8** |

Disk cache (500 MB, LRU) is **on for both modes**. THMB in-memory cache is
unbounded per session (15 000-entry safety cap) on both.

## 7. Settings UI

Add one row to `SettingsDialog`: **"Thumbnail cache"** — shows current size
(`thumb_cache_size()`, e.g. "182 MB") and a **Clear** button (`clear_thumb_cache()`,
then re-reads the size). Copy notes the cache lives in the OS cache folder and is
safe to clear at any time.

## 8. Revert scope (remove)

- Rust: `blurhash` and `zune-jpeg` crates (Cargo.toml); `extract_blurhash`
  command + `BlurhashInfo`; `cr3::read_thumbnail_meta`, `thumbnail_blurhash`,
  `oriented_rgba`, and the `blurhash` field on the `Thumbnail` struct / thumbnail
  IPC header. **Keep** `display_dims` and the THMB display `width`/`height` on the
  thumbnail read + IPC (now the aspect source).
- Frontend: the warm-pass effect, `decodeBlurCached` + `blurDecodeCache`,
  `blurhashToDataUrl` + `fetchBlurhash`, `src/utils/blurhashCache.ts`, the
  `blurhashes`/`BlurInfo` state and all `blur=`/`blurhashes=` props threaded
  through GridView, GridCell, ThumbCell, ThumbStrip, CompareStrip, CompareView.
- These are replaced by `useImage` consumption.

## 9. Edge cases (captured as requirements)

- Full-res arrives before THMB → show full, ignore late THMB (precedence).
- THMB missing → shimmer → full.
- Full-res decode fails → keep blurred THMB + "preview failed" mark.
- Evicted full-res (scrolled away then back) → blurred THMB until full re-loads.
- Folder change / resetSession mid-load → cancel queues + background fill, revoke
  full-res blob URLs, keep nothing dangling; THMB memory map cleared, disk cache
  persists.
- Monster folder (15 000+ images) → THMB memory LRU caps; disk LRU caps at 500 MB.
- Fast grid scroll over thousands of cached THMBs → only viewport cells mount
  (virtualization), so decode/texture memory stays bounded.
- THMB whose own aspect ≠ photo aspect → `object-fit: cover` + EXIF-dims frame.
- Disk cache unavailable / quota / corrupt index → degrade to no-disk-cache
  (recompute from CR3); never crash.

## 10. Testing

- **Backend (`cargo test`):** disk cache hit / miss / mtime-invalidation /
  LRU-eviction-at-cap / clear / size; cache survives a simulated "reopen" (new
  index from dir).
- **Frontend (Vitest):** the stage-resolution reducer as a pure function
  (precedence, eviction→thumb fallback, no-thumb, fail). The pools/priority and
  `useImage` wiring are integration-level and verified live (consistent with the
  project's "no component tests" stance).

## 11. Out of scope (future)

- Generating a custom mid-res derivative (we use the camera's embedded THMB +
  full preview as-is).
- Cross-machine / shared cache.
- Persisting full-res to disk (too large; intentionally windowed in memory).
