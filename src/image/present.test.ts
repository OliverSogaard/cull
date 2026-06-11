/**
 * Presenter unit tests (pipeline Phase 4 verify gate): injected fake decode —
 * late-thumb ignored, stale token dropped, snap-window boundary, scrub frame
 * budget, out-of-order decode can't downgrade.
 */
import { describe, expect, it } from "vitest";
import { FADE_MS, Presenter, SNAP_WINDOW_MS, offerTiers } from "./present";
import type { PresentLayer } from "./present";

/** Hand-controlled decode + clock + frame signal. */
function harness() {
  const pending: { layer: PresentLayer; url: string; resolve: () => void; reject: () => void }[] = [];
  let nowMs = 0;
  const frames: (() => void)[] = [];
  const p = new Presenter({
    decode: (layer, url) =>
      new Promise<void>((resolve, reject) => {
        pending.push({ layer, url, resolve, reject: () => reject(new Error("decode failed")) });
      }),
    now: () => nowMs,
    nextFrame: () => new Promise<void>((r) => frames.push(r)),
  });
  return {
    p,
    pending,
    advance: (ms: number) => {
      nowMs += ms;
    },
    fireFrame: () => {
      for (const f of frames.splice(0)) f();
    },
  };
}

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe("Presenter", () => {
  it("decode-gates the flip and snaps inside the snap window", async () => {
    const h = harness();
    h.p.nav("/a");
    const offered = h.p.offer("/a", "preview", "blob:p1");
    await flush();
    expect(h.p.snapshot().front.url).toBeNull(); // nothing presents undecoded
    h.advance(SNAP_WINDOW_MS - 1);
    h.pending[0].resolve();
    expect(await offered).toBe(true);
    const s = h.p.snapshot();
    expect(s.front).toMatchObject({ path: "/a", tier: "preview", url: "blob:p1" });
    expect(s.transitionMs).toBe(0); // snap, no fade
  });

  it("crossfades outside the snap window", async () => {
    const h = harness();
    h.p.nav("/a");
    const offered = h.p.offer("/a", "preview", "blob:p1");
    await flush();
    h.advance(SNAP_WINDOW_MS + 1);
    h.pending[0].resolve();
    expect(await offered).toBe(true);
    expect(h.p.snapshot().transitionMs).toBe(FADE_MS);
  });

  it("ONLY-UPGRADE: a late thumb never replaces a shown preview", async () => {
    const h = harness();
    h.p.nav("/a");
    const prv = h.p.offer("/a", "preview", "blob:p1");
    await flush();
    h.pending[0].resolve();
    await prv;
    // Late thumb for the same path: rejected synchronously, no decode started.
    const thumbOffered = await h.p.offer("/a", "thumb", "blob:t1");
    expect(thumbOffered).toBe(false);
    expect(h.pending).toHaveLength(1); // no second decode
    expect(h.p.snapshot().front.tier).toBe("preview");
  });

  it("NAV-TOKEN: a decode completing after the next nav is dropped", async () => {
    const h = harness();
    h.p.nav("/a");
    const offered = h.p.offer("/a", "preview", "blob:p1");
    await flush();
    h.p.nav("/b"); // supersedes
    h.pending[0].resolve();
    expect(await offered).toBe(false);
    expect(h.p.snapshot().front.url).toBeNull(); // /a never presented
  });

  it("offers for a non-current path are ignored outright", async () => {
    const h = harness();
    h.p.nav("/a");
    expect(await h.p.offer("/b", "preview", "blob:px")).toBe(false);
    expect(h.pending).toHaveLength(0);
  });

  it("out-of-order decodes never downgrade: slow preview loses to landed full", async () => {
    const h = harness();
    h.p.nav("/a");
    const prv = h.p.offer("/a", "preview", "blob:p1"); // decode stays pending
    await flush();
    const ful = h.p.offer("/a", "full", "blob:f1");
    await flush();
    h.pending[1].resolve(); // full decodes first
    expect(await ful).toBe(true);
    expect(h.p.snapshot().front.tier).toBe("full");
    h.pending[0].resolve(); // preview decode completes late
    expect(await prv).toBe(false); // re-checked at completion — no downgrade
    expect(h.p.snapshot().front.tier).toBe("full");
  });

  it("scrub: offers above preview are ignored; the frame budget gates acceptance", async () => {
    const h = harness();
    h.p.setScrubbing(true);
    h.p.nav("/a");
    // Full is never even decoded mid-scrub.
    expect(await h.p.offer("/a", "full", "blob:f1")).toBe(false);
    expect(h.pending).toHaveLength(0);

    // Budget LOSS: the frame fires before the decode → keep current, false.
    const losing = h.p.offer("/a", "preview", "blob:p1");
    await flush();
    h.fireFrame();
    expect(await losing).toBe(false);
    expect(h.p.snapshot().front.url).toBeNull();

    // Budget WIN: decode resolves first → snap (transition 0).
    const winning = h.p.offer("/a", "preview", "blob:p1");
    await flush();
    h.pending[1].resolve();
    expect(await winning).toBe(true);
    const s = h.p.snapshot();
    expect(s.front.tier).toBe("preview");
    expect(s.transitionMs).toBe(0);
  });

  it("a failed decode never presents", async () => {
    const h = harness();
    h.p.nav("/a");
    const offered = h.p.offer("/a", "preview", "blob:bad");
    await flush();
    h.pending[0].reject();
    expect(await offered).toBe(false);
    expect(h.p.snapshot().front.url).toBeNull();
  });

  it("reset clears both layers and invalidates in-flight offers", async () => {
    const h = harness();
    h.p.nav("/a");
    const offered = h.p.offer("/a", "preview", "blob:p1");
    await flush();
    h.p.reset();
    h.pending[0].resolve();
    expect(await offered).toBe(false);
    expect(h.p.snapshot().front).toMatchObject({ path: null, tier: null, url: null });
  });

  it("isCurrent tracks the navigated path", () => {
    const h = harness();
    h.p.nav("/a");
    expect(h.p.isCurrent("/a")).toBe(true);
    expect(h.p.isCurrent("/b")).toBe(false);
    h.p.nav("/b");
    expect(h.p.isCurrent("/b")).toBe(true);
  });

  it("upgrades alternate the physical layers (double buffer)", async () => {
    const h = harness();
    h.p.nav("/a");
    const t = h.p.offer("/a", "thumb", "blob:t1");
    await flush();
    h.pending[0].resolve();
    await t;
    expect(h.p.snapshot().frontLayer).toBe("B"); // first flip lands on B
    const prv = h.p.offer("/a", "preview", "blob:p1");
    await flush();
    h.pending[1].resolve();
    await prv;
    const s = h.p.snapshot();
    expect(s.frontLayer).toBe("A"); // upgrade decoded on the other layer
    expect(s.back).toMatchObject({ path: "/a", tier: "thumb" }); // old front beneath
  });
});

