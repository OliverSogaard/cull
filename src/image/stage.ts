import type { ImageDims } from "../utils/bundle";

type FullState =
  | { status: "loading" }
  | { status: "ready"; url: string; dims: ImageDims }
  | { status: "error"; error: string };

export type ImageState = {
  thumb: { url: string; dims: ImageDims } | undefined;
  /** The NAVIGATION tier. Since Phase 3 this is the 1620×1080 PRVW preview
   *  (the 32 MP JPEG moved to the zoom tier below); on a legacy backend it is
   *  still the full. The stage name stays "full" — it means "nav tier ready". */
  full: FullState | undefined;
  /** Zoom tier (Phase 3): the 32 MP mdat JPEG, fetched on settle/zoom only. */
  zoomFull?: { status: "loading" } | { status: "ready"; url: string; dims: ImageDims | undefined } | { status: "error"; error: string };
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
};

export function resolveStage(s: ImageState): Resolved {
  const error = s.full?.status === "error" ? s.full.error : undefined;
  const full =
    s.zoomFull?.status === "ready" ? { url: s.zoomFull.url, dims: s.zoomFull.dims } : undefined;
  if (s.full?.status === "ready")
    return { stage: "full", url: s.full.url, dims: s.full.dims, error: undefined, full };
  if (s.thumb) return { stage: "thumb", url: s.thumb.url, dims: s.thumb.dims, error, full };
  return { stage: "shimmer", url: undefined, dims: s.knownDims, error, full };
}
