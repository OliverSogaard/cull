import { useEffect } from "react";
import { overlayService } from "../overlays/overlayService";
import type { Resolved } from "../image/stage";
import type { Img } from "../types";

type Stage = Resolved["stage"];

/**
 * Ensure `kind` overlay masks exist for the on-screen image(s) while the
 * overlay is enabled; toggling off drops the kind's cache + request-set in
 * the service (the overlays do not persist). One effect, invoked once per
 * mask kind from App — clipping (J) and peaking (P) are exact twins; the
 * histogram effect stays separate in App (single-view-only variant).
 *
 * Skipped mid-scrub: the overlays are hidden then, and computing a mask per
 * flown-past warm frame would churn the LRU + worker for nothing — the
 * release re-fires this via the scrubbing dep. The service bails per path
 * until its PREVIEW lands; the stage deps re-fire it then. (Mask/histogram
 * pixel work itself lives in overlayService/overlayCompute — worker-first
 * with an inline fallback, generation-guarded.)
 */
export function useOverlayKind(
  kind: "clip" | "peak",
  enabled: boolean,
  params: {
    scrubbing: boolean;
    compareMode: boolean;
    championIndex: number;
    challengerIndex: number;
    currentIndex: number;
    images: Img[];
    /** Stage of the LOUPE subscription — drives the compute-once-the-preview-
     *  lands retry (dep-only, never read in the body). */
    curStage: Stage;
    /** Stages of the COMPARE pair subscriptions; the off-mode subscription is
     *  pinned to "" (stable), so these deps are inert outside compare. */
    champStage: Stage;
    chalStage: Stage;
    /** Every async service commit bumps this, so ensure() re-touches the
     *  on-screen paths' LRU recency — see App's overlayVersion subscription. */
    overlayVersion: number;
  },
): void {
  const {
    scrubbing,
    compareMode,
    championIndex,
    challengerIndex,
    currentIndex,
    images,
    curStage,
    champStage,
    chalStage,
    overlayVersion,
  } = params;
  useEffect(() => {
    if (!enabled) {
      overlayService.clearKind(kind);
      return;
    }
    if (scrubbing) return;
    if (compareMode) {
      if (images[championIndex]) overlayService.ensure(kind, images[championIndex].path);
      if (images[challengerIndex]) overlayService.ensure(kind, images[challengerIndex].path);
    } else if (images[currentIndex]) {
      overlayService.ensure(kind, images[currentIndex].path);
    }
  }, [
    kind,
    enabled,
    scrubbing,
    compareMode,
    championIndex,
    challengerIndex,
    currentIndex,
    images,
    curStage,
    champStage,
    chalStage,
    overlayVersion,
  ]);
}
