import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { shimmerPhaseMs } from "../utils/shimmer";
import type { Feedback, Img, ImageMetadata, Rating } from "../types";
import { CompareExifRail } from "./ExifRail";
import { RatingDot } from "./RatingDot";
import { useImage } from "../image/useImage";
import { imageStore } from "../image/imageStore";
import { offerTiers } from "../image/present";
import { afZoomOrigin } from "../utils/zoom";
import { sizerSrc } from "../utils/sizer";
import { HiResLayer } from "./loupe/HiResLayer";
import { PresentLayers } from "./loupe/PresentLayers";
import { usePresent } from "../image/usePresent";

/**
 * Compare mode: champion (left, green) vs challenger (right, amber).
 *
 * Both panels share a SYNCED zoom origin — the champion's AF point, shifted by
 * the shared pan offset — so zoom + pan always compares the identical region
 * of the frame. Each panel computes its own 1:1 scale from its native sensor
 * dims over its measured rect, so 1:1 means "one image pixel per screen
 * pixel" even though the two panels may be different sizes.
 */

export function CompareView({
  images,
  championIndex,
  challengerIndex,
  metadata,
  clipMasks,
  peakingMasks,
  ratings,
  exifVisible,
  clippingVisible,
  peakingVisible,
  compositionVisible,
  isZooming,
  zoomLevel,
  panOffset,
  feedback,
  scrubbing,
}: {
  images: Img[];
  championIndex: number;
  challengerIndex: number;
  metadata: Record<string, ImageMetadata>;
  clipMasks: Record<string, string>;
  peakingMasks: Record<string, string>;
  ratings: Record<number, Rating>;
  exifVisible: boolean;
  clippingVisible: boolean;
  peakingVisible: boolean;
  compositionVisible: boolean;
  isZooming: boolean;
  zoomLevel: 1 | 2;
  panOffset: { x: number; y: number };
  feedback: Feedback | null;
  scrubbing: boolean;
}) {
  const champion = images[championIndex];
  const challenger = images[challengerIndex];
  if (!champion || !challenger) return null;

  const { x: originX, y: originY } = afZoomOrigin(metadata[champion.path], panOffset);

  return (
    <div className="cull-cmp">
      <div className="cull-cmp-body">
        <div className="cull-cmp__panels">
          <ComparePanel
            role="champion"
            path={champion.path}
            rating={ratings[champion.id]}
            isZooming={isZooming}
            zoomLevel={zoomLevel}
            originX={originX}
            originY={originY}
            clippingVisible={clippingVisible}
            clipMaskUrl={clipMasks[champion.path]}
            peakingVisible={peakingVisible}
            peakingMaskUrl={peakingMasks[champion.path]}
            compositionVisible={compositionVisible}
            suppressRating={!!(feedback && feedback.imageId === champion.id)}
            flashRating={
              feedback && feedback.imageId === champion.id ? feedback.rating : null
            }
            scrubbing={false}
          />
          <ComparePanel
            role="challenger"
            path={challenger.path}
            rating={ratings[challenger.id]}
            isZooming={isZooming}
            zoomLevel={zoomLevel}
            originX={originX}
            originY={originY}
            clippingVisible={clippingVisible}
            clipMaskUrl={clipMasks[challenger.path]}
            peakingVisible={peakingVisible}
            peakingMaskUrl={peakingMasks[challenger.path]}
            compositionVisible={compositionVisible}
            suppressRating={!!(feedback && feedback.imageId === challenger.id)}
            flashRating={
              feedback && feedback.imageId === challenger.id ? feedback.rating : null
            }
            scrubbing={scrubbing}
          />
        </div>
        {exifVisible && (
          <CompareExifRail
            championName={champion.filename}
            challengerName={challenger.filename}
            championMeta={metadata[champion.path]}
            challengerMeta={metadata[challenger.path]}
            championRating={ratings[champion.id]}
            challengerRating={ratings[challenger.id]}
          />
        )}
      </div>
    </div>
  );
}

