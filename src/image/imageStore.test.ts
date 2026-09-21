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
import { PERFORMANCE_PROFILES } from "../types/settings";
import { makeSink, manualScheduler } from "./__fixtures__/metaBatching";
import { MID_SWEEP_QUIET_MS } from "./midSweep";

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

/** Every ImageStore a test builds (see getStoreClass), torn down after it.
 *
 *  `reset()` arms a 2 s background-fill fallback, and the local profile runs
 *  real background sweeps. This file's tests take ~4 s in total, so a store
 *  left alive keeps issuing reads into whichever test happens to be running
 *  two seconds later — which showed up as intermittent, order-dependent read
 *  counts in the tombstone tests near the end of the file. `hardReset()`
 *  bumps the generation, so every pending timer and in-flight read bails.
 *  Registered after the mock-restoring hook above so it runs BEFORE it
 *  (Vitest unwinds afterEach hooks in reverse registration order) and the
 *  revokes it performs still land on the mocked URL functions. */
const liveStores: { hardReset: () => void }[] = [];
afterEach(() => {
  for (const s of liveStores.splice(0)) {
    s.hardReset();
  }
});

// ── Helpers ────────────────────────────────────────────────────────────────

/** Build a minimal ArrayBuffer that fetchThumbnail parses: u32 LE header-len,
 *  JSON header, then `jpegLen` bytes of fake JPEG. `meta` rides the header on
 *  fresh parses (the Phase 3 metadata fast path). */
function makeThumbnailBuf(
  w: number,
  h: number,
  meta: Record<string, unknown> | null = null,
): ArrayBuffer {
  const header = JSON.stringify({ width: w, height: h, jpegLen: 3, meta });
  const headerBytes = new TextEncoder().encode(header);
  const buf = new ArrayBuffer(4 + headerBytes.length + 3);
  const dv = new DataView(buf);
  dv.setUint32(0, headerBytes.length, true);
  new Uint8Array(buf, 4, headerBytes.length).set(headerBytes);
  // fake JPEG bytes
  new Uint8Array(buf, 4 + headerBytes.length).set([0xff, 0xd8, 0x00]);
  return buf;
}

