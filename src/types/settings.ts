import type { Filter } from "./rating";
import { isReservedFolderName, sanitizeFolderName } from "../utils/path";

/**
 * User-tunable runtime settings. Persisted to localStorage so they survive
 * across app restarts. Open the dialog with `Ctrl+,`, the gear icon on the
 * home screen, or the gear in the cull-view status bar.
 *
 * Mostly-flat fields, so a field added later just gets its default on first
 * load. The one nested field (`exportFolder`) is validated explicitly by
 * `coerceSettings` in `useSettings`, which per-field type/enum-checks the whole
 * stored blob rather than trusting it.
 */

/**
 * Where the cull folder lives. Drives a "performance profile" — read
 * concurrency, background-fill rate, full-res cache window, hi-res zoom
 * warm-up, and XMP-restore parallelism — see {@link PERFORMANCE_PROFILES}.
 *
 * - `local` (default) — assumes the photos are on this computer (or a fast
 *   directly-attached drive). Aggressive prefetch + high concurrency.
 * - `network` — assumes the photos are on a network drive over SMB/SSHFS/NFS.
 *   Conservative concurrency, smaller prefetch window. Designed for a
 *   high-latency NAS where ~37 ms per file open dominates and concurrent
 *   opens make things worse.
 *
 * The setting only affects scheduling; it never changes correctness.
 */
export type StorageMode = "network" | "local";

/**
 * Where the "copy keeps" action sends files. `remember` ("ask each time") opens
 * the OS folder picker on every copy, pre-seeded to the last folder you exported
 * to (it never auto-exports without a prompt). `pinned` always exports under the
 * same fixed root, no prompt.
 */
export type ExportFolderMode = { mode: "remember" } | { mode: "pinned"; path: string };

/** Where the loupe / compare thumbnail strip sits relative to the photo. */
export type ThumbsPosition = "bottom" | "top";

/** Contact-sheet cell size. Drives the column-target maths in utils/gridSize;
 *  `medium` is today's grid at every window size. */
export type GridSize = "small" | "medium" | "large";

export type Settings = {
  // — Storage —
  storageMode: StorageMode;

  // — Defaults on entering a cull —
  /** Apply this filter on entry. */
  defaultFilter: Filter;
  /** Show the thumbnail strip on entry (T toggles during the cull). */
  defaultThumbsVisible: boolean;
  /** Default visibility of the (i) overlay on entry. */
  defaultExifVisible: boolean;
  /** Default visibility of the clipping overlay (h). */
  defaultClippingVisible: boolean;
  /** Default visibility of the focus-peaking overlay (p). */
  defaultPeakingVisible: boolean;
  /** Default visibility of the thirds grid (o). */
  defaultCompositionVisible: boolean;
  /** Where the loupe / compare thumbnail strip sits (bottom or top). */
  thumbsPosition: ThumbsPosition;
  /** Contact-sheet cell size. +/− in the grid, Ctrl+0 back to medium. */
  gridSize: GridSize;
  /**
   * Sort the staged set by EXIF `DateTimeOriginal` (+ SubSec) at Begin
   * culling, instead of by each file's write time. ON by default: on a local
   * SSD the pass is seconds for 4,000 frames, and the thumb tier caches every
   * read, so re-opening a shoot is free. The one place it is worth turning
   * off is a slow network share on its FIRST open — which is exactly where
   * the toggle lives, on the staged screen.
   */
  sortByCaptureTime: boolean;
  /**
   * Per-folder clock corrections in MILLISECONDS, keyed by `Img.srcFolder`
   * (the folder the user picked, not the subdirectory a recursive walk found
   * a frame in). Added to that folder's frames for ORDERING only — nothing is
   * ever written to a file and the info rail keeps showing the camera's own
   * time. Lives here rather than in recents because recents expire after 14
   * days and are capped at 5, so an offset would silently evaporate.
   *
   * Keyed by the VERBATIM `srcFolder` string the picker returned — no
   * normalisation beyond the NFC pass every folder path already gets
   * (`useSessionLifecycle.ts`), so re-picking the same folder with a
   * different spelling (a trailing separator, different case) starts it at 0
   * rather than mis-keying someone else's correction onto it.
   */
  captureOffsets: Record<string, number>;

  // — File operations —
  /** Subfolder name that "move rejects" creates inside the cull folder. */
  rejectedSubfolder: string;
  /** Where "copy keeps" sends files — remembered or pinned. */
  exportFolder: ExportFolderMode;

  // — Launch —
  /**
   * If true, on app launch the last-used folder is opened automatically (the
   * home screen is skipped). Falls back to the home screen if there is no
   * last folder or it has been deleted.
   */
  openLastFolderOnLaunch: boolean;

  // — Smart culling (advisory only; nothing is ever written by the AI) —
  /** Master switch for suggestions (ghost dots, burst visuals, `4` filter). */
  smartCulling: boolean;
  /** How confident a REJECT suggestion must be before it shows. */
  smartCullingConfidence: SmartLevel;
  /** Analyze automatically when a folder opens (off → manual Analyze button). */
  smartCullingOnOpen: boolean;
  /** Deep analysis: local ML models (faces, eyes, look-alike grouping, starred
   *  picks). Renamed from `smartCullingML` (2026-07-06) with a new ON default —
   *  the old key is deliberately dropped by coerceSettings so every user lands
   *  on the default. Inert on builds without the model runtime. */
  deepAnalysis: boolean;

  // — Stars and colour labels (Phase 5A) —
  /**
   * Lightroom's other two verdicts: 1–5 stars (`xmp:Rating`) and the five
   * colour labels (`xmp:Label`), as an optional layer ORTHOGONAL to
   * keep / reject / favorite.
   *
   * OFF by default, and off means off: the digit row keeps selecting filters,
   * no star or label renders anywhere, and no star or label byte is ever
   * written. ON, the digit row becomes Lightroom's — `1`–`5` set stars, `0`
   * clears them, `6`–`9` and `Shift+6` set Red / Yellow / Green / Blue /
   * Purple — and the five filters move to `Shift+1`–`Shift+5`.
   *
   * A starred frame with no keep/reject is still UNRATED: every count, every
   * filter and the smart pipeline keep keying on `Rating` alone.
   */
  starsAndLabels: boolean;
};

