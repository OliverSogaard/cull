import { useEffect, useMemo } from "react";
import { useImage } from "./useImage";
import type { Resolved } from "./stage";
import { shimmerPhaseMs } from "../utils/shimmer";
import { dlog, dlogEnabled } from "../utils/dlog";

/**
 * The url a thumb cell binds to its <img src> — the THUMB tier whenever it
 * exists, NEVER the nav preview for a path that has a thumb. Pure + exported
 * for the 8-away-flash regression test (imageStore.test.ts).
 *
 * Why not `resolved.url`: the direction-biased preview prefetch
 * (prefetchFullsAround, previewPrefetchAhead = 8 on the local profile) lands a
 * nav preview for the frame exactly 8 ahead of the cursor; `resolved.url`
 * flips from the thumb blob to the preview blob at that moment, and swapping a
 * live <img src> blanks the cell (~0.1 s) while WKWebView fetches + decodes
 * the 1620×1080 blob — the visible flash always 8-away in the travel
 * direction. Pinning to `thumbUrl` keeps the rendered value IDENTICAL across
 * foreign-tier landings (and later preview evictions), so React's diff never
 * touches the element.
 *
 * The nav url remains as FALLBACK for the thumbless case only (big scrub
 * jump: preview lands before the thumb) — better the preview than a shimmer.
 * ACCEPTED TRADE-OFF: that fallback frame swaps preview→thumb once when the
 * thumb finally lands — one src change, one potential single-frame blank on
 * that cell (the same mechanism this function exists to prevent). Rare (only
 * frames whose preview won the race) and once-per-frame, vs the old code's
 * flash on EVERY 8-away prefetch landing; shimmer-until-thumb would avoid it
 * at the cost of blanking every big-jump landing zone.
 */
export function thumbDisplayUrl(img: Resolved): string | undefined {
  return img.thumbUrl ?? (img.stage === "shimmer" ? undefined : img.url);
}

/**
 * Thumbnail-cell loading primitive shared by the filmstrip cell (ThumbCell) and
 * the grid cell (GridCell) — the two were near-identical here. Subscribes to the
 * path's thumbnail (wantFull:false), resolves the display URL (undefined while
 * still shimmering), and pins the shimmer animation phase ONCE at mount so every
 * cell's placeholder pulses in sync with the others.
 *
 * `probeOnLoad` (dlog-gated, undefined when dev-logging is off) wires to the
 * cell's <img onLoad> for the thumb-flash investigation: together with the
 * mount probe below it separates the two possible flash mechanisms —
 *  - flashes WITH "cell mount" logs at that moment = windowing/remount bug
 *    (cells mounting inside the viewport; the load latency shows how long the
 *    fresh <img> stayed blank on its cached blob URL);
 *  - flashes with NO mount logs = paint-level: WKWebView purged the decoded
 *    bitmaps and async-re-decoded on the scroll repaint (nothing JS-side
 *    remounted or re-rendered — only live confirmation can catch this one).
 */
export function useThumb(path: string): {
  url: string | undefined;
  shimmerDelayMs: number;
  probeOnLoad: (() => void) | undefined;
} {
  const img = useImage(path, { wantFull: false });
  const url = thumbDisplayUrl(img);
   
  const shimmerDelayMs = useMemo(() => shimmerPhaseMs(), []);

  // ── dlog probes (thumb-flash) — free when the flag is off ────────────────
  // "warm" = the cached blob URL was available synchronously on the FIRST
  // render (the store snapshot path), i.e. the cell never shimmered.
  const warmAtMount = url !== undefined;
  const mountTs = useMemo(() => performance.now(), []);
  useEffect(() => {
    dlog("thumb-flash", "cell mount", { path, warm: warmAtMount });
    // Mount-only by design: this logs cell (re)mounts, not re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const probeOnLoad = useMemo(
    () =>
      dlogEnabled()
        ? () =>
            dlog("thumb-flash", "img loaded", {
              path,
              sinceMountMs: Math.round(performance.now() - mountTs),
            })
        : undefined,
    [path, mountTs],
  );

  return { url, shimmerDelayMs, probeOnLoad };
}
