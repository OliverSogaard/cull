/**
 * present.ts — the decode-gated, double-buffered presenter (pipeline Phase 4).
 *
 * A framework-agnostic state machine over two <img> layers ("A"/"B"): the
 * visible loupe NEVER swaps to undecoded pixels. The decode function is
 * injected (the React binding passes `el.src = url; return el.decode()`), so
 * every rule here is unit-testable with a fake decoder.
 *
 * Rules (the doc of record is IMAGE_PIPELINE_PLAN.md § presenter):
 *  - ONLY-UPGRADE: an offer at tier ≤ the front tier for the same path is
 *    ignored — a late thumb can never replace a shown preview. Re-checked at
 *    decode COMPLETION too, so out-of-order decodes can't downgrade.
 *  - NAV-TOKEN GUARD: every nav/reset bumps the token; decode completions
 *    carrying a stale token are dropped. This one mechanism kills the
 *    stale-hi-res-timer class AND the sharp-before-blur inversion class.
 *  - SNAP-VS-FADE: decode resolved within SNAP_WINDOW_MS of the nav → flip
 *    with transitionMs 0 (cached nav feels instant); otherwise a FADE_MS
 *    crossfade with the old front kept beneath on the back layer.
 *  - SCRUB MODE: everything snaps; offers above "preview" are ignored; an
 *    offer is accepted only if its decode WINS a race against the injected
 *    next-frame signal (~one frame budget) — warmth heuristics can lie on
 *    WKWebView, the per-layer decode gate is the truth. On a loss the
 *    current layer stays; the caller re-offers on the next scrub step.
 *  - Per-tier presentation is FIXED (thumb ⇒ cover + blur; preview/full ⇒
 *    contain, no filter) and lives in TIER_PRESENTATION so it can never
 *    change while a layer is visible — the geometry jump is structurally
 *    impossible. The binding maps it to styles.
 */

export type PresentTier = "thumb" | "preview" | "full";

const TIER_RANK: Record<PresentTier, number> = { thumb: 0, preview: 1, full: 2 };

/** Fixed per-tier presentation facts (consumed by the React binding). */
export const TIER_PRESENTATION: Record<
  PresentTier,
  { objectFit: "cover" | "contain"; filter: string | undefined }
> = {
  thumb: { objectFit: "cover", filter: "blur(12px) brightness(0.82)" },
  preview: { objectFit: "contain", filter: undefined },
  full: { objectFit: "contain", filter: undefined },
};

/** Decode resolving within this many ms of nav() flips with no transition. */
export const SNAP_WINDOW_MS = 48;
/** Crossfade duration outside the snap window. */
export const FADE_MS = 140;

export type PresentLayer = "A" | "B";

export type LayerState = {
  path: string | null;
  tier: PresentTier | null;
  url: string | null;
};

export type PresentSnapshot = {
  /** Which physical layer is the visible front. */
  frontLayer: PresentLayer;
  front: LayerState;
  back: LayerState;
  /** Transition for the LAST flip: 0 = snap, FADE_MS = crossfade. */
  transitionMs: number;
  navToken: number;
  scrubbing: boolean;
};

export type PresentDeps = {
  /** Load `url` into the physical layer and resolve when its pixels are
   *  DECODED (the binding does `el.src = url; await el.decode()`). */
  decode: (layer: PresentLayer, url: string) => Promise<void>;
  /** Clock (test-injectable). */
  now?: () => number;
  /** Resolves at the next animation frame — the scrub-budget race opponent. */
  nextFrame?: () => Promise<void>;
};

const EMPTY: LayerState = { path: null, tier: null, url: null };

export class Presenter {
  private deps: Required<PresentDeps>;
  private layers: Record<PresentLayer, LayerState> = { A: { ...EMPTY }, B: { ...EMPTY } };
  private frontLayer: PresentLayer = "A";
  private transitionMs = 0;
  private navToken = 0;
  private scrubbing = false;
  private currentPath: string | null = null;
  private navAt = 0;
  private listeners = new Set<() => void>();
  private snap: PresentSnapshot | null = null;

