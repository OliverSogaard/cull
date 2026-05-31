import { memo, useLayoutEffect, useRef, useState } from "react";
import type { Feedback, Img, ImageMetadata, PreviewEntry, Rating } from "../types";
import { stripExt } from "../utils/path";
import { ExifPanel } from "./ExifPanel";
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
  histograms,
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
  histograms: Record<string, string>;
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
      <div className="cull-cmp__panels">
        <ComparePanel
          role="champion"
          img={champion}
          previewUrl={previewUrlOf(previews, champion.path)}
          thumbUrl={thumbnails[champion.path]}
          metadata={metadata[champion.path]}
          rating={ratings[champion.id]}
          isZooming={isZooming}
          zoomLevel={zoomLevel}
          originX={originX}
          originY={originY}
          exifVisible={exifVisible}
          clippingVisible={clippingVisible}
          clipMaskUrl={clipMasks[champion.path]}
          peakingVisible={peakingVisible}
          peakingMaskUrl={peakingMasks[champion.path]}
          compositionVisible={compositionVisible}
          histogramUrl={histograms[champion.path]}
          suppressRating={!!(feedback && feedback.imageId === champion.id)}
          scrubbing={false}
        />
        <ComparePanel
          role="challenger"
          img={challenger}
          previewUrl={previewUrlOf(previews, challenger.path)}
          thumbUrl={thumbnails[challenger.path]}
          metadata={metadata[challenger.path]}
          rating={ratings[challenger.id]}
          isZooming={isZooming}
          zoomLevel={zoomLevel}
          originX={originX}
          originY={originY}
          exifVisible={exifVisible}
          clippingVisible={clippingVisible}
          clipMaskUrl={clipMasks[challenger.path]}
          peakingVisible={peakingVisible}
          peakingMaskUrl={peakingMasks[challenger.path]}
          compositionVisible={compositionVisible}
          histogramUrl={histograms[challenger.path]}
          suppressRating={!!(feedback && feedback.imageId === challenger.id)}
          scrubbing={scrubbing}
        />
      </div>
    </div>
  );
}

const ComparePanel = memo(function ComparePanel({
  role,
  img,
  previewUrl,
  thumbUrl,
  metadata,
  rating,
  isZooming,
  zoomLevel,
  originX,
  originY,
  exifVisible,
  clippingVisible,
  clipMaskUrl,
  peakingVisible,
  peakingMaskUrl,
  compositionVisible,
  histogramUrl,
  suppressRating,
  scrubbing,
}: {
  role: "champion" | "challenger";
  img: Img;
  previewUrl: string | undefined;
  thumbUrl: string | undefined;
  metadata: ImageMetadata | undefined;
  rating: Rating | undefined;
  isZooming: boolean;
  zoomLevel: 1 | 2;
  /** Shared with the other pane (the champion's AF + the global pan offset). */
  originX: number;
  originY: number;
  exifVisible: boolean;
  clippingVisible: boolean;
  clipMaskUrl: string | undefined;
  peakingVisible: boolean;
  peakingMaskUrl: string | undefined;
  compositionVisible: boolean;
  histogramUrl: string | undefined;
  suppressRating: boolean;
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
      {previewUrl && !scrubbing ? (
        <img
          ref={imgRef}
          className="cull-cmp-img"
          src={previewUrl}
          alt=""
          onLoad={(e) => {
            setNonce((n) => n + 1);
            setNaturalSize({
              w: e.currentTarget.naturalWidth,
              h: e.currentTarget.naturalHeight,
            });
          }}
          style={{
            transform: isZooming ? `scale(${zoomZ})` : undefined,
            transformOrigin: `${originX}% ${originY}%`,
            transition: "transform 200ms ease-out",
          }}
        />
      ) : (
        // Scrub OR not-yet-loaded: heavy-blurred thumbnail (same look as
        // single view). Spinner only once settled (not scrubbing) and still
        // loading — so the challenger matches the loupe loading standard.
        <div className="cull-loading">
          {thumbUrl && <img className="cull-loading__blur" src={thumbUrl} alt="" aria-hidden />}
          {!scrubbing && <div className="cull-loading__spinner" />}
        </div>
      )}

      {clippingVisible && !scrubbing && clipMaskUrl && rect && (
        <img
          className="cull-clip-overlay"
          src={clipMaskUrl}
          alt=""
          style={{
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
            transform: isZooming ? `scale(${zoomZ})` : undefined,
            transformOrigin: `${originX}% ${originY}%`,
            transition: "transform 200ms ease-out",
          }}
        />
      )}

      {peakingVisible && !scrubbing && peakingMaskUrl && rect && (
        <img
          className="cull-peaking-overlay"
          src={peakingMaskUrl}
          alt=""
          style={{
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
            transform: isZooming ? `scale(${zoomZ})` : undefined,
            transformOrigin: `${originX}% ${originY}%`,
            transition: "transform 200ms ease-out",
            pointerEvents: "none",
          }}
        />
      )}

      {compositionVisible && !isZooming && rect && (
        <svg
          className="cull-composition-overlay"
          style={{
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
          }}
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

      {exifVisible && (
        <ExifPanel filename={img.filename} metadata={metadata} histogramUrl={histogramUrl} />
      )}

      {rating && !suppressRating && (
        <div className="cull-cmp-dot">
          <RatingDot rating={rating} size="md" />
        </div>
      )}

      <div
        className={`cull-cmp-label ${isChampion ? "is-champion" : "is-challenger"}`}
      >
        {isChampion ? "CHAMPION" : "CHALLENGER"} · {stripExt(img.filename)}
      </div>

      {/* Inset border frame, painted above the image — never clipped (see CSS). */}
      <div className="cull-cmp-frame" aria-hidden />
    </div>
  );
});
