/**
 * imageStore — framework-agnostic subscription store for per-path image state.
 *
 * Consumed via `useSyncExternalStore` in `useImage`. Owns:
 *  - all-session in-memory thumb cache (blob URLs, ~15 000-entry LRU cap)
 *  - windowed full-res cache (blob URLs, bounded by previewKeep)
 *  - bounded-concurrency priority queue for on-demand + background-fill fetches
 *  - per-path subscriber notification
 *  - blob-URL lifecycle (every createObjectURL has exactly one revokeObjectURL)
 *
 * Blob-URL revoke sites:
 *  1. loadThumbInto — when LRU cap evicts an old thumb entry
 *  2. evictFull — when a full-res entry is evicted from the windowed cache
 *  3. loadFull — when a full-res entry is REPLACED by a fresher one (no double-keep)
 *  4. hardReset — revokes ALL thumb + full blob URLs (folder change / session end)
 *  5. reset(paths) — revokes full-res for all tracked paths; thumbs are kept
 *
 * Concurrency-correctness invariants (see fixes C1/C3/C4):
 *  - Every in-flight counter decrement is generation-scoped: a load whose
 *    generation has been superseded by reset()/hardReset() does NOT touch the
 *    current-session counters (otherwise late decrements drive them negative,
 *    permanently defeating the concurrency cap).
 *  - At most ONE in-flight loadFull per path (tracked in `fullInFlightPaths`),
 *    so an evict-then-re-request mid-flight cannot start a duplicate NAS fetch
 *    or revoke a url that is still referenced by a live snapshot.
 */

import { fetchBundle, fetchThumbnail } from "../utils/bundle";
import type { PerformanceProfile } from "../types/settings";
import { PERFORMANCE_PROFILES } from "../types/settings";
import { resolveStage, type ImageState, type Resolved } from "./stage";
import type { ImageDims } from "../utils/bundle";

// ── Types ──────────────────────────────────────────────────────────────────

type ThumbEntry = { url: string; dims: ImageDims };

/** All-session thumb LRU cap (loadThumb + loadBg share this — M1). */
const THUMB_LRU_CAP = 15000;

/** Placeholder dims used before real dimensions are known (M5). */
const UNKNOWN_DIMS: ImageDims = { w: 1, h: 1 };

/** Max transient-failure retries before a path is left as shimmer (I6). */
const MAX_THUMB_ATTEMPTS = 3;

/** Constructor options (test-only knobs kept minimal). */
export type ImageStoreOptions = {
  /** Override the thumb LRU cap (test-only — exercise eviction with a small N). */
  thumbLruCap?: number;
};

/** Which in-flight counter a thumb load services. */
type ThumbLane = "thumb" | "bg";

// ── ImageStore ─────────────────────────────────────────────────────────────

export class ImageStore {
  // ── Session-persistent thumb cache (all-session, ~15 000-entry LRU cap) ──
  private thumbs = new Map<string, ThumbEntry>();
  // ── Windowed full-res cache ────────────────────────────────────────────
  private fulls = new Map<string, ImageState["full"]>();
  // ── Snapshot cache: per-path stable Resolved object ───────────────────
  //    Updated ONLY when that path's ImageState actually changes.
  private snaps = new Map<string, Resolved>();
  // ── Per-path raw ImageState (source of truth for resolveStage) ────────
  private states = new Map<string, ImageState>();
  // ── Subscribers ────────────────────────────────────────────────────────
  private subs = new Map<string, Set<() => void>>();
  // ── Request tracking (prevent duplicate fetches) ───────────────────────
  private requestedThumb = new Set<string>();
  private requestedFull = new Set<string>();
  /** Paths whose loadFull is in flight RIGHT NOW (C3: single-flight fulls). */
  private fullInFlightPaths = new Set<string>();
  private wantFull = new Set<string>();
  /** Per-path transient thumb-failure attempt counter (I6). */
  private thumbAttempts = new Map<string, number>();
  // ── Concurrency counters ───────────────────────────────────────────────
  private thumbInFlight = 0;
  private fullInFlight = 0;
  private bgInFlight = 0;
  // ── Queues ─────────────────────────────────────────────────────────────
  /** On-demand thumb requests (highest priority) */
  private thumbQueue: string[] = [];
  /** On-demand full-res requests */
  private fullQueue: string[] = [];
  /** Background-fill book-order queue */
  private bgQueue: string[] = [];
  // ── Ordered list of all paths (for background fill + eviction) ─────────
  private paths: string[] = [];
  /** path → index in `paths`, rebuilt in reset() for O(1) lookups (I2). */
  private pathIndex = new Map<string, number>();
  private cursor = 0;
  private gridStart = 0;
  private gridEnd = 0;
  // ── Session generation counter (cancellation) ─────────────────────────
  private generation = 0;
  // ── Performance profile ────────────────────────────────────────────────
  private profile: PerformanceProfile = PERFORMANCE_PROFILES.local;
  // ── Tunables ─────────────────────────────────────────────────────────────
  private readonly thumbLruCap: number;

