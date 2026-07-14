import { basename } from "../utils/path";

/**
 * Dev-HUD stats (grand cleanup Phase 8, split from imageStore): the timing
 * ring buffers and cheap counters behind `debugStats()`. Every profile-tuning
 * claim cites these numbers, not feel. The store's `debugStats()` remains the
 * aggregator (it reads live lane/cache state this module has no business
 * owning); this class owns the data that isn't a live read.
 *
 * The old inline name extraction double-sliced with indexes computed on the
 * ORIGINAL path (`slice(lastIndexOf("/")+1).slice(lastIndexOf("\\")+1)`),
 * which mangled mixed-separator paths ("C:/a\\b.CR3" → "CR3"). It now uses
 * the shared both-separator `basename` from utils/path.
 */

/** Ring-buffer length for both timing lists. */
const TIMING_RING_CAP = 20;

export type TimingEntry = { name: string; ms: number };

export class DevStats {
  /** Ring buffer of the last nav fetch timings (newest first). */
  navTimings: TimingEntry[] = [];
  /** Zoom-tier (full) fetch timings — on a fast local drive this is ≈ the raw
   *  IPC transfer cost of the ~10 MB full, i.e. the Phase 2 Windows
   *  benchmark readout. */
  zoomTimings: TimingEntry[] = [];
  counts = {
    navLoads: 0,
    zoomLoads: 0,
    thumbLoads: 0,
    midLoads: 0,
    midGens: 0,
    previewEvicts: 0,
    zoomEvicts: 0,
    midEvicts: 0,
    errors: 0,
  };

  noteNavTiming(path: string, ms: number): void {
    this.counts.navLoads++;
    this.navTimings.unshift({ name: basename(path), ms: Math.round(ms) });
    if (this.navTimings.length > TIMING_RING_CAP) this.navTimings.pop();
  }

  noteZoomTiming(path: string, ms: number): void {
    this.zoomTimings.unshift({ name: basename(path), ms: Math.round(ms) });
    if (this.zoomTimings.length > TIMING_RING_CAP) this.zoomTimings.pop();
  }

  /** hardReset drops the timing rings (counts survive — session totals). */
  clearTimings(): void {
    this.navTimings = [];
    this.zoomTimings = [];
  }

  navMsAvg(): number {
    return this.navTimings.length === 0
      ? 0
      : Math.round(this.navTimings.reduce((a, t) => a + t.ms, 0) / this.navTimings.length);
  }
}
