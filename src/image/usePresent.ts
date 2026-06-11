import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { MutableRefObject } from "react";
import { Presenter } from "./present";
import type { PresentSnapshot } from "./present";

/**
 * React binding for the Presenter (pipeline Phase 4): owns the two physical
 * <img> layer refs and the injected decode — `el.src = url; await el.decode()`
 * on the element that becomes visible is the only cross-engine guarantee that
 * pixels are ready (WebView2 + WKWebView; see the plan's platform notes).
 *
 * Flip side-effects (layout effect, before paint):
 *  - `frontRefOut.current` points at the new front element, so App's existing
 *    imgRect measurement machinery keeps working unchanged. If the front
 *    isn't mounted the ref simply keeps its last value — the measure effect's
 *    "keep last-good imgRect" contract.
 *  - the crossfade runs IMPERATIVELY on the front element via el.animate()
 *    (React must never remount the element — its decoded bitmap IS the
 *    double-buffer; a remount would throw the decode work away).
 *  - `onFlip()` lets App seed a re-measure (measureNonce bump).
 *
 * IMPORTANT: the layer <img>s must be rendered WITHOUT a React-managed `src`
 * — the decoder owns it. React never touches unmanaged attributes on
 * re-render, so the imperative src survives.
 */
export function usePresent(
  frontRefOut: MutableRefObject<HTMLImageElement | null>,
  onFlip: () => void,
): {
  presenter: Presenter;
  snap: PresentSnapshot;
  elA: MutableRefObject<HTMLImageElement | null>;
  elB: MutableRefObject<HTMLImageElement | null>;
} {
  const elA = useRef<HTMLImageElement | null>(null);
  const elB = useRef<HTMLImageElement | null>(null);
  const [presenter] = useState(
    () =>
      new Presenter({
        decode: (layer, url) => {
          const el = layer === "A" ? elA.current : elB.current;
          if (!el) return Promise.reject(new Error("layer unmounted"));
          el.src = url;
          // decode() rejects when the src changes mid-decode (a superseding
          // offer took the layer) or the data is undecodable — exactly the
          // failure semantics the presenter's gate expects.
          return el.decode();
        },
      }),
  );
  const snap = useSyncExternalStore(
    (cb) => presenter.subscribe(cb),
    () => presenter.snapshot(),
  );

  const lastFlipKey = useRef<string | null>(null);
  const onFlipRef = useRef(onFlip);
  onFlipRef.current = onFlip;
  useLayoutEffect(() => {
    const front = snap.frontLayer === "A" ? elA.current : elB.current;
    if (front) frontRefOut.current = front;
    const key = `${snap.frontLayer}:${snap.front.url ?? ""}`;
    if (front && snap.front.url && lastFlipKey.current !== key) {
      lastFlipKey.current = key;
      if (snap.transitionMs > 0 && typeof front.animate === "function") {
        front.animate([{ opacity: 0 }, { opacity: 1 }], {
          duration: snap.transitionMs,
          easing: "cubic-bezier(0.2, 0, 0, 1)",
        });
      }
      onFlipRef.current();
    }
  });

  return { presenter, snap, elA, elB };
}