  constructor(opts: ImageStoreOptions = {}) {
    this.thumbLruCap = opts.thumbLruCap ?? THUMB_LRU_CAP;
  }

  // ── Public API ─────────────────────────────────────────────────────────

  setProfile(p: PerformanceProfile): void {
    this.profile = p;
    this.pumpThumbs();
    this.pumpFull();
    this.pumpBg();
  }

  /**
   * Called when a new folder is opened. Revokes ALL full-res blob URLs (windowed
   * cache), keeps thumbs (session cache). Resets queues + scheduling state.
   */
  reset(newPaths: string[]): void {
    this.generation++;
    const gen = this.generation;

    // Cancel queued work
    this.thumbQueue = [];
    this.fullQueue = [];
    this.bgQueue = [];
    this.wantFull.clear();
    this.requestedFull.clear();
    // C4: old-gen thumb loads bailed without populating `thumbs`; if we keep
    // their paths in requestedThumb they'd be excluded from bg-fill forever
    // (permanent shimmer). Clear it so the new session can re-schedule them.
    this.requestedThumb.clear();
    this.thumbAttempts.clear();

    // C1: zero in-flight counters. Late decrements from superseded loads are
    // now gen-scoped (they no-op), so zeroing here can't be driven negative.
    this.thumbInFlight = 0;
    this.fullInFlight = 0;
    this.bgInFlight = 0;
    this.fullInFlightPaths.clear();

    // Revoke all full-res blob URLs — REVOKE SITE 5
    for (const [, state] of this.fulls) {
      if (state?.status === "ready") {
        URL.revokeObjectURL(state.url);
      }
    }
    this.fulls.clear();

    // Clear per-path state and snapshots
    this.states.clear();
    this.snaps.clear();

    // Notify all current subscribers that state has been cleared
    for (const [path, cbs] of this.subs) {
      // Only re-notify if they're in the new path set
      if (cbs.size > 0) {
        this.invalidate(path);
      }
    }

    this.paths = newPaths;
    this.rebuildPathIndex();
    this.cursor = 0;
    this.gridStart = 0;
    this.gridEnd = 0;

    // Enqueue background fill for new paths (only if generation still current)
    this.scheduleBgFill(gen);
    // Re-pump every lane so the new session starts loading immediately.
    this.pumpThumbs();
    this.pumpFull();
    this.pumpBg();
  }

  /**
   * Hard reset: revokes ALL blob URLs (thumbs + full-res). Called on
   * session end or when switching to a completely new session.
   */
  hardReset(): void {
    this.generation++;

    this.thumbQueue = [];
    this.fullQueue = [];
    this.bgQueue = [];
    this.wantFull.clear();
    this.requestedThumb.clear();
    this.requestedFull.clear();
    this.fullInFlightPaths.clear();
    this.thumbAttempts.clear();
    // C1: gen-scoped finally blocks make zeroing safe (no negative drift).
    this.thumbInFlight = 0;
    this.fullInFlight = 0;
    this.bgInFlight = 0;

    // Revoke all full-res blob URLs — REVOKE SITE 4a
    for (const [, state] of this.fulls) {
      if (state?.status === "ready") {
        URL.revokeObjectURL(state.url);
      }
    }
    this.fulls.clear();

    // Revoke all thumb blob URLs — REVOKE SITE 4b
    for (const [, entry] of this.thumbs) {
      URL.revokeObjectURL(entry.url);
    }
    this.thumbs.clear();

    this.states.clear();
    this.snaps.clear();
    this.paths = [];
    this.pathIndex.clear();
    this.cursor = 0;
    this.gridStart = 0;
    this.gridEnd = 0;
  }

