import { memo, useLayoutEffect, useRef, useState } from "react";
import type { Feedback, Img, ImageMetadata, PreviewEntry, Rating } from "../types";
import { CompareExifRail } from "./ExifRail";
import { RatingDot } from "./RatingDot";

/** Read `previewUrl` from a path's pool entry, or `undefined` if not ready. */
function previewUrlOf(
  previews: Record<string, PreviewEntry>,
  path: string,
): string | undefined {
  const e = previews[path];
  return e?.status === "ready" ? e.url : undefined;
}

/**
 * Compare mode: champion (left, green) vs challenger (right, amber).
 *
 * Both panels share a SYNCED zoom origin — the champion's AF point, shifted by
 * the shared pan offset — so zoom + pan always compares the identical region
 * of the frame. Each panel computes its own 1:1 scale from `naturalSize /
 * rect.width`, so 1:1 means "one image pixel per screen pixel" even though the
 * two panels may be different sizes.
 */
export function CompareView({
  images,
  championIndex,
  challengerIndex,
  previews,
  metadata,
  clipMasks,
  peakingMasks,
  thumbnails,
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
  previews: Record<string, PreviewEntry>;
  metadata: Record<string, ImageMetadata>;
  clipMasks: Record<string, string>;
  peakingMasks: Record<string, string>;
  thumbnails: Record<string, string>;
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
            previewUrl={previewUrlOf(previews, champion.path)}
            thumbUrl={thumbnails[champion.path]}
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
            previewUrl={previewUrlOf(previews, challenger.path)}
            thumbUrl={thumbnails[challenger.path]}
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
  previewUrl,
  thumbUrl,
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
  previewUrl: string | undefined;
  thumbUrl: string | undefined;
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
  const isChampion = role === "champion";
  const photoAr = naturalSize
    ? `${naturalSize.w} / ${naturalSize.h}`
    : undefined;

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
  }, [previewUrl, nonce]);

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
        style={
          photoAr
            ? ({ ["--photo-ar" as string]: photoAr } as React.CSSProperties)
            : undefined
        }
      >
        {/* Photo-frame stays mounted across transitions — see App.tsx for the
            same pattern. While the full preview loads, the <img> falls back
            to the thumbnail so the matte never goes blank. While scrubbing,
            we show the thumbnail without the spinner overlay. */}
        {(previewUrl && !scrubbing) || thumbUrl ? (
          <img
            ref={imgRef}
            className="cull-cmp-img"
            src={previewUrl && !scrubbing ? previewUrl : thumbUrl!}
            alt=""
            onLoad={(e) => {
              if (previewUrl && !scrubbing) {
                setNonce((n) => n + 1);
                setNaturalSize({
                  w: e.currentTarget.naturalWidth,
                  h: e.currentTarget.naturalHeight,
                });
              }
            }}
            style={{
              transform: isZooming ? `scale(${zoomZ})` : undefined,
              transformOrigin: `${originX}% ${originY}%`,
              transition: "transform 200ms ease-out",
              filter:
                previewUrl && !scrubbing
                  ? undefined
                  : "blur(14px) brightness(0.78)",
            }}
          />
        ) : null}
        {!previewUrl && !scrubbing && (
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