const ComparePanel = memo(function ComparePanel({
  role,
  path,
  rating,
  isZooming,
  zoomLevel,
  originX,
  originY,
  clippingVisible,
  clipMaskUrl,
  peakingVisible,
  peakingMaskUrl,
  compositionVisible,
  suppressRating,
  flashRating,
  scrubbing,
}: {
  role: "champion" | "challenger";
  path: string;
  rating: Rating | undefined;
  isZooming: boolean;
  zoomLevel: 1 | 2;
  /** Shared with the other pane (the champion's AF + the global pan offset). */
  originX: number;
  originY: number;
  clippingVisible: boolean;
  clipMaskUrl: string | undefined;
  peakingVisible: boolean;
  peakingMaskUrl: string | undefined;
  compositionVisible: boolean;
  suppressRating: boolean;
  /** When set, this rating's color pulses briefly over the photo (verdict flash). */
  flashRating: Rating | null;
  scrubbing: boolean;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [rect, setRect] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const [nonce, setNonce] = useState(0);
  // True when the measure effect last ran with zoom engaged — the next
  // unzoomed run delays past the 200ms transform transition (see App.tsx).
  const wasZoomingRef = useRef(false);
  const isChampion = role === "champion";
  // Shimmer phase pinned per image so this pane's shimmer syncs with the others.
  const shimmerDelay = useMemo(() => shimmerPhaseMs(), [path]);

  // This panel owns the full-res request for its image (the loupe's `wantFull`
  // is owned by App). Gated on `!scrubbing` exactly as the loupe: a challenger
  // scrub flies past frames we never settle on; fetching each would stutter.
  // The champion passes `scrubbing={false}`, so it keeps its preview as the
  // fixed reference; the challenger's lands the instant the scrub settles.
  const img = useImage(path, { wantFull: !scrubbing });

  // Phase 4: each pane is its own presenter consumer — the same decode-gated
  // double-buffer as the loupe (warm scrub steps show SHARP, cold ones keep
  // the blurred thumb, nothing ever swaps to undecoded pixels). This replaced
  // the old displaySrc/fullPainted/paintedFullUrl machinery wholesale.
  const { presenter, snap, elA, elB } = usePresent(imgRef, () => setNonce((n) => n + 1));
  useEffect(() => {
    if (path) presenter.nav(path);
  }, [path, presenter]);
  useEffect(() => {
    presenter.setScrubbing(scrubbing);
  }, [scrubbing, presenter]);
  useEffect(() => {
    if (!path) return;
    // offerTiers sequences the tiers mid-scrub (preview's frame budget, then
    // the blurred-thumb fallback) — fire-and-forgetting both let the preview
    // clobber the thumb decode and then lose its race, stalling the pane for
    // several challenger steps (the WebView2 matrix finding).
    void offerTiers(
      presenter,
      path,
      {
        thumb: imageStore.thumbUrl(path),
        preview: img.stage === "full" && img.url ? img.url : undefined,
      },
      scrubbing,
    );
  }, [path, img.stage, img.url, scrubbing, presenter]);

  // Frame aspect ratio: the orientation-correct display dims (known as soon
  // as the thumb lands; the store's dims cache keeps them across eviction).
  const frameDims =
    img.dims && img.dims.w > 1 && img.dims.h > 1
      ? img.dims
      // Large square so the sizer clamps DOWN to fill the pane (see App.tsx).
      : { w: 10000, h: 10000 };
  const photoAr = `${frameDims.w} / ${frameDims.h}`;

  useLayoutEffect(() => {
    // Mirror the loupe's measure discipline exactly:
    // - never mid-scrub (warm scrub steps flip the presenter twice; measuring
    //   per flip forces two synchronous layouts per step — the cost that made
    //   compare scrub drag behind the loupe). Release re-measures.
    // - never while zoomed (getBoundingClientRect returns the SCALED box).
    // - after an unzoom, wait out the 200ms transform transition.
    if (scrubbing) return;
    if (isZooming) {
      wasZoomingRef.current = true;
      return;
    }
    const justUnzoomed = wasZoomingRef.current;
    wasZoomingRef.current = false;
    const measure = () => {
      const im = imgRef.current;
      const p = panelRef.current;
      if (!im || !p) {
        setRect(null);
        return;
      }
      const ir = im.getBoundingClientRect();
      const pr = p.getBoundingClientRect();
      if (ir.width < 1) {
        setRect(null);
        return;
      }
      setRect({
        left: ir.left - pr.left,
        top: ir.top - pr.top,
        width: ir.width,
        height: ir.height,
      });
    };
    // Observe the panel so overlays re-align on any size change — window
    // resize AND the panels growing when the candidate strip toggles.
    const ro = new ResizeObserver(measure);
    let armTimer: number | null = null;
    const arm = () => {
      measure();
      if (panelRef.current) ro.observe(panelRef.current);
    };
    if (justUnzoomed) armTimer = window.setTimeout(arm, 260);
    else arm();
    return () => {
      ro.disconnect();
      if (armTimer !== null) clearTimeout(armTimer);
    };
    // img.stage/img.dims: the sizer reflows the frame when dims arrive; the RO
    // is on the panel (which doesn't resize when the inner frame does).
  }, [snap.front.url, nonce, img.stage, img.dims, isZooming, scrubbing]);

  // Native dims of the ZOOM raster (the displayed pane image is the 1620px
  // preview since Phase 3, so measured element sizes must not drive 1:1).
  // Same preference order as the loupe: zoom-tier meta dims → the thumb's
  // sensor display dims.
  const zoomNativeDims =
    img.full?.dims ??
    (img.dims && img.dims.w > 1 && img.dims.h > 1 ? img.dims : undefined);
  const oneToOneScale = zoomNativeDims && rect ? zoomNativeDims.w / rect.width : 5;
  const zoomZ = isZooming ? zoomLevel * oneToOneScale : 1;

  // Compare zoom fetches + pins fulls for BOTH panes (plan choreography):
  // App's compare-session pins already protect them from eviction; this
  // kicks the fetch the moment zoom engages. Preview-upscale until decode.
  useEffect(() => {
    if (isZooming && path) imageStore.requestZoomFull(path);
  }, [isZooming, path]);

  // True while the pane's hi-res pixels are decoded + in place — drives the
  // pane's zoom loading ring (mirrors the loupe).
  const [hiResReady, setHiResReady] = useState(false);
  // Per-pane decode-gated hi-res transform (mirrors the loupe's derivation:
  // rect is the displayed image's box, the layer reproduces scale(Z) about
  // the synced origin starting from the native-pixel-size element).
  const cmpHiResTx = rect ? (originX / 100) * rect.width * (1 - zoomZ) : 0;
  const cmpHiResTy = rect ? (originY / 100) * rect.height * (1 - zoomZ) : 0;
  const cmpHiResScale = rect && zoomNativeDims ? (rect.width / zoomNativeDims.w) * zoomZ : 1;

  return (
    <div
      className={`cull-cmp-panel ${isChampion ? "is-champion" : "is-challenger"}`}
      ref={panelRef}
    >
      <div
        className={`cull-cmp-photo-frame${
          flashRating
            ? ` cull-photo-frame--flash-${
                flashRating === "favorite" ? "fav" : flashRating
              }`
            : ""
        }`}
        style={{ ["--photo-ar" as string]: photoAr } as React.CSSProperties}
      >
        {/* Sizer: in-flow transparent replaced element at the KNOWN display
            ratio (frameDims) — it alone sizes the matte, so the frame never
            shrinks to the THMB pixels or collapses while the full decodes. The
            pixels below are an absolute overlay of the content box. */}
        <img
          className="cull-cmp-photo-frame__sizer"
          src={sizerSrc(frameDims.w, frameDims.h)}
          alt=""
          aria-hidden
        />
        {/* Photo-frame stays mounted across transitions — see App.tsx for the
            same pattern. The presenter's double-buffer means the pane never
            goes blank and never swaps to undecoded pixels. */}
        <PresentLayers
          snap={snap}
          elA={elA}
          elB={elB}
          className="cull-cmp-img"
          dimsKnown={!!(img.dims && img.dims.w > 1 && img.dims.h > 1)}
          isZooming={isZooming}
          zoomZ={zoomZ}
          originX={originX}
          originY={originY}
        />
        {/* Decode-gated zoom layer (Phase 4): the 32 MP zoom-tier blob at
            native size, only while compare zoom is engaged and only once
            decoded — until then the preview upscales beneath. */}
        {isZooming && rect && zoomNativeDims && img.full?.url && (
          <HiResLayer
            key={path}
            url={img.full.url}
            w={zoomNativeDims.w}
            h={zoomNativeDims.h}
            tx={cmpHiResTx}
            ty={cmpHiResTy}
            scale={cmpHiResScale}
            className="cull-cmp-img cull-image--hires"
            onDecoded={setHiResReady}
          />
        )}
        {/* Zoom loading ring (see the loupe): zoomed but the sharp raster
            isn't in place yet. The 150ms reveal delay avoids cached flashes. */}
        {isZooming && !hiResReady && (
          <div className="cull-photo-frame__spinner-wrap" aria-hidden>
            <div className="cull-loading__spinner" />
          </div>
        )}
        {!snap.front.url && (
          <div
            className="cull-photo-frame__shimmer"
            aria-hidden
            style={{ ["--shimmer-delay" as string]: `-${shimmerDelay}ms` }}
          />
        )}
        {/* Spinner only while the full is still loading (thumb stage); once the
            store has the full, skip it so a cached full doesn't flash the
            spinner for ~0.1s before paint. Mirrors the loupe (App.tsx). */}
        {img.stage === "thumb" && !scrubbing && (
          <div className="cull-photo-frame__spinner-wrap" aria-hidden>
            <div className="cull-loading__spinner" />
          </div>
        )}

        {/* Overlays — positioning + sizing comes from the CSS rule
            (`position: absolute !important; inset: 14px`), NOT inline
            style. That keeps them out of flow no matter what, so they
            cannot influence the photo-frame's intrinsic size when toggled. */}
        {clippingVisible && !scrubbing && clipMaskUrl && (
          <img
            className="cull-clip-overlay"
            src={clipMaskUrl}
            alt=""
            style={{
              transform: isZooming ? `scale(${zoomZ})` : undefined,
              transformOrigin: `${originX}% ${originY}%`,
              transition: "transform 200ms ease-out",
            }}
          />
        )}

        {peakingVisible && !scrubbing && peakingMaskUrl && (
          <img
            className="cull-peaking-overlay"
            src={peakingMaskUrl}
            alt=""
            style={{
              transform: isZooming ? `scale(${zoomZ})` : undefined,
              transformOrigin: `${originX}% ${originY}%`,
              transition: "transform 200ms ease-out",
            }}
          />
        )}

        {/* Hidden mid-scrub like its clipping/peaking siblings (and the
            loupe's grid): over the scrub's blurred thumbs and unknown-dims
            mattes the grid floats wrongly placed — the WebView2 matrix
            caught the missing gate here. */}
        {compositionVisible && !isZooming && !scrubbing && (
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

        {rating && !suppressRating && (
          <div className="cull-cmp-dot">
            <RatingDot rating={rating} />
          </div>
        )}
      </div>

      {/* Role chip centered below the photo — champagne filled for champion,
          hollow for challenger. Just the role name; the filename is in the
          status bar / EXIF rail, no need to repeat it here. */}
      <div
        className={`cull-cmp-label ${isChampion ? "is-champion" : "is-challenger"}`}
      >
        {isChampion ? "Champion" : "Challenger"}
      </div>
    </div>
  );
});