/** Mirror of `src/smart/deriveVerdict.ts`'s SmartLevel (kept here so settings
 *  stay import-cycle-free; the two unions are asserted equal by tsc where the
 *  dialog passes one to the other). */
export type SmartLevel = "low" | "medium" | "high";

export const DEFAULT_SETTINGS: Settings = {
  storageMode: "local",

  defaultFilter: "all",
  defaultThumbsVisible: true,
  defaultExifVisible: true,
  defaultClippingVisible: false,
  defaultPeakingVisible: false,
  defaultCompositionVisible: false,
  thumbsPosition: "bottom",
  gridSize: "medium",
  sortByCaptureTime: true,
  captureOffsets: {},

  rejectedSubfolder: "_rejected",
  exportFolder: { mode: "remember" },

  openLastFolderOnLaunch: false,

  smartCulling: true,
  smartCullingConfidence: "medium",
  smartCullingOnOpen: true,
  deepAnalysis: true,

  starsAndLabels: false,
};

/** localStorage key. Bump only with a migration (read old key → transform →
 *  write new → remove old); a bare bump silently discards the user's prefs. */
export const SETTINGS_STORAGE_KEY = "cull:settings:v1";

/** Normalise a rejected-subfolder name to a value the OS will actually create,
 *  falling back to the default when empty or a Windows reserved device name.
 *  sanitizeFolderName strips illegal chars + trailing dots/spaces (so the move
 *  destination matches the on-disk name we also hand the scan-ignore filter — a
 *  mismatch would re-import the moved rejects). Shared by the file-op call sites,
 *  the scan-ignore name, and the load-time coercion so the rule lives in one place. */
export const normalizeRejectedSubfolder = (s: string): string => {
  const clean = sanitizeFolderName(s);
  if (!clean || isReservedFolderName(clean)) return DEFAULT_SETTINGS.rejectedSubfolder;
  return clean;
};

/** The largest clock correction the staged screen will hold or store. A day
 *  covers every real case (a body left on the wrong date, a timezone, a dead
 *  clock battery) and keeps a hand-edited blob from reaching the sort with a
 *  number that swamps it. */
export const CAPTURE_OFFSET_LIMIT_MS = 24 * 60 * 60 * 1000;

/** Validate a stored `captureOffsets` blob: an object of finite numbers, each
 *  clamped to ±{@link CAPTURE_OFFSET_LIMIT_MS} and rounded to a whole
 *  millisecond. Anything else — a non-object, an array, a string value, a
 *  NaN — is dropped entry by entry rather than failing the whole settings
 *  load. A NaN reaching the sort would poison every comparison in that
 *  folder, and a FRACTION is worse than useless: the wire type is Rust
 *  `i64`, so serde rejects the whole `analyze_folder` call rather than
 *  degrading the sort. `stepOffset` only ever produces integers, so storage
 *  is the one source of either — which is exactly what this distrusts. */
export const coerceCaptureOffsets = (raw: unknown): Record<string, number> => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const out: Record<string, number> = {};
  for (const [folder, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    const clamped = Math.max(-CAPTURE_OFFSET_LIMIT_MS, Math.min(CAPTURE_OFFSET_LIMIT_MS, value));
    out[folder] = Math.round(clamped);
  }
  return out;
};