/** Build a minimal ArrayBuffer that fetchNav parses: a nav frame carrying no
 *  orientation/hint fields, so they parse as null (backend-scan fallback). */
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
  // Every instance registers itself for teardown (see liveStores) — the store
  // owns wall-clock timers that outlive the test that built it.
  return class TrackedStore extends mod.ImageStore {
    constructor(...args: ConstructorParameters<typeof mod.ImageStore>) {
      super(...args);
      liveStores.push(this);
    }
  };
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
    await vi.waitUntil(() => paths.every((p) => store.snapshot(p).stage === "thumb"), {
      timeout: 2000,
    });

    expect(liveUrls.size).toBeGreaterThanOrEqual(paths.length);
    store.hardReset();
    expect(liveUrls.size).toBe(0);
  });

  it("reset(paths) revokes full-res blob URLs but keeps thumbs", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke)
      .mockResolvedValueOnce(makeThumbnailBuf(800, 600)) // thumb
      .mockResolvedValueOnce(makeBundleBuf()); // full

    const store = await getStore();
    store.hardReset();
    const path = "/foo/reset.cr3";

    // Load thumb
    store.requestThumbFor(path);
    await vi.waitUntil(() => store.snapshot(path).stage === "thumb", { timeout: 2000 });
    const thumbUrlsAfterThumb = liveUrls.size;

    // Load full
    store.registerWantFull(path);
    await vi.waitUntil(() => store.snapshot(path).stage === "full", { timeout: 2000 });
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

  it("setProfile swaps the lanes' concurrency caps", async () => {
    const store = await getStore();
    store.hardReset();
    store.setMemoryPressure("normal"); // pressure clamps the caps otherwise
    const bg = () => store.debugStats().lanes.bg;
    store.setProfile(PERFORMANCE_PROFILES.network);
    const net = bg();
    store.setProfile(PERFORMANCE_PROFILES.local);
    const loc = bg();
    // The profiles must actually differ here, or the assertions below would
    // hold on a setProfile whose body had been emptied — which is exactly the
    // hole the old `.not.toThrow()` version left (its title claimed to check
    // backgroundFillConcurrency and its body never read it).
    expect(PERFORMANCE_PROFILES.network.backgroundFillConcurrency).not.toBe(
      PERFORMANCE_PROFILES.local.backgroundFillConcurrency,
    );
    expect(net).toBe(`0/${PERFORMANCE_PROFILES.network.backgroundFillConcurrency} q0`);
    expect(loc).toBe(`0/${PERFORMANCE_PROFILES.local.backgroundFillConcurrency} q0`);
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

  it("registerWantFull queues exactly one nav read per path", async () => {
    // unregisterWantFull is NOT asserted here: its only observable is the
    // eviction protection it releases, which needs the profile's keep-window
    // arithmetic to demonstrate. Better to cover half honestly than to keep a
    // `.not.toThrow()` that covers neither.
    vi.mocked(invoke).mockResolvedValue(makePreviewBuf());
    const Store = await getStoreClass();
    const store = new Store();
    const path = "/p/wf.cr3";
    store.reset([path]);
    store.registerWantFull(path);
    await vi.waitUntil(() => store.debugStats().counts.navLoads === 1, { timeout: 2000 });
    expect(vi.mocked(invoke)).toHaveBeenCalledWith(
      "read_preview",
      expect.objectContaining({ path }),
    );
    const reads = vi.mocked(invoke).mock.calls.filter((c) => c[0] === "read_preview").length;
    store.registerWantFull(path); // already resolved — must not re-read
    expect(vi.mocked(invoke).mock.calls.filter((c) => c[0] === "read_preview")).toHaveLength(reads);
    store.unregisterWantFull(path);
  });

  it("setCursor moves the reported cursor, and scrubbing suppresses the prefetch", async () => {
    // setGridRange's half of the old `.not.toThrow()` test is gone: it
    // requests nothing without setGridCellW plus a registerDisplay per path,
    // and the grid describe below already covers exactly that (see `armed`).
    vi.mocked(invoke).mockResolvedValue(makePreviewBuf());
    const Store = await getStoreClass();
    const store = new Store();
    store.reset(["/p/0.cr3", "/p/1.cr3", "/p/2.cr3", "/p/3.cr3", "/p/4.cr3"]);
    // Captured BEFORE the scrubbing move — capturing it after (the earlier
    // version of this test) would have baked the scrub move's own reads into
    // the baseline, so deleting `if (!scrubbing)` (imageStore.ts:945) could
    // never turn this test red.
    const beforeScrub = vi.mocked(invoke).mock.calls.length;
    store.setCursor(2, true); // scrubbing: no prefetchFullsAround
    expect(store.debugStats().cursor).toBe(2);
    expect(vi.mocked(invoke).mock.calls.length).toBe(beforeScrub);
    store.setCursor(3); // parked: the prefetch runs
    expect(store.debugStats().cursor).toBe(3);
    expect(vi.mocked(invoke).mock.calls.length).toBeGreaterThan(beforeScrub);
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
    const staleUrl = vi.mocked(URL.createObjectURL).mock.results[createdAfter - 1].value as string;
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
      if (cmd === "read_preview") return Promise.resolve(makePreviewBuf(opts?.orientation ?? 1));
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
      if (cmd === "extract_thumbnail") return Promise.resolve(makeThumbnailBuf(60, 40));
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
    expect(new Set(previewsRequested)).toEqual(new Set(["/p/15.cr3", "/p/10.cr3"]));

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
      if (cmd === "extract_thumbnail") return Promise.resolve(makeThumbnailBuf(60, 40));
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
  /** Route invoke by command; records calls. Unrouted commands resolve to a
   *  valid frame of their kind so background machinery never poisons a test. */
  function routeMidInvoke(overrides: Record<string, (args: unknown) => Promise<unknown>> = {}) {
    const calls: { cmd: string; args: Record<string, unknown> }[] = [];
    vi.mocked(invoke).mockImplementation((cmd: unknown, args?: unknown) => {
      calls.push({ cmd: cmd as string, args: (args ?? {}) as Record<string, unknown> });
      const route = overrides[cmd as string];
      if (route) return route(args);
      if (cmd === "read_preview") return Promise.resolve(makePreviewBuf());
      if (cmd === "extract_thumbnail") return Promise.resolve(makeThumbnailBuf(60, 40));
      if (cmd === "read_mid") return Promise.resolve(makeMidBuf());
      if (cmd === "generate_mid") return Promise.resolve(true);
      return Promise.resolve(new ArrayBuffer(0));
    });
    return calls;
  }

  type InvokeCall = { cmd: string; args: Record<string, unknown> };
  const midCalls = (calls: InvokeCall[]) => calls.filter((c) => c.cmd === "read_mid");
  const genCalls = (calls: InvokeCall[]) => calls.filter((c) => c.cmd === "generate_mid");

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

  it("a per-file 'not found' from read_mid is an ordinary tier error — it does not latch the tier off for other paths", async () => {
    const { PERFORMANCE_PROFILES } = await import("../types/settings");
    const calls = routeMidInvoke({
      read_mid: (args) => {
        const p = (args as Record<string, unknown>).path;
        return p === "/p/a.cr3"
          ? Promise.reject(new Error("read_mid(/p/a.cr3): file not found"))
          : Promise.resolve(makeMidBuf());
      },
    });
    const Store = await getStoreClass();
    const store = new Store();
    store.setProfile(PERFORMANCE_PROFILES.network);
    store.reset(["/p/a.cr3", "/p/b.cr3"]);
    store.setNeedPxProvider(() => 1860);

    store.maybeRequestMid("/p/a.cr3");
    await flush();
    expect(midCalls(calls)).toHaveLength(1);
    expect(store.snapshot("/p/a.cr3").mid).toBeUndefined();

    // A live path's own "not found" must not dormant the tier for the rest
    // of the session — only a missing read_mid COMMAND does that.
    store.maybeRequestMid("/p/b.cr3");
    await vi.waitUntil(() => store.snapshot("/p/b.cr3").mid !== undefined, { timeout: 2000 });
    expect(midCalls(calls)).toHaveLength(2);
    expect(store.snapshot("/p/b.cr3").mid?.url).toMatch(/^blob:/);
  });

  it("'Command read_mid not found' latches the mid tier off for the session", async () => {
    const { PERFORMANCE_PROFILES } = await import("../types/settings");
    const calls = routeMidInvoke({
      read_mid: () => Promise.reject(new Error("Command read_mid not found")),
    });
    const Store = await getStoreClass();
    const store = new Store();
    store.setProfile(PERFORMANCE_PROFILES.network);
    store.reset(["/p/a.cr3", "/p/b.cr3"]);
    store.setNeedPxProvider(() => 1860);

    store.maybeRequestMid("/p/a.cr3");
    await flush();
    expect(midCalls(calls)).toHaveLength(1);

    // The whole tier stays dormant — a second path never even tries.
    store.maybeRequestMid("/p/b.cr3");
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
              releaseNav = resolve;
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
              releaseNav = resolve;
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

  it("the sweep never runs on the network profile, even after its quiet window", async () => {
    const { PERFORMANCE_PROFILES } = await import("../types/settings");
    const calls = routeMidInvoke();
    const Store = await getStoreClass();
    const store = new Store();

    // Fake timers BEFORE reset(): reset arms a 2 s background-fill fallback
    // (imageStore.ts:726), and arming it on the real clock is precisely the
    // cross-test bleed imageStore.test.ts:54-64 documents — it would also
    // leave the `mid` assertion below depending on a promise chain the fake
    // clock never drives.
    vi.useFakeTimers();
    try {
      store.setProfile(PERFORMANCE_PROFILES.network);
      store.reset(["/p/a.cr3", "/p/b.cr3"]);
      store.setNeedPxProvider(() => 1860);
      store.registerWantFull("/p/a.cr3");
      store.reevaluateMid();
      // Was `await new Promise(r => setTimeout(r, 50))` — "give a wrong sweep
      // time to fire", which a sweep with >50 ms of latency would have
      // strolled straight past. advanceTimersByTimeAsync flushes the read's
      // promise chain AND runs the idle sweep's whole quiet window to its end,
      // so "it never fired" now means the deadline provably passed.
      await vi.advanceTimersByTimeAsync(MID_SWEEP_QUIET_MS + 1);
      expect(store.snapshot("/p/a.cr3").mid).toBeDefined();
      expect(genCalls(calls)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── The 8-away flash (thumb-flash-report §"The 8-away flash: root cause") ───
//
// prefetchFullsAround enqueues the nav preview for the frame exactly
// previewPrefetchAhead (8, local profile) ahead of the cursor. When it LANDS,
// resolveStage used to flip the path's `url` from the thumb blob to the
// preview blob; useThumb rendered that url, so the thumb <img src> swapped
// blobs and WKWebView blanked the cell (~0.1 s) while decoding the 1620×1080
// preview. The thumb tier must stay independently addressable so a foreign-tier
// landing never changes what a thumb cell renders.
describe("thumb-tier stability across nav-preview landings (8-away flash)", () => {
  it("a nav preview landing does NOT change the thumb cell's display url", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke)
      .mockResolvedValueOnce(makeThumbnailBuf(800, 600)) // thumb
      .mockResolvedValueOnce(makeBundleBuf()); // nav preview (no hints)
    const { thumbDisplayUrl } = await import("./useThumb");

    const store = await getStore();
    store.hardReset();
    const path = "/foo/eight-away.cr3";

    store.requestThumbFor(path);
    await vi.waitUntil(() => store.snapshot(path).stage === "thumb", { timeout: 2000 });
    const before = store.snapshot(path);
    // The thumb tier must be exposed on the snapshot itself…
    expect(before.thumbUrl).toBeDefined();
    expect(thumbDisplayUrl(before)).toBe(before.thumbUrl);

    // …and survive the preview landing (what the direction-biased prefetch does).
    store.registerWantFull(path);
    await vi.waitUntil(() => store.snapshot(path).stage === "full", { timeout: 2000 });
    const after = store.snapshot(path);
    expect(after.url).not.toBe(before.thumbUrl); // nav url really did flip…
    expect(after.thumbUrl).toBe(before.thumbUrl); // …but the thumb tier didn't
    // The value a ThumbCell/GridCell <img src> binds must be IDENTICAL, so
    // React's diff leaves the element untouched — no blob swap, no flash.
    expect(thumbDisplayUrl(after)).toBe(thumbDisplayUrl(before));
  });

  it("preview-first fallback survives: no thumb yet -> cells show the preview, then upgrade once", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke)
      .mockResolvedValueOnce(makeBundleBuf()) // nav preview lands FIRST (big jump)
      .mockResolvedValueOnce(makeThumbnailBuf(800, 600)); // thumb trails
    const { thumbDisplayUrl } = await import("./useThumb");

    const store = await getStore();
    store.hardReset();
    const path = "/foo/preview-first.cr3";

    store.registerWantFull(path);
    await vi.waitUntil(() => store.snapshot(path).stage === "full", { timeout: 2000 });
    const previewOnly = store.snapshot(path);
    // No thumb yet — the preview is the only pixels available; cells must use it.
    expect(previewOnly.thumbUrl).toBeUndefined();
    expect(thumbDisplayUrl(previewOnly)).toBe(previewOnly.url);

    // Thumb lands late: subscribers are notified (thumbUrl participates in the
    // snapshot change detection) and cells switch to the thumb tier.
    const cb = vi.fn();
    const unsub = store.subscribe(path, cb);
    store.requestThumbFor(path);
    await vi.waitUntil(() => store.snapshot(path).thumbUrl !== undefined, { timeout: 2000 });
    expect(cb).toHaveBeenCalled();
    expect(thumbDisplayUrl(store.snapshot(path))).toBe(store.snapshot(path).thumbUrl);
    unsub();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Lane-parity net (Phase 8 TierLane collapse). These pin CURRENT per-lane
// behavior BEFORE the four pump/load/evict quads collapse onto TierLane —
// the refactor must keep every one of these green byte-for-byte in behavior:
// single-flight dedup, gen-scoped stale completion (counter integrity +
// stale-blob revoke), error → cooldown → retry() re-arm, and windowed
// eviction respecting each lane's protection class.
describe("lane parity net (Phase 8 TierLane collapse)", () => {
  type Store = Awaited<ReturnType<typeof getStore>>;

  /** read_mid-shaped frame: { midLen, width, height } header + JPEG bytes. */
  function makeMidLaneBuf(): ArrayBuffer {
    const header = JSON.stringify({ midLen: 3, width: 2000, height: 1333 });
    const headerBytes = new TextEncoder().encode(header);
    const buf = new ArrayBuffer(4 + headerBytes.length + 3);
    const dv = new DataView(buf);
    dv.setUint32(0, headerBytes.length, true);
    new Uint8Array(buf, 4, headerBytes.length).set(headerBytes);
    new Uint8Array(buf, 4 + headerBytes.length).set([0xff, 0xd8, 0x00]);
    return buf;
  }

  /** Defer only `cmd`; every other command hangs forever (so e.g. the bg
   *  thumb sweep can never interleave with the lane under test). The
   *  returned array doubles as the per-command call counter. */
  function laneDeferreds(cmd: string): Deferred[] {
    const deferreds: Deferred[] = [];
    vi.mocked(invoke).mockImplementation((c: unknown) => {
      if (c === cmd) {
        return new Promise<ArrayBuffer>((resolve, reject) => {
          deferreds.push({ resolve, reject });
        });
      }
      return new Promise(() => {});
    });
    return deferreds;
  }

  type Lane = {
    name: string;
    cmd: string;
    /** On-demand concurrency cap on the NETWORK profile (set per test —
     *  the local default's caps (12/16) would need unwieldy path counts). */
    cap: number;
    buf: () => ArrayBuffer;
    setup?: (store: Store) => void;
    drive: (store: Store, path: string) => void;
    isReady: (store: Store, path: string) => boolean;
  };

  const LANES: Lane[] = [
    {
      name: "thumb",
      cmd: "extract_thumbnail",
      cap: 4, // PERFORMANCE_PROFILES.network.thumbConcurrency
      buf: () => makeThumbnailBuf(800, 600),
      drive: (s, p) => s.requestThumbFor(p),
      isReady: (s, p) => s.thumbUrl(p) !== undefined,
    },
    {
      name: "nav preview",
      cmd: "read_preview",
      cap: 4, // network .previewConcurrency
      buf: () => makePreviewBuf(),
      drive: (s, p) => s.registerWantFull(p),
      isReady: (s, p) => s.snapshot(p).stage === "full",
    },
    {
      name: "zoom full",
      cmd: "read_fullres",
      cap: 2, // network .fullConcurrency
      buf: () => makeFullresBuf(),
      drive: (s, p) => s.requestZoomFull(p),
      isReady: (s, p) => s.snapshot(p).full !== undefined,
    },
    {
      name: "mid",
      cmd: "read_mid",
      cap: 1, // network .midGenConcurrency
      buf: () => makeMidLaneBuf(),
      setup: (s) => s.setNeedPxProvider(() => 2000), // engage the tier
      drive: (s, p) => s.maybeRequestMid(p),
      isReady: (s, p) => s.snapshot(p).mid !== undefined,
    },
  ];

  for (const lane of LANES) {
    it(`${lane.name}: single-flight — re-drives while in flight and after ready never duplicate the fetch`, async () => {
      const StoreClass = await getStoreClass();
      const store = new StoreClass();
      store.setProfile(PERFORMANCE_PROFILES.network);
      const path = "/net/a.cr3";
      store.reset([path]);
      lane.setup?.(store);
      const deferreds = laneDeferreds(lane.cmd);

      lane.drive(store, path);
      lane.drive(store, path); // second drive while the first is in flight
      await flush();
      expect(deferreds).toHaveLength(1);

      deferreds[0].resolve(lane.buf());
      await vi.waitUntil(() => lane.isReady(store, path), { timeout: 2000 });

      lane.drive(store, path); // ready — must not re-fetch
      await flush();
      expect(deferreds).toHaveLength(1);
    });

    it(`${lane.name}: stale completion is gen-scoped — no state leak, blob revoked, cap intact in the new session`, async () => {
      const StoreClass = await getStoreClass();
      const store = new StoreClass();
      store.setProfile(PERFORMANCE_PROFILES.network);
      const oldPaths = Array.from({ length: lane.cap }, (_, i) => `/old/${i}.cr3`);
      store.reset(oldPaths);
      lane.setup?.(store);
      const deferreds = laneDeferreds(lane.cmd);

      for (const p of oldPaths) lane.drive(store, p);
      await flush();
      expect(deferreds).toHaveLength(lane.cap); // lane saturated

      store.hardReset(); // generation moves; counters zeroed
      for (const d of deferreds) d.resolve(lane.buf()); // stale successes land late
      await flush();

      // Nothing written into the new session; every stale blob revoked.
      for (const p of oldPaths) expect(lane.isReady(store, p)).toBe(false);
      expect(liveUrls.size).toBe(0);

      // Counter integrity: the new session still serves EXACTLY `cap`
      // concurrent fetches (a mis-scoped decrement would shift this).
      const newPaths = Array.from({ length: lane.cap + 1 }, (_, i) => `/new/${i}.cr3`);
      store.reset(newPaths);
      lane.setup?.(store);
      for (const p of newPaths) lane.drive(store, p);
      await flush();
      expect(deferreds).toHaveLength(lane.cap * 2); // +1 stays queued behind the cap
    });

    it(`${lane.name}: error → cooldown blocks re-drives → retry() re-arms and succeeds`, async () => {
      const StoreClass = await getStoreClass();
      const store = new StoreClass();
      store.setProfile(PERFORMANCE_PROFILES.network);
      const path = "/net/err.cr3";
      store.reset([path]);
      lane.setup?.(store);
      const deferreds = laneDeferreds(lane.cmd);

      lane.drive(store, path);
      await flush();
      expect(deferreds).toHaveLength(1);
      deferreds[0].reject(new Error("boom"));
      await flush();

      lane.drive(store, path); // inside the 1s backoff — must not fetch
      await flush();
      expect(deferreds).toHaveLength(1);

      store.retry(path); // clears the tier error (+ auto-requeues thumb/preview)
      lane.drive(store, path); // zoom/mid re-drive; thumb/preview no-op dedup
      await vi.waitUntil(() => deferreds.length === 2, { timeout: 2000 });
      deferreds[1].resolve(lane.buf());
      await vi.waitUntil(() => lane.isReady(store, path), { timeout: 2000 });
    });
  }

  // The grid lane's parity tests. Driven by RANGE, not by path — the store
  // owns the request, so the rule, the tombstone check and the two sentinels
  // live in one place. Same three invariants as every other lane, plus the
  // four that are this lane's alone.
  describe("grid thumb", () => {
    function makeGridThumbBuf(): ArrayBuffer {
      const header = JSON.stringify({ gridLen: 3, width: 512, height: 341 });
      const headerBytes = new TextEncoder().encode(header);
      const buf = new ArrayBuffer(4 + headerBytes.length + 3);
      new DataView(buf).setUint32(0, headerBytes.length, true);
      new Uint8Array(buf, 4, headerBytes.length).set(headerBytes);
      new Uint8Array(buf, 4 + headerBytes.length).set([0xff, 0xd8, 0x00]);
      return buf;
    }

    /** Records every invoke and defers ONLY `read_grid_thumb`; every other
     *  command answers with a valid frame, so the local profile's background
     *  machinery (thumb sweep, mid sweep) runs for real around the lane. */
    function sweepHarness() {
      const calls: { cmd: string; args: Record<string, unknown> }[] = [];
      const gridDeferreds: Deferred[] = [];
      vi.mocked(invoke).mockImplementation((cmd: unknown, args?: unknown) => {
        calls.push({ cmd: cmd as string, args: (args ?? {}) as Record<string, unknown> });
        if (cmd === "read_grid_thumb") {
          return new Promise<ArrayBuffer>((resolve, reject) => {
            gridDeferreds.push({ resolve, reject });
          });
        }
        if (cmd === "read_preview") return Promise.resolve(makePreviewBuf());
        if (cmd === "extract_thumbnail") return Promise.resolve(makeThumbnailBuf(60, 40));
        if (cmd === "read_mid") return Promise.resolve(makeMidBuf());
        if (cmd === "generate_mid") return Promise.resolve(true);
        return Promise.resolve(new ArrayBuffer(0));
      });
      const gens = () => calls.filter((c) => c.cmd === "generate_mid");
      return { calls, gridDeferreds, gens };
    }

    it("the idle mid sweep stands down for grid work and resumes when the lane drains", async () => {
      // The sweep holds both generation permits in ~450 ms jobs. While the
      // user is scrolling the contact sheet that starves the tier they are
      // actually looking at (~8 cells/s instead of ~50).
      const { gridDeferreds, gens } = sweepHarness();
      const StoreClass = await getStoreClass();
      const store = new StoreClass();
      store.setProfile(PERFORMANCE_PROFILES.local); // the sweep is local-only
      const paths = Array.from({ length: 6 }, (_, i) => `/s/${i}.cr3`);
      store.reset(paths);
      store.setNeedPxProvider(() => 1860); // 4K-class stage — the mid tier engages
      for (const p of paths) store.registerDisplay(p);
      store.registerWantFull(paths[0]); // its landing starts the background sweeps
      await flush();
      store.reevaluateMid();

      store.setGridCellW(400);
      store.setGridRange(0, 5); // 4 in flight (local cap), 2 queued
      await flush();
      expect(gridDeferreds.length).toBeGreaterThan(0);
      expect(gens()).toHaveLength(0);

      // Drain the lane — each landing pumps the sweep, which may now run.
      for (let i = 0; i < 10 && gridDeferreds.length > 0; i++) {
        for (const d of gridDeferreds.splice(0)) d.resolve(makeGridThumbBuf());
        await flush();
      }
      await vi.waitUntil(() => gens().length > 0, { timeout: 4000 });
    });

    /** A network-profile store with the grid open at a cell width the rule
     *  wants. `mount` registers a display ref for every path: the store only
     *  asks for cells that are actually MOUNTED (what a rendered GridCell
     *  does through useImage's effect), so a test that expects a fetch has to
     *  mount its cells. The window tests pass false and mount their own. */
    async function armed(paths: string[], mount = true) {
      const StoreClass = await getStoreClass();
      const store = new StoreClass();
      store.setProfile(PERFORMANCE_PROFILES.network); // gridThumbConcurrency 1
      store.reset(paths);
      if (mount) for (const p of paths) store.registerDisplay(p);
      store.setGridCellW(400); // (400 − 18) × 1 = 382 > 160
      return store;
    }

    /** The paths `read_grid_thumb` was called for, in call order. */
    const askedFor = () =>
      vi
        .mocked(invoke)
        .mock.calls.filter((c) => c[0] === "read_grid_thumb")
        .map((c) => (c[1] as { path: string }).path);

    it("asks only for cells that are actually mounted — a filtered range is mostly holes", async () => {
      // Under a filter GridView reports the min..max ABSOLUTE index of the
      // cells it rendered, so a 300-of-2,726 filter spans ~1,000 indices that
      // render nothing. Requesting those costs a head read and a generation
      // each, for frames nobody can see.
      vi.useFakeTimers();
      try {
        const paths = Array.from({ length: 10 }, (_, i) => `/f/${i}.cr3`);
        const StoreClass = await getStoreClass();
        const store = new StoreClass();
        store.setProfile(PERFORMANCE_PROFILES.local); // cap 4 — all three may start
        store.reset(paths);
        store.setGridCellW(400);
        laneDeferreds("read_grid_thumb");
        for (const i of [0, 4, 9]) store.registerDisplay(paths[i]);

        store.setGridRange(0, 9);
        await flush();
        expect(askedFor()).toEqual([paths[0], paths[4], paths[9]]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("a new range REPLACES the queue: a scrollbar drag never serves the cells it flew past", async () => {
      const paths = Array.from({ length: 20 }, (_, i) => `/q/${i}.cr3`);
      const store = await armed(paths); // network profile: one at a time
      const deferreds = laneDeferreds("read_grid_thumb");

      store.setGridRange(0, 4);
      await flush();
      expect(askedFor()).toEqual([paths[0]]); // one in flight, the rest queued

      store.setGridRange(10, 14); // the drag moves on before any of those start
      await flush();
      deferreds[0].resolve(makeGridThumbBuf()); // the in-flight cell lands
      await flush();
      // The next read is a cell on screen, not one the user scrolled past.
      expect(askedFor()[1]).toBe(paths[10]);

      // And leaving the grid stops the tier dead: no landing can arrive for a
      // cell that is no longer mounted anywhere.
      store.clearGridRange();
      for (const d of deferreds.splice(1)) d.resolve(makeGridThumbBuf());
      await flush();
      expect(askedFor()).toHaveLength(2);
    });

    it("single-flight — re-reporting the same range never duplicates the fetch", async () => {
      const store = await armed(["/net/a.cr3"]);
      const deferreds = laneDeferreds("read_grid_thumb");
      store.setGridRange(0, 0);
      store.setGridRange(0, 0);
      await flush();
      expect(deferreds).toHaveLength(1);
      deferreds[0].resolve(makeGridThumbBuf());
      await vi.waitUntil(() => store.snapshot("/net/a.cr3").gridThumbUrl !== undefined);
      store.setGridRange(0, 0);
      await flush();
      expect(deferreds).toHaveLength(1);
    });

    it("stale completion is gen-scoped — nothing leaks, the blob is revoked", async () => {
      const store = await armed(["/old/0.cr3"]);
      const deferreds = laneDeferreds("read_grid_thumb");
      store.setGridRange(0, 0);
      await flush();
      expect(deferreds).toHaveLength(1);
      store.hardReset();
      deferreds[0].resolve(makeGridThumbBuf());
      await flush();
      expect(store.snapshot("/old/0.cr3").gridThumbUrl).toBeUndefined();
      expect(liveUrls.size).toBe(0);
    });

    it("error → cooldown blocks re-requests → retry() re-arms", async () => {
      const store = await armed(["/net/err.cr3"]);
      const deferreds = laneDeferreds("read_grid_thumb");
      store.setGridRange(0, 0);
      await flush();
      deferreds[0].reject(new Error("boom"));
      await flush();
      store.setGridRange(0, 0);
      await flush();
      expect(deferreds).toHaveLength(1);
      // retry() alone must re-arm: the failed read left the lane's queue and
      // its request marker behind it, so the range is deliberately NOT
      // re-reported here — a bare pump() would find nothing to do.
      store.retry("/net/err.cr3");
      await vi.waitUntil(() => deferreds.length === 2, { timeout: 2000 });
      deferreds[1].resolve(makeGridThumbBuf());
      await vi.waitUntil(() => store.snapshot("/net/err.cr3").gridThumbUrl !== undefined);
    });

    it("the rule gates the lane: a cell the THMB already covers asks for nothing", async () => {
      const store = await armed(["/net/a.cr3"]);
      store.setGridCellW(120); // (120 − 18) × 1 = 102 ≤ 160
      const deferreds = laneDeferreds("read_grid_thumb");
      store.setGridRange(0, 0);
      await flush();
      expect(deferreds).toHaveLength(0);
    });

    it("the UNAVAILABLE sentinel latches per path: one miss, then never again", async () => {
      const store = await armed(["/net/noprvw.cr3"]);
      const deferreds = laneDeferreds("read_grid_thumb");
      store.setGridRange(0, 0);
      await flush();
      deferreds[0].reject(new Error("grid thumb unavailable (no preview)"));
      await flush();
      // No error recorded, no cooldown to expire, and no second request ever.
      store.setGridRange(0, 0);
      store.setGridCellW(500);
      await flush();
      expect(deferreds).toHaveLength(1);
      expect(store.snapshot("/net/noprvw.cr3").gridThumbUrl).toBeUndefined();
      // The THMB underneath is untouched — the cell simply keeps showing it.
      expect(store.snapshot("/net/noprvw.cr3").stage).toBe("shimmer");

      // THE BITE: a cooldown would also have blocked the re-reports above, so
      // discriminate the LATCH — retry() wipes every tier cooldown and
      // re-requests the visible range, and this path must still not be asked
      // for. The sentinel is a fact about the file; no retry can change it.
      store.retry("/net/noprvw.cr3");
      await flush();
      expect(deferreds).toHaveLength(1);
      store.setGridRange(0, 0);
      await flush();
      expect(deferreds).toHaveLength(1);
      expect(store.debugStats().gridThumb.unavailable).toBe(1);
    });

    it("the PENDING sentinel does NOT latch: a cooldown, then the tier asks again by itself", async () => {
      // The backend's MidGen pending set is shared with the whole-shoot mid
      // sweep, so this bounce is common. Latching it would strand the cell on
      // the soft THMB for the session — the bug this sentinel exists to avoid.
      vi.useFakeTimers();
      try {
        const store = await armed(["/net/busy.cr3"]);
        const deferreds = laneDeferreds("read_grid_thumb");
        store.setGridRange(0, 0);
        await flush();
        deferreds[0].reject(new Error("grid thumb pending"));
        await flush();

        // Inside the backoff: no re-fetch (a cooldown, not a latch).
        store.setGridRange(0, 0);
        await flush();
        expect(deferreds).toHaveLength(1);

        // And nobody has to scroll for it: the bounce armed ONE timer for its
        // own backoff, which re-runs the visible range when it fires.
        await vi.advanceTimersByTimeAsync(2000);
        await flush();
        expect(deferreds).toHaveLength(2);
        deferreds[1].resolve(makeGridThumbBuf());
        await flush();
        expect(store.snapshot("/net/busy.cr3").gridThumbUrl).toBeDefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it("staggered pending bounces are BOTH re-asked: the timer re-arms for the next one due", async () => {
      // One deduped timer armed on the FIRST bounce is not enough: B bounces
      // later, so its cooldown outlives that timer, and the fire that saves A
      // skips B. Nothing then asks for B until the user happens to scroll.
      vi.useFakeTimers();
      try {
        const paths = ["/net/a.cr3", "/net/b.cr3"];
        const StoreClass = await getStoreClass();
        const store = new StoreClass();
        store.setProfile(PERFORMANCE_PROFILES.local); // cap 4: both read at once
        store.reset(paths);
        for (const p of paths) store.registerDisplay(p);
        store.setGridCellW(400);
        const deferreds = laneDeferreds("read_grid_thumb");
        store.setGridRange(0, 1);
        await flush();
        expect(deferreds).toHaveLength(2);
        // A bounces now; B bounces 600 ms later, so its backoff ends later too.
        deferreds[0].reject(new Error("grid thumb pending"));
        await flush();
        await vi.advanceTimersByTimeAsync(600);
        deferreds[1].reject(new Error("grid thumb pending"));
        await flush();

        // No range is EVER re-reported from here on — the store must recover
        // both cells on its own.
        await vi.advanceTimersByTimeAsync(5000);
        await flush();
        const asked = askedFor();
        expect(asked.filter((p) => p === "/net/a.cr3").length).toBeGreaterThanOrEqual(2);
        expect(asked.filter((p) => p === "/net/b.cr3").length).toBeGreaterThanOrEqual(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("a pending bounce never goes terminal: a cell that loses four races still recovers", async () => {
      // recordTierError bumps `attempts`, and at MAX_TIER_ATTEMPTS inCooldown
      // is true forever. For a real failure that is the point; for a pending
      // bounce it would strand the cell on the soft THMB for the session.
      vi.useFakeTimers();
      try {
        const store = await armed(["/net/busy.cr3"]);
        const deferreds = laneDeferreds("read_grid_thumb");
        store.setGridRange(0, 0);
        await flush();
        // Five bounces — one more than MAX_TIER_ATTEMPTS (4).
        for (let i = 0; i < 5; i++) {
          expect(deferreds).toHaveLength(i + 1);
          deferreds[i].reject(new Error("grid thumb pending"));
          await flush();
          await vi.advanceTimersByTimeAsync(40_000); // past the backoff cap
          await flush();
        }
        // Still asking, and a success still lands.
        expect(deferreds).toHaveLength(6);
        deferreds[5].resolve(makeGridThumbBuf());
        await flush();
        expect(store.snapshot("/net/busy.cr3").gridThumbUrl).toBeDefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it("nothing is fetched after reset()/hardReset(), however long the pending timer waits", async () => {
      // Honest note: this pins the CONTRACT, it does not discriminate one
      // guard. Three independent things hold it — the teardown disarms the
      // timer, the callback re-checks the generation, and the range it would
      // re-run is -1/-1 after a session change. Removing any one (or even
      // two) still leaves nothing fetched. Kept because the contract is what
      // a future change must not break.
      vi.useFakeTimers();
      try {
        for (const teardown of ["reset", "hardReset"] as const) {
          const store = await armed(["/net/busy.cr3"]);
          const deferreds = laneDeferreds("read_grid_thumb");
          store.setGridRange(0, 0);
          await flush();
          deferreds[0].reject(new Error("grid thumb pending"));
          await flush();

          if (teardown === "reset") store.reset(["/net/busy.cr3"]);
          else store.hardReset();
          await vi.advanceTimersByTimeAsync(10_000);
          await flush();
          expect(deferreds).toHaveLength(1);
        }
      } finally {
        vi.useRealTimers();
      }
    });

    it("a pending bounce never counts as an error or trips the folder-unreachable chip", async () => {
      // On the local profile the idle mid sweep holds the same generation
      // claim, so a scrolling user bounces off it constantly. Routed through
      // noteTierError those bounces would count errors and — four terminal
      // paths later — raise "folder unreachable" on a perfectly healthy
      // folder, from a tier that shows no errors at all.
      vi.useFakeTimers();
      try {
        const paths = Array.from({ length: 4 }, (_, i) => `/net/p${i}.cr3`);
        const store = await armed(paths);
        const trouble = vi.fn();
        store.setTroubleSink(trouble);
        const deferreds = laneDeferreds("read_grid_thumb");
        // Bounce every path its full MAX_TIER_ATTEMPTS (4) — exactly the shape
        // that latches the chip when a tier reports real failures. Bounded so
        // a regression cannot spin here.
        for (let round = 0; round < 40; round++) {
          store.setGridRange(0, paths.length - 1);
          await flush();
          const batch = deferreds.splice(0);
          if (batch.length === 0) break;
          for (const d of batch) d.reject(new Error("grid thumb pending"));
          await flush();
          await vi.advanceTimersByTimeAsync(40_000); // past the backoff cap
        }

        expect(trouble).not.toHaveBeenCalled();
        expect(store.debugStats().counts.errors).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    // Both landing tests run on fake timers: reset() arms a 2 s background-fill
    // fallback, and a store left holding a REAL one keeps issuing thumb reads
    // into whichever test is running two seconds later (it polluted this
    // file's later read counts). Neither test needs the wall clock.
    it("a path forgotten mid-flight drops its landing: the fresh blob is revoked, nothing cached", async () => {
      vi.useFakeTimers();
      try {
        const store = await armed(["/net/a.cr3", "/net/b.cr3"]);
        const deferreds = laneDeferreds("read_grid_thumb");
        store.setGridRange(0, 1);
        await flush();
        // The read is already in flight when the Move takes the frame away —
        // the entry guard cannot help here; the landing site has to.
        store.forget(new Set(["/net/a.cr3"]));
        deferreds[0].resolve(makeGridThumbBuf());
        await flush();
        expect(liveUrls.size).toBe(0);
        expect(store.snapshot("/net/a.cr3").gridThumbUrl).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it("a forgotten path's ERROR landing records nothing: no tier error, no latch, no trouble", async () => {
      vi.useFakeTimers();
      try {
        const store = await armed(["/net/a.cr3", "/net/b.cr3"]);
        const trouble = vi.fn();
        store.setTroubleSink(trouble);
        const deferreds = laneDeferreds("read_grid_thumb");
        store.setGridRange(0, 1);
        await flush();
        store.forget(new Set(["/net/a.cr3"]));
        // A moved file's read usually ends here, and "no preview" is exactly
        // what a gone file looks like — latching it would be a lie about a
        // frame that no longer exists.
        deferreds[0].reject(new Error("grid thumb unavailable (no preview)"));
        await flush();
        expect(store.debugStats().counts.errors).toBe(0);
        expect(store.debugStats().gridThumb.unavailable).toBe(0);
        expect(trouble).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("eviction follows the GRID RANGE, and leaving the grid frees everything", async () => {
      const paths = Array.from({ length: 400 }, (_, i) => `/win/${i}.cr3`);
      const store = await armed(paths, false); // mount cell 0 only, by hand
      const deferreds = laneDeferreds("read_grid_thumb");
      store.registerDisplay(paths[0]);
      store.setGridRange(0, 0);
      await flush();
      deferreds[0].resolve(makeGridThumbBuf());
      await vi.waitUntil(() => store.snapshot(paths[0]).gridThumbUrl !== undefined);
      // The cell scrolls off and unmounts, which is what makes its blob
      // evictable at all — a mounted one is protected (the next test).
      store.unregisterDisplay(paths[0]);

      store.setGridRange(100, 110); // inside gridThumbKeep (120) — survives
      expect(store.snapshot(paths[0]).gridThumbUrl).toBeDefined();
      store.setGridRange(300, 310); // far outside — evicted
      expect(store.snapshot(paths[0]).gridThumbUrl).toBeUndefined();
      expect(liveUrls.size).toBe(0);
    });

    it("a mounted cell's displayRef protects its blob even outside the window", async () => {
      const paths = Array.from({ length: 400 }, (_, i) => `/win/${i}.cr3`);
      const store = await armed(paths, false);
      const deferreds = laneDeferreds("read_grid_thumb");
      // The one mounted cell: the same ref that makes it fetchable is the one
      // that protects its blob once the window has moved on.
      store.registerDisplay(paths[0]);
      store.setGridRange(0, 0);
      await flush();
      deferreds[0].resolve(makeGridThumbBuf());
      await vi.waitUntil(() => store.snapshot(paths[0]).gridThumbUrl !== undefined);
      store.setGridRange(300, 310);
      expect(store.snapshot(paths[0]).gridThumbUrl).toBeDefined();
      store.unregisterDisplay(paths[0]);
      store.setGridRange(301, 311);
      expect(store.snapshot(paths[0]).gridThumbUrl).toBeUndefined();
    });
  });

  // Windowed eviction parity for the three cursor-windowed lanes (the thumb
  // LRU's protection is pinned by the existing displayRef test above). Each
  // lane's OWN protection class must hold, and releasing it must evict.
  const WINDOWED: {
    lane: Lane;
    protect: (s: Store, p: string) => void;
    release: (s: Store, p: string) => void;
  }[] = [
    {
      lane: LANES[1], // nav preview — wantFull refcount protects
      protect: (s, p) => s.registerWantFull(p),
      release: (s, p) => s.unregisterWantFull(p),
    },
    {
      lane: LANES[2], // zoom — pins protect
      protect: (s, p) => s.pinFull(p),
      release: (s, p) => s.unpinFull(p),
    },
    {
      lane: LANES[3], // mid — displayRefs protect
      protect: (s, p) => s.registerDisplay(p),
      release: (s, p) => s.unregisterDisplay(p),
    },
  ];

  for (const { lane, protect, release } of WINDOWED) {
    it(`${lane.name}: far-cursor eviction respects the lane's protection class; releasing evicts`, async () => {
      const StoreClass = await getStoreClass();
      const store = new StoreClass();
      store.setProfile(PERFORMANCE_PROFILES.network);
      const paths = Array.from({ length: 200 }, (_, i) => `/win/${i}.cr3`);
      store.reset(paths);
      lane.setup?.(store);
      const deferreds = laneDeferreds(lane.cmd);

      lane.drive(store, paths[0]);
      await flush();
      deferreds[0].resolve(lane.buf());
      await vi.waitUntil(() => lane.isReady(store, paths[0]), { timeout: 2000 });

      // The nav-preview drive itself holds wantFull — drop the drive's own
      // ref so protection is exactly what `protect` adds below.
      if (lane.name === "nav preview") store.unregisterWantFull(paths[0]);

      protect(store, paths[0]);
      store.setCursor(150); // far outside previewKeep(60) and fullKeep(2)
      expect(lane.isReady(store, paths[0])).toBe(true); // protected — survives

      release(store, paths[0]);
      store.setCursor(151);
      expect(lane.isReady(store, paths[0])).toBe(false); // released — revoked
    });
  }
});

describe("forget (frames that left the session after Move rejects)", () => {
  it("drops gone paths, revokes their blobs, keeps survivors reference-stable and the cursor on its frame", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockImplementation((cmd: unknown) =>
      cmd === "extract_thumbnail"
        ? Promise.resolve(makeThumbnailBuf(800, 600))
        : Promise.resolve(makeBundleBuf()),
    );
    const Store = await getStoreClass();
    const store = new Store();
    const [a, b, c] = ["/f/a.cr3", "/f/b.cr3", "/f/c.cr3"];
    store.reset([a, b, c]);
    for (const p of [a, b, c]) store.requestThumbFor(p);
    await vi.waitUntil(() => [a, b, c].every((p) => store.snapshot(p).thumbUrl !== undefined), {
      timeout: 2000,
    });
    const bUrl = store.snapshot(b).thumbUrl!;
    const aSnap = store.snapshot(a);
    store.setCursor(2); // parked on c

    store.forget(new Set([b]));

    expect(store.snapshot(a)).toBe(aSnap); // survivor untouched
    expect(liveUrls.has(bUrl)).toBe(false); // gone blob revoked
    expect(store.snapshot(b).thumbUrl).toBeUndefined();
    expect(store.debugStats().caches.thumbs).toBe(2);
    expect(store.debugStats().cursor).toBe(1); // still on c, now index 1
  });

  it("clamps the cursor when its own frame is gone and ignores unknown paths", async () => {
    const Store = await getStoreClass();
    const store = new Store();
    const [a, b, c] = ["/g/a.cr3", "/g/b.cr3", "/g/c.cr3"];
    store.reset([a, b, c]);
    store.setCursor(2);
    store.forget(new Set([c, "/g/not-in-session.cr3"]));
    expect(store.debugStats().cursor).toBe(1);
    store.forget(new Set<string>()); // no-op
    expect(store.debugStats().cursor).toBe(1);
  });

  it("clears the decode pool when forget() empties the session (reject-all cull)", async () => {
    const mockInvoke = vi.mocked(invoke);
    mockInvoke.mockImplementation((cmd) => {
      if (cmd === "read_preview") return Promise.resolve(makePreviewBuf());
      if (cmd === "extract_thumbnail") return Promise.resolve(makeThumbnailBuf(60, 40));
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
    const paths = Array.from({ length: 10 }, (_, i) => `/f/${i}.cr3`);
    store.reset(paths);

    store.setCursor(4); // ±1 prefetch fetches 3 and 5
    await vi.waitUntil(() => store.snapshot("/f/5.cr3").stage === "full");
    await flush();
    // The landed previews inside the band are being held decoded.
    expect(poolImages.some((i) => i.src.startsWith("blob:"))).toBe(true);

    // Reject-all: every path leaves the session in one forget() call, so
    // setCursor's own refreshPool bails early on the now-empty path list —
    // forget() must drop the pool's decoded rasters itself.
    store.forget(new Set(paths));
    expect(poolImages.every((i) => i.src === "")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Metadata batching (Phase 2 Optimize, Task 2). Every landed thumb used to hand
// React its own delivery; the store now coalesces a 100 ms window's worth into one
// sink call. These build their OWN ImageStore with a manual flush scheduler so
// the window closes on demand — the singleton-based tests above are untouched.
// ─────────────────────────────────────────────────────────────────────────────
describe("imageStore — metadata batching", () => {
  /** Two paths whose thumbs land with metadata, the flush window still open. */
  async function twoLandedThumbs() {
    vi.mocked(invoke).mockImplementation((cmd) =>
      cmd === "extract_thumbnail"
        ? Promise.resolve(makeThumbnailBuf(800, 600, { iso: 100 }))
        : Promise.resolve(new ArrayBuffer(0)),
    );
    const { scheduler, flushWindow } = manualScheduler();
    const Store = await getStoreClass();
    const store = new Store({ flushScheduler: scheduler });
    const sink = makeSink();
    store.setMetaSink(sink);
    const paths = ["/m/a.cr3", "/m/b.cr3"];
    store.reset(paths);
    for (const p of paths) store.requestThumbFor(p);
    await vi.waitUntil(() => paths.every((p) => store.snapshot(p).stage === "thumb"));
    await flush();
    return { store, sink, flushWindow, paths };
  }

  it("coalesces two thumb landings into one sink call, only once the window closes", async () => {
    const { sink, flushWindow, paths } = await twoLandedThumbs();

    expect(sink).not.toHaveBeenCalled();
    flushWindow();

    expect(sink).toHaveBeenCalledTimes(1);
    expect([...sink.mock.calls[0][0].keys()]).toEqual(paths);
  });

  it("hardReset drops the pending batch — the sink never sees the old session", async () => {
    const { store, sink, flushWindow } = await twoLandedThumbs();

    store.hardReset();
    flushWindow();

    expect(sink).not.toHaveBeenCalled();
  });

  it("forget drops the pending delivery for a path that left the session", async () => {
    const { store, sink, flushWindow, paths } = await twoLandedThumbs();

    store.forget(new Set([paths[0]]));
    flushWindow();

    expect(sink).toHaveBeenCalledTimes(1);
    expect([...sink.mock.calls[0][0].keys()]).toEqual([paths[1]]);
  });

  it("reset KEEPS the pending batch — thumbs survive it, so their metadata must too", async () => {
    const { store, sink, flushWindow, paths } = await twoLandedThumbs();

    store.reset(paths);
    flushWindow();

    expect(sink).toHaveBeenCalledTimes(1);
    expect([...sink.mock.calls[0][0].keys()]).toEqual(paths);
  });

  it("pendingMetaFor delegates to the batcher's peek (the zoom-origin read only)", async () => {
    const { store, paths } = await twoLandedThumbs();

    expect(store.pendingMetaFor(paths[0])).toMatchObject({ iso: 100 });
    expect(store.pendingMetaFor("/m/nope.cr3")).toBeUndefined();
  });

  it("pendingMetaFor still sees the entry after reset() — reset deliberately keeps the queue", async () => {
    const { store, paths } = await twoLandedThumbs();

    store.reset(paths);

    expect(store.pendingMetaFor(paths[0])).toMatchObject({ iso: 100 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tombstones (Phase 2 Optimize, Task 3). `forget()` prunes a moved frame from
// the live session without a generation bump, so a tier read already in flight
// for it still matched the lane's generation and LANDED: it re-created the
// tier record (a stray blob waiting for the next eviction sweep) and pushed the
// moved path's metadata back into React. Each landing site now checks the
// tombstone set and drops the arrival the way a stale generation does — on the
// SUCCESS path and, since the moved file is gone, on the ERROR path too (which
// is the likelier landing: the read ends in ENOENT).
// ─────────────────────────────────────────────────────────────────────────────
describe("imageStore — reads in flight for a forgotten path", () => {
  const PATH = "/t/a.cr3";

  // The error-landing tests drive the retry backoff, so they run on fake
  // timers; restore real ones whatever the test did.
  afterEach(() => {
    vi.useRealTimers();
  });

  /** The frame that survives the prune in the tests that need one. */
  const SURVIVOR = "/t/b.cr3";

  /** A session with every read deferred and the metadata flush manual.
   *  One path unless a test needs a survivor to check the tier on. */
  async function stagedStore(paths: string[] = [PATH]) {
    const deferreds = deferredInvoke(vi.mocked(invoke));
    const { scheduler, flushWindow } = manualScheduler();
    const Store = await getStoreClass();
    const store = new Store({ flushScheduler: scheduler });
    const sink = makeSink();
    store.setMetaSink(sink);
    // Network profile: no local mid-generation sweep firing extra reads.
    store.setProfile(PERFORMANCE_PROFILES.network);
    store.reset(paths);
    return { store, sink, flushWindow, deferreds };
  }

  /** Backend reads of one command issued so far — a re-read of a moved file
   *  is the harm the error-landing tombstone prevents. */
  const readsOf = (cmd: string) => vi.mocked(invoke).mock.calls.filter((c) => c[0] === cmd).length;

  it("drops a thumb landing: blob revoked, no cache entry, no metadata delivery", async () => {
    const { store, sink, flushWindow, deferreds } = await stagedStore();
    store.requestThumbFor(PATH);
    expect(deferreds).toHaveLength(1); // the read is in flight

    store.forget(new Set([PATH]));
    deferreds[0].resolve(makeThumbnailBuf(800, 600, { iso: 100 }));
    await flush();

    expect(liveUrls.size).toBe(0); // the freshly created blob was revoked
    expect(store.debugStats().caches.thumbs).toBe(0);
    expect(store.snapshot(PATH).thumbUrl).toBeUndefined();
    flushWindow();
    expect(sink).not.toHaveBeenCalled();
  });

  it("drops a nav landing: preview blob revoked, no cache entry, no metadata delivery", async () => {
    const { store, sink, flushWindow, deferreds } = await stagedStore();
    store.registerWantFull(PATH);
    expect(deferreds).toHaveLength(1);

    store.forget(new Set([PATH]));
    deferreds[0].resolve(makePreviewBuf());
    await flush();

    expect(liveUrls.size).toBe(0);
    expect(store.debugStats().caches.previews).toBe(0);
    expect(store.snapshot(PATH).url).toBeUndefined();
    flushWindow();
    expect(sink).not.toHaveBeenCalled();
  });

  it("drops a zoom landing: the ~10 MB blob is revoked, not cached", async () => {
    const { store, deferreds } = await stagedStore();
    store.requestZoomFull(PATH);
    expect(deferreds).toHaveLength(1);

    store.forget(new Set([PATH]));
    deferreds[0].resolve(makeFullresBuf());
    await flush();

    expect(liveUrls.size).toBe(0);
    expect(store.debugStats().caches.zoomFulls).toBe(0);
  });

  it("drops a mid landing: the blob is revoked, not cached", async () => {
    const { store, deferreds } = await stagedStore();
    store.setNeedPxProvider(() => 1860); // 4K-class stage — the mid tier engages
    store.maybeRequestMid(PATH);
    expect(deferreds).toHaveLength(1);

    store.forget(new Set([PATH]));
    deferreds[0].resolve(makeMidBuf());
    await flush();

    expect(liveUrls.size).toBe(0);
    expect(store.snapshot(PATH).mid).toBeUndefined();
  });

  it("drops a thumb ERROR landing: no failure recorded, no bg re-queue, no re-read", async () => {
    vi.useFakeTimers();
    const { store, deferreds } = await stagedStore();
    const trouble = vi.fn();
    store.setTroubleSink(trouble);
    store.requestThumbFor(PATH);
    expect(deferreds).toHaveLength(1);

    store.forget(new Set([PATH]));
    deferreds[0].reject(new Error("ENOENT: no such file or directory"));
    await flush();
    // Long past the 1 s first backoff: the bg retry would re-read a file the
    // Move already took away.
    await vi.advanceTimersByTimeAsync(10_000);

    expect(readsOf("extract_thumbnail")).toBe(1);
    expect(store.debugStats().counts.errors).toBe(0);
    expect(trouble).not.toHaveBeenCalled();
  });

  it("drops a nav ERROR landing: no error state, no scheduled retry, no re-read", async () => {
    vi.useFakeTimers();
    const { store, deferreds } = await stagedStore();
    store.registerWantFull(PATH); // the wantFull that scheduleFullRetry checks
    expect(deferreds).toHaveLength(1);

    store.forget(new Set([PATH]));
    deferreds[0].reject(new Error("ENOENT: no such file or directory"));
    await flush();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(readsOf("read_preview")).toBe(1);
    expect(store.snapshot(PATH).error).toBeUndefined();
    expect(store.debugStats().counts.errors).toBe(0);
  });

  it("drops a mid ERROR landing: a moved file's 'not found' never dormants the tier", async () => {
    const { store, deferreds } = await stagedStore([PATH, SURVIVOR]);
    store.setNeedPxProvider(() => 1860); // 4K-class stage — the mid tier engages
    store.maybeRequestMid(PATH);
    expect(readsOf("read_mid")).toBe(1);

    store.forget(new Set([PATH]));
    // What a moved file's mid read really reports. Untombstoned, "not found"
    // reads as "this backend has no read_mid" and latches midUnsupported —
    // one Move would leave every survivor on preview for the session.
    deferreds[0].reject(new Error("read_mid failed: not found"));
    await flush();

    store.maybeRequestMid(SURVIVOR);
    expect(readsOf("read_mid")).toBe(2); // the tier is still live
    expect(store.debugStats().counts.errors).toBe(0);
  });

  it("a whole rejected batch failing at once never latches the folder-unreachable chip", async () => {
    vi.useFakeTimers();
    const deferreds = deferredInvoke(vi.mocked(invoke));
    const Store = await getStoreClass();
    const store = new Store();
    const trouble = vi.fn();
    store.setTroubleSink(trouble);
    // 4 distinct paths — exactly the folder-trouble threshold, i.e. an
    // ordinary "Move rejects" of four frames.
    const paths = Array.from({ length: 4 }, (_, i) => `/t/r${i}.cr3`);
    store.reset(paths);
    for (const p of paths) store.requestThumbFor(p);

    store.forget(new Set(paths));
    // Reject every attempt the backoff schedule makes, the way a moved file
    // really would, until the store stops asking (bounded so a regression
    // can't spin here).
    for (let round = 0; round < 12 && deferreds.length > 0; round++) {
      for (const d of deferreds.splice(0)) d.reject(new Error("ENOENT"));
      await flush();
      await vi.advanceTimersByTimeAsync(40_000); // past the 30 s backoff cap
    }

    expect(trouble).not.toHaveBeenCalled();
    expect(store.debugStats().counts.errors).toBe(0);
  });

  it("a forgotten path's registerWantFull never starts a read_preview — it must not steal a nav-lane slot from the frame the user is on", async () => {
    const { store, deferreds } = await stagedStore();

    store.forget(new Set([PATH]));
    store.registerWantFull(PATH);
    await flush();

    expect(deferreds).toHaveLength(0);
    expect(readsOf("read_preview")).toBe(0);
  });

  it("a forgotten path's requestThumbFor never starts a thumb read", async () => {
    const { store, deferreds } = await stagedStore();

    store.forget(new Set([PATH]));
    store.requestThumbFor(PATH);
    await flush();

    expect(deferreds).toHaveLength(0);
    expect(readsOf("extract_thumbnail")).toBe(0);
  });

  it("a forgotten path's requestZoomFull never starts a read_fullres invoke", async () => {
    const { store, deferreds } = await stagedStore();

    store.forget(new Set([PATH]));
    store.requestZoomFull(PATH);
    await flush();

    expect(deferreds).toHaveLength(0);
    expect(readsOf("read_fullres")).toBe(0);
  });

  it("a forgotten path's requestMid never starts a read_mid invoke", async () => {
    const { store, deferreds } = await stagedStore();
    store.setNeedPxProvider(() => 1860); // 4K-class stage — the mid tier engages

    store.forget(new Set([PATH]));
    store.maybeRequestMid(PATH);
    await flush();

    expect(deferreds).toHaveLength(0);
    expect(readsOf("read_mid")).toBe(0);
  });

  it("rearm() does not re-queue a forgotten path whose in-flight read settled after the tombstone, but still re-queues a surviving wanted one", async () => {
    const { store, deferreds } = await stagedStore([PATH, SURVIVOR]);
    store.registerWantFull(PATH);
    store.registerWantFull(SURVIVOR);
    expect(deferreds).toHaveLength(2); // both nav reads in flight

    store.forget(new Set([PATH])); // Move rejects mid-flight — PATH is tombstoned
    deferreds[0].reject(new Error("ENOENT: no such file or directory")); // PATH's read lands after the tombstone
    deferreds[1].reject(new Error("ENOENT: no such file or directory")); // SURVIVOR fails normally, still wanted
    await flush();

    store.rearm();

    // Without the tombstone check, rearm() would re-arm PATH too (4 reads).
    expect(readsOf("read_preview")).toBe(3);
  });

  it("reset() clears the tombstones — a re-staged path loads normally again", async () => {
    const { store, deferreds } = await stagedStore();
    store.requestThumbFor(PATH);
    store.forget(new Set([PATH]));
    deferreds[0].resolve(makeThumbnailBuf(800, 600));
    await flush();
    expect(store.debugStats().caches.thumbs).toBe(0);

    store.reset([PATH]); // the folder is re-staged
    store.requestThumbFor(PATH);
    expect(deferreds).toHaveLength(2);
    deferreds[1].resolve(makeThumbnailBuf(800, 600));
    await flush();

    expect(store.snapshot(PATH).thumbUrl).toBeDefined();
    expect(store.debugStats().caches.thumbs).toBe(1);
  });
});

describe("timer hygiene", () => {
  // hardReset SILENCES timers by bumping the generation — every callback
  // re-checks `this.generation === gen` and bails. That is not CANCELLING
  // them: the handles stay armed, so the suite teardown at :66-70 is
  // architecturally incapable of seeing a leak. These tests assert the
  // stronger property, one armed path at a time.
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reset arms the background-fill fallback, and hardReset cancels it", async () => {
    vi.useFakeTimers();
    const Store = await getStoreClass();
    const store = new Store();
    store.reset(["/p/a.cr3"]);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    store.hardReset();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a failed thumb read arms a backoff retry, and hardReset cancels it", async () => {
    vi.useFakeTimers();
    vi.mocked(invoke).mockRejectedValue(new Error("nope"));
    const Store = await getStoreClass();
    const store = new Store();
    store.reset(["/p/a.cr3"]);
    // reset() itself already armed the bg-fill fallback — a bare
    // `toBeGreaterThan(0)` below would pass on that alone even if the
    // backoff never armed. Snapshot it first so the assertion is forced to
    // prove something ELSE got scheduled.
    const afterReset = vi.getTimerCount();
    store.requestThumbFor("/p/a.cr3");
    // Flush the rejection's promise chain without advancing the clock, so
    // the catch block gets to arm its backoff.
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBeGreaterThan(afterReset);
    store.hardReset();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a failed nav read's scheduled retry is cancelled by hardReset", async () => {
    vi.useFakeTimers();
    // Route by command: reject ONLY the nav read (read_preview). If every
    // command rejected (as a blanket mockRejectedValue would), the first nav
    // settle's afterSettle starts the bg-fill sweep, which would ALSO fail
    // its own thumb read for this path and arm ITS OWN backoff
    // (imageStore.ts:1413) — a confound that satisfies the count assertion
    // below even with scheduleFullRetry completely broken.
    vi.mocked(invoke).mockImplementation((cmd: unknown) =>
      cmd === "read_preview"
        ? Promise.reject(new Error("nope"))
        : Promise.resolve(makeThumbnailBuf(60, 40)),
    );
    const Store = await getStoreClass();
    const store = new Store();
    store.reset(["/p/a.cr3"]);
    // Same reasoning as the backoff test above: reset()'s own fallback timer
    // must not be what satisfies the assertion.
    const afterReset = vi.getTimerCount();
    store.registerWantFull("/p/a.cr3");
    await vi.advanceTimersByTimeAsync(0); // the read fails, the error is recorded
    // The SECOND registration is what hits `inCooldown` and schedules the
    // retry (imageStore.ts:1106-1110).
    store.registerWantFull("/p/a.cr3");
    expect(vi.getTimerCount()).toBeGreaterThan(afterReset);
    store.hardReset();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("no store timer survives hardReset after a session that armed several", async () => {
    vi.useFakeTimers();
    vi.mocked(invoke).mockRejectedValue(new Error("nope"));
    const Store = await getStoreClass();
    const store = new Store();
    store.reset(["/p/a.cr3", "/p/b.cr3"]);
    store.requestThumbFor("/p/a.cr3");
    store.registerWantFull("/p/b.cr3");
    await vi.advanceTimersByTimeAsync(0);
    store.registerWantFull("/p/b.cr3");
    expect(vi.getTimerCount()).toBeGreaterThan(1);
    store.hardReset();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reset() for a NEW folder also cancels the outgoing session's timers", async () => {
    vi.useFakeTimers();
    const Store = await getStoreClass();
    const store = new Store();
    store.reset(["/p/a.cr3"]);
    const first = vi.getTimerCount();
    store.reset(["/q/a.cr3"]);
    // One fallback armed by the new reset, not two — the old one is gone.
    expect(vi.getTimerCount()).toBe(first);
    store.hardReset();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("every timer in the store and the sweep is tracked, so hardReset can reach it", () => {
    const src = import.meta.glob<string>("./{imageStore,midSweep}.ts", {
      query: "?raw",
      eager: true,
      import: "default",
    });
    const store = src["./imageStore.ts"] ?? "";
    const sweep = src["./midSweep.ts"] ?? "";
    // The glob must have returned real text, or every assertion below is
    // satisfied by the empty string.
    expect(store).toContain("private later(");
    expect(sweep).toContain(`const MID_SWEEP_QUIET_MS`);

    // Comments are stripped from `store`/`sweep` first — a stray `setTimeout(`
    // mentioned in one of THEIR doc comments (not this file's) must not be
    // counted, or the assertion below fails with a cryptic off-by-one that
    // has nothing to do with an untracked timer. ANY receiver counts
    // (`window.setTimeout(`, `globalThis.setTimeout(`, a bare call, …) — the
    // old `(?<![.\w])` guard let a receiver-qualified call slip through
    // uncounted — and `setInterval(` counts too, since it is just as much an
    // escape from `later()`/the tracked `timer` field as `setTimeout` is.
    const stripComments = (s: string) =>
      s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const scheduleCalls = (s: string) =>
      [...stripComments(s).matchAll(/\bset(?:Timeout|Interval)\(/g)].length;
    const rule = (file: string) =>
      `${file}: every setTimeout/setInterval must schedule through later() ` +
      `(imageStore.ts) or the tracked \`timer\` field (midSweep.ts) — a bare, ` +
      `receiver-qualified, or setInterval call is an escape from that rule`;
    expect(scheduleCalls(store), rule("imageStore.ts")).toBe(2); // one inside `later`, one for the grid retry
    expect(store).toContain("this.gridThumbPendingRetry = setTimeout(");
    expect(store).toContain("private clearTimers(");
    expect(scheduleCalls(sweep), rule("midSweep.ts")).toBe(1);
    expect(sweep).toContain("this.timer = setTimeout(");
  });
});
