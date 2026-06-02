import type { Filter } from "./rating";

/**
 * User-tunable runtime settings. Persisted to localStorage so they survive
 * across app restarts. Open the dialog with `Ctrl+,`, the gear icon on the
 * home screen, or the gear in the cull-view status bar.
 *
 * Settings are flat (no nested objects) so the shallow-merge in `useSettings`
 * naturally handles backward compatibility — a field added later just gets
 * its default on first load.
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
 * Where the "copy keeps" action sends files. `remember` reuses the last
 * folder you exported to (current default behaviour). `pinned` always exports
 * to the same path, no matter what you picked previously.
 */
export type ExportFolderMode =
  | { mode: "remember" }
  | { mode: "pinned"; path: string };

/** Where the loupe / compare thumbnail strip sits relative to the photo. */
export type ThumbsPosition = "bottom" | "top";

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
};

export const DEFAULT_SETTINGS: Settings = {
  storageMode: "local",

  defaultFilter: "all",
  defaultThumbsVisible: true,
  defaultExifVisible: false,
  defaultClippingVisible: false,
  defaultPeakingVisible: false,
  defaultCompositionVisible: false,
  thumbsPosition: "bottom",

  rejectedSubfolder: "_rejected",
  exportFolder: { mode: "remember" },

  openLastFolderOnLaunch: false,
};

/** localStorage key. Bump if the shape ever changes in a non-backward-compatible way. */
export const SETTINGS_STORAGE_KEY = "cull:settings:v1";

/**
 * Performance knobs that change with {@link StorageMode}. Pushed into the
 * imageStore via `setProfile` when the mode flips (in-flight reads finish at
 * the old numbers; new reads use the new ones — no restart). One source of
 * truth for every tunable so adding a third profile later is a single edit.
 */
export type PerformanceProfile = {
  /** Max simultaneous full-preview reads. */
  bundleConcurrency: number;
  /** Max simultaneous thumbnail reads. */
  thumbConcurrency: number;
  /** Full-res ring buffer size, each side of the cursor (windowed eviction). */
  previewKeep: number;
  /** Cursor must rest this long before the full-res zoom layer warms. */
  hiResSettleMs: number;
  /** Parallel-restore XMP sidecars during analyze (sent to the backend). */
  concurrentRestore: boolean;
  /** Max simultaneous background-fill thumbnail reads (book-order sweep). */
  backgroundFillConcurrency: number;
  /** Full-res previews to prefetch on each side of the cursor once it settles,
   *  so a single tap to a neighbour is already decoded (no on-demand wait). Kept
   *  ≤ previewKeep so prefetched fulls aren't immediately evicted. 0 disables. */
  fullPrefetchRadius: number;
};

export const PERFORMANCE_PROFILES: Record<StorageMode, PerformanceProfile> = {
  network: {
    bundleConcurrency: 3,
    thumbConcurrency: 4,
    previewKeep: 18,
    hiResSettleMs: 150,
    concurrentRestore: false,
    backgroundFillConcurrency: 2,
    fullPrefetchRadius: 3,
  },
  local: {
    bundleConcurrency: 12,
    thumbConcurrency: 16,
    previewKeep: 30,
    hiResSettleMs: 50,
    concurrentRestore: true,
    backgroundFillConcurrency: 8,
    fullPrefetchRadius: 6,
  },
};