/**
 * Harness modelling the REAL layer-element semantics the React binding
 * documents (usePresent): starting a decode on a layer whose pending decode
 * has a DIFFERENT url aborts (rejects) that pending decode — `el.src = url`
 * cancels the in-flight decode. A same-url re-offer attaches a fresh promise
 * without aborting (the src assignment is a no-op).
 */
function clobberHarness() {
  type Pending = {
    layer: PresentLayer;
    url: string;
    resolve: () => void;
    reject: (e: Error) => void;
    settled: boolean;
  };
  const decodes: Pending[] = [];
  const frames: (() => void)[] = [];
  let nowMs = 0;
  const p = new Presenter({
    decode: (layer, url) =>
      new Promise<void>((resolve, reject) => {
        for (const d of decodes) {
          if (d.layer === layer && !d.settled && d.url !== url) {
            d.settled = true;
            d.reject(new Error("aborted by src change"));
          }
        }
        const entry: Pending = {
          layer,
          url,
          settled: false,
          resolve: () => {
            entry.settled = true;
            resolve();
          },
          reject: (e: Error) => {
            entry.settled = true;
            reject(e);
          },
        };
        decodes.push(entry);
      }),
    now: () => nowMs,
    nextFrame: () => new Promise<void>((r) => frames.push(r)),
  });
  return {
    p,
    decodes,
    /** Resolve every unsettled decode for `url` (a decode completing). */
    finish: (url: string) => {
      for (const d of decodes) if (!d.settled && d.url === url) d.resolve();
    },
    fireFrame: () => {
      for (const f of frames.splice(0)) f();
    },
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

describe("offerTiers", () => {
  it("scrub: a lost preview race falls back to the blurred thumb (the compare-scrub stall)", async () => {
    const h = clobberHarness();
    h.p.setScrubbing(true);
    h.p.nav("/a");
    const done = offerTiers(h.p, "/a", { thumb: "blob:t1", preview: "blob:p1" }, true);
    await flush();
    // The preview decode is racing; the thumb has NOT been clobbered into
    // oblivion — it hasn't been offered yet (sequenced, best first).
    expect(h.decodes.map((d) => d.url)).toEqual(["blob:p1"]);
    h.fireFrame(); // preview loses its frame budget
    await flush();
    // Fallback: the thumb now decodes; let it win its race.
    h.finish("blob:t1");
    await flush();
    expect(h.p.snapshot().front).toMatchObject({ path: "/a", tier: "thumb", url: "blob:t1" });
    await done;
  });

  it("scrub: a fast preview presents sharp and the thumb is never decoded", async () => {
    const h = clobberHarness();
    h.p.setScrubbing(true);
    h.p.nav("/a");
    const done = offerTiers(h.p, "/a", { thumb: "blob:t1", preview: "blob:p1" }, true);
    await flush();
    h.finish("blob:p1"); // decode wins the race
    await done;
    expect(h.p.snapshot().front).toMatchObject({ path: "/a", tier: "preview" });
    expect(h.decodes.some((d) => d.url === "blob:t1")).toBe(false);
  });

  it("scrub: the thumb retries across frames until its decode lands", async () => {
    const h = clobberHarness();
    h.p.setScrubbing(true);
    h.p.nav("/a");
    const done = offerTiers(h.p, "/a", { thumb: "blob:t1" }, true);
    await flush();
    h.fireFrame(); // race 1 lost — decode still in flight (same src, no abort)
    await flush();
    h.fireFrame(); // race 2 lost
    await flush();
    h.finish("blob:t1"); // decode completes mid-race 3
    await flush();
    expect(h.p.snapshot().front).toMatchObject({ path: "/a", tier: "thumb" });
    await done;
  });

  it("scrub: retries stop when the scrub moves to another path", async () => {
    const h = clobberHarness();
    h.p.setScrubbing(true);
    h.p.nav("/a");
    const done = offerTiers(h.p, "/a", { thumb: "blob:t1" }, true);
    await flush();
    h.fireFrame(); // race 1 lost
    await flush();
    h.p.nav("/b"); // scrub stepped on
    h.fireFrame();
    await flush();
    h.finish("blob:t1"); // late decode for the abandoned path
    await flush();
    await done;
    expect(h.p.snapshot().front.url).toBeNull(); // /a never presented
  });

  it("settled: parallel thumb+preview — the preview clobbers the thumb decode and presents alone (cached nav, blur never mounts)", async () => {
    const h = clobberHarness();
    h.p.nav("/a");
    const done = offerTiers(h.p, "/a", { thumb: "blob:t1", preview: "blob:p1" }, false);
    await flush();
    // Both offered immediately; the preview's src-set aborted the thumb decode.
    expect(h.decodes.map((d) => d.url)).toEqual(["blob:t1", "blob:p1"]);
    expect(h.decodes[0].settled).toBe(true); // thumb decode aborted
    h.advance(SNAP_WINDOW_MS - 1);
    h.finish("blob:p1");
    await done;
    const s = h.p.snapshot();
    expect(s.front).toMatchObject({ path: "/a", tier: "preview" });
    expect(s.transitionMs).toBe(0); // snap — no blur ever mounted
  });
});
