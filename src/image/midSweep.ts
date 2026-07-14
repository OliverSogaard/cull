/**
 * Mid-tier idle sweep (grand cleanup Phase 8, split from imageStore — the
 * scheduler logic verbatim, touchpoints injected so it unit-tests standalone).
 *
 * Pre-generates mids nearest-to-cursor while the session is idle, so every
 * settled view on a high-DPI display is eventually a cache hit. Gates:
 * LOCAL profile only (the backend refuses otherwise — generating from a
 * NAS would fetch fulls solely to generate, the hard rule), display
 * actually engaged (a 1440p session must not burn CPU + 4 GB of disk on
 * mids it never shows), first-full window respected (bgStarted), paused
 * while any on-demand lane has work. Each path is attempted once per
 * session; failures are best-effort quiet (read_mid covers on-demand).
 */

/** The idle sweep waits for this much cursor quiet before (re)starting —
 *  warm-region navigation and scrubbing issue zero reads, so the on-demand
 *  queues alone can't tell "user active" from "user parked" (review F3). */
export const MID_SWEEP_QUIET_MS = 1500;

/** Sweep budget: the mid tier's disk cap (4 GiB, low-water 90%) over a
 *  realistic ~1.05 MB q80 entry ≈ 3,500 entries — sweeping past it would
 *  LRU-evict the user's own working neighbourhood to write far-end mids
 *  (review F1). Nearest-cursor-first ordering makes the budget cover the
 *  frames that matter; on-demand read_mid still serves anything beyond it. */
const MID_SWEEP_BUDGET = 3400;

type MidHintArgs = {
  fullOffset: number | null;
  fullLen: number | null;
  orientation: number | null;
};

export type MidSweepDeps = {
  /** The store-side gates checked at every pump: NOT folder-trouble, NOT
   *  mid-unsupported, local profile, bgStarted, display engaged. */
  canSweep: () => boolean;
  /** True while every on-demand lane is empty AND idle — the sweep's gate
   *  (the plan: "paused while any on-demand queue is non-empty"; the bg
   *  thumb sweep is background, not on-demand, and doesn't pause it). */
  onDemandIdle: () => boolean;
  /** profile.midGenConcurrency, read live (profile can change mid-session). */
  concurrency: () => number;
  paths: () => readonly string[];
  cursor: () => number;
  /** Skip paths whose mid is already cached-ready in the store. */
  isMidReady: (path: string) => boolean;
  /** Exact-range hint + orientation from the preview header, if landed. */
  hintFor: (path: string) => MidHintArgs;
  /** Live session generation — captured per sweep, re-checked at completion. */
  generation: () => number;
  /** invokeGenerateMid, injected for standalone testing. */
  generate: (path: string, gen: number, hint: MidHintArgs) => Promise<boolean>;
  /** Fired per confirmed generation (the dev-HUD midGens counter). */
  onGenerated: () => void;
};

export class MidSweep {
  /** Paths already attempted this session (success OR failure — best-effort,
   *  one shot each; on-demand read_mid still covers misses). */
  private done = new Set<string>();
  private inFlight = 0;
  /** Last cursor move (any kind) — the sweep waits out MID_SWEEP_QUIET_MS of
   *  cursor quiet so warm-region arrowing / scrubbing (which issue no reads)
   *  don't share the CPU with generation. */
  private lastCursorMoveAt = 0;
  /** One-shot re-pump timer for the quiet window (armed at most once). */
  private timerArmed = false;
  private readonly budget: number;

  constructor(
    private readonly deps: MidSweepDeps,
    /** Test-only override (exercise the budget stop with a small N). */
    budget = MID_SWEEP_BUDGET,
  ) {
    this.budget = budget;
  }

  /** setCursor feeds this — any cursor move restarts the quiet window. */
  noteCursorMove(): void {
    this.lastCursorMoveAt = Date.now();
  }

  /** Session change (reset/hardReset): every path gets a fresh attempt. The
   *  in-flight counter zeroes safely — completions are generation-scoped. */
  reset(): void {
    this.done.clear();
    this.inFlight = 0;
  }

  /** Attempted-this-session count (budget input + the dev-HUD sweepLeft). */
  get doneSize(): number {
    return this.done.size;
  }

  pump(): void {
    if (!this.deps.canSweep()) return;
    // Disk budget (review F1): past ~the tier cap's worth of entries, more
    // sweeping only LRU-evicts the working neighbourhood's own mids.
    if (this.done.size >= this.budget) return;
    // Cursor quiet (review F3): warm-region arrowing and scrubbing issue no
    // reads, so the on-demand-idle check alone can't see the user — wait out
    // a quiet window and re-pump from a one-shot timer.
    if (Date.now() - this.lastCursorMoveAt < MID_SWEEP_QUIET_MS) {
      this.armTimer();
      return;
    }
    while (this.inFlight < this.deps.concurrency() && this.deps.onDemandIdle()) {
      const path = this.pick();
      if (!path) return;
      this.done.add(path);
      this.inFlight++;
      void this.sweep(path);
    }
  }

  /** One-shot quiet-window re-pump (gen-scoped; at most one armed timer). */
  private armTimer(): void {
    if (this.timerArmed) return;
    this.timerArmed = true;
    const gen = this.deps.generation();
    setTimeout(() => {
      this.timerArmed = false;
      if (this.deps.generation() === gen) this.pump();
    }, MID_SWEEP_QUIET_MS);
  }

  /** Nearest-to-cursor argmin over not-yet-attempted paths (pickBg's style). */
  private pick(): string | null {
    const paths = this.deps.paths();
    const cursor = this.deps.cursor();
    let best: string | null = null;
    let bestD = Infinity;
    for (let i = 0; i < paths.length; i++) {
      const p = paths[i];
      if (this.done.has(p)) continue;
      if (this.deps.isMidReady(p)) continue;
      const d = Math.abs(i - cursor);
      if (d < bestD) {
        best = p;
        bestD = d;
      }
    }
    return best;
  }

  private async sweep(path: string): Promise<void> {
    const gen = this.deps.generation();
    try {
      const ok = await this.deps.generate(path, gen, this.deps.hintFor(path));
      if (this.deps.generation() === gen && ok) this.deps.onGenerated();
    } catch {
      // Best-effort: attempted once; on-demand read_mid still covers it.
    } finally {
      if (this.deps.generation() === gen) {
        this.inFlight--;
        this.pump();
      }
    }
  }
}
