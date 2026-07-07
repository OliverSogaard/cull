import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode, RefObject } from "react";
import { imageStore } from "../../image/imageStore";
import { offerTiers } from "../../image/present";
import { usePresent } from "../../image/usePresent";
import type { Resolved } from "../../image/stage";
import type { Rating } from "../../types";
import { shimmerPhaseMs } from "../../utils/shimmer";
import { sizerSrc } from "../../utils/sizer";
import { HiResLayer } from "../loupe/HiResLayer";
import { PresentLayers } from "../loupe/PresentLayers";
import {
  hiResTransform,
  measurePaneRect,
  paneZoomZ,
  ZOOM_UNSETTLE_MEASURE_DELAY_MS,
  type PaneRect,
} from "../loupe/paneGeometry";

/** How long after unzoom starts before the settle-time hi-res layer may
 *  return — the release glide plus slack. */
const UNZOOM_RETREAT_MS = 240;

/** Class names per consuming surface — same recipe, each surface's CSS. */
const VARIANT_CLASSES = {
  loupe: {
    frame: "cull-photo-frame",
    sizer: "cull-photo-frame__sizer",
    img: "cull-image",
  },
  compare: {
    frame: "cull-cmp-photo-frame",
    sizer: "cull-cmp-photo-frame__sizer",
    img: "cull-cmp-img",
  },
} as const;

type PhotoPaneProps = {
  /** Current frame's path ("" when none). */
  path: string;
  /** The store snapshot for `path`. The consumer owns the useImage
   *  subscription (and with it the wantFull refcount policy). */
  img: Resolved;
  scrubbing: boolean;
  isZooming: boolean;
  /** Shared transform transition for every zoom-scaling layer — "none"
   *  during a carried-zoom frame swap (see App's zoomGlide). */
  zoomGlide: string;
  /** 1:1 / 2:1 — the pane derives its own zoomZ from its measured rect. */
  zoomLevel: 1 | 2;
  /** Zoom origin (AF point + pan, %) — compare feeds both panes the SAME
   *  synced origin so zoom compares the identical region of the frame. */
  originX: number;
  originY: number;
  /** Settle delay before the hi-res layer may mount and the zoom-tier full
   *  fetches (profile.fullSettleMs — 400 net / 150 local). */
  fullSettleMs: number;
  /** Any change drops + re-arms the settle timer. Pass a key that changes
   *  when stage-resizing chrome toggles (thumb strip / info rail): the
   *  deferred layer is positioned from the measured rect and must not linger
   *  at the old size over a reflowed base image. */
  settleResetKey?: unknown;
  /** When set, this rating's color washes briefly over the frame. */
  flashRating: Rating | null;
  variant: keyof typeof VARIANT_CLASSES;
  /** Resolved overlay mask data-URLs (undefined = hidden). The consumer owns
   *  the overlayService reads; the pane stays dumb about the overlay cache. */
  clipMaskUrl?: string;
  peakingMaskUrl?: string;
  /** Thirds grid — a whole-frame tool, hidden while zoomed or scrubbing. */
  showComposition: boolean;
  /** Container the displayed-image rect is measured against (the loupe's
   *  stage / a compare panel) — App's mouse-zoom math expects stage-relative
   *  coordinates, so the loupe must keep measuring against the stage. */
  measureContainerRef: RefObject<HTMLElement | null>;
  /** Reports the measured rect up (null when unmeasurable or unmounted) —
   *  the loupe feeds its cursor-anchored mouse zoom from this. */
  onRectChange?: (rect: PaneRect | null) => void;
  /** Un-clipped frame chrome rendered after the layers (compare's rating dot). */
  children?: ReactNode;
};

