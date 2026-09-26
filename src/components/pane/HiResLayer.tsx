import { useEffect, useRef, useState } from "react";

/** Stable wrapper so the decode effect keys on `url` alone. */
function useLatest<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

/**
 * Native-size zoom raster, revealed only after its pixels are DECODED — the
 * preview-upscale beneath never pops to a half-decoded full (pipeline Phase
 * 4's decode-gated hi-res pattern, rendered by PhotoPane in every surface).
 * The element owns its own src imperatively; a url/path change re-gates, and
 * the live flag drops superseded decodes.
 */
export function HiResLayer({
  url,
  w,
  h,
  fit,
  originX,
  originY,
  zoomZ,
  isZooming,
  transition,
  className,
  onDecoded,
}: {
  url: string;
  w: number;
  h: number;
  /** Shrinks the native-size raster onto the displayed box (hiResFitScale). */
  fit: number;
  /** The presenter layers' zoom, verbatim: the wrapper mirrors their
   *  `scale(Z)` about `(originX%, originY%)`. The origin is a transform-origin,
   *  never folded into a translate — a translate is part of `transform` and
   *  restarts its transition on every pan update, which made a drag on the
   *  sharp layer ease and lag behind the pointer. */
  originX: number;
  originY: number;
  zoomZ: number;
  isZooming: boolean;
  /** Transform transition — MUST match the presenter layers' current zoom
   *  curve (zoomTransition) or the sharp raster tears away from the base
   *  mid-glide. */
  transition?: string;
  className: string;
  /** Fired with the layer's live decode state — true once the sharp pixels
   *  are actually in place (drives the zoom loading ring), false while a
   *  fresh url decodes and on unmount. */
  onDecoded?: (ready: boolean) => void;
}) {
  const ref = useRef<HTMLImageElement | null>(null);
  const [decoded, setDecoded] = useState(false);
  const onDecodedRef = useLatest(onDecoded);
  useEffect(() => {
    setDecoded(false);
    onDecodedRef.current?.(false);
    const el = ref.current;
    if (!el) return undefined;
    let live = true;
    el.src = url;
    el.decode().then(
      () => {
        if (live) {
          setDecoded(true);
          onDecodedRef.current?.(true);
        }
      },
      () => {
        /* superseded or undecodable — stay hidden */
      },
    );
    return () => {
      live = false;
      // Deliberate ref read in cleanup: the ref-dispatch pattern means the
      // LATEST onDecoded must hear the reset, not the mount-time closure.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      onDecodedRef.current?.(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);
  return (
    // Two elements on purpose. The WRAPPER fills the clip box exactly like a
    // presenter layer (same class, same box) and carries the zoom: scale(Z)
    // about the origin, on the shared glide. The IMG inside only shrinks the
    // native raster onto that box (a constant per frame, never transitioned)
    // and cross-fades in once decoded. Nothing that changes on a pan sits
    // inside a transitioned `transform`.
    <div
      className={className}
      aria-hidden
      style={{
        // ABOVE the presenter layers (front layer is zIndex 2): without this
        // the sharp raster paints UNDERNEATH the zoomed preview and zoom
        // never visibly sharpens (found in the macOS manual matrix).
        zIndex: 3,
        // .cull-image paints the matte colour; this box must stay see-through
        // until the raster has decoded, or it blanks the preview beneath.
        backgroundColor: "transparent",
        transform: isZooming ? `scale(${zoomZ})` : undefined,
        transformOrigin: `${originX}% ${originY}%`,
        transition: transition ?? "transform 200ms ease-out",
        pointerEvents: "none",
      }}
    >
      <img
        ref={ref}
        alt=""
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: w,
          height: h,
          maxWidth: "none",
          maxHeight: "none",
          transformOrigin: "0 0",
          transform: `scale(${fit})`,
          transition: "opacity 100ms ease-out",
          opacity: decoded ? 1 : 0,
          pointerEvents: "none",
        }}
      />
    </div>
  );
}
