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
 * Blob-URL revoke sites (windowed eviction — sites 2, 10, 12 — is the one
 * TierLane.evictAround loop in tierLane.ts; each lane's protection predicate
 * is injected at its construction below):
 *  1. enforceThumbLru — when the LRU cap evicts an old thumb entry
 *  2. navLane.evictAround — when a full-res entry leaves the windowed cache
 *     (2b. evictFull — test-only direct eviction of one path)
 *  3. fetchNavInto — when a full-res entry is REPLACED by a fresher one (no double-keep)
 *  4. hardReset — revokes ALL thumb + full blob URLs (folder change / session end)
 *  5. reset(paths) — revokes full-res for all tracked paths; thumbs are kept
 *  6. fetchThumbInto — stale-generation arrival: revoke the just-created thumb
 *     blob when the session changed while the read was in flight
 *  7. fetchNavInto — stale-generation arrival: revoke the just-created preview blob
 *  8–10. zoom tier (reset/hardReset, fetchZoomInto stale/replace, zoomLane.evictAround)
 *  11–12. mid tier (Phase 8): reset/hardReset + fetchMidInto stale/replace (11),
 *     midLane.evictAround window eviction (12)
 *
 * Concurrency-correctness invariants (mechanics enforced by TierLane.run —
 * see tierLane.ts):
 *  - Every in-flight counter decrement is generation-scoped: a load whose
 *    generation has been superseded by reset()/hardReset() does NOT touch the
 *    current-session counters (otherwise late decrements drive them negative,
 *    permanently defeating the concurrency cap).
 *  - At most ONE in-flight nav read per path (tracked in `fullInFlightPaths`),
 *    so an evict-then-re-request mid-flight cannot start a duplicate NAS fetch
 *    or revoke a url that is still referenced by a live snapshot.
 */

import { invoke } from "@tauri-apps/api/core";
import {
  fetchFullres,
  fetchMid,
  fetchNav,
  fetchThumbnail,
  invokeGenerateMid,
  MID_UNCACHED_RE,
} from "../utils/bundle";
import { nextMidEngaged } from "./midSelect";
import type { PerformanceProfile } from "../types/settings";
import { clampProfileForPressure, type PressureLevel } from "./pressureProfile";
import { PERFORMANCE_PROFILES } from "../types/settings";
import { DecodePool } from "./decodePool";
import type { PoolEntry, PoolImage } from "./decodePool";
import { DevStats } from "./devStats";
import { RefCountMap, TierLane } from "./tierLane";
import {
  backoffMs,
  FolderTroubleLatch,
  inCooldown,
  MAX_TIER_ATTEMPTS,
  recordTierError,
  type TierError,
} from "./tierErrors";
import { MidSweep } from "./midSweep";
import { resolveStage, type ImageState, type Resolved } from "./stage";
import type { ImageDims } from "../utils/bundle";
import type { ImageMetadata } from "../types";

// ── Types ──────────────────────────────────────────────────────────────────

type ThumbEntry = { url: string; dims: ImageDims };

/** All-session thumb LRU cap (loadThumb + loadBg share this). */
const THUMB_LRU_CAP = 15000;

/** Placeholder dims used before real dimensions are known. */
const UNKNOWN_DIMS: ImageDims = { w: 1, h: 1 };

/** Delay before re-probing `read_mid` after a quiet miss (Phase 8): the
 *  opportunistic generator needs ~300–400 ms of CPU after its zoom read
 *  returns, plus slack for the MidGen queue. */
const MID_REPROBE_MS = 1500;

