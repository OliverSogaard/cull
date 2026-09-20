# CULL — Performance Audit (fresh-eyes, read-only)

Scope: runtime performance and efficiency of the frontend (React 19 + TS) and
its IPC boundary with the Rust backend. Backend Rust internals were skimmed
only for IPC shape/threading, not deeply reviewed (a separate reviewer is
covering `cargo`/Rust).

## Summary verdict

This is an unusually disciplined performance-engineered codebase — the tiered
image pipeline (`imageStore`, `present.ts`, `decodePool.ts`, `tierLane.ts`)
reads like a systems-programming case study, not typical React app code. Blob
URL lifecycle, cancellation, backpressure, eviction, and worker-offloaded
overlay compute are all handled correctly and are backed by 487 passing unit
tests. The IPC boundary is lean (raw `ArrayBuffer` framing, no base64, no
JSON-serialized pixel arrays) and the JS bundle is small (118 KB gzip).

The one real architectural weak spot is at the **React state layer above the
image pipeline**: `App.tsx`'s `metadata` state (and, to a lesser extent,
`useSmartCulling`'s `scores` state) is updated once **per image** as
thumbnails/previews land, and each update (a) shallow-clones the whole
per-path map and (b) is a dependency of `useMemo` calls that re-scan the
**entire** `images` array (burst grouping, similar grouping, suggestion
derivation). For a shoot of a few thousand frames — exactly CULL's stated use
case ("thousands of CR3 frames") — this turns folder-open into O(n²) work
distributed across the loading window, and forces top-level view components
(`ThumbStrip`, `CompareStrip`, `CompareView`, `ExifRail`, none of which are
memoized) to re-render on every single image arrival. This is the one finding
in this report that plausibly produces user-visible jank, specifically during
the first 10–60 seconds after opening a large folder, and it is fixable
without touching the image pipeline at all.

Everything else in this report is minor: a couple of small CSS nits, a
background-sweep O(n) rescan that's already load-bounded, and observations
that confirm deliberate, documented tradeoffs (no `createImageBitmap`, no
code-splitting) rather than oversights.

## What is genuinely excellent

- **`src/image/imageStore.ts`** (1621 lines) — priority-laned, bounded-
  concurrency, generation-guarded fetch scheduler for four tiers (thumb /
  preview / zoom-full / mid) with a single, centrally-documented eviction-
  protection predicate (`isProtected`, line 1058) and an exhaustively
  commented list of every blob-URL revoke site. This is the right way to
  build a manual cache with `URL.createObjectURL`/`revokeObjectURL` — it would
  be very easy to leak blobs in an app like this, and it doesn't.
- **`src/image/present.ts`** — a decode-gated, double-buffered, only-upgrade
  presenter with an explicit scrub-mode frame-budget race against
  `requestAnimationFrame`. This directly targets the "flash of undecoded/
  wrong pixels" class of bug that photo apps normally ship with.
- **`src/image/decodePool.ts`** — deliberately *not* `createImageBitmap`
  (documented: unsupported resize options on WKWebView, doubles decoded
  memory off the display path) and a documented fix for a WKWebView "blob
  poisoning" defect (deferred `src=""` clear until a decode settles instead of
  aborting it). This is exactly the kind of empirically-earned platform
  knowledge that's easy to regress if a future refactor "simplifies" it.
- **IPC framing (`src/utils/bundle.ts`)** — `read_preview` / `read_fullres` /
  `read_mid` / `extract_thumbnail` all return a raw `u32 LE header-length +
  JSON + binary payload` frame via `tauri::ipc::Response` (confirmed in
  `bundle.rs:22,112,500,547`), sliced directly into a `Blob` — no base64, no
  JSON pixel arrays. This is the correct choice and avoids the single most
  common Tauri performance mistake.
