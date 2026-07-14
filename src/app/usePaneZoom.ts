import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { Img, ImageMetadata } from "../types";
import type { PaneRect } from "../components/pane/paneGeometry";

const PAN_LIMIT = 40; // max % offset from the AF point

/**
 * Zoom choreography, verbatim from App (grand cleanup Phase 7): the hold-based
 * Space/mouse zoom state, keyboard pan, the carried-advance one-shot flag, the
 * zoomSwapInstant two-rAF reset, the index-change zoom reset/carry, and the
 * cursor-anchored mouse zoom (press = zoom at point, drag = grab-pan,
 * release = exit).
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
  // drag = grab-pan, release = exit. Mirrors Space exactly (hold-based, no
  // sticky state); rating while held carries the zoom like the keyboard flow.
  const [mouseZooming, setMouseZooming] = useState(false);
  const lastMouseRef = useRef({ x: 0, y: 0 });
  // Mirror for the stable-identity pan() below: while the mouse owns the
  // zoom, arrow-key pan must stand down — its ±40% clamp would snap a drag
  // that legitimately sits outside it (mouse pan clamps by origin bounds).
  const mouseZoomingRef = useRef(false);
  useEffect(() => {
    mouseZoomingRef.current = mouseZooming;
  }, [mouseZooming]);
  // Live mirror of the render-derived zoomZ (declared after the chrome early
  // return, so the drag handler below can't close over it) — assigned where
  // zoomZ is computed each culling render.
  const zoomZRef = useRef(1);

  const pan = useCallback((dx: number, dy: number) => {
    // Mouse-drag zoom owns panning while the button is held: this keyboard
    // clamp (±40%) would visibly snap a drag anchored near an edge.
    if (mouseZoomingRef.current) return;
    setPanOffset((o) => ({
      x: Math.max(-PAN_LIMIT, Math.min(PAN_LIMIT, o.x + dx)),
      y: Math.max(-PAN_LIMIT, Math.min(PAN_LIMIT, o.y + dy)),
    }));
  }, []);

  // Exit zoom: drop the scale and re-center. (zoomLevel is intentionally left
  // as-is — the next Space-press re-sets it.) Centralized so the exit points stay
  // consistent.
  const resetZoom = useCallback(() => {
    setIsZooming(false);
    setMouseZooming(false); // a mouse-held zoom ends with the zoom, always
    setPanOffset({ x: 0, y: 0 });
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

  // Mouse-zoom drag loop + release. Listeners exist only while the button is
  // held. Deps close over the LIVE imgRect/meta on purpose: a carried rating
  // advance mid-drag swaps them, the effect re-attaches, and the drag
  // continues seamlessly on the new frame. zoomZ arrives via its ref mirror
  // (it is render-derived after the chrome early return).
  useEffect(() => {
    if (!mouseZooming) return;
    const curImg = images[currentIndex];
    const meta = curImg ? metadata[curImg.path] : undefined;
    const afX = meta?.afXPct ?? 50;
    const afY = meta?.afYPct ?? 50;
    const onMove = (e: MouseEvent) => {
      const dx = e.clientX - lastMouseRef.current.x;
      const dy = e.clientY - lastMouseRef.current.y;
      lastMouseRef.current = { x: e.clientX, y: e.clientY };
      const rect = imgRect;
      const z = zoomZRef.current;
      if (!rect || z <= 1) return;
      // Grab semantics: content follows the pointer. Moving the origin by d%
      // shifts the content by d(Z−1)% of the width the other way, so the 1:1
      // tracking factor is 100 / (Z−1). Pan clamps to origin bounds [0,100]
      // (NOT the keyboard's ±40%: a corner anchor legitimately exceeds it).
      setPanOffset((o) => ({
        x: Math.max(-afX, Math.min(100 - afX, o.x - ((dx / rect.width) * 100) / (z - 1))),
        y: Math.max(-afY, Math.min(100 - afY, o.y - ((dy / rect.height) * 100) / (z - 1))),
      }));
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
  }, [mouseZooming, imgRect, images, currentIndex, metadata, resetZoom]);

  // Press on the loupe photo: zoom anchored at the cursor (Shift = 2:1).
  // Only from an un-zoomed state (Space zoom owns the frame otherwise), only
  // on the photo itself (matte/background clicks stay inert), never on a
  // button (the preview-failed retry lives inside the stage).
  const handleStageMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0 || isZoomingRef.current) return;
      if (positionInFilter === -1 || !imgRect) return;
      if ((e.target as Element).closest("button")) return;
      const stage = stageRef.current;
      if (!stage) return;
      const sr = stage.getBoundingClientRect();
      const px = ((e.clientX - sr.left - imgRect.left) / imgRect.width) * 100;
      const py = ((e.clientY - sr.top - imgRect.top) / imgRect.height) * 100;
      if (px < 0 || px > 100 || py < 0 || py > 100) return;
      const curImg = images[currentIndex];
      const meta = curImg ? metadata[curImg.path] : undefined;
      e.preventDefault();
      lastMouseRef.current = { x: e.clientX, y: e.clientY };
      // origin = AF + pan, so this pan puts the origin exactly under the cursor.
      setPanOffset({ x: px - (meta?.afXPct ?? 50), y: py - (meta?.afYPct ?? 50) });
      setZoomLevel(e.shiftKey ? 2 : 1);
      setIsZooming(true);
      setMouseZooming(true);
    },
    [positionInFilter, imgRect, images, currentIndex, metadata, stageRef],
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
    zoomZRef,
    pan,
    resetZoom,
    handleStageMouseDown,
  };
}