  constructor(deps: PresentDeps) {
    this.deps = {
      decode: deps.decode,
      now: deps.now ?? (() => performance.now()),
      nextFrame:
        deps.nextFrame ??
        (() => new Promise<void>((r) => requestAnimationFrame(() => r()))),
    };
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Stable snapshot for useSyncExternalStore. */
  snapshot(): PresentSnapshot {
    if (!this.snap) {
      this.snap = {
        frontLayer: this.frontLayer,
        front: { ...this.layers[this.frontLayer] },
        back: { ...this.layers[this.backLayer()] },
        transitionMs: this.transitionMs,
        navToken: this.navToken,
        scrubbing: this.scrubbing,
      };
    }
    return this.snap;
  }

  /** The user navigated to `path`. The front KEEPS its current pixels (the
   *  frame never blanks); offers for the new path race in behind it. */
  nav(path: string): void {
    this.navToken++;
    this.currentPath = path;
    this.navAt = this.deps.now();
    this.notify();
  }

  setScrubbing(active: boolean): void {
    if (this.scrubbing === active) return;
    this.scrubbing = active;
    this.notify();
  }

  /** Session change: drop everything, bump the token. */
  reset(): void {
    this.navToken++;
    this.currentPath = null;
    this.layers = { A: { ...EMPTY }, B: { ...EMPTY } };
    this.frontLayer = "A";
    this.transitionMs = 0;
    this.notify();
  }

  /**
   * Offer pixels for `path` at `tier`. Resolves true if the offer became the
   * front (callers may re-offer on the next scrub step after a false).
   */
  async offer(path: string, tier: PresentTier, url: string): Promise<boolean> {
    if (path !== this.currentPath) return false;
    if (!this.isUpgrade(path, tier)) return false;
    // Scrub: nothing above preview may even start decoding for presentation.
    if (this.scrubbing && TIER_RANK[tier] > TIER_RANK.preview) return false;

    const token = this.navToken;
    const back = this.backLayer();
    const decodePromise = this.deps.decode(back, url);

    if (this.scrubbing) {
      // Frame-budget race: accept only a decode that wins against the next
      // frame; on a loss the blurred thumb (or whatever fronts) stays put.
      const winner = await Promise.race([
        decodePromise.then(
          () => "decoded" as const,
          () => "failed" as const,
        ),
        this.deps.nextFrame().then(() => "frame" as const),
      ]);
      if (winner !== "decoded") return false;
      if (token !== this.navToken) return false;
      if (!this.isUpgrade(path, tier)) return false;
      this.flip(back, path, tier, url, 0);
      return true;
    }

    try {
      await decodePromise;
    } catch {
      return false; // undecodable pixels never present
    }
    if (token !== this.navToken) return false; // stale nav — drop
    if (!this.isUpgrade(path, tier)) return false; // out-of-order decode — never downgrade
    const withinSnap = this.deps.now() - this.navAt <= SNAP_WINDOW_MS;
    this.flip(back, path, tier, url, withinSnap ? 0 : FADE_MS);
    return true;
  }

  private backLayer(): PresentLayer {
    return this.frontLayer === "A" ? "B" : "A";
  }

  /** True when (path, tier) beats what the front currently shows. */
  private isUpgrade(path: string, tier: PresentTier): boolean {
    const front = this.layers[this.frontLayer];
    if (front.path !== path || front.tier === null) return true;
    return TIER_RANK[tier] > TIER_RANK[front.tier];
  }

  private flip(
    layer: PresentLayer,
    path: string,
    tier: PresentTier,
    url: string,
    transitionMs: number,
  ): void {
    this.layers[layer] = { path, tier, url };
    this.frontLayer = layer;
    this.transitionMs = transitionMs;
    this.notify();
  }

  private notify(): void {
    this.snap = null;
    for (const cb of this.listeners) cb();
  }
}
