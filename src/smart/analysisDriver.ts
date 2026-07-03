import type { ImageScore } from "../types/ipc";

/**
 * Injected dependencies so the engine is unit-testable without Tauri or React.
 * The hook (`useSmartCulling`) binds these to `invoke`, `imageStore`, and
 * `setTimeout` in production.
 */
export type DriverDeps = {
  /** One `analyze_quality` chunk: paths slice + ABSOLUTE start index + session gen. */
  invokeChunk: (paths: string[], chunkStart: number, gen: number) => Promise<ImageScore[]>;
  getGeneration: () => number;
  /** imageStore backpressure: zoom fulls or nav previews in flight. */
  isBusyLoading: () => boolean;
  sleep: (ms: number) => Promise<void>;
  /** Gen-checked scores for one chunk, in dispatch order. */
  onScores: (scores: ImageScore[]) => void;
  onProgress: (done: number, total: number) => void;
  /** A chunk that failed twice and was skipped — surfaced so callers can log
   *  it (gated diagnostics); silence here made real failures undiagnosable. */
  onChunkFailed?: (chunkStart: number, message: string) => void;
  chunkLen: number;
  idleWaitMs: number;
};

/** Chunk sizes per storage profile — the ≤8-network contract keeps a chunk
 *  inside `analyze_quality`'s Full-tier timeout on a slow NAS. */
export const NET_CHUNK = 6;
export const LOCAL_CHUNK = 16;
export const NET_IDLE_MS = 400;
export const LOCAL_IDLE_MS = 120;

/**
 * Sequential, cooperative, gen-guarded chunk loop. Returns how it ended:
 * "done" (all chunks), "stale" (generation moved — results after the move were
 * dropped), or "error" is never returned per-chunk — a failing chunk retries
 * once after an idle wait, then is SKIPPED (advisory pass: missing scores are
 * silent frames, not a broken session).
 */
export async function runAnalysis(
  paths: readonly string[],
  gen: number,
  deps: DriverDeps,
): Promise<"done" | "stale"> {
  const stale = () => deps.getGeneration() !== gen;

  for (let start = 0; start < paths.length; start += deps.chunkLen) {
    // Courtesy backoff: never compete with interactive reads. The IoGate is
    // the backstop; this is the scheduler-level politeness the plan mandates.
    while (deps.isBusyLoading()) {
      await deps.sleep(deps.idleWaitMs);
      if (stale()) return "stale";
    }
    if (stale()) return "stale";

    const slice = paths.slice(start, start + deps.chunkLen) as string[];
    let scores: ImageScore[] | null = null;
    for (let attempt = 0; attempt < 2 && !scores; attempt += 1) {
      try {
        scores = await deps.invokeChunk(slice, start, gen);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("cancelled")) return "stale";
        if (attempt === 0) {
          await deps.sleep(deps.idleWaitMs); // one breath, then one retry
          if (stale()) return "stale";
        } else {
          // Second failure: skip the chunk (missing scores = silent frames),
          // but never silently — the caller decides where this surfaces.
          deps.onChunkFailed?.(start, msg);
        }
      }
    }
    // THE gen-guard: results computed for a dead generation never land.
    if (stale()) return "stale";
    if (scores) deps.onScores(scores);
    deps.onProgress(Math.min(start + deps.chunkLen, paths.length), paths.length);
  }
  return "done";
}