  setCursor(index: number): void {
    this.cursor = index;
    // I3: full-res eviction is cursor-driven — recenter the keep-window on the
    // cursor even when no new full just landed (parking on a frame recenters).
    this.evictFullAround(index);
    this.rescheduleBg();
    this.pumpFull();
  }

  setGridRange(start: number, end: number): void {
    this.gridStart = start;
    this.gridEnd = end;
    this.rescheduleBg();
  }

  private rebuildPathIndex(): void {
    this.pathIndex.clear();
    for (let i = 0; i < this.paths.length; i++) {
      this.pathIndex.set(this.paths[i], i);
    }
  }

  /** O(1) path→index lookup; -1 if not tracked (I2). */
  private indexOf(path: string): number {
    const i = this.pathIndex.get(path);
    return i === undefined ? -1 : i;
  }

  private rescheduleBg(): void {
    // Re-sort the remaining bg queue entries using the updated cursor/grid range.
    const cursor = this.cursor;
    const gridStart = this.gridStart;
    const gridEnd = this.gridEnd;
    this.bgQueue.sort((a, b) => {
      const ai = this.indexOf(a);
      const bi = this.indexOf(b);
      const aInGrid = ai >= gridStart && ai <= gridEnd ? 0 : 1;
      const bInGrid = bi >= gridStart && bi <= gridEnd ? 0 : 1;
      if (aInGrid !== bInGrid) return aInGrid - bInGrid;
      return Math.abs(ai - cursor) - Math.abs(bi - cursor);
    });
    this.pumpBg();
  }

  registerWantFull(path: string): void {
    this.wantFull.add(path);
    if (!this.requestedFull.has(path)) {
      this.fullQueue.unshift(path); // high priority: front of queue
      this.pumpFull();
      return;
    }
    // I4: already requested. If it's still queued (not yet in flight), promote
    // it to the FRONT so a landed-on frame preempts queued prefetch fulls.
    if (!this.fullInFlightPaths.has(path)) {
      const qi = this.fullQueue.indexOf(path);
      if (qi > 0) {
        this.fullQueue.splice(qi, 1);
        this.fullQueue.unshift(path);
        this.pumpFull();
      }
    }
    // If already in flight, nothing to do.
  }

  unregisterWantFull(path: string): void {
    this.wantFull.delete(path);
  }

  requestThumbFor(path: string): void {
    if (this.requestedThumb.has(path) || this.thumbs.has(path)) return;
    this.thumbQueue.push(path);
    this.pumpThumbs();
  }

  subscribe(path: string, cb: () => void): () => void {
    if (!this.subs.has(path)) this.subs.set(path, new Set());
    this.subs.get(path)!.add(cb);
    return () => {
      this.subs.get(path)?.delete(cb);
    };
  }

  /**
   * Returns a STABLE Resolved object for `path`. The same object reference is
   * returned on every call as long as the underlying ImageState has not changed.
   * This is required by useSyncExternalStore to avoid infinite re-render loops.
   */
  snapshot(path: string): Resolved {
    if (this.snaps.has(path)) {
      return this.snaps.get(path)!;
    }
    const state = this.buildState(path);
    const resolved = resolveStage(state);
    this.snaps.set(path, resolved);
    return resolved;
  }

  // ── Private helpers ────────────────────────────────────────────────────

  private buildState(path: string): ImageState {
    const cached = this.states.get(path);
    if (cached) return cached;
    return {
      thumb: this.thumbs.get(path),
      full: this.fulls.get(path),
    };
  }

  /**
   * Recompute and cache the ImageState + Resolved snapshot for `path`.
   * If the new Resolved differs from the cached one, notify subscribers.
   */
  private invalidate(path: string): void {
    const newState: ImageState = {
      thumb: this.thumbs.get(path),
      full: this.fulls.get(path),
    };
    this.states.set(path, newState);
    const newResolved = resolveStage(newState);
    const old = this.snaps.get(path);
    // Only replace the cached snap (and notify) if something actually changed.
    if (
      !old ||
      old.stage !== newResolved.stage ||
      old.url !== newResolved.url ||
      old.error !== newResolved.error ||
      old.dims?.w !== newResolved.dims?.w ||
      old.dims?.h !== newResolved.dims?.h
    ) {
      this.snaps.set(path, newResolved);
      this.notify(path);
    }
  }

