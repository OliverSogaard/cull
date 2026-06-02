/**
 * Outcome of a batch file operation (move_rejects / copy_keeps). The Rust side
 * returns this shape verbatim. `skipped` covers both destination collisions
 * and a missing source (idempotent re-runs).
 */
export type FileOpResult = {
  completed: number;
  skipped: number;
  errors: string[];
  /**
   * Total errors encountered. `errors` is capped (20) to bound the IPC payload,
   * so this can exceed `errors.length`; the UI shows it to avoid reading a
   * capped list as "only N failed". Optional for older backends.
   */
  errorCount?: number;
};

/** Analyze-phase progress event emitted on `analyze-progress`. */
export type AnalyzeProgress = { done: number; total: number; phase: string };

/** Result returned by the `analyze_folder` command. */
export type AnalyzeResult = {
  order: number[];
  ratings: (string | null)[];
  /**
   * Pre-existing LrC 1–5★ rating per input index (null = unrated). Same
   * sidecar pass as `ratings`, so it's free to extract on the backend.
   */
  lrcRatings: (number | null)[];
};
