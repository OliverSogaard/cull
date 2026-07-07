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
  tx,
  ty,
  scale,
  transition,
  className,
  onDecoded,
}: {
  url: string;
  w: number;
  h: number;
  tx: number;
  ty: number;
  scale: number;
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
    <img
      ref={ref}
      className={className}
      alt=""
      aria-hidden
      style={{
        position: "absolute",
        // ABOVE the presenter layers (front layer is zIndex 2): without this
        // the sharp raster paints UNDERNEATH the zoomed preview and zoom
        // never visibly sharpens (found in the macOS manual matrix).
        zIndex: 3,
        // Inside .cull-photo-frame__clip (the content box) — the clip's
        // inset already accounts for the matte.
        left: 0,
        top: 0,
        width: w,
        height: h,
        maxWidth: "none",
        maxHeight: "none",
        transformOrigin: "0 0",
        transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
        transition: `${transition ?? "transform 200ms ease-out"}, opacity 100ms ease-out`,
        opacity: decoded ? 1 : 0,
        pointerEvents: "none",
        willChange: "transform",
      }}
    />
  );
}
