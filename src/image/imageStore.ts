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
 *  1. loadThumb — when LRU cap evicts an old thumb entry
 *  2. evictFull — when a full-res entry is evicted from the windowed cache
 *  3. loadFull — when a full-res entry is REPLACED by a fresher one (no double-keep)
 *  4. hardReset — revokes ALL thumb + full blob URLs (folder change / session end)
 *  5. reset(paths) — revokes full-res for all tracked paths; thumbs are kept
 */

import { fetchBundle, fetchThumbnail } from "../utils/bundle";
import type { PerformanceProfile } from "../types/settings";
import { PERFORMANCE_PROFILES } from "../types/settings";
import { resolveStage, type ImageState, type Resolved } from "./stage";
import type { ImageDims } from "../utils/bundle";

// ── Types ──────────────────────────────────────────────────────────────────

type ThumbEntry = { url: string; dims: ImageDims };

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
  private wantFull = new Set<string>();
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
  private cursor = 0;
  private gridStart = 0;
  private gridEnd = 0;
  // ── Session generation counter (cancellation) ─────────────────────────
  private generation = 0;
  // ── Performance profile ────────────────────────────────────────────────
  private profile: PerformanceProfile = PERFORMANCE_PROFILES.local;

  // ── Public API ─────────────────────────────────────────────────────────

  setProfile(p: PerformanceProfile): void {
    this.profile = p;
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
    this.cursor = 0;
    this.gridStart = 0;
    this.gridEnd = 0;

    // Enqueue background fill for new paths (only if generation still current)
    this.scheduleBgFill(gen);
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
    this.cursor = 0;
    this.gridStart = 0;
    this.gridEnd = 0;
  }

  setCursor(index: number): void {
    this.cursor = index;
    this.rescheduleBg();
    this.pumpFull();
  }

  setGridRange(start: number, end: number): void {
    this.gridStart = start;
    this.gridEnd = end;
    this.rescheduleBg();
  }

  private rescheduleBg(): void {
    // Re-sort the remaining bg queue entries using the updated cursor/grid range.
    const cursor = this.cursor;
    const gridStart = this.gridStart;
    const gridEnd = this.gridEnd;
    this.bgQueue.sort((a, b) => {
      const ai = this.paths.indexOf(a);
      const bi = this.paths.indexOf(b);
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
    }
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
      this.loadThumb(path);
    }
  }

  private async loadThumb(path: string): Promise<void> {
    const gen = this.generation;
    try {
      const result = await fetchThumbnail(path);
      if (this.generation !== gen) {
        // Session changed while in-flight — revoke the freshly created blob
        URL.revokeObjectURL(result.url);
        return;
      }
      const dims: ImageDims = {
        w: result.width ?? 1,
        h: result.height ?? 1,
      };
      this.thumbs.set(path, { url: result.url, dims });

      // LRU cap at 15 000 entries — REVOKE SITE 1
      if (this.thumbs.size > 15000) {
        const oldest = this.thumbs.keys().next().value;
        if (oldest !== undefined && oldest !== path) {
          const v = this.thumbs.get(oldest);
          if (v) URL.revokeObjectURL(v.url);
          this.thumbs.delete(oldest);
          this.requestedThumb.delete(oldest);
          this.invalidate(oldest);
        }
      }

      this.invalidate(path);
    } catch {
      // Thumb load failed — leave state as shimmer (no error promotion for thumbs)
    } finally {
      this.thumbInFlight--;
      this.pumpThumbs();
      this.pumpBg();
    }
  }

  // ── Full-res pump ───────────────────────────────────────────────────────

  private pumpFull(): void {
    while (
      this.fullInFlight < this.profile.bundleConcurrency &&
      this.fullQueue.length > 0
    ) {
      const path = this.fullQueue.shift()!;
      if (this.requestedFull.has(path)) continue;
      this.requestedFull.add(path);
      // Mark as loading
      const prev = this.fulls.get(path);
      if (prev?.status === "ready") {
        // Already have a full — don't re-fetch
        this.requestedFull.delete(path);
        continue;
      }
      this.fulls.set(path, { status: "loading" });
      this.invalidate(path);
      this.fullInFlight++;
      this.loadFull(path);
    }
  }

  private async loadFull(path: string): Promise<void> {
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
      const dims: ImageDims = thumbEntry?.dims ?? { w: 1, h: 1 };
      this.fulls.set(path, { status: "ready", url: result.previewUrl, dims });
      this.invalidate(path);
      this.evictOldFull(path);
    } catch (e) {
      if (this.generation !== gen) return;
      const msg = e instanceof Error ? e.message : String(e);
      this.fulls.set(path, { status: "error", error: msg });
      this.invalidate(path);
    } finally {
      this.fullInFlight--;
      this.pumpFull();
    }
  }

  /**
   * Evict full-res entries that are far from the cursor, keeping at most
   * `previewKeep` on each side. Revoking their blob URLs. — REVOKE SITE 2
   */
  private evictOldFull(justLoaded: string): void {
    const keep = this.profile.previewKeep;
    for (const [p, state] of this.fulls) {
      if (state?.status !== "ready") continue;
      if (p === justLoaded) continue;
      const idx = this.paths.indexOf(p);
      const curIdx = this.paths.indexOf(justLoaded);
      if (idx === -1 || curIdx === -1) continue;
      if (Math.abs(idx - curIdx) > keep) {
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
    this.requestedFull.delete(path);
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
      const ai = this.paths.indexOf(a);
      const bi = this.paths.indexOf(b);
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
      this.loadBg(path);
    }
  }

  private async loadBg(path: string): Promise<void> {
    const gen = this.generation;
    try {
      const result = await fetchThumbnail(path);
      if (this.generation !== gen) {
        URL.revokeObjectURL(result.url);
        return;
      }
      const dims: ImageDims = {
        w: result.width ?? 1,
        h: result.height ?? 1,
      };
      this.thumbs.set(path, { url: result.url, dims });

      // LRU cap — REVOKE SITE 1 (bg path)
      if (this.thumbs.size > 15000) {
        const oldest = this.thumbs.keys().next().value;
        if (oldest !== undefined && oldest !== path) {
          const v = this.thumbs.get(oldest);
          if (v) URL.revokeObjectURL(v.url);
          this.thumbs.delete(oldest);
          this.requestedThumb.delete(oldest);
          this.invalidate(oldest);
        }
      }

      this.invalidate(path);
    } catch {
      // bg thumb failure — silently skip, don't block the fill sweep
    } finally {
      this.bgInFlight--;
      this.pumpBg();
    }
  }
}

export const imageStore = new ImageStore();
