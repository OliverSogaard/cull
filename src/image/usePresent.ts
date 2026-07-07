import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { MutableRefObject } from "react";
import { Presenter } from "./present";
import type { PresentLayer, PresentSnapshot } from "./present";
import { dlog, dlogEnabled } from "../utils/dlog";

/**
 * mid-dims-bug-report §6.1 — present-time bottom-strip probe. Runs AFTER
 * `el.decode()` resolves (so it re-decodes the SAME resource WKWebView just
 * decoded) and samples the bottom ~2 rows into an offscreen canvas: a
 * partially-decoded raster served from the engine's blob-URL-keyed cache
 * shows as an all-zero (undrawn) strip even though `decode()` resolved
 * clean. Log-only — this does not gate the flip (that's remedy A, deferred).
 *
 * Guarded by `dlogEnabled()` BEFORE doing any work: in production this is a
 * single cached boolean check, no canvas, no readback.
 */
function probeBottomStrip(layer: PresentLayer, url: string, el: HTMLImageElement): void {
  if (!dlogEnabled()) return;
  try {
    const w = el.naturalWidth;
    const h = el.naturalHeight;
    if (!w || !h || typeof document === "undefined") return;
    const stripH = Math.min(2, h);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = stripH;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(el, 0, h - stripH, w, stripH, 0, 0, w, stripH);
    const { data } = ctx.getImageData(0, 0, w, stripH);
    let allZero = true;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] !== 0 || data[i + 1] !== 0 || data[i + 2] !== 0) {
        allZero = false;
        break;
      }
    }
    dlog("present", "bottom-strip probe", { layer, url, w, h, allZero });
  } catch {
    // Advisory only — canvas readback failures (e.g. a tainted canvas) must
    // never affect presentation.
  }
}

/**
 * React binding for the Presenter (pipeline Phase 4): owns the two physical
 * <img> layer refs and the injected decode — `el.src = url; await el.decode()`
 * on the element that becomes visible is the only cross-engine guarantee that
 * pixels are ready (WebView2 + WKWebView; see the plan's platform notes).
 *
 * Flip side-effects (layout effect, before paint):
 *  - `frontRefOut.current` points at the new front element, so PhotoPane's
 *    rect measurement keeps working unchanged. If the front isn't mounted
 *    the ref simply keeps its last value — the measure effect's "keep
 *    last-good rect" contract.
 *  - the crossfade runs IMPERATIVELY on the front element via el.animate()
 *    (React must never remount the element — its decoded bitmap IS the
 *    double-buffer; a remount would throw the decode work away).
 *  - `onFlip()` lets PhotoPane seed a re-measure (measureNonce bump).
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
          return el.decode().then(() => {
            probeBottomStrip(layer, url, el);
          });
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
