import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { shimmerPhaseMs } from "../utils/shimmer";
import type { Feedback, Img, ImageMetadata, Rating } from "../types";
import { CompareExifRail } from "./ExifRail";
import { RatingDot } from "./RatingDot";
import { useImage } from "../image/useImage";

/**
 * Compare mode: champion (left, green) vs challenger (right, amber).
 *
 * Both panels share a SYNCED zoom origin — the champion's AF point, shifted by
 * the shared pan offset — so zoom + pan always compares the identical region
 * of the frame. Each panel computes its own 1:1 scale from `naturalSize /
 * rect.width`, so 1:1 means "one image pixel per screen pixel" even though the
 * two panels may be different sizes.
 */
/** Transparent inline-SVG sizer (see App.tsx): carries an aspect ratio via its
 *  intrinsic width/height so the matte is sized by the known ratio, not pixels. */
const sizerSrc = (w: number, h: number) =>
  `data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='${w}'%20height='${h}'%2F%3E`;

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

  const afX = metadata[champion.path]?.afXPct ?? 50;
  const afY = metadata[champion.path]?.afYPct ?? 50;
  const originX = Math.max(0, Math.min(100, afX + panOffset.x));
  const originY = Math.max(0, Math.min(100, afY + panOffset.y));

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
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  // Full-res blob URL that has actually decoded — keeps the low-res blurred
  // until the full has PAINTED, so it never flashes sharp first (see App.tsx).
  const [paintedFullUrl, setPaintedFullUrl] = useState<string | null>(null);
  const isChampion = role === "champion";
  // Shimmer phase pinned per image so this pane's shimmer syncs with the others.
  const shimmerDelay = useMemo(() => shimmerPhaseMs(), [path]);
  // Reset measured size when the pane's image changes (challenger scroll), so a
  // fresh image's shimmer never inherits the previous one's aspect (neutral
  // square until its dims are known).
  useEffect(() => {
    setNaturalSize(null);
  }, [path]);

  // This panel owns the full-res request for its image (the loupe's `wantFull`
  // is owned by App). The intermediate thumb stage shows first; the full lands
  // on top. Source/dims come from the store via useImage now.
  //
  // Gate the full-res request on `!scrubbing` exactly as the loupe does
  // (App.tsx): while the challenger is scrubbing we fly past frames we never
  // settle on, so requesting each one's full-res would fire a heavy NAS bundle
  // read + 32 MP decode per step — periodic main-thread stalls that stutter the
  // strip, made worse on direction reversal when evicted fulls get re-fetched.
  // The champion passes `scrubbing={false}`, so it keeps its full as the fixed
  // reference; the challenger's full lands the instant the scrub settles.
  const img = useImage(path, { wantFull: !scrubbing });
  // Show the full preview only once it's ready AND we're not scrubbing past it.
  const showFull = img.stage === "full" && !scrubbing;
  const fullPainted = showFull && paintedFullUrl === img.url;
  const displaySrc = showFull ? img.url : img.stage !== "shimmer" ? img.url : undefined;

  // Frame aspect ratio: prefer the orientation-correct THMB display dims (known
  // as soon as the thumb lands) over the frozen full-preview naturalSize.
  const frameDims =
    img.dims && img.dims.w > 1 && img.dims.h > 1
      ? img.dims
      // Large square so the sizer clamps DOWN to fill the pane (see App.tsx).
      : (naturalSize ?? { w: 10000, h: 10000 });
  const photoAr = `${frameDims.w} / ${frameDims.h}`;

  useLayoutEffect(() => {
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
    measure();
    // Observe the panel so overlays re-align on any size change — window
    // resize AND the panels growing when the candidate strip toggles.
    const ro = new ResizeObserver(measure);
    if (panelRef.current) ro.observe(panelRef.current);
    return () => ro.disconnect();
    // img.stage/img.dims: the sizer reflows the frame when dims arrive; the RO
    // is on the panel (which doesn't resize when the inner frame does).
  }, [displaySrc, nonce, img.stage, img.dims]);

  const oneToOneScale = naturalSize && rect ? naturalSize.w / rect.width : 5;
  const zoomZ = isZooming ? zoomLevel * oneToOneScale : 1;

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
            same pattern. While the full preview loads, the <img> falls back
            to the thumbnail so the matte never goes blank. While scrubbing,
            we show the thumbnail without the spinner overlay. */}
        {displaySrc ? (
          <img
            ref={imgRef}
            className="cull-cmp-img"
            src={displaySrc}
            alt=""
            onLoad={(e) => {
              // Only the FULL preview sets naturalSize (drives the 1:1 zoom math);
              // the thumb fallback must not, or the matte/zoom would shrink to it.
              if (showFull) {
                setNonce((n) => n + 1);
                setNaturalSize({
                  w: e.currentTarget.naturalWidth,
                  h: e.currentTarget.naturalHeight,
                });
                setPaintedFullUrl(img.url ?? null);
              }
            }}
            style={{
              transform: isZooming ? `scale(${zoomZ})` : undefined,
              transformOrigin: `${originX}% ${originY}%`,
              transition: "transform 200ms ease-out, filter 200ms ease-out",
              // cover for the low-res (THMB ~4:3 would letterbox smaller under
              // contain); contain for the full. Blur until the full has PAINTED.
              objectFit: fullPainted ? "contain" : "cover",
              filter: fullPainted ? undefined : "blur(14px) brightness(0.78)",
            }}
          />
        ) : null}
        {img.stage === "shimmer" && (
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

        {compositionVisible && !isZooming && (
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
            <RatingDot rating={rating} size="md" />
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
