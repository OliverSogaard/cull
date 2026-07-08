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
 *  2. evictFullAround — when a full-res entry leaves the windowed cache
 *     (2b. evictFull — test-only direct eviction of one path)
 *  3. loadFull — when a full-res entry is REPLACED by a fresher one (no double-keep)
 *  4. hardReset — revokes ALL thumb + full blob URLs (folder change / session end)
 *  5. reset(paths) — revokes full-res for all tracked paths; thumbs are kept
 *  6. loadThumbInto — stale-generation arrival: revoke the just-created thumb
 *     blob when the session changed while the read was in flight
 *  7. loadFull — stale-generation arrival: revoke the just-created preview blob
 *  8–10. zoom tier (reset/hardReset, loadZoomFull stale/replace, evictZoomAround)
 *  11–12. mid tier (Phase 8): reset/hardReset + loadMid stale/replace (11),
 *     evictMidAround window eviction (12)
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
import { resolveStage, type ImageState, type Resolved } from "./stage";
import type { ImageDims } from "../utils/bundle";
import type { ImageMetadata } from "../types";

// ── Types ──────────────────────────────────────────────────────────────────

type ThumbEntry = { url: string; dims: ImageDims };

/** All-session thumb LRU cap (loadThumb + loadBg share this). */
const THUMB_LRU_CAP = 15000;

/** Placeholder dims used before real dimensions are known. */
const UNKNOWN_DIMS: ImageDims = { w: 1, h: 1 };

// ── Tier error model (Phase 1) ─────────────────────────────────────────────
// Per-path per-tier transient-failure state with capped exponential backoff.
// attempts 1..MAX retry automatically (1s, 2s, 4s… capped); at MAX the tier is
// TERMINAL: no auto-retry until the folder is revisited (reset clears these)
// or the user hits the error panel's retry affordance (retry()).

/** Per-tier failure record. */
type TierError = { attempts: number; lastError: string; nextRetryAt: number };

/** First-retry delay; doubles per attempt. */
const RETRY_BASE_MS = 1000;
/** Backoff ceiling. */
const RETRY_CAP_MS = 30_000;
/** Failed attempts before a tier goes terminal. */
const MAX_TIER_ATTEMPTS = 4;
/** Distinct terminal-failed paths that trip the folder-unreachable affordance
 *  (NAS unmounted / sleep-wake) — past this the store stops hammering and App
 *  surfaces a non-blocking "folder unreachable — retry" chip. */
const FOLDER_TROUBLE_THRESHOLD = 4;

const backoffMs = (attempts: number): number =>
  Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** (attempts - 1));

/** Delay before re-probing `read_mid` after a quiet miss (Phase 8): the
 *  opportunistic generator needs ~300–400 ms of CPU after its zoom read
 *  returns, plus slack for the MidGen queue. */
const MID_REPROBE_MS = 1500;

/** The idle sweep waits for this much cursor quiet before (re)starting —
 *  warm-region navigation and scrubbing issue zero reads, so the on-demand
 *  queues alone can't tell "user active" from "user parked" (review F3). */
const MID_SWEEP_QUIET_MS = 1500;

/** Sweep budget: the mid tier's disk cap (4 GiB, low-water 90%) over a
 *  realistic ~1.05 MB q80 entry ≈ 3,500 entries — sweeping past it would
 *  LRU-evict the user's own working neighbourhood to write far-end mids
 *  (review F1). Nearest-cursor-first ordering makes the budget cover the
 *  frames that matter; on-demand read_mid still serves anything beyond it. */
const MID_SWEEP_BUDGET = 3400;

/** True while the tier must NOT be auto-requested (cooling down or terminal). */
const inCooldown = (te: TierError | undefined, now: number): boolean =>
  te !== undefined && (te.attempts >= MAX_TIER_ATTEMPTS || now < te.nextRetryAt);

