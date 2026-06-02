import type { ImageDims } from "../utils/bundle";

export type FullState =
  | { status: "loading" }
  | { status: "ready"; url: string; dims: ImageDims }
  | { status: "error"; error: string };

export type ImageState = {
  thumb: { url: string; dims: ImageDims } | undefined;
  full: FullState | undefined;
};

export type Stage = "shimmer" | "thumb" | "full";
export type Resolved = { stage: Stage; url: string | undefined; dims: ImageDims | undefined; error: string | undefined };

export function resolveStage(s: ImageState): Resolved {
  const error = s.full?.status === "error" ? s.full.error : undefined;
  if (s.full?.status === "ready") return { stage: "full", url: s.full.url, dims: s.full.dims, error: undefined };
  if (s.thumb) return { stage: "thumb", url: s.thumb.url, dims: s.thumb.dims, error };
  return { stage: "shimmer", url: undefined, dims: undefined, error };
}
