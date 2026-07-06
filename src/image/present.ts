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

import { dlog } from "../utils/dlog";

export type PresentTier = "thumb" | "preview" | "mid" | "full";

const TIER_RANK: Record<PresentTier, number> = { thumb: 0, preview: 1, mid: 2, full: 3 };

/** Fixed per-tier presentation facts (consumed by the React binding). */
export const TIER_PRESENTATION: Record<
  PresentTier,
  { objectFit: "cover" | "contain"; filter: string | undefined }
> = {
  thumb: { objectFit: "cover", filter: "blur(12px) brightness(0.82)" },
  preview: { objectFit: "contain", filter: undefined },
  // Phase 8: the generated ≤2560px tier — presentation-identical to the
  // preview (contain, no filter); only the pixel density differs.
  mid: { objectFit: "contain", filter: undefined },
  full: { objectFit: "contain", filter: undefined },
};

/** Decode resolving within this many ms of nav() flips with no transition. */
export const SNAP_WINDOW_MS = 48;
/** Crossfade duration outside the snap window. */
export const FADE_MS = 140;
/** Settled-nav thumb hold-off: when the front already shows another frame's
 *  sharp pixels, the blurred thumb waits this long before it may mount — a
 *  preview landing within the window presents directly and the blur flash
 *  (single-step nav onto a frame whose read-ahead hadn't finished) never
 *  happens. Cold starts (nothing fronting) skip it: blur beats shimmer. */
export const THUMB_HOLDOFF_MS = 160;
/** Navs arriving closer together than this are key-repeat stepping — the
 *  user is flying, so the blurred thumb presents immediately (holding the
 *  old sharp frame 160ms per step would make scrub start feel stuck). */
export const RAPID_NAV_MS = 260;

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
  /** Timer (test-injectable) — used by the thumb hold-off. */
  sleep?: (ms: number) => Promise<void>;
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
  private lastNavAt: number | null = null;
  /** True when the latest nav arrived within RAPID_NAV_MS of the previous —
   *  key-repeat stepping (scrub-like even before the scrub flag engages). */
  private rapidNav = false;
  /** Tier rank of the decode currently owning the shared back element (and a
   *  sequence to survive ownership clobbering) — a post-hold-off thumb must
   *  never set src over an in-flight higher-tier decode. */
  private pendingRank: number | null = null;
  private pendingSeq = 0;
  private listeners = new Set<() => void>();
  private snap: PresentSnapshot | null = null;

  constructor(deps: PresentDeps) {
    this.deps = {
      decode: deps.decode,
      now: deps.now ?? (() => performance.now()),
      nextFrame:
        deps.nextFrame ??
        (() => new Promise<void>((r) => requestAnimationFrame(() => r()))),
      sleep: deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))),
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
    const now = this.deps.now();
    this.rapidNav = this.lastNavAt !== null && now - this.lastNavAt < RAPID_NAV_MS;
    this.lastNavAt = now;
    this.navAt = now;
    this.notify();
  }

  setScrubbing(active: boolean): void {
    if (this.scrubbing === active) return;
    this.scrubbing = active;
    this.notify();
  }

  /** True while `path` is the navigated frame (offerTiers' retry guard). */
  isCurrent(path: string): boolean {
    return this.currentPath === path;
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

    // Thumb hold-off (settled navs, another frame fronting): give higher
    // tiers THUMB_HOLDOFF_MS to present before blur may mount. Scrub mode is
    // exempt — there the blurred thumb IS the designed fallback per step.
    if (!this.scrubbing && !this.rapidNav && tier === "thumb") {
      const front = this.layers[this.frontLayer];
      if (front.url !== null && front.path !== path) {
        await this.deps.sleep(THUMB_HOLDOFF_MS);
        if (token !== this.navToken) return false; // navigated away meanwhile
        if (!this.isUpgrade(path, tier)) return false; // something better fronted
        // A higher tier owns the back element right now — setting src would
        // abort its decode and trade sharp pixels for blur. Stand down; the
        // caller re-offers if that decode ultimately fails.
        if (this.pendingRank !== null && this.pendingRank > TIER_RANK.thumb) return false;
      }
    }

    const back = this.backLayer();
    const seq = ++this.pendingSeq;
    this.pendingRank = TIER_RANK[tier];
    // mid-dims-bug-report §6.2: timestamp right before the decode call — this
    // IS effectively "src-set time" (the injected decode() sets `el.src =
    // url` synchronously before calling el.decode()).
    const srcSetAt = this.deps.now();
    const decodePromise = this.deps.decode(back, url);
    // Ownership bookkeeping rides a PARALLEL subscriber — chaining (.finally)
    // would add a microtask hop to every presentation path.
    const release = () => {
      // Release only if no later offer took the element over.
      if (seq === this.pendingSeq) this.pendingRank = null;
    };
    void decodePromise.then(release, () => {
      // Mid-flight aborts at tens of ms are the WKWebView blob-poisoning
      // candidates (mid-dims-bug-report §4); same-tick clobbers (~0ms) are
      // ordinary back-element ownership churn, not a signal.
      dlog("present", "decode rejected", {
        tier,
        url,
        ms: this.deps.now() - srcSetAt,
      });
      release();
    });

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

/** Bound on offerTiers' scrub-mode thumb retries (each retry costs one frame,
 *  so the worst case is well under one scrub step at 33 ms/step). */
const SCRUB_THUMB_RETRIES = 8;

/**
 * How consumers hand a frame's available tiers to the presenter. The two
 * physical layers share ONE back element, so two concurrent offers clobber
 * each other: the later `el.src =` aborts the earlier offer's in-flight
 * decode (usePresent's decode contract).
 *
 * - SETTLED: fire all available tiers in tier order. When several urls are
 *   in hand (cached nav) the later src-set aborts the earlier decode —
 *   desired: the BEST tier presents directly and blur never mounts. The mid
 *   (Phase 8) rides the same rule above the preview: it's the settled fit
 *   view's tier on high-DPI stages, and a frame whose mid is in hand should
 *   present it, not pay a preview decode first.
 * - SCRUB: sequence them, best first — and never above the preview (the
 *   presenter enforces it too): mid-scrub is the preview's snap territory.
 *   Fire-and-forgetting both would let the preview abort the thumb and then
 *   LOSE its one-frame race — leaving nothing to present for the step (the
 *   compare-scrub stall found in the WebView2 matrix). Instead the preview
 *   gets its frame budget; on a loss the thumb decodes and RETRIES frame by
 *   frame (same src — re-offers don't abort it) until it presents or the
 *   scrub moves on, so every step shows at worst the blurred thumb, never a
 *   stale frame.
 */
export async function offerTiers(
  presenter: Presenter,
  path: string,
  urls: { thumb?: string; preview?: string; mid?: string },
  scrubbing: boolean,
): Promise<void> {
  if (!scrubbing) {
    if (urls.thumb) void presenter.offer(path, "thumb", urls.thumb);
    if (urls.preview) void presenter.offer(path, "preview", urls.preview);
    if (urls.mid) void presenter.offer(path, "mid", urls.mid);
    return;
  }
  if (urls.preview && (await presenter.offer(path, "preview", urls.preview))) return;
  if (!urls.thumb) return;
  for (let i = 0; i < SCRUB_THUMB_RETRIES; i++) {
    if (!presenter.isCurrent(path) || !presenter.snapshot().scrubbing) return;
    if (await presenter.offer(path, "thumb", urls.thumb)) return;
  }
}