- **Overlay compute off the main thread** (`src/overlays/maskWorker.ts`,
  `overlayCompute.ts`, `overlayService.ts`) — `createImageBitmap` transferred
  zero-copy to an `OffscreenCanvas` worker, boot-time capability probe, clean
  main-thread fallback, per-kind bounded LRU (16), generation + toggle-off
  cancellation. Histogram/clip/peak masks never block the UI thread.
- **Smart-culling scheduler (`src/smart/analysisDriver.ts`,
  `useSmartCulling.ts`)** — chunked (6/16 images per IPC call depending on
  storage mode), cooperatively yields to `imageStore.isBusyLoading()` between
  chunks, gen-guarded, retries once then skips a failed chunk rather than
  blocking the pass. The analysis genuinely cannot starve interactive reads.
- **Real virtualization, not just windowing math on paper**: both
  `GridView` (`src/components/GridView.tsx`) and the filmstrip
  (`useStripVirtualizer.ts` / `computeWindow.ts`) use rAF-throttled scroll
  handlers, `ResizeObserver` (not `getComputedStyle` on the hot path), and
  `computeWindow`'s gap-aware path binary-searches (`lowerBound`) instead of
  scanning. Grid cells and strip cells (`GridCell`, `ThumbCell`) are
  `React.memo`'d and keyed by stable image id, not index.
- **Backend I/O gating** (`io_gate.rs`) — a semaphore-backed permit backstop
  with a stuck-permit watchdog, `spawn_blocking` for all NAS reads so a hung
  SMB read pins one blocking-pool thread instead of stalling the async
  runtime (`bundle.rs:84`).
- **Bundle hygiene** — minimal dependency tree (no moment/lodash), named
  `lucide-react` icon imports (tree-shakes cleanly), two self-hosted variable
  woff2 files backing 5 `@font-face` weight declarations (not 5 separate font
  files), `font-display: swap` on all of them, and a real CSP.

## Findings

### HIGH — Per-image metadata delivery causes O(n²) recompute + un-memoized cascading re-renders on folder open

**Files:**
- `src/app/useImageStoreWiring.ts:108-113` (the `metaSink` wiring)
- `src/utils/mergeMeta.ts:21-35` (the full-map clone per delivery)
- `src/app/useSmartDerivations.ts:57-93` (`burstData`/`similarData`/`suggestions`
  `useMemo`s keyed on the `metadata` object reference)
- `src/smart/useSmartCulling.ts:105-118` (a milder version of the same pattern
  for `qualityScores`)
- `src/image/imageStore.ts:1026,1151` (the two call sites that fire the sink —
  once per thumbnail landing, once per preview landing)

**Rationale:** `imageStore` calls `metaSink(path, meta)` from
`fetchThumbInto` (every thumbnail arrival) and `fetchNavInto` (every preview
arrival). The sink, wired in `useImageStoreWiring.ts`:

```ts
imageStore.setMetaSink((path, meta) => {
  setMetadata((m) => ({ ...m, [path]: mergeMeta(m[path], meta) }));
});
```

does a shallow clone of the **entire** `metadata` map on every single call.
During the background thumbnail sweep on a fresh folder open — which runs at
`backgroundFillConcurrency` (8 local / 2 network) but completes once per
image — this fires once per image in the shoot. For a folder of N images the
clone cost alone is `1+2+...+N ≈ O(N²)`.

Worse, `useSmartDerivations.ts` derives burst/similar grouping and
suggestions from this same `metadata` object by reference:

```ts
const burstData = useMemo(
  () => buildBurstInputs(images, qualityScores, metadata),
  [images, qualityScores, metadata],
);
...
const similarData = useMemo(
  () => buildSimilarInputs(images, qualityScores, metadata),
  [images, similarData, ...],
);
```

