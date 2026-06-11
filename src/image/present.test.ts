/**
 * Presenter unit tests (pipeline Phase 4 verify gate): injected fake decode —
 * late-thumb ignored, stale token dropped, snap-window boundary, scrub frame
 * budget, out-of-order decode can't downgrade.
 */
import { describe, expect, it } from "vitest";
import { FADE_MS, Presenter, SNAP_WINDOW_MS } from "./present";
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