  private notify(path: string): void {
    this.subs.get(path)?.forEach((cb) => cb());
  }

  // ── Thumb pump ─────────────────────────────────────────────────────────

  private pumpThumbs(): void {
    while (
      this.thumbInFlight < this.profile.thumbConcurrency &&
      this.thumbQueue.length > 0
    ) {
      const path = this.thumbQueue.shift()!;
      if (this.requestedThumb.has(path) || this.thumbs.has(path)) continue;
      this.requestedThumb.add(path);
      this.thumbInFlight++;
      void this.loadThumbInto("thumb", path);
    }
  }

  /**
   * Shared thumb loader for both the on-demand lane and the background-fill
   * lane (M2). Differs only in which in-flight counter it touches, kept in the
   * `lane` parameter so the C1/C4/I6 logic lives in exactly one place.
   */
  private async loadThumbInto(lane: ThumbLane, path: string): Promise<void> {
    const gen = this.generation;
    try {
      const result = await fetchThumbnail(path);
      if (this.generation !== gen) {
        // Session changed while in-flight — revoke the freshly created blob.
        URL.revokeObjectURL(result.url);
        return;
      }
      const dims: ImageDims = {
        w: result.width ?? UNKNOWN_DIMS.w,
        h: result.height ?? UNKNOWN_DIMS.h,
      };
      this.thumbs.set(path, { url: result.url, dims });
      this.thumbAttempts.delete(path);
      this.enforceThumbLru(path);
      this.invalidate(path);
    } catch {
      // I6: transient failure — drop the request marker so it can be retried,
      // but cap retries so a genuinely-missing THMB doesn't hot-loop. Only act
      // for the current generation (a superseded load must not touch state).
      if (this.generation === gen) {
        const attempts = (this.thumbAttempts.get(path) ?? 0) + 1;
        this.thumbAttempts.set(path, attempts);
        if (attempts < MAX_THUMB_ATTEMPTS) {
          this.requestedThumb.delete(path);
        }
        // else: leave it requested → stays shimmer, no further retries.
      }
    } finally {
      // C1: gen-scoped decrement. A superseded load must NOT touch the current
      // session's counters (reset/hardReset already zeroed them).
      if (this.generation === gen) {
        if (lane === "thumb") this.thumbInFlight--;
        else this.bgInFlight--;
        this.pumpThumbs();
        this.pumpBg();
      }
    }
  }

  /** LRU cap enforcement, shared by both thumb lanes — REVOKE SITE 1. */
  private enforceThumbLru(justLoaded: string): void {
    if (this.thumbs.size <= this.thumbLruCap) return;
    const oldest = this.thumbs.keys().next().value;
    if (oldest !== undefined && oldest !== justLoaded) {
      const v = this.thumbs.get(oldest);
      if (v) URL.revokeObjectURL(v.url);
      this.thumbs.delete(oldest);
      this.requestedThumb.delete(oldest);
      this.invalidate(oldest);
    }
  }

  // ── Full-res pump ───────────────────────────────────────────────────────

  private pumpFull(): void {
    while (
      this.fullInFlight < this.profile.bundleConcurrency &&
      this.fullQueue.length > 0
    ) {
      const path = this.fullQueue.shift()!;
      // C3: single-flight per path — never start a second loadFull while one is
      // already in flight for this path (the guard lives here, before the
      // counter is touched, so accounting stays perfectly balanced).
      if (this.requestedFull.has(path) || this.fullInFlightPaths.has(path)) {
        continue;
      }
      // Already have a ready full — don't re-fetch.
      const prev = this.fulls.get(path);
      if (prev?.status === "ready") continue;
      this.requestedFull.add(path);
      this.fullInFlightPaths.add(path);
      this.fulls.set(path, { status: "loading" });
      this.invalidate(path);
      this.fullInFlight++;
      void this.loadFull(path);
    }
  }

