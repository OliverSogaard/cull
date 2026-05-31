/**
 * Outcome of a batch file operation (move_rejects / copy_keeps). The Rust side
 * returns this shape verbatim. `skipped` covers both destination collisions
 * and a missing source (idempotent re-runs).
 */
export type FileOpResult = {
  completed: number;
  skipped: number;
  errors: string[];
};

/** Analyze-phase progress event emitted on `analyze-progress`. */
export type AnalyzeProgress = { done: number; total: number; phase: string };

/** Result returned by the `analyze_folder` command. */
export type AnalyzeResult = {
  order: number[];
  ratings: (string | null)[];
};
