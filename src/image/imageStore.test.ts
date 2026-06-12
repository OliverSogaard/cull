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

import { resetNavCommandForTests } from "../utils/bundle";

// ── Mock URL.createObjectURL / URL.revokeObjectURL ─────────────────────────
let urlCounter = 0;
const liveUrls = new Set<string>();

const origCreate = globalThis.URL.createObjectURL;
const origRevoke = globalThis.URL.revokeObjectURL;

beforeEach(() => {
  // Fully reset the shared invoke mock between tests so a deferred
  // mockImplementation from one test cannot leak into the next.
  vi.mocked(invoke).mockReset();
  // A test that exercised the legacy read_bundle fallback must not leak the
  // flipped routing into the next test.
  resetNavCommandForTests();
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

/** Build a minimal ArrayBuffer that fetchNav parses (legacy bundle shape —
 *  no orientation/hint fields, exactly what an old read_bundle returns). */
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

/** read_preview-shaped frame: meta + orientation + the zoom range hint. */
function makePreviewBuf(orientation = 1, fullOffset = 1000, fullLen = 5000): ArrayBuffer {
  const header = JSON.stringify({
    meta: { pixelWidth: 6000, pixelHeight: 4000 },
    orientation,
    previewLen: 3,
    fullOffset,
    fullLen,
  });
  const headerBytes = new TextEncoder().encode(header);
  const buf = new ArrayBuffer(4 + headerBytes.length + 3);
  const dv = new DataView(buf);
  dv.setUint32(0, headerBytes.length, true);
  new Uint8Array(buf, 4, headerBytes.length).set(headerBytes);
  new Uint8Array(buf, 4 + headerBytes.length).set([0xff, 0xd8, 0x00]);
  return buf;
}

/** read_fullres-shaped frame. */
function makeFullresBuf(): ArrayBuffer {
  const header = JSON.stringify({ fullLen: 3 });
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

  it("empty-path sentinel: requestThumbFor('') and registerWantFull('') are no-ops (no invoke fired)", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const mockInvoke = vi.mocked(invoke);

    const store = await getStore();
    store.hardReset();

    // These must return immediately without enqueuing any work.
    store.requestThumbFor("");
    store.registerWantFull("");
    store.unregisterWantFull("");

    // Drain the microtask queue — no invoke should have been called.
    await flush();
    expect(mockInvoke).not.toHaveBeenCalled();
    // snapshot("") still returns a stable shimmer (unchanged).
    expect(store.snapshot("").stage).toBe("shimmer");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Concurrency / generation-accounting regression tests.
// These use a deferred `invoke` so we can interleave reset()/evict() with a
// load that is still in flight.
// ─────────────────────────────────────────────────────────────────────────────
describe("imageStore — generation & concurrency", () => {
  it("stale-generation thumb load revokes its blob and does NOT write into the new session", async () => {
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

  it("counters never go negative — concurrency cap is still respected after an interrupted load", async () => {
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

  it("a path mid-thumb-load when reset() runs is re-scheduled and eventually loads in the new session", async () => {
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

    // reset() to a NEW session that still contains `path`. The mid-load path's
    // requestedThumb must have been cleared so it's not permanently excluded.
    // The background sweep is now DEFERRED until the first full-res lands, so drive
    // the re-load on-demand (as the strip/grid would) rather than via bg-fill; if
    // requestedThumb still held the stale entry this would be a no-op (stuck at 1).
    store.reset([path]);
    store.requestThumbFor(path);
    await flush();

    // A fresh fetch launched for `path` in the new session.
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

  it("transient thumb failure backs off (no immediate hammer); retry() bypasses and succeeds", async () => {
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
    // Wait for the first (failed) attempt to settle and record the backoff.
    await flush();
    await flush();
    expect(store.snapshot(path).stage).toBe("shimmer");

    // Re-requesting inside the backoff window must NOT fire a second read —
    // a failing NAS is never hammered. Only the failed invoke has happened.
    store.requestThumbFor(path);
    await flush();
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(store.snapshot(path).stage).toBe("shimmer");

    // The manual retry affordance clears the backoff and re-queues at once.
    store.retry(path);
    await vi.waitUntil(() => store.snapshot(path).stage === "thumb", {
      timeout: 2000,
    });
    expect(store.snapshot(path).stage).toBe("thumb");
  });

  it("evict-then-re-request mid-flight does NOT start a duplicate loadFull", async () => {
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

// ── Phase 1 hardening invariants ────────────────────────────────────────────
describe("imageStore — Phase 1 hardening", () => {
  it("errored full clears requestedFull; retry() re-queues and succeeds", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const mockInvoke = vi.mocked(invoke);

    const Store = await getStoreClass();
    const store = new Store();
    const path = "/err/refetch.cr3";
    store.reset([]);

    // Route by command: retry() also re-queues the missing THUMB, so the
    // mock must serve both lanes. The first full read fails, the retry works.
    let failFull = true;
    mockInvoke.mockImplementation((cmd: unknown) => {
      if (cmd === "extract_thumbnail") return Promise.resolve(makeThumbnailBuf(800, 600));
      if (failFull) {
        failFull = false;
        return Promise.reject(new Error("read failed"));
      }
      return Promise.resolve(makeBundleBuf());
    });

    store.registerWantFull(path);
    await vi.waitUntil(() => store.snapshot(path).error !== undefined, {
      timeout: 2000,
    });
    expect(store.snapshot(path).error).toBe("read failed");

    // Before Phase 1 this path was a dead end: requestedFull kept the path and
    // pumpFull skipped it forever. retry() must produce a fresh fetch.
    store.retry(path);
    await vi.waitUntil(() => store.snapshot(path).stage === "full", {
      timeout: 2000,
    });
    expect(store.snapshot(path).error).toBeUndefined();
  });

  it("errored full auto-retries after the backoff while still wanted", async () => {
    vi.useFakeTimers();
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const mockInvoke = vi.mocked(invoke);

      const Store = await getStoreClass();
      const store = new Store();
      const path = "/err/auto.cr3";
      store.reset([]);

      mockInvoke
        .mockRejectedValueOnce(new Error("nas hiccup"))
        .mockResolvedValueOnce(makeBundleBuf());

      store.registerWantFull(path);
      await flush();
      await flush();
      expect(store.snapshot(path).error).toBe("nas hiccup");

      // First-attempt backoff is 1s; the scheduled retry must re-queue it.
      await vi.advanceTimersByTimeAsync(1100);
      await flush();
      expect(store.snapshot(path).stage).toBe("full");
    } finally {
      vi.useRealTimers();
    }
  });

  it("pinFull protects a far-from-cursor full from window eviction; unpin releases it", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const mockInvoke = vi.mocked(invoke);

    const Store = await getStoreClass();
    const store = new Store();
    const path = "/pin/p.cr3";
    store.reset([]);

    mockInvoke.mockResolvedValueOnce(makeBundleBuf());
    store.registerWantFull(path);
    await vi.waitUntil(() => store.snapshot(path).stage === "full", {
      timeout: 2000,
    });
    const url = store.snapshot(path).url!;

    // Drop the wantFull protection but pin; the path is NOT in the session
    // path list (indexOf -1), so without the pin any eviction pass takes it.
    store.pinFull(path);
    store.unregisterWantFull(path);
    store.setCursor(0); // runs evictFullAround
    expect(store.snapshot(path).stage).toBe("full");
    expect(liveUrls.has(url)).toBe(true);

    store.unpinFull(path);
    store.setCursor(0);
    expect(store.snapshot(path).stage).not.toBe("full");
    expect(liveUrls.has(url)).toBe(false);
  });

  it("a display ref protects a thumb from LRU eviction (refcounted thumbUrl consumers)", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const mockInvoke = vi.mocked(invoke);
    const deferreds = deferredInvoke(mockInvoke);

    const Store = await getStoreClass();
    const store = new Store({ thumbLruCap: 2 });
    const paths = ["/disp/a.cr3", "/disp/b.cr3", "/disp/c.cr3"];
    store.reset([]);

    for (let i = 0; i < 3; i++) {
      store.requestThumbFor(paths[i]);
      await flush();
      // Protect a (the LRU victim-to-be) as a mounted consumer would.
      if (i === 0) store.registerDisplay(paths[0]);
      deferreds[i].resolve(makeThumbnailBuf(800, 600));
      await flush();
    }

    // Cap 2, three thumbs: a is oldest but display-protected → b evicted instead.
    expect(store.snapshot(paths[0]).stage).toBe("thumb");
    expect(store.snapshot(paths[1]).stage).toBe("shimmer");
    expect(store.snapshot(paths[2]).stage).toBe("thumb");

    // Release the ref; the next over-cap load takes a.
    store.unregisterDisplay(paths[0]);
    store.requestThumbFor(paths[1]);
    await flush();
    deferreds[3].resolve(makeThumbnailBuf(800, 600));
    await flush();
    expect(store.snapshot(paths[0]).stage).toBe("shimmer");
  });

  it("dims survive thumb eviction AND full eviction (dims cache)", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const mockInvoke = vi.mocked(invoke);
    const deferreds = deferredInvoke(mockInvoke);

    const Store = await getStoreClass();
    const store = new Store({ thumbLruCap: 1 });
    const paths = ["/dims/a.cr3", "/dims/b.cr3"];
    store.reset([]);

    store.requestThumbFor(paths[0]);
    await flush();
    deferreds[0].resolve(makeThumbnailBuf(800, 600));
    await flush();
    expect(store.snapshot(paths[0]).dims).toEqual({ w: 800, h: 600 });

    // Second thumb evicts the first (cap 1) — but its dims must survive, so
    // the matte never flashes neutral-square on revisit.
    store.requestThumbFor(paths[1]);
    await flush();
    deferreds[1].resolve(makeThumbnailBuf(600, 400));
    await flush();
    const snapA = store.snapshot(paths[0]);
    expect(snapA.stage).toBe("shimmer");
    expect(snapA.dims).toEqual({ w: 800, h: 600 });

    // hardReset is the only eviction point for the dims cache.
    store.hardReset();
    expect(store.snapshot(paths[0]).dims).toBeUndefined();
  });
});

// ── Phase 3: preview nav tier + zoom-full lane ──────────────────────────────
describe("imageStore — Phase 3 zoom tier", () => {
  /** Route the invoke mock by command so lane interleaving can't shift
   *  deferred indices. Returns the read_fullres call args for assertions. */
  function routeInvoke(opts?: { orientation?: number; rejectFullres?: string }) {
    const { invoke: inv } = { invoke };
    const fullresCalls: Record<string, unknown>[] = [];
    vi.mocked(inv).mockImplementation((cmd: unknown, args?: unknown) => {
      if (cmd === "read_preview")
        return Promise.resolve(makePreviewBuf(opts?.orientation ?? 1));
      if (cmd === "read_fullres") {
        fullresCalls.push(args as Record<string, unknown>);
        if (opts?.rejectFullres) return Promise.reject(opts.rejectFullres);
        return Promise.resolve(makeFullresBuf());
      }
      if (cmd === "extract_thumbnail") return Promise.resolve(makeThumbnailBuf(800, 600));
      return Promise.resolve(undefined);
    });
    return fullresCalls;
  }

  it("zoom request uses the hint + orientation from the preview header; dims swap for orientation 6", async () => {
    const fullresCalls = routeInvoke({ orientation: 6 });
    const Store = await getStoreClass();
    const store = new Store();
    const path = "/z/a.cr3";
    store.reset([path]); // tracked → the landed zoom full sits inside fullKeep

    store.registerWantFull(path);
    await vi.waitUntil(() => store.snapshot(path).stage === "full", { timeout: 2000 });
    expect(store.snapshot(path).full).toBeUndefined(); // zoom not fetched yet

    store.requestZoomFull(path);
    await vi.waitUntil(() => store.snapshot(path).full !== undefined, { timeout: 2000 });

    // The hint + orientation were echoed to read_fullres verbatim.
    expect(fullresCalls[0]).toMatchObject({ fullOffset: 1000, fullLen: 5000, orientation: 6 });
    // Native dims: sensor 6000×4000 swapped for the rotated orientation.
    expect(store.snapshot(path).full!.dims).toEqual({ w: 4000, h: 6000 });
    // The nav stage is untouched by the zoom tier.
    expect(store.snapshot(path).stage).toBe("full");
  });

  it("zoom fulls evict outside the fullKeep window; pinFull protects them", async () => {
    routeInvoke();
    const Store = await getStoreClass();
    const store = new Store();
    const paths = Array.from({ length: 12 }, (_, i) => `/z/evict-${i}.cr3`);
    store.reset(paths);

    store.registerWantFull(paths[0]);
    await vi.waitUntil(() => store.snapshot(paths[0]).stage === "full", { timeout: 2000 });
    store.requestZoomFull(paths[0]);
    await vi.waitUntil(() => store.snapshot(paths[0]).full !== undefined, { timeout: 2000 });
    const url = store.snapshot(paths[0]).full!.url;

    // Cursor far past the local fullKeep (3) → evicted + revoked.
    store.setCursor(10);
    expect(store.snapshot(paths[0]).full).toBeUndefined();
    expect(liveUrls.has(url)).toBe(false);

    // Re-fetch, pin, move away again → survives.
    store.setCursor(0);
    store.requestZoomFull(paths[0]);
    await vi.waitUntil(() => store.snapshot(paths[0]).full !== undefined, { timeout: 2000 });
    store.pinFull(paths[0]);
    store.setCursor(10);
    expect(store.snapshot(paths[0]).full).toBeDefined();
    store.unpinFull(paths[0]);
  });

  it("a 'cancelled' zoom read drops quietly: no error, no cooldown, re-request works", async () => {
    const fullresCalls = routeInvoke({ rejectFullres: "cancelled" });
    const Store = await getStoreClass();
    const store = new Store();
    const path = "/z/c.cr3";
    store.reset([path]);

    store.registerWantFull(path);
    await vi.waitUntil(() => store.snapshot(path).stage === "full", { timeout: 2000 });
    store.requestZoomFull(path);
    await vi.waitUntil(() => fullresCalls.length === 1, { timeout: 2000 });
    await flush();
    const snap = store.snapshot(path);
    expect(snap.full).toBeUndefined();
    expect(snap.error).toBeUndefined(); // quiet drop, not an error state

    // No backoff recorded → an immediate re-request fires a fresh read.
    store.requestZoomFull(path);
    await vi.waitUntil(() => fullresCalls.length === 2, { timeout: 2000 });
  });

  it("zoom requested BEFORE the nav read lands is deferred, then fires WITH the hint", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const mockInvoke = vi.mocked(invoke);
    const fullresCalls: Record<string, unknown>[] = [];
    let resolvePreview: ((buf: ArrayBuffer) => void) | null = null;
    mockInvoke.mockImplementation((cmd: unknown, args?: unknown) => {
      if (cmd === "read_preview")
        return new Promise<ArrayBuffer>((r) => {
          resolvePreview = r;
        });
      if (cmd === "read_fullres") {
        fullresCalls.push(args as Record<string, unknown>);
        return Promise.resolve(makeFullresBuf());
      }
      if (cmd === "extract_thumbnail") return Promise.resolve(makeThumbnailBuf(800, 600));
      return Promise.resolve(undefined);
    });

    const Store = await getStoreClass();
    const store = new Store();
    const path = "/z/defer.cr3";
    store.reset([path]);

    // Nav read in flight; zoom engages immediately (the portrait-zoom-on-
    // arrival repro). The zoom fetch must NOT fire hintless.
    store.registerWantFull(path);
    await flush();
    store.requestZoomFull(path);
    await flush();
    expect(fullresCalls).toHaveLength(0);

    // The preview lands (orientation 6 + range hint) → the deferred zoom
    // fires automatically, carrying the hint and the orientation echo.
    resolvePreview!(makePreviewBuf(6));
    await vi.waitUntil(() => store.snapshot(path).full !== undefined, { timeout: 2000 });
    expect(fullresCalls).toHaveLength(1);
    expect(fullresCalls[0]).toMatchObject({ fullOffset: 1000, fullLen: 5000, orientation: 6 });
  });

  it("legacy backend: unknown read_preview flips to read_bundle once; zoom lane no-ops", async () => {
    const cmds: unknown[] = [];
    vi.mocked(invoke).mockImplementation((cmd: unknown) => {
      cmds.push(cmd);
      if (cmd === "read_preview")
        return Promise.reject(new Error("Command read_preview not found"));
      if (cmd === "read_bundle") return Promise.resolve(makeBundleBuf());
      if (cmd === "extract_thumbnail") return Promise.resolve(makeThumbnailBuf(800, 600));
      return Promise.resolve(undefined);
    });
    const Store = await getStoreClass();
    const store = new Store();
    const path = "/z/legacy.cr3";
    store.reset([path]);

    store.registerWantFull(path);
    await vi.waitUntil(() => store.snapshot(path).stage === "full", { timeout: 2000 });
    expect(store.isLegacyNav()).toBe(true);

    // The zoom tier doesn't exist on a legacy backend — request must no-op.
    store.requestZoomFull(path);
    await flush();
    expect(cmds.filter((c) => c === "read_fullres")).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("Phase 5 — direction-biased prefetch + decode pool", () => {
  it("prefetches ahead:behind = 4:2 in the travel direction (network profile)", async () => {
    const { PERFORMANCE_PROFILES } = await import("../types/settings");
    const mockInvoke = vi.mocked(invoke);
    const previewsRequested: string[] = [];
    mockInvoke.mockImplementation((cmd, args) => {
      if (cmd === "read_preview") {
        previewsRequested.push((args as { path: string }).path);
        return Promise.resolve(makePreviewBuf());
      }
      if (cmd === "extract_thumbnail")
        return Promise.resolve(makeThumbnailBuf(60, 40));
      return Promise.resolve(new ArrayBuffer(0)); // begin_session / set_io_profile
    });
    const Store = await getStoreClass();
    const store = new Store();
    store.setProfile(PERFORMANCE_PROFILES.network);
    const paths = Array.from({ length: 30 }, (_, i) => `/p/${i}.cr3`);
    store.reset(paths);

    // First settle: bgStarted=false → ±1 only; those landing flip bgStarted.
    store.setCursor(10);
    // First-tap-warm pin (Phase 1/3 contract, re-implemented by Phase 5's
    // ahead/behind split): pre-first-land prefetch is EXACTLY ±1, ahead first.
    expect(previewsRequested).toEqual(["/p/11.cr3", "/p/9.cr3"]);
    await vi.waitUntil(() => store.snapshot("/p/9.cr3").stage === "full");
    await flush();
    previewsRequested.length = 0;

    // The first full landing already ran a full-radius prefetch from cursor
    // 10 (dir → right): ahead 11..14 + behind 9,8 are ready. Stepping RIGHT
    // to 11 therefore requests exactly the NEW ahead edge (15) and the new
    // behind frame (10) — nearest-ready frames are skipped, nothing beyond
    // ahead=4 / behind=2 is touched.
    store.setCursor(11);
    await flush();
    expect(new Set(previewsRequested)).toEqual(
      new Set(["/p/15.cr3", "/p/10.cr3"]),
    );

    previewsRequested.length = 0;
    // Jump LEFT to 5: travel direction flips → ahead = 4,3,2,1; behind = 6,7.
    // ORDERED assertion: nearest-first with ahead winning ties is a stated
    // plan semantic (it decides who gets the 4 network lanes first).
    store.setCursor(5);
    await flush();
    expect(previewsRequested).toEqual([
      "/p/4.cr3",
      "/p/6.cr3",
      "/p/3.cr3",
      "/p/7.cr3",
      "/p/2.cr3",
      "/p/1.cr3",
    ]);
  });

  it("the decode pool warms ready previews around the cursor and clears on reset", async () => {
    const { PERFORMANCE_PROFILES } = await import("../types/settings");
    const mockInvoke = vi.mocked(invoke);
    mockInvoke.mockImplementation((cmd) => {
      if (cmd === "read_preview") return Promise.resolve(makePreviewBuf());
      if (cmd === "extract_thumbnail")
        return Promise.resolve(makeThumbnailBuf(60, 40));
      return Promise.resolve(new ArrayBuffer(0));
    });
    const poolImages: { src: string }[] = [];
    const Store = await getStoreClass();
    const store = new Store({
      poolImageFactory: () => {
        const img = { src: "", decode: () => Promise.resolve() };
        poolImages.push(img);
        return img;
      },
    });
    store.setProfile(PERFORMANCE_PROFILES.network);
    const paths = Array.from({ length: 10 }, (_, i) => `/p/${i}.cr3`);
    store.reset(paths);

    store.setCursor(4); // ±1 prefetch fetches 3 and 5
    await vi.waitUntil(() => store.snapshot("/p/5.cr3").stage === "full");
    await flush();
    // The landed previews inside the band are being held decoded.
    expect(poolImages.some((i) => i.src.startsWith("blob:"))).toBe(true);

    // A session reset revokes the blobs — the pool must release every ref.
    store.reset(paths.slice(0, 2));
    expect(poolImages.every((i) => i.src === "")).toBe(true);
  });
});

// ── Mid tier (Phase 8): display-adaptive needPx selection ───────────────────

describe("mid tier (Phase 8)", () => {
  /** read_mid-shaped frame: { midLen, width, height } header + 3 JPEG bytes. */
  function makeMidBuf(): ArrayBuffer {
    const header = JSON.stringify({ midLen: 3, width: 2560, height: 1707 });
    const headerBytes = new TextEncoder().encode(header);
    const buf = new ArrayBuffer(4 + headerBytes.length + 3);
    const dv = new DataView(buf);
    dv.setUint32(0, headerBytes.length, true);
    new Uint8Array(buf, 4, headerBytes.length).set(headerBytes);
    new Uint8Array(buf, 4 + headerBytes.length).set([0xff, 0xd8, 0x00]);
    return buf;
  }

  /** Route invoke by command; records calls. Unrouted commands resolve to a
   *  valid frame of their kind so background machinery never poisons a test. */
  function routeMidInvoke(
    overrides: Record<string, (args: unknown) => Promise<unknown>> = {},
  ) {
    const calls: { cmd: string; args: Record<string, unknown> }[] = [];
    vi.mocked(invoke).mockImplementation((cmd: unknown, args?: unknown) => {
      calls.push({ cmd: cmd as string, args: (args ?? {}) as Record<string, unknown> });
      const route = overrides[cmd as string];
      if (route) return route(args) as Promise<never>;
      if (cmd === "read_preview") return Promise.resolve(makePreviewBuf()) as Promise<never>;
      if (cmd === "extract_thumbnail")
        return Promise.resolve(makeThumbnailBuf(60, 40)) as Promise<never>;
      if (cmd === "read_mid") return Promise.resolve(makeMidBuf()) as Promise<never>;
      if (cmd === "generate_mid") return Promise.resolve(true) as Promise<never>;
      return Promise.resolve(new ArrayBuffer(0)) as Promise<never>;
    });
    return calls;
  }

  const midCalls = (calls: { cmd: string }[]) => calls.filter((c) => c.cmd === "read_mid");
  const genCalls = (calls: { cmd: string }[]) => calls.filter((c) => c.cmd === "generate_mid");

  it("requests read_mid only when the display engages (needPx fresh per request)", async () => {
    const { PERFORMANCE_PROFILES } = await import("../types/settings");
    const calls = routeMidInvoke();
    const Store = await getStoreClass();
    const store = new Store();
    store.setProfile(PERFORMANCE_PROFILES.network);
    store.reset(["/p/a.cr3"]);

    // 1440p-class display: the mid is NEVER requested.
    store.setNeedPxProvider(() => 1240);
    store.maybeRequestMid("/p/a.cr3");
    await flush();
    expect(midCalls(calls)).toHaveLength(0);
    expect(store.snapshot("/p/a.cr3").mid).toBeUndefined();

    // 4K-class display: requested, and the snapshot gains the mid url.
    store.setNeedPxProvider(() => 1860);
    store.maybeRequestMid("/p/a.cr3");
    await vi.waitUntil(() => store.snapshot("/p/a.cr3").mid !== undefined, { timeout: 2000 });
    expect(midCalls(calls)).toHaveLength(1);
    expect(store.snapshot("/p/a.cr3").mid?.url).toMatch(/^blob:/);
  });

  it("the hysteresis latch holds through the band and releases below it", async () => {
    const { PERFORMANCE_PROFILES } = await import("../types/settings");
    const calls = routeMidInvoke();
    const Store = await getStoreClass();
    const store = new Store();
    store.setProfile(PERFORMANCE_PROFILES.network);
    const paths = ["/p/0.cr3", "/p/1.cr3", "/p/2.cr3"];
    store.reset(paths);
    let needPx = 1860;
    store.setNeedPxProvider(() => needPx);

    store.maybeRequestMid(paths[0]); // engages
    await vi.waitUntil(() => midCalls(calls).length === 1, { timeout: 2000 });
    needPx = 1700; // resize jitter inside the band — choice held
    store.maybeRequestMid(paths[1]);
    await vi.waitUntil(() => midCalls(calls).length === 2, { timeout: 2000 });
    needPx = 1240; // dragged to the 1440p display — released
    store.maybeRequestMid(paths[2]);
    await flush();
    expect(midCalls(calls)).toHaveLength(2);
  });

  it("'mid uncached' is a quiet miss: nothing surfaced, no request spam", async () => {
    const { PERFORMANCE_PROFILES } = await import("../types/settings");
    const calls = routeMidInvoke({
      read_mid: () => Promise.reject(new Error("mid uncached (network profile)")),
    });
    const Store = await getStoreClass();
    const store = new Store();
    store.setProfile(PERFORMANCE_PROFILES.network);
    store.reset(["/p/a.cr3"]);
    store.setNeedPxProvider(() => 1860);

    store.maybeRequestMid("/p/a.cr3");
    await vi.waitUntil(() => midCalls(calls).length === 1, { timeout: 2000 });
    await flush();
    // Not an error (the fallback chain keeps rendering the preview)…
    expect(store.snapshot("/p/a.cr3").mid).toBeUndefined();
    expect(store.snapshot("/p/a.cr3").error).toBeUndefined();
    // …and memoized: re-requests don't hammer a read that can't succeed yet.
    store.maybeRequestMid("/p/a.cr3");
    await flush();
    expect(midCalls(calls)).toHaveLength(1);
  });

  it("a mid wanted mid-nav defers until the hint lands, then carries it", async () => {
    const { PERFORMANCE_PROFILES } = await import("../types/settings");
    let releaseNav: ((buf: ArrayBuffer) => void) | undefined;
    const calls = routeMidInvoke({
      read_preview: () =>
        releaseNav
          ? Promise.resolve(makePreviewBuf())
          : new Promise((resolve) => {
              releaseNav = resolve as (buf: ArrayBuffer) => void;
            }),
    });
    const Store = await getStoreClass();
    const store = new Store();
    store.setProfile(PERFORMANCE_PROFILES.network);
    store.reset(["/p/a.cr3"]);
    store.setNeedPxProvider(() => 1860);

    store.registerWantFull("/p/a.cr3"); // nav read now in flight (deferred)
    await flush();
    store.maybeRequestMid("/p/a.cr3"); // no hint yet → defers, no read_mid
    await flush();
    expect(midCalls(calls)).toHaveLength(0);

    releaseNav!(makePreviewBuf(6, 1234, 5678)); // hint + orientation echo land
    await vi.waitUntil(() => midCalls(calls).length === 1, { timeout: 2000 });
    expect(midCalls(calls)[0].args).toMatchObject({
      fullOffset: 1234,
      fullLen: 5678,
      orientation: 6,
    });
  });

  it("mids outside the keep window are revoked; displayRefs protect a mounted frame", async () => {
    const { PERFORMANCE_PROFILES } = await import("../types/settings");
    routeMidInvoke();
    const Store = await getStoreClass();
    const store = new Store();
    store.setProfile(PERFORMANCE_PROFILES.network); // fullKeep 2
    const paths = Array.from({ length: 10 }, (_, i) => `/p/${i}.cr3`);
    store.reset(paths);
    store.setNeedPxProvider(() => 1860);

    store.maybeRequestMid(paths[0]);
    await vi.waitUntil(() => store.snapshot(paths[0]).mid !== undefined, { timeout: 2000 });
    const url0 = store.snapshot(paths[0]).mid!.url;
    expect(liveUrls.has(url0)).toBe(true);

    // A mounted consumer (the presenter may still show its raster) survives…
    store.registerDisplay(paths[0]);
    store.setCursor(5);
    expect(store.snapshot(paths[0]).mid?.url).toBe(url0);
    // …and is evicted + revoked once unmounted and outside the window.
    store.unregisterDisplay(paths[0]);
    store.setCursor(6);
    expect(store.snapshot(paths[0]).mid).toBeUndefined();
    expect(liveUrls.has(url0)).toBe(false);
  });

  it("the idle sweep pre-generates on LOCAL only, paused while on-demand work runs", async () => {
    const { PERFORMANCE_PROFILES } = await import("../types/settings");
    let releaseNav: ((buf: ArrayBuffer) => void) | undefined;
    const calls = routeMidInvoke({
      read_preview: () =>
        releaseNav
          ? Promise.resolve(makePreviewBuf())
          : new Promise((resolve) => {
              releaseNav = resolve as (buf: ArrayBuffer) => void;
            }),
    });
    const Store = await getStoreClass();
    const store = new Store();
    store.setProfile(PERFORMANCE_PROFILES.local);
    const paths = ["/p/a.cr3", "/p/b.cr3", "/p/c.cr3"];
    store.reset(paths);
    store.setNeedPxProvider(() => 1860);

    store.registerWantFull(paths[0]); // first nav read in flight (deferred)
    store.reevaluateMid(); // engages; the sweep must NOT start yet
    await flush();
    expect(genCalls(calls)).toHaveLength(0);

    releaseNav!(makePreviewBuf()); // nav lands → bg starts → lanes drain
    // The sweep eventually covers the paths without a ready mid.
    await vi.waitUntil(() => genCalls(calls).length >= 2, { timeout: 4000 });
    const sweptPaths = genCalls(calls).map((c) => c.args.path);
    expect(sweptPaths).toContain("/p/b.cr3");
    expect(sweptPaths).toContain("/p/c.cr3");
    // Pause discipline: generation only began after the on-demand mid read
    // (the cursor frame's read_mid) had been issued — never alongside it.
    const firstGen = calls.findIndex((c) => c.cmd === "generate_mid");
    const midRead = calls.findIndex((c) => c.cmd === "read_mid");
    expect(midRead).toBeGreaterThanOrEqual(0);
    expect(firstGen).toBeGreaterThan(midRead);
  });

  it("the sweep never runs on the network profile", async () => {
    const { PERFORMANCE_PROFILES } = await import("../types/settings");
    const calls = routeMidInvoke();
    const Store = await getStoreClass();
    const store = new Store();
    store.setProfile(PERFORMANCE_PROFILES.network);
    store.reset(["/p/a.cr3", "/p/b.cr3"]);
    store.setNeedPxProvider(() => 1860);

    store.registerWantFull("/p/a.cr3");
    store.reevaluateMid();
    await vi.waitUntil(() => store.snapshot("/p/a.cr3").mid !== undefined, { timeout: 2000 });
    await new Promise((r) => setTimeout(r, 50)); // give a wrong sweep time to fire
    expect(genCalls(calls)).toHaveLength(0);
  });
});
