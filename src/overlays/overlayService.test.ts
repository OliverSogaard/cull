/**
 * OverlayService unit tests (pipeline Phase 6): injected compute fns — per-kind
 * bounded LRU + recency touch, in-flight dedup, source gating (compute fires
 * once the preview lands), generation + toggle-off cancellation, pin/unpin
 * pairing, subscriber notification.
 */
import { describe, expect, it } from "vitest";
import { OverlayService } from "./overlayService";
import type { OverlayKind } from "./overlayService";

type ComputeCall = {
  kind: OverlayKind;
  url: string;
  cancelled: () => boolean;
  resolve: (dataUrl: string) => void;
  reject: (e: Error) => void;
};

function harness(cap = 16) {
  const calls: ComputeCall[] = [];
  const sources = new Map<string, string>();
  const pins: string[] = [];
  const unpins: string[] = [];
  let gen = 1;
  const svc = new OverlayService({
    compute: (kind, url, cancelled) =>
      new Promise<string>((resolve, reject) =>
        calls.push({ kind, url, cancelled, resolve, reject }),
      ),
    sourceUrl: (path) => sources.get(path),
    getGeneration: () => gen,
    pin: (p) => pins.push(p),
    unpin: (p) => unpins.push(p),
    cap,
  });
  return { svc, calls, sources, pins, unpins, bumpGen: () => gen++ };
}

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

/** ensure + resolve + flush — commit one entry in a single line. */
async function commit(h: ReturnType<typeof harness>, kind: OverlayKind, path: string) {
  h.sources.set(path, `blob:${path}`);
  h.svc.ensure(kind, path);
  h.calls[h.calls.length - 1].resolve(`data:${kind}:${path}`);
  await flush();
}