`buildBurstInputs`/`buildSimilarInputs` and the `groupBursts`/`groupSimilar`
passes that consume them are each an O(N) scan over the **whole** `images`
array (`burstInputs.ts:19`, `groupBursts.ts`, `groupSimilar.ts:136`) — correct
and cheap in isolation, but here they re-run in full on **every single
per-image metadata delivery**, because React's `useMemo` only sees "the
`metadata` reference changed," not "one path's entry changed." That's another
`O(N²)` term, this one with real per-item work (Hamming-distance BigInt ops,
`Date.parse`, capture-time comparisons), not just an object clone.

`suggestions` (also in `useSmartDerivations.ts:98-119`) depends on
`burstCtx`/`similarCtx`, so it inherits the same churn even when
`qualityScores` hasn't changed. And `App.tsx`'s `visibleIndices` (line 337)
depends on `suggestions`, so the top-level filtered index list also
recomputes on every image arrival.

Finally, because `metadata` is `App`'s own `useState`, every one of these
updates re-renders the whole `App` function component. `ThumbStrip`,
`CompareStrip`, `CompareView`, and `ExifRail` (see MEDIUM finding below) are
**not** `React.memo`-wrapped, so their full render bodies re-execute on every
one of these N events too, even though the individual `ThumbCell`/`GridCell`
leaves are memoized and mostly bail out.

**Estimated impact:** For a 3,000–5,000-image shoot (explicitly the target
use case per the README: "thousands of CR3 frames"), this produces thousands
of extra `App` re-renders and thousands of O(N) burst/similar recomputations
during the ~10–60 s the background thumbnail sweep takes to complete. Each
individual recompute is cheap (sub-millisecond to a few ms at N=5,000), but
because it happens on the main thread inside `useMemo` during render, and
because it happens once per arriving image rather than once per batch, the
cumulative effect is the most likely source of any "the app feels laggy while
thumbnails are still loading" reports on large shoots. It does not affect
correctness (everything is still gen-guarded and eventually consistent) and
it does not block the image pipeline itself (thumbnails still arrive and
decode on schedule) — it's pure wasted CPU competing with paint.

**Concrete fix:** Batch the metadata sink instead of flushing on every
delivery. The store already has the right primitive to copy — it uses
`useSyncExternalStore` with a stable per-path snapshot for image state
(`imageStore.ts:940`) and for overlays (`overlayService.ts`); metadata could
follow the same pattern instead of living in `App` state. Minimally invasive
version (no new store, one file):

```ts
// useImageStoreWiring.ts
const pending = useRef(new Map<string, ImageMetadata>());
const flushHandle = useRef<number | null>(null);
useEffect(() => {
  imageStore.setMetaSink((path, meta) => {
    pending.current.set(path, meta);
    if (flushHandle.current != null) return;
    flushHandle.current = requestAnimationFrame(() => {
      flushHandle.current = null;
      const batch = pending.current;
      pending.current = new Map();
      setMetadata((m) => {
        const next = { ...m };
        for (const [p, meta] of batch) next[p] = mergeMeta(m[p], meta);
        return next;
      });
    });
  });
  return () => imageStore.setMetaSink(undefined);
}, [setMetadata]);
```

This collapses up to N per-image updates into one update per animation frame
(bounded by however many thumbnails a fast local SSD can deliver in 16 ms,
typically a handful), which turns both the clone cost and the
burst/similar-recompute cost from `O(N²)` into roughly `O(N × frames)` ≈
`O(N)` in practice. `qualityScores` in `useSmartCulling.ts` would benefit from
the identical treatment, though it's already chunked (6–16 images/update) so
the win is smaller.

---

### MEDIUM — Top-level view components are not memoized, compounding the finding above

**Files:** `src/components/ThumbStrip.tsx:15`, `src/components/CompareStrip.tsx:19`,
`src/components/CompareView.tsx:21`, `src/components/ExifRail.tsx:27`

