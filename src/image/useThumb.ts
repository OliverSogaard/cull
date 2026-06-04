import { useMemo } from "react";
import { useImage } from "./useImage";
import { shimmerPhaseMs } from "../utils/shimmer";

/**
 * Thumbnail-cell loading primitive shared by the filmstrip cell (ThumbCell) and
 * the grid cell (GridCell) — the two were near-identical here. Subscribes to the
 * path's thumbnail (wantFull:false), resolves the display URL (undefined while
 * still shimmering), and pins the shimmer animation phase ONCE at mount so every
 * cell's placeholder pulses in sync with the others.
 */
export function useThumb(path: string): { url: string | undefined; shimmerDelayMs: number } {
  const img = useImage(path, { wantFull: false });
  const url = img.stage === "shimmer" ? undefined : img.url;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const shimmerDelayMs = useMemo(() => shimmerPhaseMs(), []);
  return { url, shimmerDelayMs };
}