describe("OverlayService", () => {
  it("computes a missing entry from the path's source url and caches the result", async () => {
    const h = harness();
    h.sources.set("/a", "blob:a");
    h.svc.ensure("clip", "/a");
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].kind).toBe("clip");
    expect(h.calls[0].url).toBe("blob:a");
    expect(h.svc.get("clip", "/a")).toBeUndefined(); // not yet resolved
    h.calls[0].resolve("data:clip-a");
    await flush();
    expect(h.svc.get("clip", "/a")).toBe("data:clip-a");
  });

  it("bails while the source url is missing, then computes when re-ensured (preview lands)", () => {
    const h = harness();
    h.svc.ensure("clip", "/a");
    expect(h.calls).toHaveLength(0); // preview not ready — no probe, no marker
    h.sources.set("/a", "blob:a");
    h.svc.ensure("clip", "/a"); // the .stage dep re-fires the effect
    expect(h.calls).toHaveLength(1);
  });

  it("dedups: in-flight and cached paths never start a second compute", async () => {
    const h = harness();
    h.sources.set("/a", "blob:a");
    h.svc.ensure("clip", "/a");
    h.svc.ensure("clip", "/a"); // in flight
    expect(h.calls).toHaveLength(1);
    h.calls[0].resolve("data:clip-a");
    await flush();
    h.svc.ensure("clip", "/a"); // cached
    expect(h.calls).toHaveLength(1);
  });

  it("kinds are independent: the same path computes once per kind", async () => {
    const h = harness();
    h.sources.set("/a", "blob:a");
    h.svc.ensure("clip", "/a");
    h.svc.ensure("histogram", "/a");
    expect(h.calls.map((c) => c.kind)).toEqual(["clip", "histogram"]);
    h.calls[0].resolve("data:clip-a");
    h.calls[1].resolve("data:histo-a");
    await flush();
    expect(h.svc.get("clip", "/a")).toBe("data:clip-a");
    expect(h.svc.get("histogram", "/a")).toBe("data:histo-a");
  });

  it("an empty path is a no-op", () => {
    const h = harness();
    h.sources.set("", "blob:empty");
    h.svc.ensure("clip", "");
    expect(h.calls).toHaveLength(0);
  });

  it("notifies subscribers when a result commits; unsubscribe stops it", async () => {
    const h = harness();
    let notified = 0;
    const unsub = h.svc.subscribe(() => notified++);
    await commit(h, "clip", "/a");
    expect(notified).toBe(1);
    unsub();
    await commit(h, "clip", "/b");
    expect(notified).toBe(1);
  });

  it("a failed compute clears the request marker so a later ensure retries", async () => {
    const h = harness();
    h.sources.set("/a", "blob:a");
    h.svc.ensure("clip", "/a");
    h.calls[0].reject(new Error("probe failed"));
    await flush();
    expect(h.svc.get("clip", "/a")).toBeUndefined();
    h.svc.ensure("clip", "/a");
    expect(h.calls).toHaveLength(2); // retried
  });

  it("drops a result that lands after the session generation moved", async () => {
    const h = harness();
    let notified = 0;
    h.svc.subscribe(() => notified++);
    h.sources.set("/a", "blob:a");
    h.svc.ensure("clip", "/a");
    h.bumpGen();
    h.calls[0].resolve("data:stale");
    await flush();
    expect(h.svc.get("clip", "/a")).toBeUndefined();
    expect(notified).toBe(0); // no render for a dropped result
    expect(h.unpins).toEqual(["/a"]); // the pin is still released
    h.svc.ensure("clip", "/a"); // marker was cleared — recomputable
    expect(h.calls).toHaveLength(2);
  });

  it("clearKind drops the kind's cache, cancels its in-flight request, leaves other kinds", async () => {
    const h = harness();
    await commit(h, "peak", "/a"); // other kind — must survive
    await commit(h, "clip", "/b"); // cached — must drop
    h.sources.set("/c", "blob:/c");
    h.svc.ensure("clip", "/c"); // in flight — its result must be dropped
    h.svc.clearKind("clip");
    expect(h.svc.get("clip", "/b")).toBeUndefined();
    h.calls[h.calls.length - 1].resolve("data:late");
    await flush();
    expect(h.svc.get("clip", "/c")).toBeUndefined();
    expect(h.svc.get("peak", "/a")).toBe("data:peak:/a");
  });

  it("toggle-off/on spam: a stale superseded compute can't clobber the fresh one", async () => {
    const h = harness();
    h.sources.set("/a", "blob:a");
    h.svc.ensure("clip", "/a"); // compute #1
    h.svc.clearKind("clip"); // toggle off
    h.svc.ensure("clip", "/a"); // toggle on — compute #2
    expect(h.calls).toHaveLength(2);
    h.calls[0].resolve("data:stale");
    await flush();
    expect(h.svc.get("clip", "/a")).toBeUndefined(); // #1 was cancelled
    h.calls[1].resolve("data:fresh");
    await flush();
    expect(h.svc.get("clip", "/a")).toBe("data:fresh");
  });

  it("clearKind on an already-empty kind doesn't notify (per-scrub-frame effect re-runs)", () => {
    const h = harness();
    let notified = 0;
    h.svc.subscribe(() => notified++);
    h.svc.clearKind("clip");
    h.svc.clearKind("clip");
    expect(notified).toBe(0);
  });

  it("reset drops every kind's cache and request-set", async () => {
    const h = harness();
    await commit(h, "clip", "/a");
    await commit(h, "histogram", "/b");
    h.sources.set("/c", "blob:/c");
    h.svc.ensure("peak", "/c"); // in flight across the reset
    h.svc.reset();
    expect(h.svc.get("clip", "/a")).toBeUndefined();
    expect(h.svc.get("histogram", "/b")).toBeUndefined();
    h.calls[h.calls.length - 1].resolve("data:late");
    await flush();
    expect(h.svc.get("peak", "/c")).toBeUndefined();
  });

  it("evicts the least-recently-used entry beyond the cap", async () => {
    const h = harness(2);
    await commit(h, "clip", "/a");
    await commit(h, "clip", "/b");
    await commit(h, "clip", "/c");
    expect(h.svc.get("clip", "/a")).toBeUndefined(); // oldest out
    expect(h.svc.get("clip", "/b")).toBe("data:clip:/b");
    expect(h.svc.get("clip", "/c")).toBe("data:clip:/c");
  });

  it("an ensure on a cached path refreshes its recency (the on-screen frame survives)", async () => {
    const h = harness(2);
    await commit(h, "clip", "/a");
    await commit(h, "clip", "/b");
    h.svc.ensure("clip", "/a"); // displayed frame re-ensured by the effect
    await commit(h, "clip", "/c");
    expect(h.svc.get("clip", "/a")).toBe("data:clip:/a");
    expect(h.svc.get("clip", "/b")).toBeUndefined(); // /b became the LRU victim
  });

  it("the cap is per kind, not shared", async () => {
    const h = harness(1);
    await commit(h, "clip", "/a");
    await commit(h, "peak", "/b");
    expect(h.svc.get("clip", "/a")).toBe("data:clip:/a");
    expect(h.svc.get("peak", "/b")).toBe("data:peak:/b");
  });

  it("pins the path for the duration of the compute, success or failure", async () => {
    const h = harness();
    h.sources.set("/a", "blob:a");
    h.svc.ensure("clip", "/a");
    expect(h.pins).toEqual(["/a"]);
    expect(h.unpins).toEqual([]); // held while the probe decodes
    h.calls[0].resolve("data:a");
    await flush();
    expect(h.unpins).toEqual(["/a"]);
    h.sources.set("/b", "blob:b");
    h.svc.ensure("clip", "/b");
    h.calls[1].reject(new Error("decode failed"));
    await flush();
    expect(h.pins).toEqual(["/a", "/b"]);
    expect(h.unpins).toEqual(["/a", "/b"]);
  });

  it("cancelled() flips true once the request is superseded (early-bail for the prod probe)", () => {
    const h = harness();
    h.sources.set("/a", "blob:a");
    h.svc.ensure("clip", "/a");
    expect(h.calls[0].cancelled()).toBe(false);
    h.svc.clearKind("clip");
    expect(h.calls[0].cancelled()).toBe(true);

    h.svc.ensure("clip", "/a");
    expect(h.calls[1].cancelled()).toBe(false);
    h.bumpGen(); // session change cancels without any clear call
    expect(h.calls[1].cancelled()).toBe(true);
  });
});
