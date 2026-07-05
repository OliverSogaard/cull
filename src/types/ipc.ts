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

/** Tier-2 face metrics (empty in the classical MVP; wire contract is stable). */
export type FaceScore = {
  bbox: [number, number, number, number];
  eyesOpen: number;
  faceSharpness: number;
};

/**
 * Raw per-file quality metrics from `analyze_quality` (smart culling). The
 * backend computes per-file ONLY — burst grouping, winner selection, and
 * verdicts are derived in TS (`src/smart/`). Mirrors Rust `analyze::ImageScore`.
 */
export type ImageScore = {
  /** ABSOLUTE input-order index into the dispatched list (chunk_start + offset). */
  index: number;
  /** Noise-normalized 0..1 variance-of-Laplacian over the AF crop. */
  afSharpness: number;
  afValid: boolean;
  /** AF-crop p95−p5 luma spread 0..1 — below TEXTURE_MIN, focus is unjudgeable. */
  afTexture: number;
  globalSharpness: number;
  noiseFloor: number;
  blownPct: number;
  crushedPct: number;
  exposureScore: number;
  motionBlurLikelihood: number;
  /** Sobel cross-check, same normalization as afSharpness. */
  tenengrad: number;
  /** 64-bit DCT pHash, 16 lowercase hex chars (string: JS numbers lose 64-bit
   *  precision). null ⇒ decode failure. Compare via BigInt. */
  phash: string | null;
  mtimeMs: number;
  driveMode: number | null;
  focalLengthMm: number | null;
  shutterSeconds: number | null;
  iso: number | null;
  subSecMs: number | null;
  /** captured_at + SubSec as ms (camera clock; DELTAS only). */
  capturedAtMs: number | null;
  faces: FaceScore[];
  aesthetic: number | null;
  /** false ⇒ preview missing/corrupt — show no suggestion for this frame. */
  decodeOk: boolean;
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