**Rationale:** `GridView`, `GridCell`, `ThumbCell`, and `PhotoPane` are all
wrapped in `React.memo`. `ThumbStrip`, `CompareStrip`, `CompareView`, and
`ExifRail` are plain function components. Since `App` re-renders on every
cursor move, every keypress, and (per the HIGH finding) every image arrival,
these four re-execute their full render bodies every time regardless of
whether their own inputs changed. Today the cost is mostly absorbed by their
children's own memoization, but it's a straightforward, low-risk win once the
HIGH finding is addressed (fewer App re-renders means each of these four
matters less, but memoizing them also caps the damage from any future
`App`-level state that changes often).

**Fix:** Wrap each in `React.memo`. Verify prop identity stability first —
`App.tsx` already builds `loupeStrip`/`cmpStrip` as JSX once per render
(lines 1932, 1947) rather than inline in multiple branches, which is a good
sign these components' props are already reasonably stable candidates for
memoization; the array/callback props passed in (`images`, `visibleIndices`,
`suggestions`, `bursts`, `similar`, `onPick`, etc.) should be checked for
identity churn before/while adding the memo so it doesn't silently become a
no-op.

---

### LOW — `MidSweep.pick()` is an O(N) linear rescan per pick, invoked repeatedly during the idle sweep

**File:** `src/image/midSweep.ts:127-144`

**Rationale:** The local-profile idle mid-tier generator scans the full
`paths` array from the start on every `pick()` call to find the
nearest-to-cursor not-yet-attempted path, and `pump()` calls `pick()` once per
available concurrency slot. With a budget of up to 3,400 attempts
(`MID_SWEEP_BUDGET`) on a 5,000-image folder, that's a worst case on the
order of `3,400 × ~2,500` (average scan depth) ≈ 8.5M array-index comparisons
— cheap per-comparison, but all on the main thread, and it's already gated
behind `MID_SWEEP_QUIET_MS` (1.5 s of cursor quiet) and
`profile.midGenConcurrency` (1–2), so in practice this is spread out and
unlikely to be visible. Flagging only because the pattern (linear rescan
instead of a resumable cursor/pointer) is the same shape as the HIGH finding,
just already load-bounded and already flagged in the codebase's own review
comments (the "review F1/F3" citations in `midSweep.ts`).

**Fix (optional, low priority):** Not urgent given the existing gating; if it
ever needs to scale further, a simple pointer that resumes from the last scan
position (wrapping around) instead of restarting from 0 would turn repeated
full rescans into amortized single passes.

---

### LOW — One CSS transition animates `width` instead of a compositor-friendly property

**File:** `src/App.css:1522-1527`

```css
.cull-progress__fill {
  height: 100%;
  background: var(--accent);
  border-radius: 2px;
  transition: width 150ms ease-out;
}
```

**Rationale:** This is the folder-analyze progress bar fill. It's a single
small element, updates infrequently (once per `analyze_folder` progress
event, not every frame), and only exists on the "analyzing" chrome screen —
real-world impact is negligible. Flagging only because the project's own
performance rules (web/performance.md) call for `transform`/`opacity`-only
animation, and this is the one place in the stylesheet that doesn't follow
it.

**Fix:** `transform: scaleX(fraction)` with a fixed-width track and
`transform-origin: left` instead of an inline `width` percentage.

---

### LOW — No route-level code splitting / lazy loading configured

**File:** `vite.config.ts` (no `manualChunks`, no `React.lazy`/dynamic
`import()` anywhere in `src/` besides the worker)

**Rationale:** The measured bundle (118 KB gzip JS, see Bundle report below)
is well inside the app-page budget (300 KB), and CULL is a single-view kiosk-
style desktop app (LOUPE/COMPARE/GRID are three renders of the same session,
not separate routes), so there's genuinely nothing to lazy-load — this is a
correct application of YAGNI, not an oversight. Noting it only because the
task asked to check for code splitting; no action recommended at current
bundle size.

---

### Informational — deliberate tradeoffs confirmed, not defects

