import type { TierError } from "./tierErrors";

/**
 * TierLane (grand cleanup Phase 8): the one copy of the pump/load/evict
 * mechanics that used to exist as four ~85%-identical quads in imageStore
 * (thumb / bg / nav preview / zoom / mid). The lane owns the QUAD MECHANICS
 * only — queue admission, single-flight dedup, the concurrency counter, the
 * generation-scoped completion, and windowed eviction. Everything
 * tier-SPECIFIC (success/error interiors, hint plumbing, sentinel handling,
 * scheduling policy) stays with the store and is injected.
 *
 * Concurrency-correctness invariants (verbatim from the old quads):
 *  - Every in-flight counter decrement is generation-scoped: a load whose
 *    generation has been superseded by reset()/hardReset() does NOT touch the
 *    current-session counter (otherwise late decrements drive it negative,
 *    permanently defeating the concurrency cap).
 *  - At most ONE in-flight load per path (`inFlightPaths` + `requested`), so
 *    an evict-then-re-request mid-flight cannot start a duplicate NAS fetch
 *    or revoke a url still referenced by a live snapshot.
 *  - `inFlightPaths.delete` in run() is UNCONDITIONAL (path-keyed state must
 *    not leak even for a superseded load); the counter decrement is not.
 */

export type TierLaneDeps<E extends { status: string; url?: string } | undefined> = {
  /** Live concurrency cap (profile can change mid-session). */
  cap: () => number;
  /** Live session generation (captured per run, re-checked at completion). */
  generation: () => number;
  /** "Already have it — don't re-fetch." (thumbs.has / status === "ready") */
  isReady: (path: string) => boolean;
  /** Windowed lanes: set the tier's {status:"loading"} + notify. */
  markLoading?: (path: string) => void;
  /**
   * The tier-specific load interior: fetch + success/error handling, WITHOUT
   * the generation-scoped finally — run() owns that.
   */
  fetch: (path: string, gen: number) => Promise<void>;
  /** Completion pumps, run ONLY when the generation still matches. */
  afterSettle: () => void;
  /** bg lane: scheduling-policy gates re-checked before every start. */
  canStart?: () => boolean;
  /** bg lane: candidate picker (index into queue; -1 = nothing eligible). */
  pick?: () => number;
  /** Share the store's request-marker set (thumb + bg share one). */
  requested?: Set<string>;
  /** Share the store's per-path in-flight set (other subsystems read it). */
  inFlightPaths?: Set<string>;
  /** Share the store's per-tier error map (retry/rearm/cooldown read it). */
  errors?: Map<string, TierError>;
  /** Windowed eviction (nav/zoom/mid): the tier's blob cache. */
  cache?: Map<string, E>;
  /** Windowed eviction: the lane's OWN protection predicate (window radius
   *  included). in-flight and non-ready entries are skipped mechanically. */
  isEvictionProtected?: (path: string, centerIndex: number) => boolean;
  /** Windowed eviction: per-victim bookkeeping (evict counter + invalidate). */
  onEvict?: (path: string) => void;
};

export class TierLane<E extends { status: string; url?: string } | undefined = undefined> {
  queue: string[] = [];
  inFlight = 0;
  readonly requested: Set<string>;
  readonly inFlightPaths: Set<string>;
  readonly errors: Map<string, TierError>;

  constructor(private readonly deps: TierLaneDeps<E>) {
    this.requested = deps.requested ?? new Set();
    this.inFlightPaths = deps.inFlightPaths ?? new Set();
    this.errors = deps.errors ?? new Map<string, TierError>();
  }

  pump(): void {
    const { deps } = this;
    while (
      this.inFlight < deps.cap() &&
      this.queue.length > 0 &&
      (!deps.canStart || deps.canStart())
    ) {
      let path: string;
      if (deps.pick) {
        const k = deps.pick();
        if (k === -1) break; // every remaining candidate is ineligible
        path = this.queue.splice(k, 1)[0];
      } else {
        path = this.queue.shift()!;
      }
      // single-flight per path — never start a second load while one is
      // already in flight (the guard lives here, before the counter is
      // touched, so accounting stays perfectly balanced).
      if (deps.isReady(path)) continue;
      if (this.requested.has(path) || this.inFlightPaths.has(path)) continue;
      this.requested.add(path);
      this.inFlightPaths.add(path);
      deps.markLoading?.(path);
      this.inFlight++;
      void this.run(path);
    }
  }

  private async run(path: string): Promise<void> {
    const gen = this.deps.generation();
    try {
      await this.deps.fetch(path, gen);
    } finally {
      // clear the in-flight marker regardless of generation (it's path-keyed
      // and must not leak even for a superseded load).
      this.inFlightPaths.delete(path);
      // gen-scoped counter decrement + pumps.
      if (this.deps.generation() === gen) {
        this.inFlight--;
        this.deps.afterSettle();
      }
    }
  }

  /**
   * Evict READY entries whose protection predicate rejects them, revoking
   * their blob URLs — the one copy of the old evictFullAround /
   * evictZoomAround / evictMidAround loops (REVOKE SITES 2, 10, 12).
   * In-flight and non-ready entries are always skipped.
   */
  evictAround(centerIndex: number): void {
    const { cache, isEvictionProtected, onEvict } = this.deps;
    if (!cache || !isEvictionProtected) return;
    if (centerIndex < 0) return;
    for (const [p, state] of cache) {
      if (state?.status !== "ready") continue;
      if (this.inFlightPaths.has(p)) continue;
      if (isEvictionProtected(p, centerIndex)) continue;
      if (state.url !== undefined) URL.revokeObjectURL(state.url);
      cache.delete(p);
      this.requested.delete(p);
      onEvict?.(p);
    }
  }

  /** Session change: cancel queued work, drop markers/errors, zero the
   *  counter (safe — run()'s decrement is generation-scoped). */
  reset(): void {
    this.queue = [];
    this.requested.clear();
    this.inFlightPaths.clear();
    this.inFlight = 0;
    this.errors.clear();
  }
}

/**
 * Refcounted path set — the one copy of the wantFull / displayRefs /
 * pinnedFulls trios. A count (not a bare Set) so two consumers registering
 * the same path don't lose protection when only one unregisters.
 * `has(p)` ⟺ count > 0 (entries are deleted at 0).
 */
export class RefCountMap {
  private counts = new Map<string, number>();

  inc(path: string): void {
    this.counts.set(path, (this.counts.get(path) ?? 0) + 1);
  }

  dec(path: string): void {
    const n = this.counts.get(path);
    if (n === undefined) return;
    if (n <= 1) this.counts.delete(path);
    else this.counts.set(path, n - 1);
  }

  has(path: string): boolean {
    return this.counts.has(path);
  }

  keys(): IterableIterator<string> {
    return this.counts.keys();
  }

  clear(): void {
    this.counts.clear();
  }
}