/**
 * PhotoPane — THE photo pane: the decode-gated presentation core (Phase 4)
 * plus the measure discipline, hi-res settle policy, and overlay layers that
 * used to be hand-copied between the loupe (LoupeStage + App glue) and each
 * compare pane. One implementation, consumed once by the loupe and twice by
 * compare; behavior is the loupe's proven recipe everywhere.
 *
 * Owns, inside the photo-frame div it renders:
 * - the aspect sizer + --photo-ar (frame never collapses while pixels load),
 * - the presenter's double-buffered layers (never swaps to undecoded pixels),
 * - shimmer / spinner / quiet error chip / zoom loading ring,
 * - the settle-gated, decode-gated, dims-gated hi-res zoom layer,
 * - clip/peak mask + thirds-grid overlays (mask pixels passed in as props).
 *
 * Stays outside: EXIF rails, strips, feedback chip, role chips — and the
 * whole-frame error panel (it replaces the frame, so the consumer owns it).
 *
 * Session lifecycle note: a folder change routes through the staged screen,
 * which unmounts this component — the next mount gets a FRESH presenter, so
 * no generation plumbing is needed here (revoked blob URLs die with it).
 */
export const PhotoPane = memo(function PhotoPane({
  path,
  img,
  scrubbing,
  isZooming,
  zoomGlide,
  zoomLevel,
  originX,
  originY,
  fullSettleMs,
  settleResetKey,
  flashRating,
  variant,
  clipMaskUrl,
  peakingMaskUrl,
  showComposition,
  measureContainerRef,
  onRectChange,
  children,
}: PhotoPaneProps) {
  const cls = VARIANT_CLASSES[variant];
  const imgRef = useRef<HTMLImageElement | null>(null);
  // A presenter flip changed what's displayed → re-measure the (new) front layer.
  const [measureNonce, setMeasureNonce] = useState(0);
  const bumpMeasureNonce = useCallback(() => setMeasureNonce((n) => n + 1), []);
  const { presenter, snap, elA, elB } = usePresent(imgRef, bumpMeasureNonce);

  // Navigation + scrub mode into the state machine.
  useEffect(() => {
    if (path) presenter.nav(path);
  }, [path, presenter]);
  useEffect(() => {
    presenter.setScrubbing(scrubbing);
  }, [scrubbing, presenter]);

  // Offer the store's pixels via offerTiers: settled navs fire all available
  // tiers in parallel, best last (only-upgrade + the best tier clobbering the
  // lesser decodes keep cached navs blur-free); mid-scrub the tiers are
  // SEQUENCED so a preview that loses its frame-budget race falls back to the
  // blurred thumb instead of leaving a stale frame (the WebView2 matrix's
  // compare-scrub stall). The mid (Phase 8) is offered whenever the store has
  // it — request gating (needPx) lives in the store; a ready mid is simply
  // the best fit-view pixels available. Deps include scrubbing so the release
  // re-offers instantly.
  useEffect(() => {
    if (!path) return;
    void offerTiers(
      presenter,
      path,
      {
        thumb: imageStore.thumbUrl(path),
        preview: img.stage === "full" && img.url ? img.url : undefined,
        mid: img.mid?.url,
      },
      scrubbing,
    );
  }, [path, img.stage, img.url, img.mid?.url, scrubbing, presenter]);

  // Shimmer phase pinned per image so this pane's placeholder pulses in sync
  // with the strip cells and any sibling pane showing the same frame.
  const shimmerDelayMs = useMemo(() => shimmerPhaseMs(), [path]);

  // ── Measured rect of the displayed image (relative to the container) ─────
  // Feeds the deferred hi-res layer's transform (pixel-aligned with the base
  // by construction) and, reported up, the loupe's mouse-zoom math. Discipline:
  // - never mid-scrub (warm scrub steps flip the presenter twice; measuring
  //   per flip forces two synchronous layouts per step). Release re-measures.
  // - never the img itself while zoomed (getBoundingClientRect returns the
  //   SCALED box) — measurePaneRect goes transform-safe via the __clip parent,
  //   so a carried-zoom advance onto a different aspect ratio stays aligned.
  // - after an unzoom, wait out the release transform transition — an
  //   immediate measure captures the animating, still-scaled box.
  const [rect, setRect] = useState<PaneRect | null>(null);
  // True when the measure effect last ran with zoom engaged — its next
  // unzoomed run delays past the release transition (see above).
  const wasZoomingRef = useRef(false);
  const onRectChangeRef = useRef(onRectChange);
  onRectChangeRef.current = onRectChange;
  const applyRect = useCallback((r: PaneRect | null) => {
    setRect(r);
    onRectChangeRef.current?.(r);
  }, []);
  // The consumer's copy must not outlive the pane (mode switches, empty
  // filter, the whole-frame error panel all unmount it).
  useEffect(() => {
    return () => {
      onRectChangeRef.current?.(null);
    };
  }, []);
  useLayoutEffect(() => {
    if (scrubbing) return; // overlays are hidden mid-scrub; skip measure + RO churn
    if (isZooming) {
      wasZoomingRef.current = true;
      const zoomedRect = measurePaneRect(imgRef.current, measureContainerRef.current, true);
      if (zoomedRect) applyRect(zoomedRect);
      return;
    }
    const justUnzoomed = wasZoomingRef.current;
    wasZoomingRef.current = false;
    const measure = () => {
      applyRect(measurePaneRect(imgRef.current, measureContainerRef.current, false));
    };
    // Observe the container so the layer re-aligns on any size change —
    // window resize AND the strip / rail toggles reflowing the stage.
    const ro = new ResizeObserver(measure);
    let armTimer: number | null = null;
    const arm = () => {
      measure();
      if (measureContainerRef.current) ro.observe(measureContainerRef.current);
    };
    if (justUnzoomed) armTimer = window.setTimeout(arm, ZOOM_UNSETTLE_MEASURE_DELAY_MS);
    else arm();
    return () => {
      ro.disconnect();
      if (armTimer !== null) clearTimeout(armTimer);
    };
    // img.stage/img.dims: the sizer reflows the frame when dims arrive; the RO
    // is on the container (which doesn't resize when the inner frame does).
  }, [path, measureNonce, scrubbing, isZooming, img.stage, img.dims, applyRect, measureContainerRef]);

  // ── Hi-res settle policy (the loupe's, everywhere) ────────────────────────
  // The browser rasterizes the on-screen JPEG only at screen-fit size (keeps
  // navigation instant), so zooming GPU-upscales that until it re-decodes —
  // the ~0.2s softness. Once the cursor rests on a ready frame, fetch the
  // zoom-tier full and mount a second copy rendered at native pixel size, so
  // zoom composites from already-sharp pixels. Reset on every navigation so
  // rapid arrow-through never pays the heavy fetch + native-res decode;
  // fullSettleMs only charges deliberately-parked frames.
  const [hiRes, setHiRes] = useState(false);
  const hiResTimer = useRef<number | null>(null);
  const navReady = img.stage === "full";
  useEffect(() => {
    setHiRes(false);
    if (hiResTimer.current) clearTimeout(hiResTimer.current);
    if (!path || !navReady) return;
    hiResTimer.current = window.setTimeout(() => {
      setHiRes(true);
      // Phase 8: the settled fit view prefers the mid on high-DPI stages —
      // the store re-checks needPx fresh and no-ops below the threshold.
      imageStore.maybeRequestMid(path);
      imageStore.requestZoomFull(path);
    }, fullSettleMs);
    return () => {
      if (hiResTimer.current) clearTimeout(hiResTimer.current);
    };
  }, [path, navReady, settleResetKey, fullSettleMs]);

  // ── Geometry ──────────────────────────────────────────────────────────────
  // Frame size source: the orientation-correct THMB display dims (w/h > 1
  // guards the {1,1} UNKNOWN sentinel), else a NEUTRAL SQUARE while the
  // aspect is unknown. Drives BOTH --photo-ar and the sizer. Large square
  // (not 1×1): the sizer fills the matte by clamping its intrinsic size DOWN
  // to the stage, so the fallback must EXCEED the stage — a square fills the
  // stage height (width = height), like a portrait.
  const dims = img.dims && img.dims.w > 1 && img.dims.h > 1 ? img.dims : undefined;
  const dimsKnown = !!dims;
  const frameDims = dims ?? { w: 10000, h: 10000 };
  const photoAr = `${frameDims.w} / ${frameDims.h}`;
  // Native dims of the ZOOM raster (the displayed image is the 1620px preview
  // since Phase 3, so measured element sizes must NOT feed the zoom math).
  // Preference: the zoom tier's meta-derived dims → the thumb's sensor
  // display dims (dims is the full sensor size, orientation-adjusted).
  const zoomNative = img.full?.dims ?? dims;
  const zoomZ = paneZoomZ(zoomNative, rect, zoomLevel, isZooming);
  // Transform for the deferred hi-res layer: reproduces the base's scale(Z)
  // about the origin EXACTLY, from the native-pixel-size element — pixel-
  // aligned with the base by construction, so it can appear/disappear with
  // zero visible shift.
  const hiResT = hiResTransform(rect, zoomNative, originX, originY, zoomZ);
  const hiResSrc = img.full?.url ?? (imageStore.isLegacyNav() ? img.url : undefined);
  // True while the hi-res layer's pixels are actually decoded + in place
  // (HiResLayer reports both ways) — drives the zoom loading ring below.
  const [hiResReady, setHiResReady] = useState(false);
  // The layer mounts on settle (hiRes) OR the moment zoom engages — a zoom
  // before the settle timer fired must not wait out the timer to sharpen.
  // NEVER while dims are unknown: the frame is then the neutral-square
  // fallback, the base image letterboxes inside it, and this layer's
  // top-left-anchored transform (which assumes matte AR == image AR) would
  // paint a misaligned second copy over it. The clip/peak masks paint ABOVE
  // this layer (z-index 4/5 vs 3) and stretch over the same displayed area,
  // so overlays and the sharp raster coexist — the old !clippingVisible gate
  // silently degraded the settled view to the preview and left the zoom
  // spinner waiting forever whenever highlights were on.
  // Unzoom retreat: the native-size raster must not transform-animate BACK
  // to fit — even behind a rectangular clip, gliding a ~32 MP texture down
  // stutters. Drop it the moment unzoom starts (the light preview carries
  // the release glide) and re-reveal once settled. Engaging keeps the layer
  // mounted and animating with the base on the SHARED engage curve —
  // dropping it there bought nothing and flashed the zoom ring (hiResReady
  // went false for the hide window). `justUnzoomed` covers the flip render
  // itself (state lands a commit later).
  const prevZoomingRef = useRef(isZooming);
  const justUnzoomed = prevZoomingRef.current && !isZooming;
  useEffect(() => {
    prevZoomingRef.current = isZooming;
  });
  const [unzoomSettling, setUnzoomSettling] = useState(false);
  const everZoomedRef = useRef(false);
  useEffect(() => {
    if (isZooming) {
      everZoomedRef.current = true;
      setUnzoomSettling(false);
      return undefined;
    }
    if (!everZoomedRef.current) return undefined;
    setUnzoomSettling(true);
    const t = setTimeout(() => setUnzoomSettling(false), UNZOOM_RETREAT_MS);
    return () => clearTimeout(t);
  }, [isZooming]);

  const hiResWanted =
    (hiRes || isZooming) && dimsKnown && !justUnzoomed && !unzoomSettling;

  // Overlay transform: masks scale with the image so they stay aligned
  // through zoom, on the SAME shared glide as every other scaling layer.
  const overlayStyle: CSSProperties = {
    transform: isZooming ? `scale(${zoomZ})` : undefined,
    transformOrigin: `${originX}% ${originY}%`,
    transition: zoomGlide,
  };

  return (
    // Photo-frame stays mounted across image transitions AND across scrubbing
    // so the matte + outer structure don't pop in/out on every tap-to-navigate
    // or arrow-key release — the presenter's double-buffer means the pane
    // never goes blank and never swaps to undecoded pixels.
    <div
      className={`${cls.frame}${
        flashRating
          ? ` cull-photo-frame--flash-${flashRating === "favorite" ? "fav" : flashRating}`
          : ""
      }`}
      style={{ ["--photo-ar" as string]: photoAr } as CSSProperties}
    >
      {/* Sizer: in-flow transparent replaced element at the KNOWN display
          ratio — it alone sizes the matte (see the plan's integration
          contract); the presenter layers are absolute overlays. */}
      <img className={cls.sizer} src={sizerSrc(frameDims.w, frameDims.h)} alt="" aria-hidden />
      {/* Content-box clip: everything that scales with zoom lives inside, so
          the zoomed image can never paint over the 10px matte ring — the
          matte is a true window frame at any zoom. */}
      <div className="cull-photo-frame__clip">
        <PresentLayers
          snap={snap}
          elA={elA}
          elB={elB}
          className={cls.img}
          dimsKnown={dimsKnown}
          isZooming={isZooming}
          zoomGlide={zoomGlide}
          zoomZ={zoomZ}
          originX={originX}
          originY={originY}
        />
      </div>
      {/* Skeleton shimmer only while the presenter has NOTHING — once any
          pixels presented, old content stays during navigation (no blanking). */}
      {!snap.front.url && (
        <div
          className="cull-photo-frame__shimmer"
          aria-hidden
          style={{ ["--shimmer-delay" as string]: `-${shimmerDelayMs}ms` }}
        />
      )}
      {/* Spinner: genuinely waiting on the nav tier (thumb in hand, preview
          on disk), never mid-scrub. The 150ms CSS reveal delay still applies. */}
      {img.stage === "thumb" && !scrubbing && (
        <div className="cull-photo-frame__spinner-wrap" aria-hidden>
          <div className="cull-loading__spinner" />
        </div>
      )}
      {/* Quiet error chip (choreography "Error" row): the thumb stays up and
          the failure is non-blocking. The shimmer-stage hard error panel
          lives in the consumer (it replaces the whole frame). */}
      {img.error && img.stage === "thumb" && (
        <div className="cull-error-chip" title={img.error}>
          <span>read failed</span>
          <button type="button" onClick={() => imageStore.retry(path)}>
            retry
          </button>
        </div>
      )}
      {/* Zoom loading ring: zoomed but the sharp raster isn't in place yet
          (fetching or decoding) — tells the user when the pixels are real.
          The 150ms CSS reveal delay keeps cached zooms ring-free. */}
      {isZooming && !hiResReady && (
        <div className="cull-photo-frame__spinner-wrap" aria-hidden>
          <div className="cull-loading__spinner" />
        </div>
      )}
      {/* Deferred zoom layer: the 32 MP zoom-tier blob at native size,
          transformed to coincide with the base — revealed only POST-DECODE
          (HiResLayer gates on el.decode()), token-guarded by the path key. */}
      {hiResWanted && !!rect && zoomNative && img.stage === "full" && hiResSrc && (
        <div className="cull-photo-frame__clip">
          <HiResLayer
            key={path}
            url={hiResSrc}
            w={zoomNative.w}
            h={zoomNative.h}
            tx={hiResT.tx}
            ty={hiResT.ty}
            scale={hiResT.scale}
            transition={zoomGlide}
            className={`${cls.img} cull-image--hires`}
            onDecoded={setHiResReady}
          />
        </div>
      )}
      {/* Overlays — positioning + sizing comes from the CSS rule
          (`position: absolute !important; inset: 14px`), NOT inline style.
          That keeps them out of flow no matter what, so they cannot influence
          the photo-frame's intrinsic size when toggled. Inline style is
          reserved for the zoom transform. Hidden mid-scrub: over the scrub's
          blurred thumbs and unknown-dims mattes they float wrongly placed. */}
      <div className="cull-photo-frame__clip" aria-hidden>
        {!scrubbing && clipMaskUrl && (
          <img className="cull-clip-overlay" src={clipMaskUrl} alt="" style={overlayStyle} />
        )}
        {!scrubbing && peakingMaskUrl && (
          <img className="cull-peaking-overlay" src={peakingMaskUrl} alt="" style={overlayStyle} />
        )}
        {/* Thirds grid is a whole-frame tool: intentionally hidden while
            zoomed, unlike the clip/peak masks (which stay mounted and scale
            via the inline transform). */}
        {showComposition && !isZooming && !scrubbing && (
          <svg
            className="cull-composition-overlay"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            aria-hidden
          >
            <line x1="33.333" y1="0" x2="33.333" y2="100" />
            <line x1="66.667" y1="0" x2="66.667" y2="100" />
            <line x1="0" y1="33.333" x2="100" y2="33.333" />
            <line x1="0" y1="66.667" x2="100" y2="66.667" />
          </svg>
        )}
      </div>
      {children}
    </div>
  );
});