- **No `createImageBitmap` in the decode pool** (`decodePool.ts:13`): this is
  a documented, empirically-justified choice (WKWebView resize-option support
  + doubled decoded memory), not a missed optimization opportunity. Do not
  "fix" this without re-reading the linked mid-dims bug report reasoning.
- **`backdrop-filter: blur()` on two full-screen fixed overlays**
  (`App.css:1618`, `App.css:3426`, the quit-guard and help overlays): both are
  static (non-animating) modals shown rarely; the one-time paint cost of a
  full-viewport blur is not a per-frame cost here. No action needed.
- **Two background JPEGs bundled at 82 KB and 132 KB** (`assets/desert.jpg`,
  `assets/backdrop.jpg`, referenced from `App.css:1102,2551`): shipped inside
  the local app bundle (not fetched over a network at runtime), so the
  "bundle size" budget lens that applies to web landing pages doesn't really
  apply — local disk read of ~200 KB is sub-millisecond. No action needed.
- **`src/App.css` is 3,858 lines as one file**: CSS parse cost at this size is
  a few milliseconds at most and is paid once at startup, not per frame — not
  a runtime performance issue. (It may still be worth splitting for
  maintainability per the project's own file-size coding-style guidance, but
  that's a code-quality concern, not a performance one, and is out of this
  report's lens.)

## Bundle report

`pnpm build` (`tsc && vite build`) output:

| Asset | Raw | Gzip |
|---|---|---|
| `assets/index-*.js` (app bundle) | 385.38 KB | 118.46 KB |
| `assets/index-*.css` | 53.64 KB | 9.39 KB |
| `assets/maskWorker-*.js` (overlay worker, separate chunk) | 2.80 KB | — |
| `assets/inter-*.woff2` | 48.43 KB | — |
| `assets/jetbrains-mono-*.woff2` | 31.34 KB | — |
| `assets/backdrop-*.jpg` | 132.65 KB | — |
| `assets/desert-*.jpg` | 82.20 KB | — |
| `index.html` | 0.62 KB | 0.40 KB |

Against this repo's own budget table (web/performance.md, "App page" row:
<300 KB JS gzip, <50 KB CSS): JS is at 118 KB / 300 KB (well under), CSS is at
9.39 KB gzip / 50 KB (well under). The overlay worker is automatically code-
split by Vite (it's loaded via `new Worker(new URL(...))` in
`maskClient.ts`), so it doesn't inflate the main bundle. No ONNX runtime or
model bytes are in the JS bundle — those are backend Rust/binary assets,
correctly kept out of the frontend entirely.

`pnpm test`: 44 test files, 487 tests, all passing, 3.57 s total.

## Measurement plan

The dev HUD (`localStorage["cull:devhud"] = "1"` + reload, rendered by
`src/components/DevHud.tsx`, backed by `imageStore.debugStats()` in
`imageStore.ts:1548`) already exposes: per-nav-read timings (last 8), per-
zoom-read timings (last 5), average nav ms, per-lane
in-flight/cap/queue-depth for preview/zoom/thumb/bg, cache sizes per tier,
load/evict/error counters, the mid-tier's live `needPx` + engaged/hysteresis
state, and a decoded-memory estimate. That HUD should be the first stop for
verification — most of the instrumentation this report would otherwise
recommend building already exists. In priority order:

1. **Metadata-churn cost on a large real folder (verifies the HIGH finding).**
   Open a 3,000+ image folder with the HUD on, and additionally add one
   temporary `performance.mark`/`measure` around `App`'s render (React
   DevTools Profiler "Record" during the first 30 s after folder-open is
   sufficient — no code change needed). Expected signature if the finding is
   real: hundreds to thousands of `App` commits during the background-fill
   window, each a few ms, with `useSmartDerivations`'s `burstData`/
   `similarData`/`suggestions` memoization showing up as the recomputed
   hooks in the Profiler's "why did this render" flame graph. Expected
   number: commit count ≈ image count (or close to it) before the fix;
   ≈ (load duration / 16 ms) after batching.
