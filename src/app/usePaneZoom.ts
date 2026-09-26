import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { Img, ImageMetadata } from "../types";
import type { PaneRect } from "../components/pane/paneGeometry";
import { imageStore } from "../image/imageStore";
import { zoomOriginMeta } from "../utils/zoom";

const PAN_LIMIT = 40; // max % offset from the AF point

/**
 * Zoom choreography, verbatim from App (grand cleanup Phase 7): the hold-based
 * Space/mouse zoom state, keyboard pan, the carried-advance one-shot flag, the
 * zoomSwapInstant two-rAF reset, the index-change zoom reset/carry, and the
 * cursor-anchored mouse zoom (press = zoom at point, move = the zoom follows
 * the cursor, release = exit).
 *
 * The render-derived zoomZ/zoomGlide stay in App's culling render (they read
 * the loupe's useImage result, which doesn't exist at this call site) — App
 * assigns `zoomZRef.current` there each render. The decide-side zoom-drop
 * sequencing stays in useDecideCallbacks and reaches this hook only through
 * setPanOffset/setZoomSwapInstant/keepZoomOnAdvanceRef.
 */
export function usePaneZoom({
  images,
  currentIndex,
  metadata,
  imgRect,
  stageRef,
  positionInFilter,
}: {
  images: Img[];
  currentIndex: number;
  metadata: Record<string, ImageMetadata>;
  imgRect: PaneRect | null;
  stageRef: RefObject<HTMLDivElement | null>;
  positionInFilter: number;
}) {
  const [isZooming, setIsZooming] = useState(false);
  const [zoomLevel, setZoomLevel] = useState<1 | 2>(1); // 1 = 1:1, 2 = 2:1 (Shift+Space)
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  // Rate-while-zoomed: a rating advance with Space still held CARRIES the zoom
  // to the next frame (anchored at ITS OWN AF point — pan resets). One-shot
  // flag set by applyRating right before the cursor moves, consumed by the
  // index-change reset effect below; every other cursor move still drops zoom.
  const keepZoomOnAdvanceRef = useRef(false);
  // True for exactly the carried-zoom swap render(s): the next frame lands AT
  // scale with transitions off (animating between two frames' origins is
  // meaningless motion), then glides come back so pan/release keep their feel.
  const [zoomSwapInstant, setZoomSwapInstant] = useState(false);
  useEffect(() => {
    if (!zoomSwapInstant) return;
    // Two rAFs: the swap commits with transition none, glides return the
    // frame after. A rapid Enter-burst keeps re-arming it, which is correct —
    // the whole burst lands instantly.
    let inner: number | null = null;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setZoomSwapInstant(false));
    });
    return () => {
      cancelAnimationFrame(outer);
      if (inner !== null) cancelAnimationFrame(inner);
    };
  }, [zoomSwapInstant]);
  // Live mirror of isZooming so the navigation-reset effect can fire on a cursor
  // move WITHOUT depending on isZooming (which would make it cancel the very zoom
  // a Space-press just started).
  const isZoomingRef = useRef(isZooming);
  useEffect(() => {
    isZoomingRef.current = isZooming;
  }, [isZooming]);

  // Cursor-anchored mouse zoom: press on the photo = zoom at that point,
  // move = the zoom origin follows the cursor (a loupe, not a grab: the
  // origin is the one input the scale glide is indifferent to, so steering
  // it mid-glide never fights the animation), release = exit. Mirrors Space
  // (hold-based, no sticky state); rating while held carries the zoom like
  // the keyboard flow.
  const [mouseZooming, setMouseZooming] = useState(false);
  // Mirror for the stable-identity pan() below: while the mouse owns the
  // zoom, arrow-key pan must stand down — the cursor sets the origin outright
  // and a keyboard nudge would be overwritten by the next mouse move anyway.
  const mouseZoomingRef = useRef(false);
  useEffect(() => {
    mouseZoomingRef.current = mouseZooming;
  }, [mouseZooming]);

  const pan = useCallback((dx: number, dy: number) => {
    if (mouseZoomingRef.current) return;
    setPanOffset((o) => ({
      x: Math.max(-PAN_LIMIT, Math.min(PAN_LIMIT, o.x + dx)),
      y: Math.max(-PAN_LIMIT, Math.min(PAN_LIMIT, o.y + dy)),
    }));
  }, []);

  // Exit zoom: drop the scale. The pan is deliberately KEPT: the release
  // glide scales down around the origin the user was looking at, and every
  // zoom start sets its own pan first (Space → 0, mouse → the cursor), so a
  // stale pan can never leak into the next zoom. Resetting it here made the
  // origin snap back to the AF point a frame before the glide, so the exit
  // visibly hopped. (zoomLevel is left as-is — the next press re-sets it.)
  const resetZoom = useCallback(() => {
    setIsZooming(false);
    setMouseZooming(false); // a mouse-held zoom ends with the zoom, always
  }, []);

  // Leaving a zoomed frame via a cursor move drops the zoom (the new image
  // would land scaled to the old pan) — with ONE exception: a rating advance
  // that set keepZoomOnAdvanceRef carries the zoom to the next frame (pan was
  // already reset at the rate site, so the new frame anchors at its own AF
  // point). The flag is one-shot: undo, compare exits, and any other cursor
  // move still exit zoom. Reads isZoomingRef so it fires on the index change,
  // never on the Space-press that started the zoom.
  useEffect(() => {
    if (!isZoomingRef.current) return;
    if (keepZoomOnAdvanceRef.current) {
      keepZoomOnAdvanceRef.current = false;
      return;
    }
    resetZoom();
  }, [currentIndex, resetZoom]);

  // Where the cursor sits on the photo, in image percent (may fall outside
  // 0–100). Null when the pane has no measured image.
  const cursorPct = useCallback(
    (clientX: number, clientY: number) => {
      const stage = stageRef.current;
      if (!stage || !imgRect) return null;
      const sr = stage.getBoundingClientRect();
      return {
        x: ((clientX - sr.left - imgRect.left) / imgRect.width) * 100,
        y: ((clientY - sr.top - imgRect.top) / imgRect.height) * 100,
      };
    },
    [stageRef, imgRect],
  );

  // The AF point the origin is measured from — the same read as App's
  // origin: a zoom inside the 100 ms metadata batch window must see the
  // pending AF point too, or pan and origin disagree and the zoom lands
  // off the cursor.
  const afPoint = useCallback(() => {
    const curImg = images[currentIndex];
    const meta = curImg
      ? zoomOriginMeta(metadata[curImg.path], () => imageStore.pendingMetaFor(curImg.path))
      : undefined;
    return { x: meta?.afXPct ?? 50, y: meta?.afYPct ?? 50 };
  }, [images, currentIndex, metadata]);

  // Mouse-zoom follow loop + release. Listeners exist only while the button
  // is held. Deps close over the LIVE imgRect/meta on purpose: a carried
  // rating advance mid-hold swaps them, the effect re-attaches, and the
  // follow continues seamlessly on the new frame.
  useEffect(() => {
    if (!mouseZooming) return;
    const af = afPoint();
    const onMove = (e: MouseEvent) => {
      const at = cursorPct(e.clientX, e.clientY);
      if (!at) return;
      // origin = AF + pan, so this pan puts the origin exactly under the
      // cursor — the same formula as the press. No scale factor and no
      // per-move delta, so there is nothing to drift or to fight the glide.
      // Clamped to the image: a held button can wander off the frame, and
      // the zoom then holds at the nearest edge instead of anchoring outside.
      setPanOffset({
        x: Math.max(0, Math.min(100, at.x)) - af.x,
        y: Math.max(0, Math.min(100, at.y)) - af.y,
      });
    };
    const end = () => {
      setMouseZooming(false);
      resetZoom();
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", end);
    window.addEventListener("blur", end);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", end);
      window.removeEventListener("blur", end);
    };
  }, [mouseZooming, afPoint, cursorPct, resetZoom]);

  // Press on the loupe photo: zoom anchored at the cursor (Shift = 2:1).
  // Only from an un-zoomed state (Space zoom owns the frame otherwise), only
  // on the photo itself (matte/background clicks stay inert), never on a
  // button (the preview-failed retry lives inside the stage).
  const handleStageMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0 || isZoomingRef.current) return;
      if (positionInFilter === -1 || !imgRect) return;
      if ((e.target as Element).closest("button")) return;
      const at = cursorPct(e.clientX, e.clientY);
      if (!at || at.x < 0 || at.x > 100 || at.y < 0 || at.y > 100) return;
      const af = afPoint();
      e.preventDefault();
      // origin = AF + pan, so this pan puts the origin exactly under the cursor.
      setPanOffset({ x: at.x - af.x, y: at.y - af.y });
      setZoomLevel(e.shiftKey ? 2 : 1);
      setIsZooming(true);
      setMouseZooming(true);
    },
    [positionInFilter, imgRect, cursorPct, afPoint],
  );

  return {
    isZooming,
    setIsZooming,
    zoomLevel,
    setZoomLevel,
    panOffset,
    setPanOffset,
    zoomSwapInstant,
    setZoomSwapInstant,
    isZoomingRef,
    keepZoomOnAdvanceRef,
    mouseZooming,
    pan,
    resetZoom,
    handleStageMouseDown,
  };
}
