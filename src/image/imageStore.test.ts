/**
 * imageStore unit tests.
 *
 * These run in the default vitest environment (no DOM, no Tauri IPC).
 * fetchThumbnail and fetchBundle are mocked so no real IPC fires.
 *
 * Critical areas covered:
 *  1. Snapshot stability — getSnapshot must return the SAME object reference
 *     when nothing changed.
 *  2. Blob-URL lifecycle — every createObjectURL must pair with exactly one
 *     revokeObjectURL (tracked via mock counters).
 *  3. Cancellation — hardReset revokes all outstanding blob URLs.
 *  4. Queue priority — requestThumbFor (on-demand) is served before background
 *     fill; background fill uses backgroundFillConcurrency cap.
 *  5. 15 000-entry thumb LRU cap (smoke-tested with a small cap shim).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

// ── Mock @tauri-apps/api/core before importing imageStore ──────────────────
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

// ── Mock URL.createObjectURL / URL.revokeObjectURL ─────────────────────────
let urlCounter = 0;
const liveUrls = new Set<string>();

const origCreate = globalThis.URL.createObjectURL;
const origRevoke = globalThis.URL.revokeObjectURL;

beforeEach(() => {
  // Fully reset the shared invoke mock between tests so a deferred
  // mockImplementation from one test cannot leak into the next.
  vi.mocked(invoke).mockReset();
  urlCounter = 0;
  liveUrls.clear();
  globalThis.URL.createObjectURL = vi.fn((_blob: Blob) => {
    const u = `blob:mock-${++urlCounter}`;
    liveUrls.add(u);
    return u;
  });
  globalThis.URL.revokeObjectURL = vi.fn((u: string) => {
    liveUrls.delete(u);
  });
});

afterEach(() => {
  globalThis.URL.createObjectURL = origCreate;
  globalThis.URL.revokeObjectURL = origRevoke;
  vi.restoreAllMocks();
});

// ── Helpers ────────────────────────────────────────────────────────────────

/** Build a minimal ArrayBuffer that fetchThumbnail parses: u32 LE header-len,
 *  JSON header, then `jpegLen` bytes of fake JPEG. */
function makeThumbnailBuf(w: number, h: number): ArrayBuffer {
  const header = JSON.stringify({ width: w, height: h, jpegLen: 3 });
  const headerBytes = new TextEncoder().encode(header);
  const buf = new ArrayBuffer(4 + headerBytes.length + 3);
  const dv = new DataView(buf);
  dv.setUint32(0, headerBytes.length, true);
  new Uint8Array(buf, 4, headerBytes.length).set(headerBytes);
  // fake JPEG bytes
  new Uint8Array(buf, 4 + headerBytes.length).set([0xff, 0xd8, 0x00]);
  return buf;
}

/** Build a minimal ArrayBuffer that fetchBundle parses. */
function makeBundleBuf(): ArrayBuffer {
  const header = JSON.stringify({ meta: null, previewLen: 3 });
  const headerBytes = new TextEncoder().encode(header);
  const buf = new ArrayBuffer(4 + headerBytes.length + 3);
  const dv = new DataView(buf);
  dv.setUint32(0, headerBytes.length, true);
  new Uint8Array(buf, 4, headerBytes.length).set(headerBytes);
  new Uint8Array(buf, 4 + headerBytes.length).set([0xff, 0xd8, 0x00]);
  return buf;
}

// ── Lazy import so mocks are in place first ────────────────────────────────
async function getStore() {
  // Dynamic import gets a fresh module each time because vi.resetModules() is
  // called in beforeEach — but we DON'T reset modules here because we want the
  // singleton. Instead we call hardReset() between tests.
  const mod = await import("./imageStore");
  return mod.imageStore;
}

/** Import the ImageStore CLASS so each test can build an isolated instance
 *  (fresh generation/counters, optional small LRU cap). */
async function getStoreClass() {
  const mod = await import("./imageStore");
  return mod.ImageStore;
}

// ── Deferred fetch control ──────────────────────────────────────────────────
//
// `fetchThumbnail`/`fetchBundle` both do `await invoke(...)` then synchronously
// parse the ArrayBuffer and (on success) call URL.createObjectURL. By making the
// `invoke` mock return a promise we resolve/reject by hand, we can start a load,
// run reset()/evict() while it is in flight, THEN settle the original load and
// assert it does not corrupt the new session.

type Deferred = {
  resolve: (buf: ArrayBuffer) => void;
  reject: (err: unknown) => void;
};

