/**
 * overlayService.ts — owner of the analysis-overlay pixels (pipeline Phase 6):
 * the clip/peak mask PNGs and the EXIF-rail histogram, all data URLs keyed by
 * path. Replaces the per-family React state + requested-Set pairs that lived in
 * App.tsx (and leaked across toggles/sessions — plan problems P7/P9).
 *
 * - Per-kind bounded LRU (~16): leaving an overlay on while arrowing through a
 *   long shoot caps at cap entries per kind instead of one PNG per visited
 *   frame. ensure() on a cached path refreshes recency, so the on-screen
 *   frame(s) are never the eviction victim.
 * - Generation hook: a compute captures the session generation; a result that
 *   lands after reset()/hardReset() bumped it is dropped (and `cancelled()`
 *   lets the prod probe bail before the expensive scan).
 * - Toggle-off hook: clearKind() drops the kind's cache AND its in-flight
 *   markers — a stale compute finishing later can't write into a fresh set.
 *
 * Sources from the NAV-TIER PREVIEW only (the 1620×1080 PRVW since Phase 3 —
 * stage "full" means "nav tier ready"): never the 32 MP zoom full, never a new
 * read. Everything is injected (compute fn, source lookup, generation, pins)
 * so the lifecycle logic is unit-testable without a DOM — see the test file.
 */

import type { MaskKind } from "./maskScans";
import { imageStore } from "../image/imageStore";
import { computeOverlay } from "./overlayCompute";

export type OverlayKind = MaskKind | "histogram";

const KINDS: OverlayKind[] = ["clip", "peak", "histogram"];

/** Per-kind LRU bound. Overlays are ~10–100 KB data-URL PNGs computed for the
 *  on-screen frame (±compare pair); 16 keeps quick back-and-forth free. */
const OVERLAY_LRU_CAP = 16;

type OverlayComputeFn = (
  kind: OverlayKind,
  url: string,
  /** Polled by the compute between its async steps — true once the request is
   *  superseded (kind toggled off / session changed), so it can stop early. */
  cancelled: () => boolean,
) => Promise<string>;

export type OverlayServiceDeps = {
  compute: OverlayComputeFn;
  /** The path's nav-tier (preview) blob URL, or undefined while it hasn't
   *  landed — ensure() bails and the caller re-fires when the stage flips. */
  sourceUrl: (path: string) => string | undefined;
  getGeneration: () => number;
  /** Pin/unpin the path's nav-tier blob while the probe decodes it — a
   *  keep-window eviction mid-decode would revoke the URL being read. */
  pin: (path: string) => void;
  unpin: (path: string) => void;
  cap?: number;
};

export class OverlayService {
  /** path → data URL per kind; Map insertion order doubles as LRU order
   *  (oldest first), refreshed by ensure() on cache hits. */
  private caches: Record<OverlayKind, Map<string, string>>;
  /** path → request token per kind (the request-sets). A completion commits
   *  only if its token is still current — clearKind/reset cancel by wiping. */
  private inFlight: Record<OverlayKind, Map<string, number>>;
  private seq = 0;
  private version = 0;
  private listeners = new Set<() => void>();
  private readonly cap: number;

  constructor(private readonly deps: OverlayServiceDeps) {
    this.cap = deps.cap ?? OVERLAY_LRU_CAP;
    this.caches = { clip: new Map(), peak: new Map(), histogram: new Map() };
    this.inFlight = { clip: new Map(), peak: new Map(), histogram: new Map() };
  }

  /** Cached data URL for (kind, path), if computed. Pure peek — safe to call
   *  during render; recency is refreshed by ensure(), not reads. */
  get(kind: OverlayKind, path: string): string | undefined {
    return this.caches[kind].get(path);
  }

  /**
   * Make sure (kind, path) is computed or computing. Dedups in-flight work,
   * refreshes LRU recency on hits, and silently bails while the path's preview
   * hasn't landed (the caller's .stage effect deps re-fire it when it does).
   */
  ensure(kind: OverlayKind, path: string): void {
    if (!path) return;
    const cache = this.caches[kind];
    const hit = cache.get(path);
    if (hit !== undefined) {
      // LRU touch: the displayed frame is re-ensured on every effect run, so
      // it can never be the eviction victim while on screen.
      cache.delete(path);
      cache.set(path, hit);
      return;
    }
    const flights = this.inFlight[kind];
    if (flights.has(path)) return;
    const src = this.deps.sourceUrl(path);
    if (!src) return;

    const token = ++this.seq;
    flights.set(path, token);
    const gen = this.deps.getGeneration();
    const live = () => flights.get(path) === token && this.deps.getGeneration() === gen;
    this.deps.pin(path);
    this.deps.compute(kind, src, () => !live()).then(
      (dataUrl) => {
        this.deps.unpin(path);
        if (!live()) {
          // Superseded (toggle-off cleared the marker / session moved / a
          // newer request took the slot) — drop the result; only remove the
          // marker when it is still OURS (never a successor's).
          if (flights.get(path) === token) flights.delete(path);
          return;
        }
        flights.delete(path);
        cache.set(path, dataUrl);
        while (cache.size > this.cap) {
          const oldest = cache.keys().next().value;
          if (oldest === undefined) break;
          cache.delete(oldest);
        }
        this.bump();
      },
      () => {
        // Probe/scan failed (or bailed via cancelled()) — release the marker
        // so a later ensure() retries cleanly.
        this.deps.unpin(path);
        if (flights.get(path) === token) flights.delete(path);
      },
    );
  }

  /** Toggle-off hook: drop one kind's cache and cancel its in-flight work.
   *  Idempotent and silent when already empty — the calling effect re-runs
   *  per scrub frame, and an empty clear must not force a render. */
  clearKind(kind: OverlayKind): void {
    const had = this.caches[kind].size > 0;
    this.caches[kind].clear();
    this.inFlight[kind].clear();
    if (had) this.bump();
  }

  /** Session-change hook (reset/hardReset, next to imageStore's): drop every
   *  kind. In-flight results are already doomed by the generation check; this
   *  also frees the markers immediately. */
  reset(): void {
    let had = false;
    for (const kind of KINDS) {
      had = had || this.caches[kind].size > 0;
      this.caches[kind].clear();
      this.inFlight[kind].clear();
    }
    if (had) this.bump();
  }

  // Arrow properties: handed to useSyncExternalStore as-is, so they must not
  // depend on call-site `this` binding.
  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };

  getVersion = (): number => this.version;

  private bump(): void {
    this.version++;
    for (const cb of this.listeners) cb();
  }
}

/** The app-wide service, wired to the imageStore and the worker-backed
 *  compute. `stage === "full"` means "nav tier ready" — since Phase 3 that IS
 *  the 1620×1080 PRVW preview (on a legacy backend, the full: same as today),
 *  so masks + histogram source from the preview and never trigger a read. */
export const overlayService = new OverlayService({
  compute: computeOverlay,
  sourceUrl: (path) => {
    const snap = imageStore.snapshot(path);
    return snap.stage === "full" ? snap.url : undefined;
  },
  getGeneration: () => imageStore.getGeneration(),
  pin: (path) => imageStore.pinFull(path),
  unpin: (path) => imageStore.unpinFull(path),
});
