import { memo, useEffect, useState } from "react";
import type { MutableRefObject } from "react";
import { imageStore } from "../../image/imageStore";
import { offerTiers } from "../../image/present";
import { usePresent } from "../../image/usePresent";
import type { Resolved } from "../../image/stage";
import type { ImageDims } from "../../utils/bundle";
import { sizerSrc } from "../../utils/sizer";
import { HiResLayer } from "./HiResLayer";
import { PresentLayers } from "./PresentLayers";

type LoupeStageProps = {
  /** Current frame's path ("" when none). */
  path: string;
  /** The store snapshot for `path`. */
  cur: Resolved;
  scrubbing: boolean;
  isZooming: boolean;
  /** Zoom transform (same values the overlays use, so layers stay aligned). */
  zoomZ: number;
  originX: number;
  originY: number;
  /** Matte/sizer dims (aspect-correct; App's frameDims). */
  frameDims: ImageDims;
  /** Shared shimmer phase so the placeholder pulses in sync with cells. */
  shimmerDelayMs: number;
  /** Hi-res zoom layer inputs (App's settle flag + measured geometry). */
  hiRes: boolean;
  clippingVisible: boolean;
  hasImgRect: boolean;
  zoomNative: ImageDims | null | undefined;
  hiResTx: number;
  hiResTy: number;
  hiResScale: number;
  /** App's measurement ref — usePresent keeps it on the FRONT layer. */
  imgRef: MutableRefObject<HTMLImageElement | null>;
  /** Bump App's measureNonce (a flip changed what's displayed). */
  onFrontFlip: () => void;
};

/**
 * LoupeStage — the decode-gated presentation core of the loupe (Phase 4).
 *
 * Replaces the old single-<img> path: two presenter-owned layers double-buffer
 * the frame so the visible image NEVER swaps to undecoded pixels and never
 * changes objectFit/filter while visible (TIER_PRESENTATION is fixed per
 * tier). The old path's `fullPainted` flag, inline objectFit/filter flips,
 * and the scrub-time thumbUrl src special-case are all structurally gone:
 * the presenter's only-upgrade + scrub rules subsume them. Swap choreography
 * (cold/cached/scrub/zoom/error) is the plan's table, implemented here.
 *
 * The photo-frame wrapper, overlays, and feedback chip stay in App — this
 * component renders INSIDE the frame. (The legacy single-<img> path was
 * deleted once the dual-engine manual matrix passed on WKWebView + WebView2.)
 */
export const LoupeStage = memo(function LoupeStage({
  path,
  cur,
  scrubbing,
  isZooming,
  zoomZ,
  originX,
  originY,
  frameDims,
  shimmerDelayMs,
  hiRes,
  clippingVisible,
  hasImgRect,
  zoomNative,
  hiResTx,
  hiResTy,
  hiResScale,
  imgRef,
  onFrontFlip,
}: LoupeStageProps) {
  const { presenter, snap, elA, elB } = usePresent(imgRef, onFrontFlip);

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
        preview: cur.stage === "full" && cur.url ? cur.url : undefined,
        mid: cur.mid?.url,
      },
      scrubbing,
    );
  }, [path, cur.stage, cur.url, cur.mid?.url, scrubbing, presenter]);

  // Session lifecycle note: a folder change routes through the staged screen,
  // which unmounts this component — the next mount gets a FRESH presenter, so
  // no generation plumbing is needed here (revoked blob URLs die with it).

  const dimsKnown = !!(cur.dims && cur.dims.w > 1 && cur.dims.h > 1);
  const hiResSrc = cur.full?.url ?? (imageStore.isLegacyNav() ? cur.url : undefined);
  // True while the hi-res layer's pixels are actually decoded + in place
  // (HiResLayer reports both ways) — drives the zoom loading ring below.
  const [hiResReady, setHiResReady] = useState(false);
  // The layer mounts on settle (hiRes) OR the moment zoom engages — a zoom
  // before the settle timer fired must not wait out the timer to sharpen.
  // NEVER while dims are unknown: the frame is then the neutral-square
  // fallback, the base image letterboxes inside it, and this layer's
  // top-left-anchored transform (which assumes matte AR == image AR) would
  // paint a misaligned second copy over it.
  const hiResWanted = (hiRes || isZooming) && !clippingVisible && dimsKnown;

  return (
    <>
      {/* Sizer: in-flow transparent replaced element at the KNOWN display
          ratio — it alone sizes the matte (see the plan's integration
          contract); the presenter layers are absolute overlays. */}
      <img
        className="cull-photo-frame__sizer"
        src={sizerSrc(frameDims.w, frameDims.h)}
        alt=""
        aria-hidden
      />
      <PresentLayers
        snap={snap}
        elA={elA}
        elB={elB}
        className="cull-image"
        dimsKnown={dimsKnown}
        isZooming={isZooming}
        zoomZ={zoomZ}
        originX={originX}
        originY={originY}
      />
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
      {cur.stage === "thumb" && !scrubbing && (
        <div className="cull-photo-frame__spinner-wrap" aria-hidden>
          <div className="cull-loading__spinner" />
        </div>
      )}
      {/* Quiet error chip (choreography "Error" row): the thumb stays up and
          the failure is non-blocking. The shimmer-stage hard error panel
          lives in App (it replaces the whole frame). */}
      {cur.error && cur.stage === "thumb" && (
        <div className="cull-error-chip" title={cur.error}>
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
      {hiResWanted && hasImgRect && zoomNative && cur.stage === "full" && hiResSrc && (
        <HiResLayer
          key={path}
          url={hiResSrc}
          w={zoomNative.w}
          h={zoomNative.h}
          tx={hiResTx}
          ty={hiResTy}
          scale={hiResScale}
          className="cull-image cull-image--hires"
          onDecoded={setHiResReady}
        />
      )}
    </>
  );
});