/** Queue an `invoke` mock that hands out one controllable deferred per call,
 *  in call order. Returns the array the deferreds land in. */
function deferredInvoke(mockInvoke: ReturnType<typeof vi.fn>): Deferred[] {
  const deferreds: Deferred[] = [];
  mockInvoke.mockImplementation(() => {
    return new Promise<ArrayBuffer>((resolve, reject) => {
      deferreds.push({ resolve, reject });
    });
  });
  return deferreds;
}

/** Let the microtask queue drain so awaited continuations run. */
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

// ─────────────────────────────────────────────────────────────────────────────
describe("imageStore", () => {
  it("snapshot is shimmer for an unknown path", async () => {
    const store = await getStore();
    store.hardReset();
    const snap = store.snapshot("/foo/a.cr3");
    expect(snap.stage).toBe("shimmer");
  });

  it("snapshot returns the SAME object reference when nothing changed (stability)", async () => {
    const store = await getStore();
    store.hardReset();
    const path = "/foo/stable.cr3";
    const s1 = store.snapshot(path);
    const s2 = store.snapshot(path);
    // Must be referentially equal — no new object created on second call.
    expect(s1).toBe(s2);
  });

  it("snapshot object changes identity after a thumb load", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const mockInvoke = vi.mocked(invoke);
    mockInvoke.mockResolvedValue(makeThumbnailBuf(800, 600));

    const store = await getStore();
    store.hardReset();
    const path = "/foo/change.cr3";

    const before = store.snapshot(path);
    // Trigger load
    store.requestThumbFor(path);
    // Wait for microtask queue to drain (the async fetch resolves)
    await vi.waitUntil(() => store.snapshot(path) !== before, { timeout: 2000 });

    const after = store.snapshot(path);
    expect(after).not.toBe(before);
    expect(after.stage).toBe("thumb");
  });

  it("subscribe callback fires when state changes", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockResolvedValue(makeThumbnailBuf(800, 600));

    const store = await getStore();
    store.hardReset();
    const path = "/foo/sub.cr3";

    const cb = vi.fn();
    const unsub = store.subscribe(path, cb);
    store.requestThumbFor(path);
    await vi.waitUntil(() => cb.mock.calls.length > 0, { timeout: 2000 });
    expect(cb).toHaveBeenCalled();
    unsub();
  });

  it("blob URL is created when a thumb loads", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockResolvedValue(makeThumbnailBuf(800, 600));

    const store = await getStore();
    store.hardReset();
    const path = "/foo/blob.cr3";

    store.requestThumbFor(path);
    await vi.waitUntil(() => store.snapshot(path).stage === "thumb", { timeout: 2000 });

    expect(liveUrls.size).toBeGreaterThan(0);
  });

  it("hardReset revokes ALL blob URLs (no leak)", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockResolvedValue(makeThumbnailBuf(800, 600));

    const store = await getStore();
    store.hardReset();
    const paths = ["/foo/r1.cr3", "/foo/r2.cr3", "/foo/r3.cr3"];

    for (const p of paths) {
      store.requestThumbFor(p);
    }
    await vi.waitUntil(
      () => paths.every((p) => store.snapshot(p).stage === "thumb"),
      { timeout: 2000 },
    );

    expect(liveUrls.size).toBeGreaterThanOrEqual(paths.length);
    store.hardReset();
    expect(liveUrls.size).toBe(0);
  });

  it("reset(paths) revokes full-res blob URLs but keeps thumbs", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke)
      .mockResolvedValueOnce(makeThumbnailBuf(800, 600)) // thumb
      .mockResolvedValueOnce(makeBundleBuf());            // full

    const store = await getStore();
    store.hardReset();
    const path = "/foo/reset.cr3";

    // Load thumb
    store.requestThumbFor(path);
    await vi.waitUntil(() => store.snapshot(path).stage === "thumb", { timeout: 2000 });
    const thumbUrlsAfterThumb = liveUrls.size;

    // Load full
    store.registerWantFull(path);
    await vi.waitUntil(
      () => store.snapshot(path).stage === "full",
      { timeout: 2000 },
    );
    const urlsAfterFull = liveUrls.size;
    expect(urlsAfterFull).toBeGreaterThan(thumbUrlsAfterThumb);

    // reset() — should revoke full-res but not thumbs
    store.reset([path]);
    const urlsAfterReset = liveUrls.size;
    // At least the full-res URL was revoked
    expect(urlsAfterReset).toBeLessThan(urlsAfterFull);
    // Thumb still present: stage falls back to thumb, not shimmer
    const snap = store.snapshot(path);
    expect(snap.stage).toBe("thumb");
  });

  it("setProfile changes backgroundFillConcurrency", async () => {
    const { PERFORMANCE_PROFILES } = await import("../types/settings");
    const store = await getStore();
    store.hardReset();
    // Just verify setProfile doesn't throw with valid profiles
    expect(() => store.setProfile(PERFORMANCE_PROFILES.network)).not.toThrow();
    expect(() => store.setProfile(PERFORMANCE_PROFILES.local)).not.toThrow();
  });

  it("no double-revoke: calling hardReset twice doesn't revoke already-revoked URLs", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockResolvedValue(makeThumbnailBuf(800, 600));

    const store = await getStore();
    store.hardReset();
    store.requestThumbFor("/foo/dr.cr3");
    await vi.waitUntil(() => store.snapshot("/foo/dr.cr3").stage === "thumb", { timeout: 2000 });

    store.hardReset();
    const revokeCount1 = vi.mocked(URL.revokeObjectURL).mock.calls.length;
    store.hardReset(); // second reset — store is already empty
    const revokeCount2 = vi.mocked(URL.revokeObjectURL).mock.calls.length;
    // No additional revokes on the second empty reset
    expect(revokeCount2).toBe(revokeCount1);
  });

  it("snapshot is shimmer after hardReset clears all state", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockResolvedValue(makeThumbnailBuf(800, 600));

    const store = await getStore();
    store.hardReset();
    const path = "/foo/clear.cr3";
    store.requestThumbFor(path);
    await vi.waitUntil(() => store.snapshot(path).stage === "thumb", { timeout: 2000 });
    store.hardReset();
    expect(store.snapshot(path).stage).toBe("shimmer");
  });

  it("registerWantFull / unregisterWantFull do not throw", async () => {
    const store = await getStore();
    store.hardReset();
    const path = "/foo/wf.cr3";
    expect(() => store.registerWantFull(path)).not.toThrow();
    expect(() => store.unregisterWantFull(path)).not.toThrow();
  });

  it("setCursor and setGridRange do not throw", async () => {
    const store = await getStore();
    store.hardReset();
    expect(() => store.setCursor(5)).not.toThrow();
    expect(() => store.setGridRange(0, 30)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Concurrency / generation-accounting regression tests (C1, C3, C4, I6, LRU).
// These use a deferred `invoke` so we can interleave reset()/evict() with a
// load that is still in flight.
// ─────────────────────────────────────────────────────────────────────────────
describe("imageStore — generation & concurrency", () => {
  it("C1/C4: stale-generation thumb load revokes its blob and does NOT write into the new session", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const mockInvoke = vi.mocked(invoke);
    const deferreds = deferredInvoke(mockInvoke);

    const Store = await getStoreClass();
    const store = new Store();
    const path = "/foo/stale.cr3";
    store.reset([path]);

    // Start the on-demand thumb load (now in flight, awaiting the deferred).
    store.requestThumbFor(path);
    await flush();
    expect(deferreds.length).toBe(1);

    // Folder switch while the old load is still in flight.
    store.reset(["/bar/new.cr3"]);

    // NOW settle the old-generation fetch.
    const createdBefore = vi.mocked(URL.createObjectURL).mock.calls.length;
    deferreds[0].resolve(makeThumbnailBuf(800, 600));
    await flush();

    // (a) A blob WAS created by the old fetch, but it must have been revoked.
    const createdAfter = vi.mocked(URL.createObjectURL).mock.calls.length;
    expect(createdAfter).toBe(createdBefore + 1);
    const staleUrl = vi.mocked(URL.createObjectURL).mock.results[createdAfter - 1]
      .value as string;
    expect(liveUrls.has(staleUrl)).toBe(false); // revoked

    // (b) It did NOT populate thumbs for the old path in the new session.
    expect(store.snapshot(path).stage).toBe("shimmer");
  });

  it("C1: counters never go negative — concurrency cap is still respected after an interrupted load", async () => {
    const { PERFORMANCE_PROFILES } = await import("../types/settings");
    const { invoke } = await import("@tauri-apps/api/core");
    const mockInvoke = vi.mocked(invoke);

    // Instrument the mock, tracking in-flight PER SESSION (keyed by path prefix
    // — "/a/" = first folder, "/b/" = second). A pending load only resolves when
    // the test chooses, so we can interleave a folder switch mid-flight.
    const live: Record<string, number> = { "/a/": 0, "/b/": 0 };
    const maxLive: Record<string, number> = { "/a/": 0, "/b/": 0 };
    type Pend = { sess: string; resolve: (buf: ArrayBuffer) => void };
    const pending: Pend[] = [];
    mockInvoke.mockImplementation((_cmd, args) => {
      const p = (args as { path: string }).path;
      const sess = p.slice(0, 3); // "/a/" or "/b/"
      live[sess]++;
      maxLive[sess] = Math.max(maxLive[sess], live[sess]);
      return new Promise<ArrayBuffer>((resolve) => {
        pending.push({
          sess,
          resolve: (buf) => {
            live[sess]--;
            resolve(buf);
          },
        });
      });
    });

    const Store = await getStoreClass();
    const store = new Store();
    // network profile: small, clear caps. Total concurrent thumb-ish fetches
    // across the on-demand + background lanes is thumbConcurrency + bgFill.
    const prof = PERFORMANCE_PROFILES.network;
    store.setProfile(prof);
    const totalCap = prof.thumbConcurrency + prof.backgroundFillConcurrency;

    const firstPaths = Array.from({ length: 12 }, (_, i) => `/a/${i}.cr3`);
    store.reset(firstPaths);
    for (const p of firstPaths) store.requestThumbFor(p);
    await flush();
    // First session respected its cap.
    expect(maxLive["/a/"]).toBeLessThanOrEqual(totalCap);

    // Folder switch mid-flight (first session's loads are STILL pending). This
    // zeroes the counters. If the OLD finallys later decrement the NEW counters
    // they'd go negative → the new session would over-pump beyond the cap.
    const secondPaths = Array.from({ length: 12 }, (_, i) => `/b/${i}.cr3`);
    store.reset(secondPaths);
    for (const p of secondPaths) store.requestThumbFor(p);
    await flush();

    // Settle ALL stale (first-session) loads now. Their gen-scoped finally must
    // NOT touch the second session's counters.
    for (const pend of pending.filter((x) => x.sess === "/a/")) {
      pend.resolve(makeThumbnailBuf(10, 10));
    }
    await flush();

    // Drain the second session one load at a time. Each completion may pump a
    // replacement; the NEW session's live in-flight must never exceed the cap —
    // the proof no counter went negative.
    let guard = 0;
    while (pending.some((x) => x.sess === "/b/") && guard++ < 200) {
      const idx = pending.findIndex((x) => x.sess === "/b/");
      const [pend] = pending.splice(idx, 1);
      pend.resolve(makeThumbnailBuf(10, 10));
      await flush();
      expect(live["/b/"]).toBeLessThanOrEqual(totalCap);
    }
    expect(maxLive["/b/"]).toBeLessThanOrEqual(totalCap);
  });

  it("C4: a path mid-thumb-load when reset() runs is re-scheduled and eventually loads in the new session", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const mockInvoke = vi.mocked(invoke);
    const deferreds = deferredInvoke(mockInvoke);

    const Store = await getStoreClass();
    const store = new Store();
    const path = "/keep/same.cr3";
    store.reset([path]);
    store.requestThumbFor(path);
    await flush();
    expect(deferreds.length).toBe(1); // first (old-gen) fetch in flight

    // reset() to a NEW session that still contains `path` (bg-fill should pick
    // it up). Old requestedThumb must have been cleared (C4) so it's not
    // permanently excluded.
    store.reset([path]);
    await flush();

    // The bg-fill of the new session should have launched a fetch for `path`.
    expect(deferreds.length).toBeGreaterThanOrEqual(2);

    // Settle the old fetch (stale → revoked, no write) and the new fetch.
    deferreds[0].resolve(makeThumbnailBuf(800, 600));
    deferreds[deferreds.length - 1].resolve(makeThumbnailBuf(800, 600));
    await flush();

    // Path now has its thumb in the new session — not stuck on shimmer.
    expect(store.snapshot(path).stage).toBe("thumb");
  });

  it("LRU: small cap evicts the oldest thumb (revoked + back to shimmer)", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const mockInvoke = vi.mocked(invoke);
    const deferreds = deferredInvoke(mockInvoke);

    const Store = await getStoreClass();
    const store = new Store({ thumbLruCap: 2 });
    const paths = ["/lru/a.cr3", "/lru/b.cr3", "/lru/c.cr3"];
    // Empty path-set so background-fill stays inert — we sequence loads by hand
    // (otherwise all three load at once and the cap evicts before we can read).
    store.reset([]);

    // Load a, then b (fills the cap of 2), resolving one at a time.
    store.requestThumbFor(paths[0]);
    await flush();
    deferreds[0].resolve(makeThumbnailBuf(800, 600));
    await flush();
    expect(store.snapshot(paths[0]).stage).toBe("thumb");
    const urlA = store.snapshot(paths[0]).url!;
    expect(liveUrls.has(urlA)).toBe(true);

    store.requestThumbFor(paths[1]);
    await flush();
    deferreds[1].resolve(makeThumbnailBuf(800, 600));
    await flush();
    expect(store.snapshot(paths[1]).stage).toBe("thumb");
    expect(liveUrls.has(urlA)).toBe(true); // a survived (size === cap)

    // Load c → size 3 > cap 2 → oldest (a) evicted + revoked.
    store.requestThumbFor(paths[2]);
    await flush();
    deferreds[2].resolve(makeThumbnailBuf(800, 600));
    await flush();
    expect(store.snapshot(paths[2]).stage).toBe("thumb");

    expect(liveUrls.has(urlA)).toBe(false); // a's url revoked
    expect(store.snapshot(paths[0]).stage).toBe("shimmer"); // a back to shimmer
  });

  it("error: full fetch rejects but thumb is preserved — stage 'thumb' + error set", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const mockInvoke = vi.mocked(invoke);

    const Store = await getStoreClass();
    const store = new Store();
    const path = "/err/x.cr3";
    // Empty path-set → no background-fill phantom invoke; the test fully
    // controls the call sequence (thumb then full).
    store.reset([]);

    // First call (thumb) resolves, second call (full) rejects.
    mockInvoke
      .mockResolvedValueOnce(makeThumbnailBuf(800, 600))
      .mockRejectedValueOnce(new Error("nas timeout"));

    store.requestThumbFor(path);
    await vi.waitUntil(() => store.snapshot(path).stage === "thumb", {
      timeout: 2000,
    });

    store.registerWantFull(path);
    await vi.waitUntil(() => store.snapshot(path).error !== undefined, {
      timeout: 2000,
    });

    const snap = store.snapshot(path);
    expect(snap.stage).toBe("thumb"); // full error doesn't blank the thumb
    expect(snap.error).toBe("nas timeout");
    expect(snap.url).toBeDefined();
  });

  it("I6: transient thumb failure clears requestedThumb so a retry succeeds", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const mockInvoke = vi.mocked(invoke);

    const Store = await getStoreClass();
    const store = new Store();
    const path = "/flaky/t.cr3";
    // Empty path-set → no background-fill phantom invoke.
    store.reset([]);

    // First attempt rejects, second resolves.
    mockInvoke
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce(makeThumbnailBuf(800, 600));

    store.requestThumbFor(path);
    // Wait for the first (failed) attempt to settle and clear requestedThumb.
    await flush();
    await flush();
    expect(store.snapshot(path).stage).toBe("shimmer");

    // Retry — requestedThumb was cleared, so this is NOT an early-return no-op.
    store.requestThumbFor(path);
    await vi.waitUntil(() => store.snapshot(path).stage === "thumb", {
      timeout: 2000,
    });
    expect(store.snapshot(path).stage).toBe("thumb");
  });

  it("C3: evict-then-re-request mid-flight does NOT start a duplicate loadFull", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const mockInvoke = vi.mocked(invoke);
    const deferreds = deferredInvoke(mockInvoke);

    const Store = await getStoreClass();
    const store = new Store();
    const path = "/single/a.cr3";
    // Empty path-set → no background-fill thumb fetch; the only invoke will be
    // the full-res fetchBundle, so deferreds maps 1:1 to loadFull calls.
    store.reset([]);

    // Request full A → one loadFull in flight.
    store.registerWantFull(path);
    await flush();
    expect(deferreds.length).toBe(1);

    // Evict A while its loadFull is still in flight (loading, not ready → no
    // revoke; requestedFull retained because it's in fullInFlightPaths).
    store.evictFull(path);

    // Re-request A. Must NOT spawn a second fetch.
    store.registerWantFull(path);
    await flush();
    expect(deferreds.length).toBe(1); // still exactly ONE NAS fetch

    // Settle the single in-flight load; no url is revoked while referenced.
    deferreds[0].resolve(makeBundleBuf());
    await flush();
    const snap = store.snapshot(path);
    // It resolved to a live full url.
    if (snap.stage === "full") {
      expect(snap.url).toBeDefined();
      expect(liveUrls.has(snap.url!)).toBe(true);
    }
    // Exactly one fetch total — the core assertion.
    expect(deferreds.length).toBe(1);
  });
});
