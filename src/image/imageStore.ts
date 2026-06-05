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
 *  1. enforceThumbLru — when the LRU cap evicts an old thumb entry
 *  2. evictFull / evictFullAround — when a full-res entry leaves the windowed cache
 *  3. loadFull — when a full-res entry is REPLACED by a fresher one (no double-keep)
 *  4. hardReset — revokes ALL thumb + full blob URLs (folder change / session end)
 *  5. reset(paths) — revokes full-res for all tracked paths; thumbs are kept
 *  6. loadThumbInto — stale-generation arrival: revoke the just-created thumb
 *     blob when the session changed while the read was in flight
 *  7. loadFull — stale-generation arrival: revoke the just-created preview blob
 *
 * Concurrency-correctness invariants:
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
import type { ImageMetadata } from "../types";

// ── Types ──────────────────────────────────────────────────────────────────

type ThumbEntry = { url: string; dims: ImageDims };

/** All-session thumb LRU cap (loadThumb + loadBg share this). */
const THUMB_LRU_CAP = 15000;

/** Placeholder dims used before real dimensions are known. */
const UNKNOWN_DIMS: ImageDims = { w: 1, h: 1 };

/** Max transient-failure retries before a path is left as shimmer. */
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
  /** Paths whose loadFull is in flight RIGHT NOW (single-flight fulls). */
  private fullInFlightPaths = new Set<string>();
  /** path → number of mounted consumers wanting full-res. A refcount (not a bare
   *  Set) so two consumers wanting the same path don't lose eviction-protection
   *  when only one unmounts. `has(p)` ⟺ count > 0 (entries are deleted at 0). */
  private wantFull = new Map<string, number>();
  /** Per-path transient thumb-failure attempt counter. */
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
  /** The background thumbnail sweep is deferred until the first full-res read
   *  lands, so on cull entry the one full the user is waiting on isn't starved
   *  behind an N-image thumbnail stampede through the shared blocking-read pool. */
  private bgStarted = false;
  // ── Ordered list of all paths (for background fill + eviction) ─────────
  private paths: string[] = [];
  /** path → index in `paths`, rebuilt in reset() for O(1) lookups. */
  private pathIndex = new Map<string, number>();
  private cursor = 0;
  // -1/-1 = "no grid viewport" (matches clearGridRange); set to a real range only
  // while the grid is shown. No real path index is ever in [-1,-1], so bg-fill
  // ordering is pure cursor-distance until a grid range is set.
  private gridStart = -1;
  private gridEnd = -1;
  // ── Session generation counter (cancellation) ─────────────────────────
  private generation = 0;
  // ── Performance profile ────────────────────────────────────────────────
  private profile: PerformanceProfile = PERFORMANCE_PROFILES.local;
  // ── Metadata sink ──────────────────────────────────────────────────────
  // The full-res bundle read also returns the image's EXIF metadata (camera /
  // lens / AF point / pixel dims). The store doesn't own metadata state — it
  // hands each freshly-read `meta` to this callback so App can merge it into
  // its `metadata` map (consumed by the EXIF rail, AF-point zoom origin, and
  // the status-bar MP). Set once via `setMetaSink`.
  private metaSink: ((path: string, meta: ImageMetadata) => void) | undefined;
  // ── Tunables ─────────────────────────────────────────────────────────────
  private readonly thumbLruCap: number;

  constructor(opts: ImageStoreOptions = {}) {
    this.thumbLruCap = opts.thumbLruCap ?? THUMB_LRU_CAP;
  }

  // ── Public API ─────────────────────────────────────────────────────────

  setProfile(p: PerformanceProfile): void {
    this.profile = p;
    // Apply the new (possibly smaller) full-res keep window now — don't wait for
    // the next cursor move to free fulls that are suddenly outside the window.
    this.evictFullAround(this.cursor);
    this.pumpThumbs();
    this.pumpFull();
    this.pumpBg();
  }

  /** Current session generation — bumped by reset()/hardReset(). Consumers (e.g.
   *  the overlay mask loaders) capture it before an async op and discard a
   *  result whose generation no longer matches (the session changed underneath). */
  getGeneration(): number {
    return this.generation;
  }

  /**
   * Register the metadata sink. The store calls it with (path, meta) whenever a
   * full-res bundle read yields EXIF metadata. App uses this to keep its
   * `metadata` map fed.
   */
  setMetaSink(sink: ((path: string, meta: ImageMetadata) => void) | undefined): void {
    this.metaSink = sink;
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
    // old-gen thumb loads bailed without populating `thumbs`; if we keep
    // their paths in requestedThumb they'd be excluded from bg-fill forever
    // (permanent shimmer). Clear it so the new session can re-schedule them.
    this.requestedThumb.clear();
    this.thumbAttempts.clear();

    // zero in-flight counters. Late decrements from superseded loads are
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

    this.paths = newPaths;
    this.rebuildPathIndex();
    this.cursor = 0;
    this.gridStart = -1;
    this.gridEnd = -1;

    // Notify subscribers whose path SURVIVES into the new folder so their cell
    // re-reads the (thumb-kept, full-cleared) snapshot. Paths absent from the new
    // set don't need it — their cell is about to unmount.
    const newSet = new Set(newPaths);
    for (const [path, cbs] of this.subs) {
      if (cbs.size > 0 && newSet.has(path)) this.invalidate(path);
    }

    // DON'T start the background thumbnail sweep yet. On cull entry the loupe is
    // about to request the first full-res; an N-image thumbnail stampede through
    // the shared blocking-read pool would starve that one read (→ minute-long
    // first paint). The sweep is kicked once the first full lands (loadFull's
    // finally). Fallback: if no full is requested within 2s (e.g. grid-first),
    // start it anyway so off-screen thumbs still fill. gen-scoped.
    this.bgStarted = false;
    setTimeout(() => {
      // Fallback for an entry that never requests a full (e.g. grid-first): start
      // the sweep so off-screen thumbs still fill — but NOT while a full is mid-read
      // (a slow first full would otherwise get the stampede the deferral prevents;
      // its own loadFull-finally starts the sweep when it lands).
      if (this.generation === gen && !this.bgStarted && this.fullInFlightPaths.size === 0) {
        this.bgStarted = true;
        this.scheduleBgFill(gen);
      }
    }, 2000);
    // Re-pump the on-demand lanes so visible thumbs + the first full load now.
    this.pumpThumbs();
    this.pumpFull();
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
    // gen-scoped finally blocks make zeroing safe (no negative drift).
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
    this.gridStart = -1;
    this.gridEnd = -1;
  }

  setCursor(index: number, scrubbing = false): void {
    this.cursor = index;
    // full-res eviction is cursor-driven — recenter the keep-window on the
    // cursor even when no new full just landed (parking on a frame recenters).
    this.evictFullAround(index);
    this.rescheduleBg(scrubbing);
    this.pumpFull();
    // Warm neighbours' full-res once the cursor SETTLES — so a single tap to an
    // adjacent frame is already decoded. Never mid-scrub: a scrub flies past
    // frames it never lands on, and prefetching each would flood the NAS. Also NOT
    // until the first full has landed (bgStarted): on cull entry the neighbour
    // prefetch (12 MB reads each) would race the one full the user is waiting on.
    if (!scrubbing && this.bgStarted) this.prefetchFullsAround(index);
  }

  setGridRange(start: number, end: number): void {
    this.gridStart = start;
    this.gridEnd = end;
    this.rescheduleBg();
  }

  /** Clear the grid viewport so bg-fill prioritizes purely by cursor distance. */
  clearGridRange(): void {
    this.gridStart = -1;
    this.gridEnd = -1;
    this.rescheduleBg();
  }

  private rebuildPathIndex(): void {
    this.pathIndex.clear();
    for (let i = 0; i < this.paths.length; i++) {
      this.pathIndex.set(this.paths[i], i);
    }
  }

  /** O(1) path→index lookup; -1 if not tracked. */
  private indexOf(path: string): number {
    const i = this.pathIndex.get(path);
    return i === undefined ? -1 : i;
  }

  private rescheduleBg(scrubbing = false): void {
    // During a scrub the cursor moves ~30×/s; re-sorting the whole bg queue every
    // step is wasted O(n log n) on the UI thread (the order only decides which
    // not-yet-loaded thumb pumpBg pops next, and on-demand thumb/full reads always
    // preempt bg anyway). Skip the sort mid-scrub but still pump so in-flight bg
    // slots keep filling; the scrub-settle re-fires setCursor with scrubbing=false
    // and performs the deferred re-sort.
    if (!scrubbing) this.bgQueue = this.sortByPriority(this.bgQueue);
    this.pumpBg();
  }

  /**
   * Order paths grid-viewport-first, then nearest-cursor. Index lookups are
   * precomputed once (O(n)) rather than two Map.gets per comparison (which made
   * the comparator O(n log n) Map lookups on a queue of thousands).
   */
  private sortByPriority(q: string[]): string[] {
    const cursor = this.cursor;
    const gridStart = this.gridStart;
    const gridEnd = this.gridEnd;
    const tagged = q.map((p) => {
      const i = this.indexOf(p);
      return { p, i, g: i >= gridStart && i <= gridEnd ? 0 : 1 };
    });
    tagged.sort((a, b) =>
      a.g !== b.g ? a.g - b.g : Math.abs(a.i - cursor) - Math.abs(b.i - cursor),
    );
    return tagged.map((t) => t.p);
  }

  registerWantFull(path: string): void {
    if (!path) return;
    this.wantFull.set(path, (this.wantFull.get(path) ?? 0) + 1);
    if (!this.requestedFull.has(path)) {
      this.fullQueue.unshift(path); // high priority: front of queue
      this.pumpFull();
      return;
    }
    // already requested. If it's still queued (not yet in flight), promote
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
    if (!path) return;
    const n = this.wantFull.get(path);
    if (n === undefined) return;
    if (n <= 1) this.wantFull.delete(path);
    else this.wantFull.set(path, n - 1);
  }

  requestThumbFor(path: string): void {
    if (!path) return;
    if (this.requestedThumb.has(path) || this.thumbs.has(path)) return;
    this.thumbQueue.push(path);
    this.pumpThumbs();
  }

  /** The thumb blob URL for a path if loaded, regardless of full-res state. */
  thumbUrl(path: string): string | undefined {
    return this.thumbs.get(path)?.url;
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
   * lane. Differs only in which in-flight counter it touches, kept in the
   * `lane` parameter so the concurrency logic lives in exactly one place.
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
      // transient failure — drop the request marker so it can be retried,
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
      // gen-scoped decrement. A superseded load must NOT touch the current
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
    // Evict the oldest-inserted thumb that is NOT protected. A thumb is protected
    // if it's the one just loaded, currently wanted full (on screen), or within
    // the full-res keep-window of the cursor. Without this guard a >cap shoot
    // could revoke the blob URL of a thumb a live <img> is still displaying
    // (loupe scrub fallback / compare / histogram probe read thumbUrl directly),
    // blanking the frame. Fall back to the strict oldest only if all are
    // protected (the protected set is bounded, so the cap can't run away).
    const keep = this.profile.previewKeep;
    const cursor = this.cursor;
    let victim: string | undefined;
    for (const key of this.thumbs.keys()) {
      if (key === justLoaded) continue;
      if (this.wantFull.has(key)) continue;
      const idx = this.indexOf(key);
      if (idx !== -1 && Math.abs(idx - cursor) <= keep) continue;
      victim = key;
      break;
    }
    if (victim === undefined) {
      const oldest = this.thumbs.keys().next().value;
      if (oldest !== undefined && oldest !== justLoaded) victim = oldest;
    }
    if (victim !== undefined) {
      const v = this.thumbs.get(victim);
      if (v) URL.revokeObjectURL(v.url);
      this.thumbs.delete(victim);
      this.requestedThumb.delete(victim);
      this.invalidate(victim);
    }
  }

  // ── Full-res pump ───────────────────────────────────────────────────────

  private pumpFull(): void {
    while (
      this.fullInFlight < this.profile.bundleConcurrency &&
      this.fullQueue.length > 0
    ) {
      const path = this.fullQueue.shift()!;
      // single-flight per path — never start a second loadFull while one is
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
    // `pumpFull` has already added `path` to `fullInFlightPaths` and
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
      // Surface EXIF metadata to App (camera / lens / AF point / pixel dims).
      if (result.meta) this.metaSink?.(path, result.meta);
      this.invalidate(path);
      // also recenter the keep-window on the CURSOR (not just-loaded), so
      // eviction tracks where the user is, not where the last load happened.
      this.evictFullAround(this.cursor);
    } catch (e) {
      if (this.generation !== gen) return;
      const msg = e instanceof Error ? e.message : String(e);
      this.fulls.set(path, { status: "error", error: msg });
      this.invalidate(path);
    } finally {
      // clear in-flight marker regardless of generation (it's path-keyed
      // and must not leak even for a superseded load).
      this.fullInFlightPaths.delete(path);
      // gen-scoped counter decrement + pumps.
      if (this.generation === gen) {
        this.fullInFlight--;
        // First full-res has landed (or errored) — NOW start the deferred
        // background thumbnail sweep AND neighbour prefetch, so neither raced the
        // first full read (the cause of the minute-long first paint).
        if (!this.bgStarted) {
          this.bgStarted = true;
          this.scheduleBgFill(gen);
          this.prefetchFullsAround(this.cursor);
        }
        this.pumpFull();
        // finishing the last on-demand full must wake the bg sweep.
        this.pumpBg();
      }
    }
  }

  /**
   * Evict full-res entries that are far from `centerIndex`, keeping at most
   * `previewKeep` on each side. Revokes their blob URLs. — REVOKE SITE 2.
   * Cursor-driven: callable from setCursor and after a load.
   */
  private evictFullAround(centerIndex: number): void {
    if (centerIndex < 0) return;
    const keep = this.profile.previewKeep;
    for (const [p, state] of this.fulls) {
      if (state?.status !== "ready") continue;
      // Never evict a full that something is actively displaying (loupe current,
      // or BOTH compare panes). In compare the cursor follows the challenger, so
      // without this the champion — far from the cursor — would be evicted and
      // re-fetched on every challenger step, thrashing it back to a blurred load.
      if (this.wantFull.has(p)) continue;
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

  /**
   * Evict a single path's full-res entry (direct, not window-based). Test-only
   * today — production eviction goes through {@link evictFullAround} — but kept
   * because it's the one place the "evict-then-re-request mid-flight doesn't
   * double-fetch" dedup invariant is exercised end-to-end.
   */
  evictFull(path: string): void {
    const state = this.fulls.get(path);
    if (state?.status === "ready") {
      URL.revokeObjectURL(state.url); // REVOKE SITE 2 (direct eviction)
    }
    this.fulls.delete(path);
    // do NOT drop requestedFull while a loadFull is still in flight for
    // this path, or a re-request would start a duplicate fetch.
    if (!this.fullInFlightPaths.has(path)) {
      this.requestedFull.delete(path);
    }
    this.invalidate(path);
  }

  /**
   * Prefetch full-res previews for frames within `fullPrefetchRadius` of the
   * cursor (nearest-first), so a single tap to a neighbour shows the full
   * immediately instead of waiting on an on-demand read. Enqueued at the BACK of
   * the full queue, so the on-demand wantFull for the displayed frame (which
   * unshifts to the front) always wins. Bounded by previewKeep eviction, so it
   * never grows unbounded. Called only when the cursor is settled (see setCursor).
   */
  private prefetchFullsAround(centerIndex: number): void {
    if (centerIndex < 0) return;
    const radius = this.profile.fullPrefetchRadius;
    if (radius <= 0) return;
    let enqueued = false;
    // Nearest-first so the most likely next tap (±1) decodes before ±radius.
    for (let d = 1; d <= radius; d++) {
      for (const idx of [centerIndex - d, centerIndex + d]) {
        if (idx < 0 || idx >= this.paths.length) continue;
        const path = this.paths[idx];
        const prev = this.fulls.get(path);
        if (prev?.status === "ready" || prev?.status === "loading") continue;
        if (this.requestedFull.has(path) || this.fullInFlightPaths.has(path)) continue;
        if (this.fullQueue.includes(path)) continue;
        this.fullQueue.push(path);
        enqueued = true;
      }
    }
    if (enqueued) this.pumpFull();
  }

  // ── Background-fill pump ────────────────────────────────────────────────

  private scheduleBgFill(gen: number): void {
    if (this.generation !== gen) return;
    // Build the background queue using cursor-outward / grid-viewport-first order.
    // Paths inside the grid viewport come first, then cursor-outward for the rest.
    const unloaded = this.paths.filter(
      (p) => !this.thumbs.has(p) && !this.requestedThumb.has(p),
    );
    this.bgQueue = this.sortByPriority(unloaded);
    this.pumpBg();
  }

  private pumpBg(): void {
    const cap = this.profile.backgroundFillConcurrency;
    while (
      this.bgInFlight < cap &&
      // On-demand thumbs + on-demand full take priority — don't start new bg
      // work if there are higher-priority items queued, or while a wanted full
      // is actively READING (in flight). The latter keeps the bg lane from
      // refilling its slots and starving the full the user is staring at.
      this.thumbQueue.length === 0 &&
      this.fullQueue.length === 0 &&
      this.fullInFlightPaths.size === 0 &&
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