2. **React Profiler flame graph during a held-arrow scrub (30 Hz) and during
   grid fling-scroll.** Confirms the claimed "only ~2 cells change props per
   step" behavior for `ThumbCell`/`GridCell` and checks whether
   `ThumbStrip`/`CompareView`/`ExifRail` show up as re-rendering every scrub
   tick even though their meaningful inputs (which frame is centered) do
   change every tick — this is expected and fine; the concern is only
   re-rendering when they *shouldn't* need to (MEDIUM finding).
3. **Nav-tier and zoom-tier timings from the HUD on the actual target
   storage** (local NVMe vs. the "network" profile against a real NAS/SMB
   share) — the HUD's `navMsAvg` and the per-timing list are exactly the
   numbers `ARCHITECTURE.md`'s profile table (`fullSettleMs`,
   `previewConcurrency`, etc.) was tuned against; re-measuring on Oliver's
   actual hardware/storage before touching any profile constant is the
   project's own stated policy ("every profile-tuning claim cites these
   numbers, not feel").
4. **`decodedMB` HUD readout during a long loupe session with zoom engaged
   repeatedly**, watching for growth that doesn't return to baseline after
   parking on a new frame — the fastest real-world leak check for the
   zoom/mid windowed caches, independent of reading the eviction code.
5. **Lighthouse is not applicable here** (this is a Tauri desktop webview, not
   a served web page — there's no navigation/LCP/CLS in the traditional
   sense). If a web-facing marketing page for CULL exists separately, it's
   out of this audit's scope; skip Lighthouse against the app itself.

## Top 10 prioritized recommendations

1. **(HIGH)** Batch `imageStore`'s metadata-sink deliveries (rAF or
   microtask-coalesced) in `useImageStoreWiring.ts` before they reach
   `setMetadata`, so `useSmartDerivations`'s burst/similar/suggestion
   `useMemo`s stop recomputing once per image during folder open.
2. **(HIGH, same fix family)** Apply the same batching to `useSmartCulling`'s
   `setScores` updates in `useSmartCulling.ts:107-118` (secondary, since it's
   already chunked at 6–16 images).
3. **(MEDIUM)** Wrap `ThumbStrip`, `CompareStrip`, `CompareView`, and
   `ExifRail` in `React.memo`, verifying prop identity stability first.
4. Re-measure with the React DevTools Profiler on a 3,000+ image real folder
   before and after (1)+(2) to confirm the fix actually collapses the commit
   count (measurement plan #1) — this codebase's own culture is "cite the
   numbers, not feel," so don't skip this step.
5. **(LOW, optional)** Give `MidSweep.pick()` a resumable scan pointer instead
   of restarting from index 0 each call — only worth doing if a future
   larger-than-5,000-image target folder makes it show up in profiling.
6. **(LOW, trivial)** Switch `.cull-progress__fill`'s `width` transition to a
   `transform: scaleX()` for consistency with the project's own
   compositor-only-animation rule.
7. Leave the decode pool's `createImageBitmap` avoidance, the backdrop-filter
   usage, and the lack of code-splitting exactly as they are — all three are
   correct, documented decisions for this app's shape and platform target.
8. Keep the dev HUD as the source of truth for any future profile-constant
   change (it already exists and already covers everything a bolt-on
   profiler would add).
9. No backend (Rust) changes are recommended from this pass — `io_gate.rs`'s
   semaphore + `spawn_blocking` + watchdog design and the raw-`ArrayBuffer`
   IPC framing in `bundle.rs` are both correct and were only skimmed, not
   deeply audited (that's the other reviewer's remit for this session).
10. No bundle-size or dependency changes are recommended — the JS/CSS budgets
    are comfortably met and the dependency tree is already minimal.