/**
 * Performance knobs that change with {@link StorageMode}. Pushed into the
 * imageStore via `setProfile` when the mode flips (in-flight reads finish at
 * the old numbers; new reads use the new ones — no restart). One source of
 * truth for every tunable so adding a third profile later is a single edit.
 */
export type PerformanceProfile = {
  /** Max simultaneous PREVIEW (navigation-tier, ~2 MiB) reads. */
  previewConcurrency: number;
  /** Max simultaneous zoom full-res reads — rare now (settle/zoom only);
   *  2×10 MB concurrent NAS reads ≈ link saturation. */
  fullConcurrency: number;
  /** Max simultaneous thumbnail reads. */
  thumbConcurrency: number;
  /** Preview-blob retention, each side of the cursor (windowed eviction).
   *  Previews are ~15× lighter than the old full blobs, so the window is wide. */
  previewKeep: number;
  /** Zoom full-res blobs kept per side; pins (zoom/compare) override. */
  fullKeep: number;
  /** Cursor must rest this long before the zoom full-res WARMS (it now
   *  FETCHES ~10 MB + a 32 MP decode — must only charge deliberately-parked
   *  frames, never an arrow-through). */
  fullSettleMs: number;
  /** Parallel-restore XMP sidecars during analyze (sent to the backend). */
  concurrentRestore: boolean;
  /** Max simultaneous background-fill thumbnail reads (book-order sweep). */
  backgroundFillConcurrency: number;
  /** Previews to prefetch AHEAD of the cursor (travel direction) once it
   *  settles — direction-biased 2:1 against previewPrefetchBehind (Phase 5).
   *  Kept ≤ previewKeep so prefetched previews aren't immediately evicted.
   *  0 (both) disables prefetch. */
  previewPrefetchAhead: number;
  /** Previews to prefetch BEHIND the cursor (against travel direction). */
  previewPrefetchBehind: number;
  /** Decode-ahead pool cap (Phase 5): previews held DECODED via detached
   *  image refs so neighbour taps snap and warm scrub is sharp. Decoded RGBA
   *  is the real budget — ~7 MB per 1620px preview. NOTE: with the current
   *  radii the band (1 + ahead + behind) sits BELOW this cap, so it is a
   *  backstop that only binds if the radii grow past it. */
  decodedPoolPreviews: number;
  /** Decode-ahead pool cap for zoom-tier fulls (~130 MB decoded at 32.5 MP) —
   *  keeps the settled frame's full raster warm across hi-res layer remounts. */
  decodedPoolFulls: number;
  /** Mid-tier (Phase 8) concurrency: the store's `read_mid` lane cap AND the
   *  local idle sweep's lane cap (the backend's MidGen semaphore mirrors the
   *  same 1 network / 2 local numbers). Generation is ~250–400 ms of CPU per
   *  image, so this is a CPU knob, not an I/O one. */
  midGenConcurrency: number;
  /** Grid-tier (Phase 3B) concurrency: the store's `read_grid_thumb` lane cap.
   *  A 512px resize from an already-cached preview is ~20 ms of CPU, so this
   *  is a CPU knob like midGenConcurrency, not an I/O one. */
  gridThumbConcurrency: number;
  /** Grid-tier blobs kept each side of the VISIBLE GRID RANGE (not the
   *  cursor). ~35 KB on disk but ~0.7 MB decoded each, so the window is what
   *  bounds the tier's memory; displayRefs additionally protect a mounted cell. */
  gridThumbKeep: number;
};

export const PERFORMANCE_PROFILES: Record<StorageMode, PerformanceProfile> = {
  network: {
    previewConcurrency: 4,
    fullConcurrency: 2,
    thumbConcurrency: 4,
    previewKeep: 60,
    fullKeep: 2,
    fullSettleMs: 400,
    concurrentRestore: false,
    backgroundFillConcurrency: 2,
    previewPrefetchAhead: 4,
    previewPrefetchBehind: 2,
    decodedPoolPreviews: 9,
    decodedPoolFulls: 1,
    midGenConcurrency: 1,
    gridThumbConcurrency: 1,
    gridThumbKeep: 120,
  },
  local: {
    previewConcurrency: 12,
    fullConcurrency: 2,
    thumbConcurrency: 16,
    previewKeep: 150,
    fullKeep: 3,
    fullSettleMs: 150,
    concurrentRestore: true,
    backgroundFillConcurrency: 8,
    previewPrefetchAhead: 8,
    previewPrefetchBehind: 4,
    decodedPoolPreviews: 18,
    decodedPoolFulls: 2,
    midGenConcurrency: 2,
    gridThumbConcurrency: 4,
    gridThumbKeep: 120,
  },
};
