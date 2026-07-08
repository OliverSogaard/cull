import type { ImageDims } from "../utils/bundle";

type FullState =
  | { status: "loading" }
  | { status: "ready"; url: string; dims: ImageDims }
  | { status: "error"; error: string };

export type ImageState = {
  thumb: { url: string; dims: ImageDims } | undefined;
  /** The NAVIGATION tier. Since Phase 3 this is the 1620×1080 PRVW preview
   *  (the 32 MP JPEG moved to the zoom tier below). The stage name stays
   *  "full" — it means "nav tier ready". */
  full: FullState | undefined;
  /** Zoom tier (Phase 3): the 32 MP mdat JPEG, fetched on settle/zoom only. */
  zoomFull?: { status: "loading" } | { status: "ready"; url: string; dims: ImageDims | undefined } | { status: "error"; error: string };
  /** Mid tier (Phase 8): the generated ≤2560px JPEG serving the settled fit
   *  view on high-DPI stages. Errors are tracked in the store's midErrors
   *  (never displayed — the fallback chain mid→preview always renders). */
  mid?: { status: "loading" } | { status: "ready"; url: string };
  /** Session-lifetime dims cache entry (orientation-adjusted display dims).
   *  Present even after the thumb/full blobs are evicted, so a revisited
   *  frame's matte keeps its true aspect instead of flashing neutral-square. */
  knownDims?: ImageDims;
};

type Stage = "shimmer" | "thumb" | "full";
export type Resolved = {
  stage: Stage;
  url: string | undefined;
  dims: ImageDims | undefined;
  error: string | undefined;
  /** Ready zoom-tier full for the hi-res layer (url + NATIVE display dims),
   *  whatever the nav stage — undefined while unfetched/loading/errored. */
  full: { url: string; dims: ImageDims | undefined } | undefined;
  /** Ready mid tier (Phase 8) for the settled fit view on high-DPI stages —
   *  offered to the presenter ABOVE the preview; undefined while absent. */
  mid: { url: string } | undefined;
  /** The thumb tier, exposed INDEPENDENTLY of the nav stage. Thumb cells
   *  (useThumb → ThumbCell/GridCell) must keep rendering this blob when a
   *  prefetched nav preview lands for the same path — `url` flips to the
   *  preview then, and binding it to a strip/grid <img src> swaps blobs and
   *  blanks the cell while WebKit decodes the 1620×1080 preview (the
   *  "8-away flash", thumb-flash-report). Undefined until the thumb exists. */
  thumbUrl: string | undefined;
};

export function resolveStage(s: ImageState): Resolved {
  const error = s.full?.status === "error" ? s.full.error : undefined;
  const full =
    s.zoomFull?.status === "ready" ? { url: s.zoomFull.url, dims: s.zoomFull.dims } : undefined;
  const mid = s.mid?.status === "ready" ? { url: s.mid.url } : undefined;
  const thumbUrl = s.thumb?.url;
  if (s.full?.status === "ready") {
    // The full can land BEFORE the thumb (big scrub jump): the store freezes
    // it with the {1,1} UNKNOWN sentinel, so real dims must stand in from the
    // thumb / dims cache the moment they exist — otherwise the frame is stuck
    // on the neutral-square matte and the hi-res layer (top-left-anchored,
    // assumes matte AR == image AR) paints a misaligned second copy.
    const dims =
      s.full.dims.w > 1 && s.full.dims.h > 1
        ? s.full.dims
        : (s.thumb?.dims ?? s.knownDims ?? s.full.dims);
    return { stage: "full", url: s.full.url, dims, error: undefined, full, mid, thumbUrl };
  }
  if (s.thumb) return { stage: "thumb", url: s.thumb.url, dims: s.thumb.dims, error, full, mid, thumbUrl };
  return { stage: "shimmer", url: undefined, dims: s.knownDims, error, full, mid, thumbUrl };
}
