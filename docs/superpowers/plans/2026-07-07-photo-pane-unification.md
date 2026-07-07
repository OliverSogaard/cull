# PhotoPane Unification Plan (loupe + compare, one pane implementation)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Approved direction by Oliver 2026-07-07 ("that unifying code would be endgame"). Execute in a FRESH session with Oliver live (hot-reload visual gates) — this is the app's hottest rendering path, with WKWebView paint-bug history.

**Goal:** One `PhotoPane` component renders a photo with zoom/hi-res/overlays, consumed once by the loupe and twice by compare. Behavior = the LOUPE's proven recipe everywhere.

**Why (drift evidence, all 2026-07-07):** the compare pane is a hand-copied sibling of LoupeStage + App glue, and every copy drifted:
- Hi-res glide gap: compare's HiResLayer never received the shared zoom curve (fixed `96d6b24`, was user-visible tearing).
- Transform-safe zoomed measure had to be written twice (`069a06c` loupe, `663383b` compare), now shared via `paneGeometry.ts`.
- Unzoom measure delay: named constant in loupe, bare `260` in compare (now shared).
- **OPEN, the acceptance test:** compare's hi-res REVEAL snaps at decode (loupe glides smoothly then sharpens in place). Deliberately NOT point-fixed — unification is its fix.

## Current duplication map
| Concern | Loupe | Compare |
|---|---|---|
| Presenter wiring (usePresent + offerTiers + nav) | LoupeStage + App glue | ComparePanel (near-copy) |
| Measure discipline (scrub skip, zoomed clip-measure, unzoom delay, RO) | App.tsx effect (~1590) | ComparePanel effect (~243) — same shape, own shell |
| Hi-res mount gating | App `hiRes` settle timer (fullSettleMs) + `cur.stage==="full"` + dims gate + hasImgRect | ComparePanel: immediate on `isZooming` + decode gate (NO settle) ← likely the snap |
| Hi-res transform math | shared `hiResTransform` (done) | shared (done) |
| Zoom full fetch/pin | App settle effect + zoom-pin effect (loupe-only since `5005e14`) | compare-session pins (App ~870) + per-pane fetch effect |
| Frame dims fallback (10000-square sizer) | App `frameDims` | ComparePanel `frameDims` (copy) |
| Spinner/shimmer/error surfaces | LoupeStage | ComparePanel (copy, small diffs) |
| Feedback wash / overlays clip | shared classes, dual wiring | — |

## Target architecture
`src/components/pane/PhotoPane.tsx` owns: presenter (usePresent/offerTiers/nav), measure (paneGeometry), hi-res mount policy (THE LOUPE'S: settle-gated, decode-gated, dims-gated, transition = shared glide prop), spinner/shimmer/error, frame sizer + --photo-ar. Props: `path`, `img` (useImage state), `isZooming/zoomZ/originX/originY/zoomGlide`, `scrubbing`, `variant: "loupe" | "compare"` (class names + role chrome), `onRectChange?` (loupe feeds overlays/zoom math from the pane's rect — invert today's App-owned imgRect), masks as children or props.
- Loupe keeps: EXIF rail, strips, feedback — outside the pane.
- Compare keeps: role chips, CompareExifRail, strip — outside the pane.
- App sheds: imgRect measure effect, hiRes settle state (moves into pane, parameterized by profile.fullSettleMs), frameDims, hiRes transform consts.

## Order of work (each step suites-green + Oliver visual gate)
1. Extract `PhotoPane` from LoupeStage verbatim (loupe consumes it; zero behavior change intended). Gate: loupe indistinguishable (zoom engage/release, carry, overlays, error, shimmer).
2. Swap ComparePanel's pane guts for `PhotoPane` (compare-specific chrome stays). Gate: compare reveal now GLIDES like loupe (the open snap disappears) + zoomed decides + role chips intact.
3. Delete the dead ComparePanel duplication; sweep comments referencing the old split.
4. Regression lap: mixed-AR carries, memory budget behavior (sequential swap still fires), NAS profile, 8927-class paint checks.

## Risks
- WKWebView stale-paint patterns (see 2026-07-06 notes: layer opacity + layout shift ghosts) — visual gates per step, no batching steps.
- The presenter's decode-gated double-buffer is timing-sensitive (mid-scrub offers must stay sequenced best-first).
- App's imgRect consumers (overlay masks, zoom math, cursor-anchored zoom mousedown) must keep one rect source — the pane reports it up.

---

## Implementation note — 2026-07-07 (steps 1–3 DONE, live-gated; step 4 partial)

Executed in one session with Oliver gating each step live (hot-reload). Commits
`ac5f588` (step 1) → `1b194f5` (step 2) → `0fd0cf2` (step 3), all local until
Oliver's push say-so. Suites at every step: 414 TS + 103 Rust, tsc clean.

**Step 1 (extract, zero drift — GATE PASSED).** `src/components/pane/PhotoPane.tsx`
absorbed LoupeStage verbatim PLUS the App glue: the measure discipline (now
pane-owned, reported up via `onRectChange`; App keeps only the mouse-zoom math
and a `zoomZ` drag-factor mirror), the settle policy (`fullSettleMs` prop +
`settleResetKey` replacing the thumbs/exif deps), frame div + sizer +
`--photo-ar`, hi-res transform, and the mask/thirds overlays (mask URLs as
props). New shared `paneZoomZ()` in paneGeometry (TDD) — the zoomLevel×1:1
formula that existed as three hand-copies. LoupeStage deleted.

**Step 2 (compare swap — ACCEPTANCE TEST PASSED).** ComparePanel kept only its
chrome (role chip, rating dot, `useImage wantFull:!scrubbing`, the zoom-engage
fetch); everything else is PhotoPane. Compare's hi-res reveal GLIDES —
confirmed live; the settle-gated pre-mount is what does it. The gate surfaced
one real bug + the audit two more, all fixed in `1b194f5`:
1. **Zoomed measure now observes container resizes.** Compare's panels RESIZE
   mid-zoom (a decide swapping in a different-AR challenger redistributes the
   row) — the stale rect mis-scaled every derived zoom factor on the STAYING
   pane (Oliver's blurry-champion, landscape+portrait case). The zoomed
   measure is transform-safe (__clip parent), so observing is safe. Also fixes
   the loupe's latent strip/rail-toggle-while-zoomed variant.
2. **Drop-recovery:** zoomed + nav-ready + no zoom full → the pane re-requests
   it (decide drops / errored reads previously left the blurry preview + ring
   forever; nothing else re-fired the fetch).
3. **Decide drops now run UNZOOMED too** (all three decide callbacks): the
   settle policy keeps both panes' fulls resident even unzoomed, so unzoomed
   decides accumulated the outgoing challenger's full. Same after-last-setState
   position (sync-flush hazard unchanged).

**Deliberate policy change:** compare panes now settle-fetch their zoom fulls
(both panes, ~10 MB blobs + a fit-scale native raster each) even unzoomed —
that IS the glide. Memory guarded by decide drops + the pressure stack.

**Step 3 (consolidation).** HiResLayer/PresentLayers/paneGeometry/zoomTransition
moved `components/loupe/` → `components/pane/`; loupe/ gone; old-split comments
swept (usePresent header, ARCHITECTURE.md presenter + deferred-zoom sections).
Identical bundle hash before/after = zero behavior change.

**Step 4 (regression lap) — remaining live items:** NAS-profile run, 8927-class
paint checks, one more mixed-AR carry lap in loupe AND compare, memory watch in
a long compare session (Activity Monitor on WebContent). Code-side items done:
sequential swap verified firing on every decide; post-diff review pass run.