/** Constructor options (test-only knobs kept minimal). */
export type ImageStoreOptions = {
  /** Override the thumb LRU cap (test-only — exercise eviction with a small N). */
  thumbLruCap?: number;
  /** Decode-ahead pool element factory (Phase 5) — tests inject fakes; the
   *  default uses `new Image()` and disables the pool when no DOM exists. */
  poolImageFactory?: () => PoolImage;
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
  /** path → number of mounted consumers DISPLAYING this path (every useImage
   *  caller — loupe, compare panes, grid/strip cells). Protects the path's
   *  thumb blob from LRU revocation while a live <img> may be showing it
   *  (the direct `thumbUrl()` readers all sit inside such a consumer). */
  private displayRefs = new Map<string, number>();
  /** path → pin count. A pinned path's full is NEVER evicted: compare pins its
   *  pair for the session, App pins the zoomed frame, the histogram probe pins
   *  during its decode. Refcounted like wantFull. */
  private pinnedFulls = new Map<string, number>();
  /** Per-path per-tier failure state (capped backoff; see TierError). */
  private thumbErrors = new Map<string, TierError>();
  private fullErrors = new Map<string, TierError>();
  /** Paths whose thumb or full reached MAX_TIER_ATTEMPTS this session. */
  private terminalPaths = new Set<string>();
  /** Latched when terminalPaths crosses FOLDER_TROUBLE_THRESHOLD: stop all
   *  auto-retries + bg sweep until the user retries (App re-runs the scan →
   *  reset() clears this) or retry()/reset re-arms. */
  private folderTrouble = false;
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
  private zoomQueue: string[] = [];
  private requestedZoom = new Set<string>();
  private zoomInFlightPaths = new Set<string>();
  private zoomInFlight = 0;
  private zoomErrors = new Map<string, TierError>();
  /** Zoom requests deferred until the nav read delivers the path's hint —
   *  fetching without it loses the exact range AND the orientation echo
   *  (the portrait-zoom-on-arrival bug). loadFull's completion re-issues. */
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
  private midQueue: string[] = [];
  private requestedMid = new Set<string>();
  private midInFlightPaths = new Set<string>();
  private midInFlight = 0;
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
   *  scan instead of two exact-range reads). loadFull's completion re-issues. */
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
  // Local-profile idle sweep (paused while any on-demand lane has work):
  /** Paths already attempted this session (success OR failure — best-effort,
   *  one shot each; on-demand read_mid still covers misses). */
  private midSweepDone = new Set<string>();
  private midSweepInFlight = 0;
  /** Last cursor move (any kind) — the sweep waits out MID_SWEEP_QUIET_MS of
   *  cursor quiet so warm-region arrowing / scrubbing (which issue no reads)
   *  don't share the CPU with generation. */
  private lastCursorMoveAt = 0;
  /** One-shot re-pump timer for the quiet window (armed at most once). */
  private midSweepTimerArmed = false;
  /** Decode-ahead warm pool (Phase 5) — null when no DOM (unit tests). */
  private readonly pool: DecodePool | null;
  /** Last cursor travel direction: biases prefetch + the pool band 2:1. */
  private lastDir: 1 | -1 = 1;
  // ── Dev HUD stats (cheap counters; read via debugStats) ─────────────────
  private navTimings: { name: string; ms: number }[] = [];
  /** Zoom-tier (full) fetch timings — on a fast local drive this is ≈ the raw
   *  IPC transfer cost of the ~10 MB full, i.e. the Phase 2 Windows
   *  benchmark readout. */
  private zoomTimings: { name: string; ms: number }[] = [];
  private counts = {
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
    this.evictFullAround(this.cursor);
    this.evictZoomAround(this.cursor);
    this.evictMidAround(this.cursor);
    // Re-aim the pool under the new caps/radii (a network→local flip may
    // shrink it; eviction above may have dropped blobs it referenced).
    this.refreshPool();
    this.pumpThumbs();
    this.pumpFull();
    this.pumpBg();
    this.pumpZoom();
    this.pumpMid();
    this.pumpMidSweep();
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
      this.counts.zoomEvicts++;
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
    return this.zoomInFlight > 0 || this.fullInFlightPaths.size > 0;
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

    // Cancel queued work
    this.thumbQueue = [];
    this.fullQueue = [];
    this.bgQueue = [];
    this.zoomQueue = [];
    this.wantFull.clear();
    this.requestedFull.clear();
    this.requestedZoom.clear();
    this.pendingZoom.clear();
    this.zoomInFlightPaths.clear();
    this.zoomInFlight = 0;
    this.zoomErrors.clear();
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
    this.midQueue = [];
    this.requestedMid.clear();
    this.pendingMid.clear();
    this.midInFlightPaths.clear();
    this.midInFlight = 0;
    this.midErrors.clear();
    this.midUncached.clear();
    this.midReprobed.clear();
    this.midSweepDone.clear();
    this.midSweepInFlight = 0;
    // The pool's decoded refs point at blob URLs this reset revokes.
    this.pool?.clear();
    // old-gen thumb loads bailed without populating `thumbs`; if we keep
    // their paths in requestedThumb they'd be excluded from bg-fill forever
    // (permanent shimmer). Clear it so the new session can re-schedule them.
    this.requestedThumb.clear();
    // Folder revisit re-arms every failed tier (terminal included) — an
    // unmounted NAS that reconnected gets a clean slate. pathDims survives
    // (it's a session-lifetime cache, like thumbs; hardReset clears it).
    // displayRefs/pinnedFulls are component-lifetime, not generation-scoped:
    // mounted consumers unregister on their own unmount.
    this.thumbErrors.clear();
    this.fullErrors.clear();
    this.terminalPaths.clear();
    this.folderTrouble = false;

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
    this.pushBackend("begin_session", { gen: this.generation });

    this.thumbQueue = [];
    this.fullQueue = [];
    this.bgQueue = [];
    this.zoomQueue = [];
    this.wantFull.clear();
    this.requestedThumb.clear();
    this.requestedFull.clear();
    this.requestedZoom.clear();
    this.pendingZoom.clear();
    this.fullInFlightPaths.clear();
    this.zoomInFlightPaths.clear();
    this.zoomInFlight = 0;
    this.zoomErrors.clear();
    for (const [, state] of this.zoomFulls) {
      if (state?.status === "ready") URL.revokeObjectURL(state.url); // REVOKE SITE 8
    }
    this.zoomFulls.clear();
    for (const [, state] of this.mids) {
      if (state?.status === "ready") URL.revokeObjectURL(state.url); // REVOKE SITE 11
    }
    this.mids.clear();
    this.midQueue = [];
    this.requestedMid.clear();
    this.pendingMid.clear();
    this.midInFlightPaths.clear();
    this.midInFlight = 0;
    this.midErrors.clear();
    this.midUncached.clear();
    this.midReprobed.clear();
    this.midSweepDone.clear();
    this.midSweepInFlight = 0;
    this.fullHints.clear();
    this.nativeDims.clear();
    this.navTimings = [];
    this.zoomTimings = [];
    this.pool?.clear();
    this.thumbErrors.clear();
    this.fullErrors.clear();
    this.terminalPaths.clear();
    this.folderTrouble = false;
    this.pathDims.clear();
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
    this.lastDir = 1; // stale travel direction must not aim the new session's first prefetch backwards
    this.gridStart = -1;
    this.gridEnd = -1;
  }

  setCursor(index: number, scrubbing = false): void {
    if (index > this.cursor) this.lastDir = 1;
    else if (index < this.cursor) this.lastDir = -1;
    this.cursor = index;
    this.lastCursorMoveAt = Date.now();
    // Eviction is cursor-driven — recenter the keep-windows on the cursor
    // even when no new load just landed (parking on a frame recenters).
    this.evictFullAround(index);
    this.evictZoomAround(index);
    this.evictMidAround(index);
    // bg priority needs no re-sort: pickBg() reads the live cursor at pump time.
    this.pumpBg();
    this.pumpFull();
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
    this.pumpMidSweep();
  }

  setGridRange(start: number, end: number): void {
    this.gridStart = start;
    this.gridEnd = end;
    // Grid view never zooms — release the pool's decoded zoom fulls
    // (~130 MB each); the previews stay warm for the return to loupe.
    this.pool?.retain("full", [], 0);
    this.pumpBg();
  }

  /** Clear the grid viewport so bg-fill prioritizes purely by cursor distance. */
  clearGridRange(): void {
    this.gridStart = -1;
    this.gridEnd = -1;
    this.refreshPool(); // back in loupe — re-warm the band (incl. zoom fulls)
    this.pumpBg();
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
    for (let k = 0; k < this.bgQueue.length; k++) {
      const p = this.bgQueue[k];
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
    this.wantFull.set(path, (this.wantFull.get(path) ?? 0) + 1);
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

  /** A mounted consumer is displaying this path (any tier). Protects the
   *  path's THUMB blob from LRU revocation while a live <img> may show it. */
  registerDisplay(path: string): void {
    if (!path) return;
    this.displayRefs.set(path, (this.displayRefs.get(path) ?? 0) + 1);
  }

  unregisterDisplay(path: string): void {
    if (!path) return;
    const n = this.displayRefs.get(path);
    if (n === undefined) return;
    if (n <= 1) this.displayRefs.delete(path);
    else this.displayRefs.set(path, n - 1);
  }

  /** Pin a path's full against eviction (compare pair for the session, the
   *  zoomed frame, the histogram probe mid-decode). Refcounted. */
  pinFull(path: string): void {
    if (!path) return;
    this.pinnedFulls.set(path, (this.pinnedFulls.get(path) ?? 0) + 1);
  }

  unpinFull(path: string): void {
    if (!path) return;
    const n = this.pinnedFulls.get(path);
    if (n === undefined) return;
    if (n <= 1) this.pinnedFulls.delete(path);
    else this.pinnedFulls.set(path, n - 1);
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
    this.terminalPaths.delete(path);
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
      if (!this.thumbQueue.includes(path)) this.thumbQueue.unshift(path);
    }
    if (
      this.wantFull.has(path) &&
      !this.requestedFull.has(path) &&
      !this.fullInFlightPaths.has(path) &&
      this.fulls.get(path)?.status !== "ready" &&
      !this.fullQueue.includes(path)
    ) {
      this.fullQueue.unshift(path);
    }
    this.invalidate(path);
    this.pumpThumbs();
    this.pumpFull();
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
    this.terminalPaths.clear();
    this.folderTrouble = false;
    for (const p of this.wantFull.keys()) {
      if (
        this.fulls.get(p)?.status !== "ready" &&
        !this.requestedFull.has(p) &&
        !this.fullInFlightPaths.has(p) &&
        !this.fullQueue.includes(p)
      ) {
        this.fullQueue.unshift(p);
      }
    }
    this.pumpThumbs();
    this.pumpFull();
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

  // ── Thumb pump ─────────────────────────────────────────────────────────

  private pumpThumbs(): void {
    while (this.thumbInFlight < this.profile.thumbConcurrency && this.thumbQueue.length > 0) {
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
      // Feed the session-lifetime dims cache (real dims only, never the
      // {1,1} sentinel) — survives thumb AND full eviction until hardReset.
      if (dims.w > 1 && dims.h > 1) this.pathDims.set(path, dims);
      // Metadata fast path (Phase 3): fresh thumb parses carry the complete
      // Cr3Meta, so the EXIF rail / status-bar MP populate when the THUMB
      // lands — the bg sweep guarantees that for every frame eventually.
      if (result.meta) this.metaSink?.(path, result.meta);
      this.counts.thumbLoads++;
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
        const te = this.recordTierError(this.thumbErrors, path, msg);
        this.requestedThumb.delete(path);
        if (te.attempts < MAX_TIER_ATTEMPTS && !this.folderTrouble) {
          if (!this.bgQueue.includes(path)) this.bgQueue.push(path);
          setTimeout(() => {
            if (this.generation === gen && !this.folderTrouble) this.pumpBg();
          }, backoffMs(te.attempts));
        }
      }
    } finally {
      // gen-scoped decrement. A superseded load must NOT touch the current
      // session's counters (reset/hardReset already zeroed them).
      if (this.generation === gen) {
        if (lane === "thumb") this.thumbInFlight--;
        else this.bgInFlight--;
        this.pumpThumbs();
        this.pumpBg();
        this.pumpMidSweep();
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

  /** Record a failed read for one tier; latches folder-trouble at threshold. */
  private recordTierError(map: Map<string, TierError>, path: string, msg: string): TierError {
    const attempts = (map.get(path)?.attempts ?? 0) + 1;
    const te: TierError = {
      attempts,
      lastError: msg,
      nextRetryAt: Date.now() + backoffMs(attempts),
    };
    map.set(path, te);
    this.counts.errors++;
    if (attempts >= MAX_TIER_ATTEMPTS) {
      this.terminalPaths.add(path);
      if (!this.folderTrouble && this.terminalPaths.size >= FOLDER_TROUBLE_THRESHOLD) {
        // Several distinct paths went terminal — the folder itself is almost
        // certainly unreachable (NAS unmount / sleep-wake). Stop hammering;
        // App surfaces the retry affordance, whose re-scan reset()s us clean.
        this.folderTrouble = true;
        this.troubleSink?.();
      }
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

  // ── Full-res pump ───────────────────────────────────────────────────────

  private pumpFull(): void {
    while (this.fullInFlight < this.profile.previewConcurrency && this.fullQueue.length > 0) {
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
      const t0 = performance.now();
      const result = await fetchNav(path, gen);
      const ms = performance.now() - t0;
      if (this.generation !== gen) {
        // Stale session — revoke the freshly created blob
        URL.revokeObjectURL(result.previewUrl);
        return;
      }
      this.noteNavTiming(path, ms);
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
      this.evictFullAround(this.cursor);
      // A preview that landed inside the warm band starts decoding now.
      this.refreshPool();
    } catch (e) {
      if (this.generation !== gen) return;
      const msg = e instanceof Error ? e.message : String(e);
      this.fulls.set(path, { status: "error", error: msg });
      // Phase 1 retry model (P6): clear the request marker so the path CAN
      // re-queue (before this, an errored full was skipped by pumpFull
      // forever), record capped backoff, and auto-retry while it's still
      // wanted. Terminal after MAX_TIER_ATTEMPTS → retry()/revisit only.
      // A deferred zoom want dies with the failed nav read (its retry path
      // re-defers via requestZoomFull if the user is still zoomed); same for
      // a deferred mid (the next settle re-requests).
      this.pendingZoom.delete(path);
      this.pendingMid.delete(path);
      this.requestedFull.delete(path);
      const te = this.recordTierError(this.fullErrors, path, msg);
      this.scheduleFullRetry(path, te, gen);
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
        // finishing the last on-demand full must wake the bg sweep — and the
        // mid sweep, which idles while any on-demand lane has work.
        this.pumpBg();
        this.pumpMidSweep();
      }
    }
  }

  /**
   * Evict full-res entries that are far from `centerIndex`, keeping at most
   * `previewKeep` on each side. Revokes their blob URLs. — REVOKE SITE 2.
   * Cursor-driven: callable from setCursor and after a load. Protection
   * (wantFull, pins, in-flight, keep window) lives in isProtected — e.g. in
   * compare the cursor follows the challenger, so without the champion's
   * wantFull/pin it would be evicted + re-fetched on every challenger step.
   */
  private evictFullAround(centerIndex: number): void {
    if (centerIndex < 0) return;
    for (const [p, state] of this.fulls) {
      if (state?.status !== "ready") continue;
      if (this.isProtected(p, "full", centerIndex)) continue;
      URL.revokeObjectURL(state.url);
      this.fulls.delete(p);
      this.requestedFull.delete(p);
      this.counts.previewEvicts++;
      this.invalidate(p);
    }
  }

  // ── Zoom tier (Phase 3): full-res on settle/zoom only ───────────────────

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
    // engaged immediately on arrival)? DEFER — a hintless fetch loses the
    // exact range and, worse, the orientation echo. loadFull re-issues.
    if (
      !this.fullHints.has(path) &&
      (this.fullInFlightPaths.has(path) ||
        this.requestedFull.has(path) ||
        this.fullQueue.includes(path) ||
        this.wantFull.has(path))
    ) {
      this.pendingZoom.add(path);
      return;
    }
    if (!this.zoomQueue.includes(path)) this.zoomQueue.push(path);
    this.pumpZoom();
  }

  private pumpZoom(): void {
    while (this.zoomInFlight < this.profile.fullConcurrency && this.zoomQueue.length > 0) {
      const path = this.zoomQueue.shift()!;
      const prev = this.zoomFulls.get(path);
      if (prev?.status === "ready") continue;
      if (this.requestedZoom.has(path) || this.zoomInFlightPaths.has(path)) continue;
      this.requestedZoom.add(path);
      this.zoomInFlightPaths.add(path);
      this.zoomFulls.set(path, { status: "loading" });
      this.invalidate(path);
      this.zoomInFlight++;
      void this.loadZoomFull(path);
    }
  }

  private async loadZoomFull(path: string): Promise<void> {
    const gen = this.generation;
    const hint = this.fullHints.get(path);
    try {
      const t0 = performance.now();
      const result = await fetchFullres(path, gen, {
        fullOffset: hint?.offset ?? null,
        fullLen: hint?.len ?? null,
        // null → the backend derives orientation from the file's own moov.
        orientation: hint?.orientation ?? null,
      });
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
      this.counts.zoomLoads++;
      this.noteZoomTiming(path, performance.now() - t0);
      this.invalidate(path);
      this.evictZoomAround(this.cursor);
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
        this.recordTierError(this.zoomErrors, path, msg);
      }
      this.invalidate(path);
    } finally {
      this.zoomInFlightPaths.delete(path);
      if (this.generation === gen) {
        this.zoomInFlight--;
        this.pumpZoom();
        this.pumpMidSweep();
      }
    }
  }

  /** Evict zoom fulls outside the (tiny) fullKeep window — REVOKE SITE 10.
   *  Pins (zoomed frame, compare pair, histogram probe) and in-flight reads
   *  are protected; full blobs are ~10 MB each so the window stays small. */
  private evictZoomAround(centerIndex: number): void {
    if (centerIndex < 0) return;
    const keep = this.profile.fullKeep;
    for (const [p, state] of this.zoomFulls) {
      if (state?.status !== "ready") continue;
      if (this.pinnedFulls.has(p) || this.zoomInFlightPaths.has(p)) continue;
      const idx = this.indexOf(p);
      if (idx !== -1 && Math.abs(idx - centerIndex) <= keep) continue;
      URL.revokeObjectURL(state.url);
      this.zoomFulls.delete(p);
      this.requestedZoom.delete(p);
      this.counts.zoomEvicts++;
      this.invalidate(p);
    }
  }

  /** Re-queue an errored-but-still-wanted full when its backoff expires.
   *  Gen-scoped; every guard re-checks at fire time, so stacked timers from
   *  register/unregister churn are harmless no-ops. */
  private scheduleFullRetry(path: string, te: TierError, gen: number): void {
    if (te.attempts >= MAX_TIER_ATTEMPTS || this.folderTrouble) return;
    setTimeout(
      () => {
        if (this.generation !== gen || this.folderTrouble) return;
        if (!this.wantFull.has(path)) return; // nobody's looking — re-register retries
        if (this.requestedFull.has(path) || this.fullInFlightPaths.has(path)) return;
        if (this.fulls.get(path)?.status === "ready") return;
        if (!this.fullQueue.includes(path)) this.fullQueue.unshift(path);
        this.pumpFull();
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
    this.pumpMidSweep();
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
    // mirror of pendingZoom (loadFull's completion re-issues).
    if (
      !this.fullHints.has(path) &&
      (this.fullInFlightPaths.has(path) ||
        this.requestedFull.has(path) ||
        this.fullQueue.includes(path) ||
        this.wantFull.has(path))
    ) {
      this.pendingMid.add(path);
      return;
    }
    if (!this.midQueue.includes(path)) this.midQueue.push(path);
    this.pumpMid();
  }

  private pumpMid(): void {
    while (this.midInFlight < this.profile.midGenConcurrency && this.midQueue.length > 0) {
      const path = this.midQueue.shift()!;
      const prev = this.mids.get(path);
      if (prev?.status === "ready") continue;
      if (this.requestedMid.has(path) || this.midInFlightPaths.has(path)) continue;
      this.requestedMid.add(path);
      this.midInFlightPaths.add(path);
      this.mids.set(path, { status: "loading" });
      this.invalidate(path);
      this.midInFlight++;
      void this.loadMid(path);
    }
  }

  private async loadMid(path: string): Promise<void> {
    const gen = this.generation;
    const hint = this.fullHints.get(path);
    try {
      const result = await fetchMid(path, gen, {
        fullOffset: hint?.offset ?? null,
        fullLen: hint?.len ?? null,
        // null → the backend self-derives orientation from moov (never 1).
        orientation: hint?.orientation ?? null,
      });
      if (this.generation !== gen) {
        URL.revokeObjectURL(result.url); // REVOKE SITE 11 (stale session)
        return;
      }
      const existing = this.mids.get(path);
      if (existing?.status === "ready") URL.revokeObjectURL(existing.url);
      this.mids.set(path, { status: "ready", url: result.url });
      this.midErrors.delete(path);
      this.midUncached.delete(path);
      this.counts.midLoads++;
      this.invalidate(path);
      this.evictMidAround(this.cursor);
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
        this.recordTierError(this.midErrors, path, msg);
      }
      this.invalidate(path);
    } finally {
      this.midInFlightPaths.delete(path);
      if (this.generation === gen) {
        this.midInFlight--;
        this.pumpMid();
        this.pumpMidSweep();
      }
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

  /** Evict mids outside the fullKeep window — REVOKE SITE 12. Mid blobs are
   *  ~1 MB and share the zoom tier's settled-frame cadence, so they share its
   *  window too. displayRefs additionally protect any mounted consumer's
   *  frame (the presenter may still be showing its decoded raster). */
  private evictMidAround(centerIndex: number): void {
    if (centerIndex < 0) return;
    const keep = this.profile.fullKeep;
    for (const [p, state] of this.mids) {
      if (state?.status !== "ready") continue;
      if (this.midInFlightPaths.has(p) || this.displayRefs.has(p)) continue;
      const idx = this.indexOf(p);
      if (idx !== -1 && Math.abs(idx - centerIndex) <= keep) continue;
      URL.revokeObjectURL(state.url);
      this.mids.delete(p);
      this.requestedMid.delete(p);
      this.counts.midEvicts++;
      this.invalidate(p);
    }
  }

  // ── Mid-tier idle sweep (Phase 8, LOCAL profile only) ────────────────────

  /** True while every on-demand lane is empty AND idle — the sweep's gate
   *  (the plan: "paused while any on-demand queue is non-empty"; the bg
   *  thumb sweep is background, not on-demand, and doesn't pause it). */
  private onDemandIdle(): boolean {
    return (
      this.thumbQueue.length === 0 &&
      this.fullQueue.length === 0 &&
      this.zoomQueue.length === 0 &&
      this.midQueue.length === 0 &&
      this.fullInFlightPaths.size === 0 &&
      this.zoomInFlightPaths.size === 0 &&
      this.midInFlightPaths.size === 0
    );
  }

  /**
   * Pre-generate mids nearest-to-cursor while the session is idle, so every
   * settled view on a high-DPI display is eventually a cache hit. Gates:
   * LOCAL profile only (the backend refuses otherwise — generating from a
   * NAS would fetch fulls solely to generate, the hard rule), display
   * actually engaged (a 1440p session must not burn CPU + 4 GB of disk on
   * mids it never shows), first-full window respected (bgStarted), paused
   * while any on-demand lane has work. Each path is attempted once per
   * session; failures are best-effort quiet (read_mid covers on-demand).
   */
  private pumpMidSweep(): void {
    if (this.folderTrouble || this.midUnsupported) return;
    if (!this.profile.concurrentRestore) return; // network profile — local only
    if (!this.bgStarted || !this.midEngaged) return;
    // Disk budget (review F1): past ~the tier cap's worth of entries, more
    // sweeping only LRU-evicts the working neighbourhood's own mids.
    if (this.midSweepDone.size >= MID_SWEEP_BUDGET) return;
    // Cursor quiet (review F3): warm-region arrowing and scrubbing issue no
    // reads, so the on-demand-idle check alone can't see the user — wait out
    // a quiet window and re-pump from a one-shot timer.
    if (Date.now() - this.lastCursorMoveAt < MID_SWEEP_QUIET_MS) {
      this.armMidSweepTimer();
      return;
    }
    while (this.midSweepInFlight < this.profile.midGenConcurrency && this.onDemandIdle()) {
      const path = this.pickMidSweep();
      if (!path) return;
      this.midSweepDone.add(path);
      this.midSweepInFlight++;
      void this.sweepMid(path);
    }
  }

  /** One-shot quiet-window re-pump (gen-scoped; at most one armed timer). */
  private armMidSweepTimer(): void {
    if (this.midSweepTimerArmed) return;
    this.midSweepTimerArmed = true;
    const gen = this.generation;
    setTimeout(() => {
      this.midSweepTimerArmed = false;
      if (this.generation === gen) this.pumpMidSweep();
    }, MID_SWEEP_QUIET_MS);
  }

  /** Nearest-to-cursor argmin over not-yet-attempted paths (pickBg's style). */
  private pickMidSweep(): string | null {
    let best: string | null = null;
    let bestD = Infinity;
    for (let i = 0; i < this.paths.length; i++) {
      const p = this.paths[i];
      if (this.midSweepDone.has(p)) continue;
      if (this.mids.get(p)?.status === "ready") continue;
      const d = Math.abs(i - this.cursor);
      if (d < bestD) {
        best = p;
        bestD = d;
      }
    }
    return best;
  }

  private async sweepMid(path: string): Promise<void> {
    const gen = this.generation;
    const hint = this.fullHints.get(path);
    try {
      const ok = await invokeGenerateMid(path, gen, {
        fullOffset: hint?.offset ?? null,
        fullLen: hint?.len ?? null,
        orientation: hint?.orientation ?? null,
      });
      if (this.generation === gen && ok) this.counts.midGens++;
    } catch {
      // Best-effort: attempted once; on-demand read_mid still covers it.
    } finally {
      if (this.generation === gen) {
        this.midSweepInFlight--;
        this.pumpMidSweep();
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
      URL.revokeObjectURL(state.url); // REVOKE SITE 2b (test-only direct eviction)
    }
    this.fulls.delete(path);
    // do NOT drop requestedFull while a loadFull is still in flight for
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
        if (this.fullQueue.includes(path)) continue;
        this.fullQueue.push(path);
        enqueued = true;
      }
    }
    if (enqueued) this.pumpFull();
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
    this.bgQueue = this.paths.filter((p) => !this.thumbs.has(p) && !this.requestedThumb.has(p));
    this.pumpBg();
  }

  private pumpBg(): void {
    // Folder unreachable — every new read would hang/fail for its full
    // timeout. The retry affordance (re-scan → reset) re-arms everything.
    if (this.folderTrouble) return;
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
      const k = this.pickBg();
      if (k === -1) break; // every remaining candidate is cooling down
      const path = this.bgQueue.splice(k, 1)[0];
      if (this.thumbs.has(path) || this.requestedThumb.has(path)) continue;
      this.requestedThumb.add(path);
      this.bgInFlight++;
      void this.loadThumbInto("bg", path);
    }
  }

  // ── Dev HUD (Phase 3) ────────────────────────────────────────────────────

  /** Ring buffer of the last nav fetch timings (newest first). */
  private noteNavTiming(path: string, ms: number): void {
    this.counts.navLoads++;
    const name = path.slice(path.lastIndexOf("/") + 1).slice(path.lastIndexOf("\\") + 1);
    this.navTimings.unshift({ name, ms: Math.round(ms) });
    if (this.navTimings.length > 20) this.navTimings.pop();
  }

  /** Ring buffer of the last zoom-tier (full) fetch timings (newest first). */
  private noteZoomTiming(path: string, ms: number): void {
    const name = path.slice(path.lastIndexOf("/") + 1).slice(path.lastIndexOf("\\") + 1);
    this.zoomTimings.unshift({ name, ms: Math.round(ms) });
    if (this.zoomTimings.length > 20) this.zoomTimings.pop();
  }

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
    const navMsAvg =
      this.navTimings.length === 0
        ? 0
        : Math.round(this.navTimings.reduce((a, t) => a + t.ms, 0) / this.navTimings.length);
    return {
      navTimings: this.navTimings.slice(0, 8),
      zoomTimings: this.zoomTimings.slice(0, 5),
      pool: this.pool?.counts() ?? { previews: 0, fulls: 0 },
      navMsAvg,
      lanes: {
        preview: `${this.fullInFlight}/${this.profile.previewConcurrency} q${this.fullQueue.length}`,
        zoom: `${this.zoomInFlight}/${this.profile.fullConcurrency} q${this.zoomQueue.length}`,
        thumb: `${this.thumbInFlight}/${this.profile.thumbConcurrency} q${this.thumbQueue.length}`,
        bg: `${this.bgInFlight}/${this.profile.backgroundFillConcurrency} q${this.bgQueue.length}`,
      },
      caches: {
        previews,
        zoomFulls: zooms.length,
        thumbs: this.thumbs.size,
        dims: this.pathDims.size,
      },
      counts: { ...this.counts },
      // The needPx readout is the manual matrix's instrument: it shows the
      // LIVE display demand and which side of the hysteresis band it sits on.
      mid: {
        engaged: this.midEngaged,
        needPx: (() => {
          const v = this.needPxProvider?.() ?? null;
          return v === null ? null : Math.round(v);
        })(),
        lane: `${this.midInFlight}/${this.profile.midGenConcurrency} q${this.midQueue.length}`,
        cached: mids,
        sweepLeft:
          this.profile.concurrentRestore && this.midEngaged
            ? Math.max(0, this.paths.length - this.midSweepDone.size)
            : 0,
      },
      decodedMB: Math.round(previews * 7 + zoomMB + mids * 17 + this.thumbs.size * 0.08),
    };
  }
}

export const imageStore = new ImageStore();