/** Constructor options (test-only knobs kept minimal). */
export type ImageStoreOptions = {
  /** Override the thumb LRU cap (test-only — exercise eviction with a small N). */
  thumbLruCap?: number;
  /** Decode-ahead pool element factory (Phase 5) — tests inject fakes; the
   *  default uses `new Image()` and disables the pool when no DOM exists. */
  poolImageFactory?: () => PoolImage;
};

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
  /** Paths whose nav read is in flight RIGHT NOW (single-flight fulls). */
  private fullInFlightPaths = new Set<string>();
  /** path → number of mounted consumers wanting full-res (RefCountMap: two
   *  consumers wanting the same path don't lose eviction-protection when only
   *  one unmounts). */
  private wantFull = new RefCountMap();
  /** path → number of mounted consumers DISPLAYING this path (every useImage
   *  caller — loupe, compare panes, grid/strip cells). Protects the path's
   *  thumb blob from LRU revocation while a live <img> may be showing it
   *  (the direct `thumbUrl()` readers all sit inside such a consumer). */
  private displayRefs = new RefCountMap();
  /** path → pin count. A pinned path's full is NEVER evicted: compare pins its
   *  pair for the session, App pins the zoomed frame, the histogram probe pins
   *  during its decode. Refcounted like wantFull. */
  private pinnedFulls = new RefCountMap();
  /** Per-path per-tier failure state (capped backoff; see TierError). */
  private thumbErrors = new Map<string, TierError>();
  private fullErrors = new Map<string, TierError>();
  /** Terminal-path tracking + the folder-unreachable latch (tierErrors.ts). */
  private readonly trouble = new FolderTroubleLatch();
  /** App-registered callback fired once when folderTrouble latches. */
  private troubleSink: (() => void) | undefined;
  /** Session-lifetime dims cache: orientation-adjusted display dims, fed by
   *  thumb meta as it arrives. Never evicted until hardReset (entries are a
   *  few bytes) — so the matte keeps a frame's true aspect even after its
   *  thumb/full blobs were evicted. */
  private pathDims = new Map<string, ImageDims>();
  // ── Zoom tier (Phase 3: full-res is settle/zoom-only) ──────────────────
  /** path → zoom full-res state. Tiny windowed cache (profile.fullKeep per
   *  side; pins override) — full blobs are ~10 MB each. */
  private zoomFulls = new Map<string, ImageState["zoomFull"]>();
  private requestedZoom = new Set<string>();
  private zoomInFlightPaths = new Set<string>();
  private zoomErrors = new Map<string, TierError>();
  /** Zoom requests deferred until the nav read delivers the path's hint —
   *  fetching without it loses the exact range AND the orientation echo
   *  (the portrait-zoom-on-arrival bug). fetchNavInto's completion re-issues. */
  private pendingZoom = new Set<string>();
  /** path → exact-range hint + orientation from the preview header. Derived
   *  from immutable file content — survives reset(), cleared on hardReset. */
  private fullHints = new Map<
    string,
    { offset: number | null; len: number | null; orientation: number }
  >();
  /** path → NATIVE full-res display dims (sensor pixels, orientation-swapped)
   *  for the hi-res layer's transform math. Same lifetime as fullHints. */
  private nativeDims = new Map<string, ImageDims>();
  // ── Mid tier (Phase 8: display-adaptive ≤2560px settled fit view) ───────
  /** path → mid state. Windowed like the zoom tier (fullKeep per side) —
   *  mid blobs are ~1 MB, but their decoded rasters (~17 MB) are the budget. */
  private mids = new Map<string, ImageState["mid"]>();
  private requestedMid = new Set<string>();
  private midInFlightPaths = new Set<string>();
  private midErrors = new Map<string, TierError>();
  /** Paths whose `read_mid` answered the quiet-miss sentinel (network
   *  profile / generation pending) — NOT failures. Cleared by the re-probe
   *  triggers (zoom-tier landing, the scheduled re-probe, reset). */
  private midUncached = new Set<string>();
  /** Paths whose quiet miss already spent its ONE catch-scheduled re-probe —
   *  without this, miss → re-probe → miss → re-schedule would poll read_mid
   *  every 1.5 s forever while parked (review finding). A fresh zoom landing
   *  clears the mark: new bytes mean a new chance the generator published. */
  private midReprobed = new Set<string>();
  /** Mid requests deferred until the nav read delivers the path's hint —
   *  mirror of pendingZoom (a hintless local generation would pay a 12 MiB
   *  scan instead of two exact-range reads). fetchNavInto's completion re-issues. */
  private pendingMid = new Set<string>();
  /** Latched once `read_mid` is rejected as an unknown command (Phase-8
   *  frontend on an older backend): the tier stays dormant for the session. */
  private midUnsupported = false;
  /** Hysteresis latch for the display-adaptive choice (midSelect.ts):
   *  engage >1750 device px, release <1650, hold in between. */
  private midEngaged = false;
  /** App-injected provider returning the FRESH needPx (stage rect height ×
   *  devicePixelRatio) — called at each tier request, never cached at mount. */
  private needPxProvider: (() => number | null) | undefined;
  // Local-profile idle sweep (paused while any on-demand lane has work) —
  // scheduler lives in midSweep.ts; the store injects its gates + touchpoints.
  private readonly midSweep = new MidSweep({
    canSweep: () =>
      !this.trouble.isTroubled &&
      !this.midUnsupported &&
      this.profile.concurrentRestore && // network profile — local only
      this.bgStarted &&
      this.midEngaged,
    onDemandIdle: () => this.onDemandIdle(),
    concurrency: () => this.profile.midGenConcurrency,
    paths: () => this.paths,
    cursor: () => this.cursor,
    isMidReady: (p) => this.mids.get(p)?.status === "ready",
    hintFor: (p) => {
      const hint = this.fullHints.get(p);
      return {
        fullOffset: hint?.offset ?? null,
        fullLen: hint?.len ?? null,
        orientation: hint?.orientation ?? null,
      };
    },
    generation: () => this.generation,
    generate: (path, gen, hint) => invokeGenerateMid(path, gen, hint),
    onGenerated: () => {
      this.stats.counts.midGens++;
    },
  });
  /** Decode-ahead warm pool (Phase 5) — null when no DOM (unit tests). */
  private readonly pool: DecodePool | null;
  /** Last cursor travel direction: biases prefetch + the pool band 2:1. */
  private lastDir: 1 | -1 = 1;
  // ── Dev HUD stats (timing rings + cheap counters; see devStats.ts) ──────
  private readonly stats = new DevStats();
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
  /** The settings-selected profile BEFORE the memory-pressure clamp — kept so
   *  pressure easing restores the user's real numbers, not the clamped ones. */
  private baseProfile: PerformanceProfile = PERFORMANCE_PROFILES.local;
  private pressure: PressureLevel = "normal";
  // ── Metadata sink ──────────────────────────────────────────────────────
  // The full-res bundle read also returns the image's EXIF metadata (camera /
  // lens / AF point / pixel dims). The store doesn't own metadata state — it
  // hands each freshly-read `meta` to this callback so App can merge it into
  // its `metadata` map (consumed by the EXIF rail, AF-point zoom origin, and
  // the status-bar MP). Set once via `setMetaSink`.
  private metaSink: ((path: string, meta: ImageMetadata) => void) | undefined;
  // ── Tunables ─────────────────────────────────────────────────────────────
  private readonly thumbLruCap: number;

  // ── Lanes (Phase 8): pump/load/evict quad mechanics live in tierLane.ts ──
  // Each lane injects its cap, ready-check, load interior, and completion
  // pumps; the request markers / in-flight sets / error maps are the store's
  // own collections (other subsystems read them), shared into the lane.

  /** On-demand thumb lane (highest priority). Shares request markers + error
   *  map with the bg lane below — one thumb fetch pipeline, two schedulers. */
  private readonly thumbLane: TierLane = new TierLane({
    cap: () => this.profile.thumbConcurrency,
    generation: () => this.generation,
    isReady: (p) => this.thumbs.has(p),
    fetch: (p, gen) => this.fetchThumbInto(p, gen),
    afterSettle: () => {
      this.thumbLane.pump();
      this.bgLane.pump();
      this.midSweep.pump();
    },
    requested: this.requestedThumb,
    errors: this.thumbErrors,
  });

  /** Background-fill book-order lane. Same fetch pipeline as thumbLane; only
   *  the scheduling policy differs: grid-first / nearest-cursor argmin pick
   *  (pickBg) and full deference to the on-demand lanes (canStart). */
  private readonly bgLane: TierLane = new TierLane({
    cap: () => this.profile.backgroundFillConcurrency,
    generation: () => this.generation,
    isReady: (p) => this.thumbs.has(p),
    fetch: (p, gen) => this.fetchThumbInto(p, gen),
    afterSettle: () => {
      this.thumbLane.pump();
      this.bgLane.pump();
      this.midSweep.pump();
    },
    // Folder unreachable — every new read would hang/fail for its full
    // timeout (the retry affordance re-arms everything). On-demand thumbs +
    // on-demand full take priority — don't start new bg work if there are
    // higher-priority items queued, or while a wanted full is actively
    // READING (in flight): that keeps the bg lane from refilling its slots
    // and starving the full the user is staring at.
    canStart: () =>
      !this.trouble.isTroubled &&
      this.thumbLane.queue.length === 0 &&
      this.navLane.queue.length === 0 &&
      this.fullInFlightPaths.size === 0,
    pick: () => this.pickBg(),
    requested: this.requestedThumb,
    errors: this.thumbErrors,
  });

  /** Nav-preview lane (the on-demand + prefetch full-res reads). */
  private readonly navLane: TierLane<ImageState["full"]> = new TierLane({
    cap: () => this.profile.previewConcurrency,
    generation: () => this.generation,
    isReady: (p) => this.fulls.get(p)?.status === "ready",
    markLoading: (p) => {
      this.fulls.set(p, { status: "loading" });
      this.invalidate(p);
    },
    fetch: (p, gen) => this.fetchNavInto(p, gen),
    afterSettle: () => {
      // First full-res has landed (or errored) — NOW start the deferred
      // background thumbnail sweep AND neighbour prefetch, so neither raced
      // the first full read (the cause of the minute-long first paint).
      if (!this.bgStarted) {
        this.bgStarted = true;
        this.scheduleBgFill(this.generation);
        this.prefetchFullsAround(this.cursor);
      }
      this.navLane.pump();
      // finishing the last on-demand full must wake the bg sweep — and the
      // mid sweep, which idles while any on-demand lane has work.
      this.bgLane.pump();
      this.midSweep.pump();
    },
    requested: this.requestedFull,
    inFlightPaths: this.fullInFlightPaths,
    errors: this.fullErrors,
    // Windowed eviction — REVOKE SITE 2. Protection (wantFull, pins,
    // in-flight, keep window) lives in isProtected — e.g. in compare the
    // cursor follows the challenger, so without the champion's wantFull/pin
    // it would be evicted + re-fetched on every challenger step.
    cache: this.fulls,
    isEvictionProtected: (p, center) => this.isProtected(p, "full", center),
    onEvict: (p) => {
      this.stats.counts.previewEvicts++;
      this.invalidate(p);
    },
  });

  /** Zoom-tier lane (the ~10 MB settle/zoom full-res reads). */
  private readonly zoomLane: TierLane<ImageState["zoomFull"]> = new TierLane({
    cap: () => this.profile.fullConcurrency,
    generation: () => this.generation,
    isReady: (p) => this.zoomFulls.get(p)?.status === "ready",
    markLoading: (p) => {
      this.zoomFulls.set(p, { status: "loading" });
      this.invalidate(p);
    },
    fetch: (p, gen) => this.fetchZoomInto(p, gen),
    afterSettle: () => {
      this.zoomLane.pump();
      this.midSweep.pump();
    },
    requested: this.requestedZoom,
    inFlightPaths: this.zoomInFlightPaths,
    errors: this.zoomErrors,
    // Windowed eviction — REVOKE SITE 10. Pins (zoomed frame, compare pair,
    // histogram probe) are protected; full blobs are ~10 MB each so the
    // window stays small (fullKeep).
    cache: this.zoomFulls,
    isEvictionProtected: (p, center) => {
      if (this.pinnedFulls.has(p)) return true;
      const idx = this.indexOf(p);
      return idx !== -1 && Math.abs(idx - center) <= this.profile.fullKeep;
    },
    onEvict: (p) => {
      this.stats.counts.zoomEvicts++;
      this.invalidate(p);
    },
  });

  /** Mid-tier lane (the display-adaptive ≤2560px settled fit view). */
  private readonly midLane: TierLane<ImageState["mid"]> = new TierLane({
    cap: () => this.profile.midGenConcurrency,
    generation: () => this.generation,
    isReady: (p) => this.mids.get(p)?.status === "ready",
    markLoading: (p) => {
      this.mids.set(p, { status: "loading" });
      this.invalidate(p);
    },
    fetch: (p, gen) => this.fetchMidInto(p, gen),
    afterSettle: () => {
      this.midLane.pump();
      this.midSweep.pump();
    },
    requested: this.requestedMid,
    inFlightPaths: this.midInFlightPaths,
    errors: this.midErrors,
    // Windowed eviction — REVOKE SITE 12. Mid blobs are ~1 MB and share the
    // zoom tier's settled-frame cadence, so they share its window too;
    // displayRefs additionally protect any mounted consumer's frame (the
    // presenter may still be showing its decoded raster).
    cache: this.mids,
    isEvictionProtected: (p, center) => {
      if (this.displayRefs.has(p)) return true;
      const idx = this.indexOf(p);
      return idx !== -1 && Math.abs(idx - center) <= this.profile.fullKeep;
    },
    onEvict: (p) => {
      this.stats.counts.midEvicts++;
      this.invalidate(p);
    },
  });

  constructor(opts: ImageStoreOptions = {}) {
    this.thumbLruCap = opts.thumbLruCap ?? THUMB_LRU_CAP;
    const poolFactory =
      opts.poolImageFactory ?? (typeof Image !== "undefined" ? () => new Image() : undefined);
    this.pool = poolFactory ? new DecodePool(poolFactory) : null;
  }

  // ── Public API ─────────────────────────────────────────────────────────

  setProfile(p: PerformanceProfile): void {
    this.baseProfile = p;
    this.profile = clampProfileForPressure(p, this.pressure);
    // Mirror the storage mode into the backend's IoGate (permit cap + timeout
    // tiers). Heuristic on a profile field rather than a mode string so this
    // stays decoupled from the settings shape.
    this.pushBackend("set_io_profile", {
      mode: p.concurrentRestore ? "local" : "network",
    });
    // Apply the new (possibly smaller) keep windows now — don't wait for the
    // next cursor move to free blobs that are suddenly outside the window.
    this.navLane.evictAround(this.cursor);
    this.zoomLane.evictAround(this.cursor);
    this.midLane.evictAround(this.cursor);
    // Re-aim the pool under the new caps/radii (a network→local flip may
    // shrink it; eviction above may have dropped blobs it referenced).
    this.refreshPool();
    this.thumbLane.pump();
    this.navLane.pump();
    this.bgLane.pump();
    this.zoomLane.pump();
    this.midLane.pump();
    this.midSweep.pump();
  }

  /**
   * OS memory-pressure response. Re-derives the effective profile through
   * {@link clampProfileForPressure} and re-runs the SAME eviction cascade
   * setProfile uses, so shrunken windows/pools free their bytes immediately —
   * the whole point is to shed BEFORE jetsam kills the WebContent process
   * (the proven gray-window crash). Easing back to "normal" restores the
   * user's real profile numbers.
   */
  setMemoryPressure(level: PressureLevel): void {
    if (level === this.pressure) return;
    this.pressure = level;
    this.setProfile(this.baseProfile);
    if (level === "critical") {
      // The ~130 MB decoded fulls are the biggest single lever: drop every
      // zoom blob except in-flight ones. Pins are deliberately bypassed —
      // a pinned raster is exactly what is killing the process.
      this.dropZoomFullsExcept([]);
    }
  }

  /**
   * Release every READY zoom-full blob except `keep` (and in-flight reads).
   * Deliberately ignores pins: callers use this at the moments pins lie —
   * a zoomed compare decide (the outgoing pair is still pinned but must go
   * BEFORE the incoming pair's fulls arrive, or the transient overlap spikes
   * WebContent past the jetsam line) and the critical-pressure shed above.
   */
  dropZoomFullsExcept(keep: readonly string[]): void {
    const keepSet = new Set(keep);
    for (const [p, state] of this.zoomFulls) {
      if (state?.status !== "ready") continue;
      if (keepSet.has(p) || this.zoomInFlightPaths.has(p)) continue;
      URL.revokeObjectURL(state.url);
      this.zoomFulls.delete(p);
      this.requestedZoom.delete(p);
      this.stats.counts.zoomEvicts++;
      this.invalidate(p);
    }
    this.refreshPool();
  }

  /** Fire-and-forget backend push (session gen / io profile). Quiet on a
   *  pre-Phase-2 backend (unknown command) and skipped entirely in unit tests
   *  (node env, no webview). */
  private pushBackend(
    cmd: "begin_session" | "set_io_profile",
    args: Record<string, unknown>,
  ): void {
    if (typeof window === "undefined") return;
    void (async () => {
      try {
        await invoke(cmd, args);
      } catch {
        // old backend — the feature simply stays dormant
      }
    })();
  }

  /** Current session generation — bumped by reset()/hardReset(). Consumers (e.g.
   *  the overlay mask loaders) capture it before an async op and discard a
   *  result whose generation no longer matches (the session changed underneath). */
  getGeneration(): number {
    return this.generation;
  }

  /** Smart-culling backpressure probe: is the user actively loading? True while
   *  zoom fulls (the heavy ~10 MB reads) or nav previews are in flight — the
   *  quality pass waits these out between chunks instead of reading privates. */
  isBusyLoading(): boolean {
    return this.zoomLane.inFlight > 0 || this.fullInFlightPaths.size > 0;
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
    // Tell the backend the session moved: superseded chunked reads bail
    // within ~one 2 MiB chunk instead of finishing multi-MB transfers.
    this.pushBackend("begin_session", { gen });

    // Cancel queued work: every lane drops its queue, request markers,
    // in-flight markers, counter, and error map (TierLane.reset — counter
    // zeroing is safe because run()'s decrement is generation-scoped).
    this.thumbLane.reset();
    this.bgLane.reset();
    this.navLane.reset();
    this.zoomLane.reset();
    this.midLane.reset();
    this.wantFull.clear();
    this.pendingZoom.clear();
    // Revoke all zoom full-res blob URLs — REVOKE SITE 8 (they are the
    // heaviest blobs in the app; a folder switch must drop them at once).
    for (const [, state] of this.zoomFulls) {
      if (state?.status === "ready") URL.revokeObjectURL(state.url);
    }
    this.zoomFulls.clear();
    // Mid tier (Phase 8): same session scope as the zoom tier — REVOKE SITE 11.
    // midEngaged survives (the display didn't change); midUnsupported too
    // (the backend can't change mid-run).
    for (const [, state] of this.mids) {
      if (state?.status === "ready") URL.revokeObjectURL(state.url);
    }
    this.mids.clear();
    this.pendingMid.clear();
    this.midUncached.clear();
    this.midReprobed.clear();
    this.midSweep.reset();
    // The pool's decoded refs point at blob URLs this reset revokes.
    this.pool?.clear();
    // old-gen thumb loads bailed without populating `thumbs`; if we keep
    // their paths in requestedThumb they'd be excluded from bg-fill forever
    // (permanent shimmer). Clear it so the new session can re-schedule them.
    this.requestedThumb.clear();
    // Folder revisit re-arms every failed tier (terminal included; the
    // per-lane error maps were cleared by the lane resets above) — an
    // unmounted NAS that reconnected gets a clean slate. pathDims survives
    // (it's a session-lifetime cache, like thumbs; hardReset clears it).
    // displayRefs/pinnedFulls are component-lifetime, not generation-scoped:
    // mounted consumers unregister on their own unmount.
    this.trouble.reset();

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
    this.lastDir = 1; // stale travel direction must not aim the new session's first prefetch backwards
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
    // first paint). The sweep is kicked once the first full lands (the nav
    // lane's afterSettle). Fallback: if no full is requested within 2s (e.g. grid-first),
    // start it anyway so off-screen thumbs still fill. gen-scoped.
    this.bgStarted = false;
    setTimeout(() => {
      // Fallback for an entry that never requests a full (e.g. grid-first): start
      // the sweep so off-screen thumbs still fill — but NOT while a full is mid-read
      // (a slow first full would otherwise get the stampede the deferral prevents;
      // its own nav-lane afterSettle starts the sweep when it lands).
      if (this.generation === gen && !this.bgStarted && this.fullInFlightPaths.size === 0) {
        this.bgStarted = true;
        this.scheduleBgFill(gen);
      }
    }, 2000);
    // Re-pump the on-demand lanes so visible thumbs + the first full load now.
    this.thumbLane.pump();
    this.navLane.pump();
  }

  /**
   * Hard reset: revokes ALL blob URLs (thumbs + full-res). Called on
   * session end or when switching to a completely new session.
   */
  hardReset(): void {
    this.generation++;
    this.pushBackend("begin_session", { gen: this.generation });

    this.thumbLane.reset();
    this.bgLane.reset();
    this.navLane.reset();
    this.zoomLane.reset();
    this.midLane.reset();
    this.wantFull.clear();
    this.pendingZoom.clear();
    for (const [, state] of this.zoomFulls) {
      if (state?.status === "ready") URL.revokeObjectURL(state.url); // REVOKE SITE 8
    }
    this.zoomFulls.clear();
    for (const [, state] of this.mids) {
      if (state?.status === "ready") URL.revokeObjectURL(state.url); // REVOKE SITE 11
    }
    this.mids.clear();
    this.pendingMid.clear();
    this.midUncached.clear();
    this.midReprobed.clear();
    this.midSweep.reset();
    this.fullHints.clear();
    this.nativeDims.clear();
    this.stats.clearTimings();
    this.pool?.clear();
    this.trouble.reset();
    this.pathDims.clear();

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
    this.lastDir = 1; // stale travel direction must not aim the new session's first prefetch backwards
    this.gridStart = -1;
    this.gridEnd = -1;
  }

  setCursor(index: number, scrubbing = false): void {
    if (index > this.cursor) this.lastDir = 1;
    else if (index < this.cursor) this.lastDir = -1;
    this.cursor = index;
    this.midSweep.noteCursorMove();
    // Eviction is cursor-driven — recenter the keep-windows on the cursor
    // even when no new load just landed (parking on a frame recenters).
    this.navLane.evictAround(index);
    this.zoomLane.evictAround(index);
    this.midLane.evictAround(index);
    // bg priority needs no re-sort: pickBg() reads the live cursor at pump time.
    this.bgLane.pump();
    this.navLane.pump();
    // Warm neighbours' full-res once the cursor SETTLES — so a single tap to an
    // adjacent frame is already decoded. Never mid-scrub: a scrub flies past
    // frames it never lands on, and prefetching each would flood the NAS.
    // Before the first full lands (bgStarted=false) prefetch only ±1 at the
    // BACK of the queue — the first-tap warm: the displayed frame's wantFull
    // unshifts to the front so it still wins a lane, and the bg-sweep deferral
    // (the actual starvation guard) is untouched. Today's "second tap is
    // always cold" dies here. Full radius once the first full has landed.
    if (!scrubbing) {
      this.prefetchFullsAround(index, this.bgStarted ? undefined : 1);
    }
    // Re-aim the decode-ahead pool on EVERY cursor move — including mid-
    // scrub, where re-prioritizing already-fetched previews (zero fetches)
    // is exactly what keeps scrubbing across a warm region sharp.
    this.refreshPool();
    // Warm-region navigation issues zero reads, so no load-completion would
    // ever re-pump the sweep once the user parks — poke it here (it bails
    // instantly into the quiet-window timer while the cursor is moving).
    this.midSweep.pump();
  }

  setGridRange(start: number, end: number): void {
    this.gridStart = start;
    this.gridEnd = end;
    // Grid view never zooms — release the pool's decoded zoom fulls
    // (~130 MB each); the previews stay warm for the return to loupe.
    this.pool?.retain("full", [], 0);
    this.bgLane.pump();
  }

  /** Clear the grid viewport so bg-fill prioritizes purely by cursor distance. */
  clearGridRange(): void {
    this.gridStart = -1;
    this.gridEnd = -1;
    this.refreshPool(); // back in loupe — re-warm the band (incl. zoom fulls)
    this.bgLane.pump();
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

  /**
   * Pick the highest-priority bg candidate by O(n) argmin scan at pump time —
   * grid-viewport paths first, then nearest-to-cursor — replacing the old
   * O(n log n) whole-queue re-sort per cursor move (P8). Always computed
   * against the LIVE cursor, so no scrub-time staleness either. Skips paths
   * cooling down after a failed read. Returns an index into bgQueue, or -1.
   */
  private pickBg(): number {
    const now = Date.now();
    const cursor = this.cursor;
    const gridStart = this.gridStart;
    const gridEnd = this.gridEnd;
    let best = -1;
    let bestG = 2;
    let bestD = Infinity;
    for (let k = 0; k < this.bgLane.queue.length; k++) {
      const p = this.bgLane.queue[k];
      if (inCooldown(this.thumbErrors.get(p), now)) continue;
      const i = this.indexOf(p);
      const g = i >= gridStart && i <= gridEnd ? 0 : 1;
      const d = Math.abs(i - cursor);
      if (g < bestG || (g === bestG && d < bestD)) {
        best = k;
        bestG = g;
        bestD = d;
        if (g === 0 && d === 0) break; // can't beat the cursor's own cell
      }
    }
    return best;
  }

  registerWantFull(path: string): void {
    if (!path) return;
    this.wantFull.inc(path);
    if (!this.requestedFull.has(path)) {
      // Failed earlier? Respect the backoff instead of hammering: the
      // scheduled retry (or the manual retry affordance) re-queues. Terminal
      // paths wait for retry()/folder revisit.
      const te = this.fullErrors.get(path);
      if (inCooldown(te, Date.now())) {
        if (te && te.attempts < MAX_TIER_ATTEMPTS) {
          this.scheduleFullRetry(path, te, this.generation);
        }
        return;
      }
      this.navLane.queue.unshift(path); // high priority: front of queue
      this.navLane.pump();
      return;
    }
    // already requested. If it's still queued (not yet in flight), promote
    // it to the FRONT so a landed-on frame preempts queued prefetch fulls.
    if (!this.fullInFlightPaths.has(path)) {
      const qi = this.navLane.queue.indexOf(path);
      if (qi > 0) {
        this.navLane.queue.splice(qi, 1);
        this.navLane.queue.unshift(path);
        this.navLane.pump();
      }
    }
    // If already in flight, nothing to do.
  }

  unregisterWantFull(path: string): void {
    if (!path) return;
    this.wantFull.dec(path);
  }

  /** A mounted consumer is displaying this path (any tier). Protects the
   *  path's THUMB blob from LRU revocation while a live <img> may show it. */
  registerDisplay(path: string): void {
    if (!path) return;
    this.displayRefs.inc(path);
  }

  unregisterDisplay(path: string): void {
    if (!path) return;
    this.displayRefs.dec(path);
  }

  /** Pin a path's full against eviction (compare pair for the session, the
   *  zoomed frame, the histogram probe mid-decode). Refcounted. */
  pinFull(path: string): void {
    if (!path) return;
    this.pinnedFulls.inc(path);
  }

  unpinFull(path: string): void {
    if (!path) return;
    this.pinnedFulls.dec(path);
  }

  /**
   * Manual retry affordance (the error panel / folder-trouble chip): wipe the
   * path's failure state and immediately re-queue whatever is missing, at the
   * front of the on-demand lanes.
   */
  retry(path: string): void {
    if (!path) return;
    this.thumbErrors.delete(path);
    this.fullErrors.delete(path);
    this.zoomErrors.delete(path);
    this.midErrors.delete(path);
    this.midUncached.delete(path);
    this.midReprobed.delete(path);
    this.trouble.clearPath(path);
    if (this.fulls.get(path)?.status === "error") {
      this.fulls.delete(path);
      this.requestedFull.delete(path);
    }
    if (this.zoomFulls.get(path)?.status === "error") {
      this.zoomFulls.delete(path);
      this.requestedZoom.delete(path);
    }
    if (!this.thumbs.has(path)) {
      this.requestedThumb.delete(path);
      if (!this.thumbLane.queue.includes(path)) this.thumbLane.queue.unshift(path);
    }
    if (
      this.wantFull.has(path) &&
      !this.requestedFull.has(path) &&
      !this.fullInFlightPaths.has(path) &&
      this.fulls.get(path)?.status !== "ready" &&
      !this.navLane.queue.includes(path)
    ) {
      this.navLane.queue.unshift(path);
    }
    this.invalidate(path);
    this.thumbLane.pump();
    this.navLane.pump();
  }

  /** App registers this to surface the non-blocking "folder unreachable —
   *  retry" affordance. Fired once when the trouble threshold latches. */
  setTroubleSink(sink: (() => void) | undefined): void {
    this.troubleSink = sink;
  }

  /**
   * Re-arm everything in place after folder trouble (App calls this once its
   * re-scan probe confirms the folder is reachable again): wipe all failure
   * state, restart the bg sweep over still-missing thumbs, re-queue any
   * wanted-but-missing fulls. Keeps every loaded blob and the user's place —
   * reconnect self-heals without restarting the session.
   */
  rearm(): void {
    this.thumbErrors.clear();
    this.fullErrors.clear();
    this.midErrors.clear();
    this.midUncached.clear();
    this.midReprobed.clear();
    this.trouble.reset();
    for (const p of this.wantFull.keys()) {
      if (
        this.fulls.get(p)?.status !== "ready" &&
        !this.requestedFull.has(p) &&
        !this.fullInFlightPaths.has(p) &&
        !this.navLane.queue.includes(p)
      ) {
        this.navLane.queue.unshift(p);
      }
    }
    this.thumbLane.pump();
    this.navLane.pump();
    // Failed thumbs dropped their request markers — rebuild the sweep queue.
    this.scheduleBgFill(this.generation);
  }

  requestThumbFor(path: string): void {
    if (!path) return;
    if (this.requestedThumb.has(path) || this.thumbs.has(path)) return;
    // Cooling down or terminal → don't queue; the bg-sweep retry (re-added to
    // bgQueue on failure) picks it up when the backoff expires, and the cell
    // is notified via invalidate when the thumb finally lands.
    if (inCooldown(this.thumbErrors.get(path), Date.now())) return;
    this.thumbLane.queue.push(path);
    this.thumbLane.pump();
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
      zoomFull: this.zoomFulls.get(path),
      mid: this.mids.get(path),
      knownDims: this.pathDims.get(path),
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
      zoomFull: this.zoomFulls.get(path),
      mid: this.mids.get(path),
      knownDims: this.pathDims.get(path),
    };
    this.states.set(path, newState);
    const newResolved = resolveStage(newState);
    const old = this.snaps.get(path);
    // Only replace the cached snap (and notify) if something actually changed.
    if (
      !old ||
      old.stage !== newResolved.stage ||
      old.url !== newResolved.url ||
      old.thumbUrl !== newResolved.thumbUrl ||
      old.error !== newResolved.error ||
      old.full?.url !== newResolved.full?.url ||
      old.mid?.url !== newResolved.mid?.url ||
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

  // ── Thumb lane interior (pump mechanics live in tierLane.ts) ──────────

  /**
   * Shared thumb-load interior for both the on-demand lane and the
   * background-fill lane — the two TierLane instances own their counters, so
   * the fetch pipeline lives in exactly one place with no lane parameter.
   */
  private async fetchThumbInto(path: string, gen: number): Promise<void> {
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
      // Feed the session-lifetime dims cache (real dims only, never the
      // {1,1} sentinel) — survives thumb AND full eviction until hardReset.
      if (dims.w > 1 && dims.h > 1) this.pathDims.set(path, dims);
      // Metadata fast path (Phase 3): fresh thumb parses carry the complete
      // Cr3Meta, so the EXIF rail / status-bar MP populate when the THUMB
      // lands — the bg sweep guarantees that for every frame eventually.
      if (result.meta) this.metaSink?.(path, result.meta);
      this.stats.counts.thumbLoads++;
      this.thumbErrors.delete(path);
      this.enforceThumbLru(path);
      this.invalidate(path);
    } catch (e) {
      // Transient failure — record per-tier backoff, drop the request marker
      // so the path CAN re-arm (backoff expiry, folder revisit, manual retry),
      // and re-join the bg sweep, which skips it until nextRetryAt. Terminal
      // after MAX_TIER_ATTEMPTS. Only act for the current generation.
      if (this.generation === gen) {
        const msg = e instanceof Error ? e.message : String(e);
        const te = this.noteTierError(this.thumbErrors, path, msg);
        this.requestedThumb.delete(path);
        if (te.attempts < MAX_TIER_ATTEMPTS && !this.trouble.isTroubled) {
          if (!this.bgLane.queue.includes(path)) this.bgLane.queue.push(path);
          setTimeout(() => {
            if (this.generation === gen && !this.trouble.isTroubled) this.bgLane.pump();
          }, backoffMs(te.attempts));
        }
      }
    }
  }

  /**
   * THE eviction-protection predicate (Phase 1, P5): the one place that
   * answers "may this path's blob be revoked right now?". Tier-aware —
   * display refcounts protect only the thumb (a mounted cell may be showing
   * it via the direct `thumbUrl()` fallbacks); wantFull / pins / in-flight /
   * the keep window protect both tiers. Every eviction site routes through
   * here so a new protection class can never be forgotten at one of them.
   */
  private isProtected(path: string, tier: "thumb" | "full", centerIndex: number): boolean {
    if (this.wantFull.has(path)) return true;
    if (this.pinnedFulls.has(path)) return true;
    // An in-flight full's thumb is the visible fallback the user is staring
    // at; its full entry is "loading" (not evictable) but the thumb matters.
    if (this.fullInFlightPaths.has(path)) return true;
    if (tier === "thumb" && this.displayRefs.has(path)) return true;
    const idx = this.indexOf(path);
    return idx !== -1 && Math.abs(idx - centerIndex) <= this.profile.previewKeep;
  }

  /** Record a failed read for one tier; latches folder-trouble at threshold
   *  (model + latch live in tierErrors.ts — this wires the counter + sink). */
  private noteTierError(map: Map<string, TierError>, path: string, msg: string): TierError {
    const te = recordTierError(map, path, msg);
    this.stats.counts.errors++;
    if (te.attempts >= MAX_TIER_ATTEMPTS && this.trouble.noteTerminal(path)) {
      // Several distinct paths went terminal — the folder itself is almost
      // certainly unreachable (NAS unmount / sleep-wake). Stop hammering;
      // App surfaces the retry affordance, whose re-scan reset()s us clean.
      this.troubleSink?.();
    }
    return te;
  }

  /** LRU cap enforcement, shared by both thumb lanes — REVOKE SITE 1. */
  private enforceThumbLru(justLoaded: string): void {
    if (this.thumbs.size <= this.thumbLruCap) return;
    // Evict the oldest-inserted thumb that is NOT protected (see isProtected).
    // Without the guard a >cap shoot could revoke the blob URL of a thumb a
    // live <img> is still displaying, blanking the frame. Fall back to the
    // strict oldest only if all are protected (the protected set is bounded,
    // so the cap can't run away).
    const cursor = this.cursor;
    let victim: string | undefined;
    for (const key of this.thumbs.keys()) {
      if (key === justLoaded) continue;
      if (this.isProtected(key, "thumb", cursor)) continue;
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

  // ── Nav-preview lane interior ──────────────────────────────────────────

  private async fetchNavInto(path: string, gen: number): Promise<void> {
    // The nav lane's pump has already added `path` to `fullInFlightPaths`
    // and guarantees this is the only in-flight nav read for it.
    try {
      const t0 = performance.now();
      const result = await fetchNav(path, gen);
      const ms = performance.now() - t0;
      if (this.generation !== gen) {
        // Stale session — revoke the freshly created blob
        URL.revokeObjectURL(result.previewUrl);
        return;
      }
      this.stats.noteNavTiming(path, ms);
      // Zoom-tier plumbing from the preview header: the exact-range hint +
      // orientation (echoed to read_fullres), and the NATIVE display dims
      // (sensor pixels, swapped for the rotating orientations) that the
      // hi-res layer's transform math needs.
      const orientation = result.orientation ?? 1;
      this.fullHints.set(path, { offset: result.fullOffset, len: result.fullLen, orientation });
      const pw = result.meta?.pixelWidth;
      const ph = result.meta?.pixelHeight;
      if (pw && ph) {
        const swap = orientation === 6 || orientation === 8;
        this.nativeDims.set(path, swap ? { w: ph, h: pw } : { w: pw, h: ph });
      }
      // If there was already a ready full-res (race), revoke the old one — REVOKE SITE 3
      const existing = this.fulls.get(path);
      if (existing?.status === "ready") {
        URL.revokeObjectURL(existing.url);
      }
      // Use thumb dims as authoritative aspect (orientation-adjusted); the
      // dims cache stands in when the thumb itself was already evicted.
      const thumbEntry = this.thumbs.get(path);
      const dims: ImageDims = thumbEntry?.dims ?? this.pathDims.get(path) ?? UNKNOWN_DIMS;
      this.fulls.set(path, { status: "ready", url: result.previewUrl, dims });
      this.fullErrors.delete(path);
      // Surface EXIF metadata to App (camera / lens / AF point / pixel dims).
      if (result.meta) this.metaSink?.(path, result.meta);
      // A zoom request deferred on this path's missing hint can fire now —
      // the hint (and orientation echo) just landed above.
      if (this.pendingZoom.delete(path)) this.requestZoomFull(path);
      // Same for a deferred mid request (re-checks display engagement fresh).
      if (this.pendingMid.delete(path)) this.maybeRequestMid(path);
      this.invalidate(path);
      // also recenter the keep-window on the CURSOR (not just-loaded), so
      // eviction tracks where the user is, not where the last load happened.
      this.navLane.evictAround(this.cursor);
      // A preview that landed inside the warm band starts decoding now.
      this.refreshPool();
    } catch (e) {
      if (this.generation !== gen) return;
      const msg = e instanceof Error ? e.message : String(e);
      this.fulls.set(path, { status: "error", error: msg });
      // Phase 1 retry model (P6): clear the request marker so the path CAN
      // re-queue (before this, an errored full was skipped by the nav pump
      // forever), record capped backoff, and auto-retry while it's still
      // wanted. Terminal after MAX_TIER_ATTEMPTS → retry()/revisit only.
      // A deferred zoom want dies with the failed nav read (its retry path
      // re-defers via requestZoomFull if the user is still zoomed); same for
      // a deferred mid (the next settle re-requests).
      this.pendingZoom.delete(path);
      this.pendingMid.delete(path);
      this.requestedFull.delete(path);
      const te = this.noteTierError(this.fullErrors, path, msg);
      this.scheduleFullRetry(path, te, gen);
      this.invalidate(path);
    }
  }

  // ── Zoom tier (Phase 3): full-res on settle/zoom only ───────────────────

  /** Exact-range hint + orientation for the zoom/mid reads, from the nav
   *  preview's header if it has landed (all-null → the backend self-derives
   *  orientation from the file's own moov — never assume 1). */
  private hintArgs(path: string): {
    fullOffset: number | null;
    fullLen: number | null;
    orientation: number | null;
  } {
    const hint = this.fullHints.get(path);
    return {
      fullOffset: hint?.offset ?? null,
      fullLen: hint?.len ?? null,
      orientation: hint?.orientation ?? null,
    };
  }

  /** Defer a zoom/mid want until the nav read delivers the path's hint —
   *  fetching without it loses the exact range AND, worse, the orientation
   *  echo (the portrait-zoom-on-arrival bug). fetchNavInto's completion
   *  re-issues the deferred request. */
  private deferUntilHint(path: string, pending: Set<string>): boolean {
    if (
      !this.fullHints.has(path) &&
      (this.fullInFlightPaths.has(path) ||
        this.requestedFull.has(path) ||
        this.navLane.queue.includes(path) ||
        this.wantFull.has(path))
    ) {
      pending.add(path);
      return true;
    }
    return false;
  }

  /**
   * Warm/fetch the zoom full-res for `path` (App calls this from the settle
   * timer and on zoom engage).
   */
  requestZoomFull(path: string): void {
    if (!path) return;
    const existing = this.zoomFulls.get(path);
    if (existing?.status === "ready" || existing?.status === "loading") return;
    if (this.requestedZoom.has(path) || this.zoomInFlightPaths.has(path)) return;
    if (inCooldown(this.zoomErrors.get(path), Date.now())) return;
    // No hint yet and the nav read that delivers it is still underway (zoom
    // engaged immediately on arrival)? DEFER (deferUntilHint).
    if (this.deferUntilHint(path, this.pendingZoom)) return;
    if (!this.zoomLane.queue.includes(path)) this.zoomLane.queue.push(path);
    this.zoomLane.pump();
  }

  private async fetchZoomInto(path: string, gen: number): Promise<void> {
    try {
      const t0 = performance.now();
      const result = await fetchFullres(path, gen, this.hintArgs(path));
      if (this.generation !== gen) {
        URL.revokeObjectURL(result.url); // REVOKE SITE 9 (stale session)
        return;
      }
      const existing = this.zoomFulls.get(path);
      if (existing?.status === "ready") URL.revokeObjectURL(existing.url);
      this.zoomFulls.set(path, {
        status: "ready",
        url: result.url,
        dims: this.nativeDims.get(path),
      });
      this.zoomErrors.delete(path);
      this.stats.counts.zoomLoads++;
      this.stats.noteZoomTiming(path, performance.now() - t0);
      this.invalidate(path);
      this.zoomLane.evictAround(this.cursor);
      // Warm the landed full so zoom stays sharp across hi-res remounts.
      this.refreshPool();
      // Phase 8: the backend's opportunistic generator is (likely) producing
      // this path's mid from the bytes this read just paid for — clear the
      // quiet-miss memo (and the spent re-probe mark: fresh bytes grant a
      // fresh re-probe) and re-probe shortly if the display wants mids.
      this.midUncached.delete(path);
      this.midReprobed.delete(path);
      if (this.evaluateMidEngaged()) this.scheduleMidReprobe(path, gen);
    } catch (e) {
      if (this.generation !== gen) return;
      const msg = e instanceof Error ? e.message : String(e);
      this.requestedZoom.delete(path);
      if (/^cancelled$/i.test(msg)) {
        // Superseded by a session change the backend saw first — quiet drop.
        this.zoomFulls.delete(path);
      } else {
        this.zoomFulls.set(path, { status: "error", error: msg });
        this.noteTierError(this.zoomErrors, path, msg);
      }
      this.invalidate(path);
    }
  }

  /** Re-queue an errored-but-still-wanted full when its backoff expires.
   *  Gen-scoped; every guard re-checks at fire time, so stacked timers from
   *  register/unregister churn are harmless no-ops. */
  private scheduleFullRetry(path: string, te: TierError, gen: number): void {
    if (te.attempts >= MAX_TIER_ATTEMPTS || this.trouble.isTroubled) return;
    setTimeout(
      () => {
        if (this.generation !== gen || this.trouble.isTroubled) return;
        if (!this.wantFull.has(path)) return; // nobody's looking — re-register retries
        if (this.requestedFull.has(path) || this.fullInFlightPaths.has(path)) return;
        if (this.fulls.get(path)?.status === "ready") return;
        if (!this.navLane.queue.includes(path)) this.navLane.queue.unshift(path);
        this.navLane.pump();
      },
      Math.max(0, te.nextRetryAt - Date.now()),
    );
  }

  // ── Mid tier (Phase 8): the display-adaptive ≤2560px settled fit view ───

  /** App injects the FRESH needPx provider (stage rect height × DPR). The
   *  store calls it at each tier-choice moment — never cached at mount. */
  setNeedPxProvider(provider: (() => number | null) | undefined): void {
    this.needPxProvider = provider;
  }

  /** Re-run the hysteresis against a fresh needPx; returns the latch. */
  private evaluateMidEngaged(): boolean {
    this.midEngaged = nextMidEngaged(this.midEngaged, this.needPxProvider?.() ?? null);
    return this.midEngaged;
  }

  /**
   * Display change (stage ResizeObserver fire / matchMedia dppx flip): re-run
   * the tier choice for the CURRENT frame without waiting for a navigation —
   * dragging the window 4K → 1440p and back flips tier choice live. A release
   * only stops future requests; an already-presented mid stays (it's sharper
   * than needed, and the presenter's only-upgrade rule owns what shows).
   */
  reevaluateMid(): void {
    if (this.evaluateMidEngaged()) {
      const path = this.paths[this.cursor];
      if (path) this.requestMid(path);
    }
    this.midSweep.pump();
  }

  /**
   * Request the mid for `path` IF the display needs it — needPx is computed
   * fresh here, per request. App calls this from the settle timer (the mid is
   * the settled fit view's tier); the store calls it from its own re-probe
   * triggers. No-op below the threshold, mid-scrub never reaches it (the
   * settle timer doesn't run there).
   */
  maybeRequestMid(path: string): void {
    if (!this.evaluateMidEngaged()) return;
    this.requestMid(path);
  }

  private requestMid(path: string): void {
    if (!path || this.midUnsupported) return;
    const existing = this.mids.get(path);
    if (existing?.status === "ready" || existing?.status === "loading") return;
    if (this.requestedMid.has(path) || this.midInFlightPaths.has(path)) return;
    // Quiet-miss memo (network profile / generation pending): wait for a
    // re-probe trigger instead of spamming a read that can't succeed yet.
    if (this.midUncached.has(path)) return;
    if (inCooldown(this.midErrors.get(path), Date.now())) return;
    // No hint yet and the nav read that delivers it is underway? Defer —
    // mirror of pendingZoom (deferUntilHint).
    if (this.deferUntilHint(path, this.pendingMid)) return;
    if (!this.midLane.queue.includes(path)) this.midLane.queue.push(path);
    this.midLane.pump();
  }

  private async fetchMidInto(path: string, gen: number): Promise<void> {
    try {
      const result = await fetchMid(path, gen, this.hintArgs(path));
      if (this.generation !== gen) {
        URL.revokeObjectURL(result.url); // REVOKE SITE 11 (stale session)
        return;
      }
      const existing = this.mids.get(path);
      if (existing?.status === "ready") URL.revokeObjectURL(existing.url);
      this.mids.set(path, { status: "ready", url: result.url });
      this.midErrors.delete(path);
      this.midUncached.delete(path);
      this.stats.counts.midLoads++;
      this.invalidate(path);
      this.midLane.evictAround(this.cursor);
    } catch (e) {
      if (this.generation !== gen) return;
      const msg = e instanceof Error ? e.message : String(e);
      this.requestedMid.delete(path);
      this.mids.delete(path);
      if (/^cancelled$/i.test(msg)) {
        // Superseded by a session change the backend saw first — quiet drop.
      } else if (MID_UNCACHED_RE.test(msg)) {
        // Not a failure: nothing cached and this call may not generate (the
        // hard rule) or another producer is mid-generation. Stay on preview;
        // remember so navs don't spam; re-probe ONCE when a zoom landing
        // makes success plausible (a second catch for the same landing stays
        // quiet — without the mark this would poll read_mid every 1.5 s).
        this.midUncached.add(path);
        if (!this.midReprobed.has(path)) {
          this.midReprobed.add(path);
          this.scheduleMidReprobe(path, gen);
        }
      } else if (/not found|unknown command|no handler/i.test(msg)) {
        // Phase-8 frontend on an older backend: the tier stays dormant.
        this.midUnsupported = true;
      } else {
        this.noteTierError(this.midErrors, path, msg);
      }
      this.invalidate(path);
    }
  }

  /** One delayed re-probe after a quiet miss: the opportunistic generator
   *  needs ~300–400 ms of CPU after its zoom read returns. Fires only when a
   *  zoom-tier read is in play for the path (otherwise nothing will have
   *  filled the cache) and only re-requests if the user is still on the
   *  frame. Stacked timers are harmless — every guard re-checks at fire time. */
  private scheduleMidReprobe(path: string, gen: number): void {
    const z = this.zoomFulls.get(path);
    if (!z || z.status === "error") return;
    setTimeout(() => {
      if (this.generation !== gen) return;
      this.midUncached.delete(path);
      if (this.paths[this.cursor] === path) this.maybeRequestMid(path);
    }, MID_REPROBE_MS);
  }

  // ── Mid-tier idle sweep (Phase 8, LOCAL profile only) ────────────────────

  /** True while every on-demand lane is empty AND idle — the sweep's gate
   *  (the plan: "paused while any on-demand queue is non-empty"; the bg
   *  thumb sweep is background, not on-demand, and doesn't pause it). */
  private onDemandIdle(): boolean {
    return (
      this.thumbLane.queue.length === 0 &&
      this.navLane.queue.length === 0 &&
      this.zoomLane.queue.length === 0 &&
      this.midLane.queue.length === 0 &&
      this.fullInFlightPaths.size === 0 &&
      this.zoomInFlightPaths.size === 0 &&
      this.midInFlightPaths.size === 0
    );
  }

  /**
   * Evict a single path's full-res entry (direct, not window-based). Test-only
   * today — production eviction goes through navLane.evictAround — but kept
   * because it's the one place the "evict-then-re-request mid-flight doesn't
   * double-fetch" dedup invariant is exercised end-to-end.
   */
  evictFull(path: string): void {
    const state = this.fulls.get(path);
    if (state?.status === "ready") {
      URL.revokeObjectURL(state.url); // REVOKE SITE 2b (test-only direct eviction)
    }
    this.fulls.delete(path);
    // do NOT drop requestedFull while a nav read is still in flight for
    // this path, or a re-request would start a duplicate fetch.
    if (!this.fullInFlightPaths.has(path)) {
      this.requestedFull.delete(path);
    }
    this.invalidate(path);
    // Every revoke site re-aims the pool MECHANICALLY (never by caller
    // discipline) — a slot must not outlive its blob by more than this call.
    this.refreshPool();
  }

  /**
   * Prefetch nav-tier previews around the cursor — DIRECTION-BIASED 2:1
   * (Phase 5): `previewPrefetchAhead` frames in the travel direction,
   * `previewPrefetchBehind` against it, nearest-first with ahead winning
   * ties, so a single tap to the likely-next neighbour shows the preview
   * immediately. Enqueued at the BACK of the full queue, so the on-demand
   * wantFull for the displayed frame (which unshifts to the front) always
   * wins. Bounded by previewKeep eviction, so it never grows unbounded.
   * Called only when the cursor is settled (see setCursor).
   */
  private prefetchFullsAround(centerIndex: number, radiusOverride?: number): void {
    if (centerIndex < 0) return;
    const ahead = radiusOverride ?? this.profile.previewPrefetchAhead;
    const behind = radiusOverride ?? this.profile.previewPrefetchBehind;
    if (ahead <= 0 && behind <= 0) return;
    const dir = this.lastDir;
    const now = Date.now();
    let enqueued = false;
    for (let d = 1; d <= Math.max(ahead, behind); d++) {
      const candidates: number[] = [];
      if (d <= ahead) candidates.push(centerIndex + d * dir);
      if (d <= behind) candidates.push(centerIndex - d * dir);
      for (const idx of candidates) {
        if (idx < 0 || idx >= this.paths.length) continue;
        const path = this.paths[idx];
        const prev = this.fulls.get(path);
        if (prev?.status === "ready" || prev?.status === "loading") continue;
        if (this.requestedFull.has(path) || this.fullInFlightPaths.has(path)) continue;
        // A neighbour that failed recently retries on ITS schedule, not on
        // every cursor settle (prefetch must never hammer a sick NAS).
        if (inCooldown(this.fullErrors.get(path), now)) continue;
        if (this.navLane.queue.includes(path)) continue;
        this.navLane.queue.push(path);
        enqueued = true;
      }
    }
    if (enqueued) this.navLane.pump();
  }

  /**
   * Re-aim the decode-ahead pool (Phase 5) at the cursor's neighbourhood:
   * already-fetched preview blobs in the direction-biased band decode on
   * detached elements, so the presenter's `decode()` later resolves from the
   * engine's decoded-image cache — neighbour taps snap inside the 48 ms
   * window, warm-scrub steps win their one-frame race. The band's zoom fulls
   * (usually just the settled frame's) stay warm across hi-res layer
   * remounts. Advisory only (see decodePool.ts); zero fetches happen here;
   * a null pool (no DOM — unit tests) is a no-op.
   */
  private refreshPool(): void {
    if (!this.pool) return;
    const c = this.cursor;
    if (c < 0 || c >= this.paths.length) return;
    const previews: PoolEntry[] = [];
    const fulls: PoolEntry[] = [];
    const collect = (idx: number) => {
      if (idx < 0 || idx >= this.paths.length) return;
      const path = this.paths[idx];
      const f = this.fulls.get(path);
      if (f?.status === "ready") previews.push({ path, url: f.url });
      const z = this.zoomFulls.get(path);
      if (z?.status === "ready") fulls.push({ path, url: z.url });
    };
    collect(c); // the displayed frame is always highest priority
    const ahead = this.profile.previewPrefetchAhead;
    const behind = this.profile.previewPrefetchBehind;
    for (let d = 1; d <= Math.max(ahead, behind); d++) {
      if (d <= ahead) collect(c + d * this.lastDir);
      if (d <= behind) collect(c - d * this.lastDir);
    }
    this.pool.retain("preview", previews, this.profile.decodedPoolPreviews);
    this.pool.retain("full", fulls, this.profile.decodedPoolFulls);
  }

  // ── Background-fill pump ────────────────────────────────────────────────

  private scheduleBgFill(gen: number): void {
    if (this.generation !== gen) return;
    // The queue is UNORDERED — pickBg() finds the grid-viewport-first /
    // nearest-cursor candidate by argmin at pump time, against the live cursor.
    this.bgLane.queue = this.paths.filter(
      (p) => !this.thumbs.has(p) && !this.requestedThumb.has(p),
    );
    this.bgLane.pump();
  }

  // ── Dev HUD (Phase 3; data + ring buffers live in devStats.ts) ──────────

  /**
   * Snapshot for the dev HUD — every profile-tuning claim cites these
   * numbers, not feel. Cheap: plain reads over existing state. Decoded-memory
   * is an ESTIMATE (preview ≈ 7 MB RGBA at 1620×1080; zoom full from native
   * dims ×4 B/px; thumbs ≈ 0.08 MB); the webview's decoded cache is opaque.
   */
  debugStats(): {
    navTimings: { name: string; ms: number }[];
    zoomTimings: { name: string; ms: number }[];
    pool: { previews: number; fulls: number };
    navMsAvg: number;
    lanes: { preview: string; zoom: string; thumb: string; bg: string };
    caches: { previews: number; zoomFulls: number; thumbs: number; dims: number };
    counts: {
      navLoads: number;
      zoomLoads: number;
      thumbLoads: number;
      midLoads: number;
      midGens: number;
      previewEvicts: number;
      zoomEvicts: number;
      midEvicts: number;
      errors: number;
    };
    mid: {
      engaged: boolean;
      needPx: number | null;
      lane: string;
      cached: number;
      sweepLeft: number;
    };
    decodedMB: number;
  } {
    const previews = [...this.fulls.values()].filter((s) => s?.status === "ready").length;
    const zooms = [...this.zoomFulls.entries()].filter(([, s]) => s?.status === "ready");
    const mids = [...this.mids.values()].filter((s) => s?.status === "ready").length;
    let zoomMB = 0;
    for (const [p] of zooms) {
      const d = this.nativeDims.get(p);
      zoomMB += d ? (d.w * d.h * 4) / 1_048_576 : 130;
    }
    return {
      navTimings: this.stats.navTimings.slice(0, 8),
      zoomTimings: this.stats.zoomTimings.slice(0, 5),
      pool: this.pool?.counts() ?? { previews: 0, fulls: 0 },
      navMsAvg: this.stats.navMsAvg(),
      lanes: {
        preview: `${this.navLane.inFlight}/${this.profile.previewConcurrency} q${this.navLane.queue.length}`,
        zoom: `${this.zoomLane.inFlight}/${this.profile.fullConcurrency} q${this.zoomLane.queue.length}`,
        thumb: `${this.thumbLane.inFlight}/${this.profile.thumbConcurrency} q${this.thumbLane.queue.length}`,
        bg: `${this.bgLane.inFlight}/${this.profile.backgroundFillConcurrency} q${this.bgLane.queue.length}`,
      },
      caches: {
        previews,
        zoomFulls: zooms.length,
        thumbs: this.thumbs.size,
        dims: this.pathDims.size,
      },
      counts: { ...this.stats.counts },
      // The needPx readout is the manual matrix's instrument: it shows the
      // LIVE display demand and which side of the hysteresis band it sits on.
      mid: {
        engaged: this.midEngaged,
        needPx: (() => {
          const v = this.needPxProvider?.() ?? null;
          return v === null ? null : Math.round(v);
        })(),
        lane: `${this.midLane.inFlight}/${this.profile.midGenConcurrency} q${this.midLane.queue.length}`,
        cached: mids,
        sweepLeft:
          this.profile.concurrentRestore && this.midEngaged
            ? Math.max(0, this.paths.length - this.midSweep.doneSize)
            : 0,
      },
      decodedMB: Math.round(previews * 7 + zoomMB + mids * 17 + this.thumbs.size * 0.08),
    };
  }
}

export const imageStore = new ImageStore();
