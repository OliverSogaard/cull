import type { CSSProperties, MutableRefObject } from "react";
import { TIER_PRESENTATION } from "../../image/present";
import { zoomTransition } from "./zoomTransition";
import type { PresentSnapshot, PresentTier } from "../../image/present";

/**
 * The two presenter-owned <img> layers, shared by the loupe (LoupeStage) and
 * the compare panes. src is OWNED by the decoder (usePresent) — the elements
 * render src-less and React never touches it. Presentation is FIXED per tier
 * (TIER_PRESENTATION) so objectFit/filter can never change while a layer is
 * visible; the zoom transform applies to both layers so they stay coincident.
 */
export function PresentLayers({
  snap,
  elA,
  elB,
  className,
  dimsKnown,
  isZooming,
  zoomZ,
  originX,
  originY,
}: {
  snap: PresentSnapshot;
  elA: MutableRefObject<HTMLImageElement | null>;
  elB: MutableRefObject<HTMLImageElement | null>;
  className: string;
  /** Real display dims known for this path (drives the thumb cover/contain
   *  carve-out while the matte is still the neutral square). */
  dimsKnown: boolean;
  isZooming: boolean;
  zoomZ: number;
  originX: number;
  originY: number;
}) {
  const layerStyle = (layer: "A" | "B"): CSSProperties => {
    const st = snap.frontLayer === layer ? snap.front : snap.back;
    const isFront = snap.frontLayer === layer;
    const tier: PresentTier = st.tier ?? "thumb";
    const pres = TIER_PRESENTATION[tier];
    return {
      zIndex: isFront ? 2 : 1,
      objectFit: tier === "thumb" && !dimsKnown ? "contain" : pres.objectFit,
      filter: pres.filter,
      transform: isZooming ? `scale(${zoomZ})` : undefined,
      transformOrigin: `${originX}% ${originY}%`,
      transition: zoomTransition(isZooming),
      // The back layer stays visible beneath the front ONLY for the same
      // path (the blurred thumb under the preview crossfade). A different
      // path's leftovers must not peek through the front's letterbox.
      opacity: st.url ? (isFront || snap.back.path === snap.front.path ? 1 : 0) : 0,
    };
  };
  return (
    <>
      <img ref={elA} className={className} alt="" style={layerStyle("A")} />
      <img ref={elB} className={className} alt="" style={layerStyle("B")} />
    </>
  );
}