  private async loadFull(path: string): Promise<void> {
    // C3: `pumpFull` has already added `path` to `fullInFlightPaths` and
    // guarantees this is the only in-flight loadFull for it.
    const gen = this.generation;
    try {
      const result = await fetchBundle(path);
      if (this.generation !== gen) {
        // Stale session — revoke the freshly created blob
        URL.revokeObjectURL(result.previewUrl);
        return;
      }
      // If there was already a ready full-res (race), revoke the old one — REVOKE SITE 3
      const existing = this.fulls.get(path);
      if (existing?.status === "ready") {
        URL.revokeObjectURL(existing.url);
      }
      // Use thumb dims as authoritative aspect (orientation-adjusted)
      const thumbEntry = this.thumbs.get(path);
      const dims: ImageDims = thumbEntry?.dims ?? UNKNOWN_DIMS;
      this.fulls.set(path, { status: "ready", url: result.previewUrl, dims });
      this.invalidate(path);
      // I3: also recenter the keep-window on the CURSOR (not just-loaded), so
      // eviction tracks where the user is, not where the last load happened.
      this.evictFullAround(this.cursor);
    } catch (e) {
      if (this.generation !== gen) return;
      const msg = e instanceof Error ? e.message : String(e);
      this.fulls.set(path, { status: "error", error: msg });
      this.invalidate(path);
    } finally {
      // C3: clear in-flight marker regardless of generation (it's path-keyed
      // and must not leak even for a superseded load).
      this.fullInFlightPaths.delete(path);
      // C1: gen-scoped counter decrement + pumps.
      if (this.generation === gen) {
        this.fullInFlight--;
        this.pumpFull();
        // I1: finishing the last on-demand full must wake the bg sweep.
        this.pumpBg();
      }
    }
  }

  /**
   * Evict full-res entries that are far from `centerIndex`, keeping at most
   * `previewKeep` on each side. Revokes their blob URLs. — REVOKE SITE 2.
   * Cursor-driven (I3): callable from setCursor and after a load.
   */
  private evictFullAround(centerIndex: number): void {
    if (centerIndex < 0) return;
    const keep = this.profile.previewKeep;
    for (const [p, state] of this.fulls) {
      if (state?.status !== "ready") continue;
      const idx = this.indexOf(p);
      if (idx === -1) continue;
      if (Math.abs(idx - centerIndex) > keep) {
        URL.revokeObjectURL(state.url);
        this.fulls.delete(p);
        this.requestedFull.delete(p);
        this.invalidate(p);
      }
    }
  }

  evictFull(path: string): void {
    const state = this.fulls.get(path);
    if (state?.status === "ready") {
      URL.revokeObjectURL(state.url); // REVOKE SITE 2 (direct eviction)
    }
    this.fulls.delete(path);
    // C3: do NOT drop requestedFull while a loadFull is still in flight for
    // this path, or a re-request would start a duplicate fetch.
    if (!this.fullInFlightPaths.has(path)) {
      this.requestedFull.delete(path);
    }
    this.invalidate(path);
  }

  // ── Background-fill pump ────────────────────────────────────────────────

  private scheduleBgFill(gen: number): void {
    if (this.generation !== gen) return;
    // Build the background queue using cursor-outward / grid-viewport-first order.
    // Paths inside the grid viewport come first, then cursor-outward for the rest.
    const unloaded = this.paths.filter(
      (p) => !this.thumbs.has(p) && !this.requestedThumb.has(p),
    );
    // Sort: grid viewport first, then by distance from cursor
    const cursor = this.cursor;
    const gridStart = this.gridStart;
    const gridEnd = this.gridEnd;
    this.bgQueue = unloaded.sort((a, b) => {
      const ai = this.indexOf(a);
      const bi = this.indexOf(b);
      const aInGrid = ai >= gridStart && ai <= gridEnd ? 0 : 1;
      const bInGrid = bi >= gridStart && bi <= gridEnd ? 0 : 1;
      if (aInGrid !== bInGrid) return aInGrid - bInGrid;
      return Math.abs(ai - cursor) - Math.abs(bi - cursor);
    });
    this.pumpBg();
  }

  private pumpBg(): void {
    const cap = this.profile.backgroundFillConcurrency;
    while (
      this.bgInFlight < cap &&
      // On-demand thumbs + on-demand full take priority — don't start new bg
      // work if there are higher-priority items queued
      this.thumbQueue.length === 0 &&
      this.fullQueue.length === 0 &&
      this.bgQueue.length > 0
    ) {
      const path = this.bgQueue.shift()!;
      if (this.thumbs.has(path) || this.requestedThumb.has(path)) continue;
      this.requestedThumb.add(path);
      this.bgInFlight++;
      void this.loadThumbInto("bg", path);
    }
  }
}

export const imageStore = new ImageStore();
