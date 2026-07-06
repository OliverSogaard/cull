import { useEffect, useMemo } from "react";
import { useImage } from "./useImage";
import { shimmerPhaseMs } from "../utils/shimmer";
import { dlog, dlogEnabled } from "../utils/dlog";

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
  const url = img.stage === "shimmer" ? undefined : img.url;
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
