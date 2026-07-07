import { memo, useEffect, useRef } from "react";
import type { Feedback, Img, ImageMetadata, Rating } from "../types";
import { CompareExifRail } from "./ExifRail";
import type { Suggestion } from "../smart/deriveVerdict";
import { RatingDot } from "./RatingDot";
import { useImage } from "../image/useImage";
import { imageStore } from "../image/imageStore";
import { afZoomOrigin } from "../utils/zoom";
import { PhotoPane } from "./pane/PhotoPane";

/**
 * Compare mode: champion (left, green) vs challenger (right, amber).
 *
 * Both panels share a SYNCED zoom origin — the champion's AF point, shifted by
 * the shared pan offset — so zoom + pan always compares the identical region
 * of the frame. Each panel's PhotoPane computes its own 1:1 scale from its
 * native sensor dims over its measured rect, so 1:1 means "one image pixel
 * per screen pixel" even though the two panels may be different sizes.
 */

export function CompareView({
  images,
  championIndex,
  challengerIndex,
  metadata,
  championClipMask,
  challengerClipMask,
  championPeakingMask,
  challengerPeakingMask,
  ratings,
  exifVisible,
  clippingVisible,
  peakingVisible,
  compositionVisible,
  isZooming,
  zoomGlide,
  zoomLevel,
  panOffset,
  feedback,
  scrubbing,
  fullSettleMs,
  settleResetKey,
  championSuggestion,
  challengerSuggestion,
}: {
  images: Img[];
  championIndex: number;
  challengerIndex: number;
  metadata: Record<string, ImageMetadata>;
  /** Resolved per-pane mask data URLs (App reads them from overlayService —
   *  Phase 6 — so this component stays dumb about the overlay cache). */
  championClipMask: string | undefined;
  challengerClipMask: string | undefined;
  championPeakingMask: string | undefined;
  challengerPeakingMask: string | undefined;
  ratings: Record<number, Rating>;
  exifVisible: boolean;
  clippingVisible: boolean;
  peakingVisible: boolean;
  compositionVisible: boolean;
  isZooming: boolean;
  /** Shared zoom transform transition from App (zoomGlide) — "none" during
   *  a carried-zoom decide swap. */
  zoomGlide: string;
  zoomLevel: 1 | 2;
  panOffset: { x: number; y: number };
  feedback: Feedback | null;
  scrubbing: boolean;
  /** PhotoPane's hi-res settle delay (profile.fullSettleMs). */
  fullSettleMs: number;
  /** Changes when stage-resizing chrome toggles — see PhotoPane. */
  settleResetKey?: unknown;
  /** Per-side smart suggestions (unrated only) for the rail's top section. */
  championSuggestion?: Suggestion | null;
  challengerSuggestion?: Suggestion | null;
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
            zoomGlide={zoomGlide}
            zoomLevel={zoomLevel}
            originX={originX}
            originY={originY}
            clipMaskUrl={clippingVisible ? championClipMask : undefined}
            peakingMaskUrl={peakingVisible ? championPeakingMask : undefined}
            compositionVisible={compositionVisible}
            suppressRating={!!(feedback && feedback.imageId === champion.id)}
            flashRating={feedback && feedback.imageId === champion.id ? feedback.rating : null}
            scrubbing={false}
            fullSettleMs={fullSettleMs}
            settleResetKey={settleResetKey}
          />
          <ComparePanel
            role="challenger"
            path={challenger.path}
            rating={ratings[challenger.id]}
            isZooming={isZooming}
            zoomGlide={zoomGlide}
            zoomLevel={zoomLevel}
            originX={originX}
            originY={originY}
            clipMaskUrl={clippingVisible ? challengerClipMask : undefined}
            peakingMaskUrl={peakingVisible ? challengerPeakingMask : undefined}
            compositionVisible={compositionVisible}
            suppressRating={!!(feedback && feedback.imageId === challenger.id)}
            flashRating={feedback && feedback.imageId === challenger.id ? feedback.rating : null}
            scrubbing={scrubbing}
            fullSettleMs={fullSettleMs}
            settleResetKey={settleResetKey}
          />
        </div>
        {exifVisible && (
          <CompareExifRail
            championName={champion.filename}
            challengerName={challenger.filename}
            championMeta={metadata[champion.path]}
            challengerMeta={metadata[challenger.path]}
            championSuggestion={championSuggestion}
            challengerSuggestion={challengerSuggestion}
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
  zoomGlide,
  zoomLevel,
  originX,
  originY,
  clipMaskUrl,
  peakingMaskUrl,
  compositionVisible,
  suppressRating,
  flashRating,
  scrubbing,
  fullSettleMs,
  settleResetKey,
}: {
  role: "champion" | "challenger";
  path: string;
  rating: Rating | undefined;
  isZooming: boolean;
  /** Shared zoom transform transition from App (zoomGlide) — "none" during
   *  a carried-zoom decide swap. */
  zoomGlide: string;
  zoomLevel: 1 | 2;
  /** Shared with the other pane (the champion's AF + the global pan offset). */
  originX: number;
  originY: number;
  clipMaskUrl: string | undefined;
  peakingMaskUrl: string | undefined;
  compositionVisible: boolean;
  suppressRating: boolean;
  /** When set, this rating's color pulses briefly over the photo (verdict flash). */
  flashRating: Rating | null;
  scrubbing: boolean;
  fullSettleMs: number;
  settleResetKey?: unknown;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const isChampion = role === "champion";

  // This panel owns the full-res request for its image (the loupe's `wantFull`
  // is owned by App). Gated on `!scrubbing` exactly as the loupe: a challenger
  // scrub flies past frames we never settle on; fetching each would stutter.
  // The champion passes `scrubbing={false}`, so it keeps its preview as the
  // fixed reference; the challenger's lands the instant the scrub settles.
  const img = useImage(path, { wantFull: !scrubbing });

  // Compare zoom fetches fulls for BOTH panes the moment zoom engages (App's
  // compare-session pins already protect them from eviction): the pane's
  // settle timer also fetches, but a zoom engaged BEFORE the settle must not
  // wait it out. Preview-upscale until decode; requestZoomFull is idempotent.
  useEffect(() => {
    if (isZooming && path) imageStore.requestZoomFull(path);
  }, [isZooming, path]);

  return (
    <div
      className={`cull-cmp-panel ${isChampion ? "is-champion" : "is-challenger"}`}
      ref={panelRef}
    >
      {/* The unified pane (PhotoPane): frame + sizer, the decode-gated
          presenter double-buffer, shimmer/spinner/error, the settle-gated
          post-decode zoom layer (the loupe's mount policy — this is what
          makes the hi-res reveal GLIDE instead of snapping at decode), and
          the mask/thirds overlays. */}
      <PhotoPane
        variant="compare"
        path={path}
        img={img}
        scrubbing={scrubbing}
        isZooming={isZooming}
        zoomGlide={zoomGlide}
        zoomLevel={zoomLevel}
        originX={originX}
        originY={originY}
        fullSettleMs={fullSettleMs}
        settleResetKey={settleResetKey}
        flashRating={flashRating}
        clipMaskUrl={clipMaskUrl}
        peakingMaskUrl={peakingMaskUrl}
        showComposition={compositionVisible}
        measureContainerRef={panelRef}
      >
        {rating && !suppressRating && (
          <div className="cull-cmp-dot">
            <RatingDot rating={rating} />
          </div>
        )}
      </PhotoPane>

      {/* Role chip centered below the photo — champagne filled for champion,
          hollow for challenger. Just the role name; the filename is in the
          status bar / EXIF rail, no need to repeat it here. */}
      <div className={`cull-cmp-label ${isChampion ? "is-champion" : "is-challenger"}`}>
        {isChampion ? "Champion" : "Challenger"}
      </div>
    </div>
  );
});
