# Phase 2 — Optimize Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the per-image React churn on folder open (one App commit and one full burst/similar re-derivation per arriving thumbnail), make the top-level views bail out of renders they do not need, stop a mid-cull Move from wiping and re-running smart culling, and publish measured before/after numbers.

**Architecture:** Metadata deliveries are coalesced inside the image store by a small `MetaBatcher` (one flush per animation frame), so session resets and `forget()` own the pending queue where they already own every other per-path record. A dev-only render meter (React `<Profiler>` around `<App/>`, shown in the dev HUD) supplies the numbers. Everything else is local: `memo` on four views, hoisted status-bar prop groups, a tombstone set for moved paths, a pruned-subset check in the smart-culling hook.

**Tech Stack:** React 19, TypeScript 5.8 strict, Vitest 4 (node env; jsdom per file via `// @vitest-environment jsdom`), @testing-library/react 16, pnpm 10. No Rust changes in this phase.

**Spec:** `docs/superpowers/audits/2026-09-13-full-app-audit/reports/performance.md` (HIGH + MEDIUM + the progress-fill LOW), `audit.md` §6 "Phase 2", and the "Left for later phases → Phase 2" lists closing `2026-09-14-phase-0-safety.md` and `2026-09-14-phase-1-clean.md`.

## Global Constraints

- Branch `phase-2-optimize`, cut from `phase-1-clean` @ `107dd46`. Line numbers below are as of that commit; if they drifted, the symbol names win.
- Behaviour is unchanged except: metadata reaches React up to 100 ms later (written as "one animation frame" until the measurement re-ruled it; see the implementation note); a Move no longer resets smart-culling scores.
- No Rust changes. No new runtime dependencies. No `console.log`.
- Commits: conventional (`perf:`, `feat:`, `test:`, `refactor:`, `docs:`), **no attribution trailers**, and always pathspec form: `git commit -m "…" -- <files>`. Never `git add -A`, never a bare `git commit`.
- The repo's prettier hook may leave working-tree changes after a commit: content → a follow-up `style:` commit; line-endings only (empty `git diff`) → `git add <file>` to refresh.
- Gate for every task: `pnpm lint && pnpm typecheck && pnpm typecheck:tests && pnpm test`. Tasks touching CSS add `pnpm lint:css`. The final gate adds `pnpm build`.
- Subagents never launch the app, never touch `C:\Canon Media`, never send keys. Measurements (Task 7) are the controller's, only while the PC is idle, only on the hard-linked scratch copy, and never with a rating key.
- The plan's code is a draft: where it contradicts the code base, the code wins — report the contradiction.

## File Structure

| File | Role |
|---|---|
| `src/utils/renderMeter.ts` (new) | Commit/derive counter; pure factory + app singleton |
| `src/image/metaBatcher.ts` (new) | Per-frame coalescing of metadata deliveries |
| `src/smart/sessionIdentity.ts` (new) | `isPrunedSubset(prev, next)` |
| `src/utils/mergeMeta.ts` | gains `applyMetaBatch` |
| `src/image/imageStore.ts` | composes `MetaBatcher`; `forgotten` tombstones |
| `src/overlays/overlayService.ts` | gains `forget(paths)` |
| `src/app/useImageStoreWiring.ts` | batch sink |
| `src/app/useSessionLifecycle.ts` | meter reset; `overlayService.forget` in `pruneMoved` |
| `src/smart/useSmartCulling.ts` | survives a prune |
| `src/components/{ThumbStrip,CompareStrip,CompareView,ExifRail}.tsx` | `memo` |
| `src/App.tsx` | status-bar groups hoisted + memoized; DevHud leaves; progress transform |
| `src/main.tsx`, `src/components/DevHud.tsx` | Profiler + HUD row |
| `src/styles/chrome.css` | progress fill transitions `transform` |

Waves (disjoint file sets inside a wave): **A** = Task 1 · **B** = Tasks 2, 4, 6 in parallel · **C** = Tasks 3, 5 in parallel · **D** = Task 7 (controller).

---

### Task 1: Render meter in the dev HUD

**Files:**
- Create: `src/utils/renderMeter.ts`, `src/utils/renderMeter.test.ts`
- Modify: `src/main.tsx` (last line), `src/components/DevHud.tsx`, `src/App.tsx:346-353,1721` (remove `devHudOn` + the `<DevHud />` render + the import), `src/app/useSessionLifecycle.ts:476`, `src/app/useSmartDerivations.ts:57-60`

**Interfaces:**
- Produces: `createRenderMeter(now: () => number): RenderMeter`; `renderMeter` singleton; `RenderMeter = { record(ms: number): void; bumpDerive(): void; reset(): void; snapshot(): RenderMeterSnapshot }`; `RenderMeterSnapshot = { commits: number; totalMs: number; maxMs: number; derives: number; elapsedS: number }`.

- [ ] **Step 1: failing test** — `src/utils/renderMeter.test.ts`

```ts
import { describe, expect, test } from "vitest";
import { createRenderMeter } from "./renderMeter";

describe("createRenderMeter", () => {
  test("accumulates commits, total and max duration, and derives", () => {
    let t = 1000;
    const meter = createRenderMeter(() => t);
    meter.record(2.5);
    meter.record(7.25);
    meter.bumpDerive();
    t = 4000;
    expect(meter.snapshot()).toEqual({
      commits: 2,
      totalMs: 9.8,
      maxMs: 7.3,
      derives: 1,
      elapsedS: 3,
    });
  });

  test("reset zeroes the counters and restarts the clock", () => {
    let t = 0;
    const meter = createRenderMeter(() => t);
    meter.record(5);
    meter.bumpDerive();
    t = 9000;
    meter.reset();
    t = 10000;
    expect(meter.snapshot()).toEqual({ commits: 0, totalMs: 0, maxMs: 0, derives: 0, elapsedS: 1 });
  });
});
```

- [ ] **Step 2:** `pnpm vitest run src/utils/renderMeter.test.ts` → FAIL (module missing).

- [ ] **Step 3: implement** — `src/utils/renderMeter.ts`

```ts
/**
 * Dev-only render cost meter behind the dev HUD: how many React commits the
 * App tree made since the session began, what they cost, and how often the
 * burst/similar derivation chain re-ran. Fed by the <Profiler> in main.tsx
 * (dev builds only — React strips Profiler timing from production bundles,
 * where these stay at zero). Every Phase 2 claim cites these numbers.
 */
export type RenderMeterSnapshot = {
  commits: number;
  totalMs: number;
  maxMs: number;
  derives: number;
  elapsedS: number;
};

export type RenderMeter = {
  record: (actualMs: number) => void;
  bumpDerive: () => void;
  reset: () => void;
  snapshot: () => RenderMeterSnapshot;
};

const round1 = (n: number) => Math.round(n * 10) / 10;

export function createRenderMeter(now: () => number): RenderMeter {
  let commits = 0;
  let totalMs = 0;
  let maxMs = 0;
  let derives = 0;
  let since = now();
  return {
    record: (actualMs) => {
      commits++;
      totalMs += actualMs;
      if (actualMs > maxMs) maxMs = actualMs;
    },
    bumpDerive: () => {
      derives++;
    },
    reset: () => {
      commits = 0;
      totalMs = 0;
      maxMs = 0;
      derives = 0;
      since = now();
    },
    snapshot: () => ({
      commits,
      totalMs: round1(totalMs),
      maxMs: round1(maxMs),
      derives,
      elapsedS: Math.round((now() - since) / 1000),
    }),
  };
}

export const renderMeter = createRenderMeter(() => performance.now());
```

- [ ] **Step 4:** test passes.

- [ ] **Step 5: wire it.**
  - `src/main.tsx`: replace the final `render(<App />)` with the block below (add `import { Profiler } from "react"`, `DevHud`, `renderMeter` imports). The HUD moves OUT of App so its own 500 ms poll commits are not counted, and `VITE_CULL_DEVHUD=1` enables it without devtools (undefined in release builds).

```tsx
const devHudOn = (() => {
  if (import.meta.env.VITE_CULL_DEVHUD === "1") return true;
  try {
    return localStorage.getItem("cull:devhud") === "1";
  } catch {
    return false;
  }
})();

// No StrictMode: (keep the existing comment here)
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  devHudOn ? (
    <>
      <Profiler id="app" onRender={(_id, _phase, actualMs) => renderMeter.record(actualMs)}>
        <App />
      </Profiler>
      <DevHud />
    </>
  ) : (
    <App />
  ),
);
```

  - `src/App.tsx`: delete the `devHudOn` state (346-353), the `{devHudOn && <DevHud />}` line and the now-unused `DevHud` import. Check `src/styles/stage.css` `.cull-devhud`: it is `position: fixed` with its own font; if it inherits `color` from `.cull-app`, give it the same colour token explicitly so it looks the same mounted under `#root`.
  - `src/vite-env.d.ts` (or wherever `ImportMetaEnv` lives; create the interface if absent): `readonly VITE_CULL_DEVHUD?: string`.
  - `src/components/DevHud.tsx`: poll `renderMeter.snapshot()` in the same interval and add a row after the head row:

```tsx
<div className="cull-devhud__row">
  react&nbsp; commits {meter.commits} · Σ {meter.totalMs}ms · max {meter.maxMs}ms · derive{" "}
  {meter.derives} · {meter.elapsedS}s
</div>
```

  - `src/app/useSessionLifecycle.ts`: `renderMeter.reset();` on the line after `imageStore.reset(sorted.map((im) => im.path));`.
  - `src/app/useSmartDerivations.ts`: the `burstData` memo is an expression-bodied arrow; give it a block body whose first statement is `renderMeter.bumpDerive();` with the comment `// dev meter: one tick per full re-derivation (an integer increment; see renderMeter)`.

- [ ] **Step 6:** gate green. Commit: `feat(devhud): render meter — App commits, cost and derivation count`.

---

### Task 2: Batch metadata deliveries per frame

**Files:**
- Create: `src/image/metaBatcher.ts`, `src/image/metaBatcher.test.ts`
- Modify: `src/utils/mergeMeta.ts` (+ its test file), `src/image/imageStore.ts` (options type ~84, field ~247, `setMetaSink` ~518, `forget` ~621, `hardReset` ~703, landing sites ~1089 and ~1214), `src/image/imageStore.test.ts`, `src/app/useImageStoreWiring.ts:100-113`

**Interfaces:**
- Produces: `MetaBatch = ReadonlyMap<string, ImageMetadata>`; `MetaBatchSink = (batch: MetaBatch) => void`; `FrameScheduler = { request(cb: () => void): number; cancel(handle: number): void }`; `class MetaBatcher { setSink; push(path, meta); forget(gone: ReadonlySet<string>); clear() }`; `applyMetaBatch(prev, batch)`; `imageStore.setMetaSink(sink: MetaBatchSink | undefined)`; `ImageStoreOptions.frameScheduler?: FrameScheduler`.

- [ ] **Step 1: failing tests** — `src/image/metaBatcher.test.ts`

```ts
import { describe, expect, test, vi } from "vitest";
import { MetaBatcher, type FrameScheduler, type MetaBatch } from "./metaBatcher";
import type { ImageMetadata } from "../types";

function manualScheduler() {
  let queued: (() => void) | null = null;
  const scheduler: FrameScheduler = {
    request: (cb) => {
      queued = cb;
      return 1;
    },
    cancel: () => {
      queued = null;
    },
  };
  return { scheduler, frame: () => queued?.(), hasFrame: () => queued !== null };
}
// EMPTY_METADATA is a private const of useSessionLifecycle - copy the full-field
// meta(over) helper from src/utils/mergeMeta.test.ts:6-29 here instead of this line:
declare function meta(over?: Partial<ImageMetadata>): ImageMetadata;
// Typed spy: a bare vi.fn() types mock.calls as any[][] and fails the
// no-unsafe-* lint rules that stay on for test files.
const makeSink = () => vi.fn((_batch: MetaBatch) => {});

describe("MetaBatcher", () => {
  test("coalesces many deliveries into one sink call per frame", () => {
    const { scheduler, frame } = manualScheduler();
    const sink = makeSink();
    const b = new MetaBatcher(scheduler);
    b.setSink(sink);
    b.push("/a.CR3", meta({ iso: 100 }));
    b.push("/b.CR3", meta({ iso: 200 }));
    expect(sink).not.toHaveBeenCalled();
    frame();
    expect(sink).toHaveBeenCalledTimes(1);
    expect([...sink.mock.calls[0][0].keys()]).toEqual(["/a.CR3", "/b.CR3"]);
  });

  test("two deliveries for one path in a frame keep the carry-forward fields", () => {
    const { scheduler, frame } = manualScheduler();
    const sink = makeSink();
    const b = new MetaBatcher(scheduler);
    b.setSink(sink);
    b.push("/a.CR3", meta({ phash: "abc" }));
    b.push("/a.CR3", meta({ phash: null, iso: 400 }));
    frame();
    expect(sink.mock.calls[0][0].get("/a.CR3")).toMatchObject({ phash: "abc", iso: 400 });
  });

  test("forget drops pending entries for gone paths", () => {
    const { scheduler, frame } = manualScheduler();
    const sink = makeSink();
    const b = new MetaBatcher(scheduler);
    b.setSink(sink);
    b.push("/a.CR3", meta({}));
    b.push("/b.CR3", meta({}));
    b.forget(new Set(["/a.CR3"]));
    frame();
    expect([...sink.mock.calls[0][0].keys()]).toEqual(["/b.CR3"]);
  });

  test("clear cancels the frame and delivers nothing", () => {
    const { scheduler, frame, hasFrame } = manualScheduler();
    const sink = makeSink();
    const b = new MetaBatcher(scheduler);
    b.setSink(sink);
    b.push("/a.CR3", meta({}));
    b.clear();
    expect(hasFrame()).toBe(false);
    frame();
    expect(sink).not.toHaveBeenCalled();
  });

  test("deliveries with no sink are dropped, and a new frame is requested after a flush", () => {
    const { scheduler, frame } = manualScheduler();
    const b = new MetaBatcher(scheduler);
    b.push("/a.CR3", meta({}));
    const sink = makeSink();
    b.setSink(sink);
    frame();
    expect(sink).not.toHaveBeenCalled();
    b.push("/b.CR3", meta({}));
    frame();
    b.push("/c.CR3", meta({}));
    frame();
    expect(sink).toHaveBeenCalledTimes(2);
  });
});
```

(`iso`, `phash`, `lrcRating` exist on `ImageMetadata` — `src/types/image.ts`.)

And in `src/utils/mergeMeta.test.ts`, reusing that file's own `meta(over)` helper and adding `applyMetaBatch` to its existing import:

```ts
describe("applyMetaBatch", () => {
  test("returns the same object for an empty batch", () => {
    const prev = { "/a.CR3": meta() };
    expect(applyMetaBatch(prev, new Map())).toBe(prev);
  });
  test("merges each entry against the previous map, carrying lrcRating forward", () => {
    const prev = { "/a.CR3": meta({ lrcRating: 4 }) };
    const next = applyMetaBatch(
      prev,
      new Map([
        ["/a.CR3", meta()],
        ["/b.CR3", meta()],
      ]),
    );
    expect(next).not.toBe(prev);
    expect(next["/a.CR3"].lrcRating).toBe(4);
    expect(Object.keys(next)).toEqual(["/a.CR3", "/b.CR3"]);
  });
});
```

- [ ] **Step 2:** run both files → FAIL.

- [ ] **Step 3: implement.**

`src/image/metaBatcher.ts`:

```ts
import type { ImageMetadata } from "../types";
import { mergeMeta } from "../utils/mergeMeta";

export type MetaBatch = ReadonlyMap<string, ImageMetadata>;
export type MetaBatchSink = (batch: MetaBatch) => void;
export type FrameScheduler = {
  request: (cb: () => void) => number;
  cancel: (handle: number) => void;
};

/** rAF in the webview; a 16 ms timer where no DOM exists (node tests). A
 *  hidden window pauses rAF — deliveries then wait, bounded by the frame
 *  count, and land in one flush when the window returns. */
export const defaultFrameScheduler: FrameScheduler =
  typeof requestAnimationFrame === "function"
    ? { request: (cb) => requestAnimationFrame(() => cb()), cancel: (h) => cancelAnimationFrame(h) }
    : {
        request: (cb) => setTimeout(cb, 16) as unknown as number,
        cancel: (h) => clearTimeout(h),
      };

/**
 * Coalesces per-image metadata deliveries into one sink call per animation
 * frame. The background thumbnail sweep delivers once per image; handing each
 * one to React cloned the whole metadata map and re-ran burst/similar
 * grouping over the whole shoot per image (audit 2026-09-13, performance
 * HIGH). Lives in the store so reset paths own the pending queue the way
 * they own every other per-path record.
 */
export class MetaBatcher {
  private pending = new Map<string, ImageMetadata>();
  private handle: number | null = null;
  private sink: MetaBatchSink | undefined;

  constructor(private readonly scheduler: FrameScheduler = defaultFrameScheduler) {}

  setSink(sink: MetaBatchSink | undefined): void {
    this.sink = sink;
    if (!sink) this.clear();
  }

  push(path: string, meta: ImageMetadata): void {
    if (!this.sink) return;
    // Fold same-frame deliveries with the sink's own rule, so a thumb's phash
    // survives a preview delivery that lands in the same frame.
    this.pending.set(path, mergeMeta(this.pending.get(path), meta));
    if (this.handle === null) this.handle = this.scheduler.request(() => this.flush());
  }

  forget(gone: ReadonlySet<string>): void {
    for (const p of gone) this.pending.delete(p);
  }

  clear(): void {
    this.pending.clear();
    if (this.handle !== null) {
      this.scheduler.cancel(this.handle);
      this.handle = null;
    }
  }

  private flush(): void {
    this.handle = null;
    if (this.pending.size === 0 || !this.sink) return;
    const batch = this.pending;
    this.pending = new Map();
    this.sink(batch);
  }
}
```

`src/utils/mergeMeta.ts` — append:

```ts
/** Applies one frame's worth of deliveries (see MetaBatcher) to the metadata
 *  map: one clone per frame instead of one per image. */
export function applyMetaBatch(
  prev: Record<string, ImageMetadata>,
  batch: ReadonlyMap<string, ImageMetadata>,
): Record<string, ImageMetadata> {
  if (batch.size === 0) return prev;
  const next = { ...prev };
  for (const [path, meta] of batch) next[path] = mergeMeta(prev[path], meta);
  return next;
}
```

`src/image/imageStore.ts`:
  - `ImageStoreOptions`: `/** Frame scheduler for the metadata batcher (tests inject a manual one). */ frameScheduler?: FrameScheduler;`
  - replace the `metaSink` field with `private readonly metaBatcher: MetaBatcher;`, constructed in the constructor: `this.metaBatcher = new MetaBatcher(opts.frameScheduler);`
  - `setMetaSink(sink: MetaBatchSink | undefined): void { this.metaBatcher.setSink(sink); }` (keep its doc comment, say "per frame").
  - both landing sites: `if (result.meta) this.metaBatcher.push(path, result.meta);`
  - `forget()`: after the `dropPath` loop — `this.metaBatcher.forget(gone);`
  - `hardReset()`: `this.metaBatcher.clear();` next to the lane resets.
  - `reset()` does **not** clear: thumbs survive `reset()`, so metadata from thumbs that already landed must too. Say so in a one-line comment in `reset()`.

`src/app/useImageStoreWiring.ts` — the sink effect becomes (keep the long comment above it, append "Deliveries arrive batched per animation frame — see MetaBatcher."):

```ts
useEffect(() => {
  imageStore.setMetaSink((batch) => {
    setMetadata((m) => applyMetaBatch(m, batch));
  });
  return () => imageStore.setMetaSink(undefined);
}, [setMetadata]);
```

Update the `mergeMeta` doc comment's "wired in `App.tsx`" to `useImageStoreWiring.ts`.

- [ ] **Step 4: store-level tests** in `src/image/imageStore.test.ts`, following the file's existing mock/`invoke` helpers. The suite has only ever used the singleton (`getStore()`); these tests instead construct their own `new ImageStore({ frameScheduler })` with a manual scheduler and leave the singleton alone: (a) two thumb landings → sink called once, with both paths, only after the frame runs; (b) `hardReset()` before the frame → sink never called; (c) `forget(new Set([pathA]))` before the frame → batch lacks `pathA`; (d) `reset(samePaths)` before the frame → batch still delivered.

- [ ] **Step 5:** gate green. Commit: `perf(store): batch metadata deliveries per animation frame`.

---

### Task 3: Moved paths stay gone — tier-landing tombstones + `overlayService.forget`

**Files:**
- Modify: `src/image/imageStore.ts` (`forget`, `reset`, `hardReset`, the four `fetch*Into` landing sites), `src/image/imageStore.test.ts`, `src/overlays/overlayService.ts` (+ its test file), `src/app/useSessionLifecycle.ts` (`pruneMoved`)

**Interfaces:**
- Consumes: Task 2's `imageStore.ts` (run after it).
- Produces: `overlayService.forget(paths: ReadonlySet<string>): void`.

Why a tombstone set and not `pathIndex.has(path)`: thumbnails are also requested for staged frames before `reset()` registers the culling set, so "not in `pathIndex`" is not "gone".

- [ ] **Step 1: failing tests.**
  - imageStore: start a thumb read for `pathA` (unresolved `invoke` promise), `forget(new Set([pathA]))`, resolve → the blob URL is revoked, `thumbs` has no entry (assert through the public snapshot/`debugStats().caches.thumbs`), and the metadata sink never receives `pathA`. Same shape for the nav tier. (These store tests also construct their own `new ImageStore({ frameScheduler })`, as Task 2's do.) Then `reset([pathA])` and a fresh read lands normally (tombstone cleared).
  - overlayService: seed a cached clip for `/a` and an in-flight histogram for `/b` (deferred `compute`); `forget(new Set(["/a", "/b"]))` → `get("clip","/a")` undefined, version bumped once, and resolving `/b`'s compute commits nothing. `forget` of unknown paths does not bump.

- [ ] **Step 2:** run → FAIL.

- [ ] **Step 3: implement.**

```ts
// imageStore.ts — field
/** Paths removed by forget() this session. A read that was already in flight
 *  must not re-create their records when it lands. Cleared by reset()/hardReset(). */
private forgotten = new Set<string>();
```
  - `forget()`: `for (const p of gone) this.forgotten.add(p);`
  - `reset()` and `hardReset()`: `this.forgotten.clear();`
  - In each of `fetchThumbInto`, `fetchNavInto`, `fetchZoomInto`, `fetchMidInto`: directly after the existing stale-generation branch, add a branch with the **same body** (same revokes, same return) guarded by `this.forgotten.has(path)`. Do not invent a new cleanup shape — mirror that site's generation branch (revoke + return). Unlike a stale generation, a forgotten landing still matches the lane's generation, so `TierLane.run`'s `finally` decrements `inFlight` and pumps — which is what we want.
  - Rewrite the last sentence of `forget()`'s doc comment: reads in flight for a gone path are dropped on landing (tombstones), not swept later.

```ts
// overlayService.ts
/** Prune hook, next to imageStore.forget(): drop the moved paths' rasters and
 *  cancel their in-flight work (a wiped marker fails the live() check). */
forget(paths: ReadonlySet<string>): void {
  let had = false;
  for (const kind of KINDS) {
    for (const p of paths) {
      had = this.caches[kind].delete(p) || had;
      this.inFlight[kind].delete(p);
    }
  }
  if (had) this.bump();
}
```
  - `pruneMoved`: build the set once — `const goneSet = new Set(gone); imageStore.forget(goneSet); overlayService.forget(goneSet);`

- [ ] **Step 4:** gate green. Commit: `fix(store): reads in flight for moved frames no longer land; overlay cache forgets them`.

---

### Task 4: A Move no longer wipes smart-culling scores

**Files:**
- Create: `src/smart/sessionIdentity.ts`, `src/smart/sessionIdentity.test.ts`, `src/smart/useSmartCulling.test.tsx`
- Modify: `src/smart/useSmartCulling.ts:70-76,105-118`

**Interfaces:**
- Produces: `isPrunedSubset(prev: readonly Img[], next: readonly Img[]): boolean`.

Today the hook's session key is the `images` array identity. `pruneMoved` hands it a new array, so every Move of rejects clears all scores and (with analyze-on-open) re-runs inference over every remaining unrated frame.

- [ ] **Step 1: failing tests.**

`src/smart/sessionIdentity.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { isPrunedSubset } from "./sessionIdentity";
import type { Img } from "../types/image";

const img = (id: number, path = `/shoot/${id}.CR3`) => ({ id, path, filename: `${id}.CR3` }) as Img;

describe("isPrunedSubset", () => {
  test("true when frames were only removed", () => {
    expect(isPrunedSubset([img(0), img(1), img(2)], [img(0), img(2)])).toBe(true);
  });
  test("false for an empty next (session ended)", () => {
    expect(isPrunedSubset([img(0)], [])).toBe(false);
  });
  test("false when nothing was removed or frames were added", () => {
    expect(isPrunedSubset([img(0)], [img(0)])).toBe(false);
    expect(isPrunedSubset([img(0)], [img(0), img(1)])).toBe(false);
  });
  test("false when an id maps to a different path (another folder reusing ids)", () => {
    expect(isPrunedSubset([img(0), img(1)], [img(0, "/other/0.CR3")])).toBe(false);
  });
});
```

`src/smart/useSmartCulling.test.tsx` (`// @vitest-environment jsdom`, `renderHook` from `@testing-library/react`, `vi.useFakeTimers()`); mock `@tauri-apps/api/core` (`invoke`), `../image/imageStore` (`getGeneration: () => 1`, `isBusyLoading: () => false`) and `./analysisDriver` — partially, because the hook also imports the chunk/idle constants from it: `vi.mock("./analysisDriver", async (orig) => ({ ...(await orig<typeof import("./analysisDriver")>()), runAnalysis: vi.fn() }))` — so `runAnalysis` captures its third argument (`deps`) and returns a promise the test resolves. Each numbered case is its own `test()` with its own `renderHook`:
  1. *keeps scores across a prune and does not re-run*: render `{enabled, autoStart, active: true, ml: false, images: [i0,i1,i2], ratedIds: new Set(), storageMode: "local"}`; advance 1200 ms → `runAnalysis` called once; `act(() => deps.onScores([{index:0},{index:1},{index:2}] as ImageScore[]))`, resolve the pass; rerender with `images: [i0,i2]` (same `Img` objects); expect `Object.keys(result.current.scores)` → `["0","2"]`; advance 5000 ms → still one `runAnalysis` call.
  2. *a different folder resets and re-runs*: repeat case 1's setup up to the landed scores, then rerender with three frames under another directory → `scores` is `{}`, and after 1200 ms `runAnalysis` has been called twice.
  3. *scores for frames pruned mid-pass are not inserted*: start a pass over `[i0,i1,i2]`, rerender with `[i0,i2]` before scores land, then `onScores` for all three → keys `["0","2"]`.

- [ ] **Step 2:** run → FAIL.

- [ ] **Step 3: implement.**

`src/smart/sessionIdentity.ts`:

```ts
import type { Img } from "../types/image";

/**
 * True when `next` is `prev` with frames taken out — the mid-cull prune after
 * "Move rejects" — so per-id state (smart-culling scores, latches) can carry
 * over. Ids restart at 0 per folder, so the check is id AND path: another
 * folder never matches. An empty `next` is a session end, never a prune.
 */
export function isPrunedSubset(prev: readonly Img[], next: readonly Img[]): boolean {
  if (next.length === 0 || next.length >= prev.length) return false;
  const pathById = new Map<number, string>();
  for (const im of prev) pathById.set(im.id, im.path);
  return next.every((im) => pathById.get(im.id) === im.path);
}
```

`useSmartCulling.ts` — replace the "new staged set invalidates everything" effect:

```ts
/** The previous staged set, to tell a prune from a new session. */
const prevImagesRef = useRef<readonly Img[]>(images);
/** Ids in the live session — a pass dispatched before a prune must not
 *  insert scores for frames that have since been moved away. */
const liveIdsRef = useRef<ReadonlySet<number>>(new Set());

// A new staged set invalidates everything derived from the old one — except
// a prune (Move rejects): the survivors keep their scores and the pass stays
// latched, so a Move never re-runs inference over the whole shoot.
useEffect(() => {
  const prev = prevImagesRef.current;
  prevImagesRef.current = images;
  const live = new Set(images.map((im) => im.id));
  liveIdsRef.current = live;
  if (isPrunedSubset(prev, images)) {
    setScores((s) => {
      const out: Record<number, ImageScore> = {};
      for (const [id, sc] of Object.entries(s)) if (live.has(Number(id))) out[Number(id)] = sc;
      return out;
    });
    if (startedForRef.current === prev) startedForRef.current = images;
    return;
  }
  setScores({});
  setProgress(null);
  startedForRef.current = null;
  attemptedRef.current = new Set();
}, [images]);
```

and in `onScores`: `if (im && liveIdsRef.current.has(im.id)) next[im.id] = s;`. This effect must stay defined **before** the auto-start effect (effects run in definition order; the latch must move to the new array before auto-start compares it). Update the hook's doc comment ("Restarts fresh when the staged set changes — a prune is not a change") and the `images` option comment.

Out of scope, on purpose: `useFolderTrouble.ts:36-38` also resets on `images` identity (it hides the "folder unreachable" chip). After a Move that is the right behaviour — the folder just proved reachable.

- [ ] **Step 4:** gate green. Commit: `perf(smart): a Move keeps scores and does not re-run the pass`.

---

### Task 5: Memoize the four top-level views; make StatusBar's memo bite

**Files:**
- Create: `src/components/memoBailout.test.tsx`
- Modify: `src/hooks/useChipsTooltipVisibility.ts`, `src/components/ThumbStrip.tsx`, `CompareStrip.tsx`, `CompareView.tsx`, `ExifRail.tsx`, `src/App.tsx` (the status-bar group block ~1617-1681 and whatever pure derivations it needs, moved above the `if (phase !== "culling")` return at ~1297)

- [ ] **Step 1: failing test** — `src/components/memoBailout.test.tsx` (`// @vitest-environment jsdom`):

```tsx
import { describe, expect, test, vi } from "vitest";
import { render } from "@testing-library/react";

// vi.mock is hoisted above the imports; a plain outer const would be in its TDZ.
const { stripRenders } = vi.hoisted(() => ({ stripRenders: vi.fn(() => {}) }));
vi.mock("./strip/PhotoStrip", () => ({
  PhotoStrip: () => {
    stripRenders();
    return null;
  },
}));

import { ThumbStrip } from "./ThumbStrip";
import { CompareStrip } from "./CompareStrip";
import { CompareView } from "./CompareView";
import { ExifRail } from "./ExifRail";

const MEMO = Symbol.for("react.memo");
const typeOf = (c: unknown) => (c as { $$typeof?: symbol }).$$typeof;

describe("top-level views bail out of renders with unchanged props", () => {
  test("all four are memo components", () => {
    for (const c of [ThumbStrip, CompareStrip, CompareView, ExifRail]) expect(typeOf(c)).toBe(MEMO);
  });

  test("ThumbStrip re-renders for a new cursor, not for an identical prop set", () => {
    const props = {
      images: [],
      currentIndex: 0,
      ratings: {},
      visibleIndices: [],
      metadata: {},
      onPick: () => {},
    };
    const { rerender } = render(<ThumbStrip {...props} />);
    rerender(<ThumbStrip {...props} />);
    expect(stripRenders).toHaveBeenCalledTimes(1);
    rerender(<ThumbStrip {...props} currentIndex={1} />);
    expect(stripRenders).toHaveBeenCalledTimes(2);
  });
});
```

(Add the matching CompareStrip case with `stripIndices`, `championIndex`, `challengerIndex`, `onPickChallenger`; reset the spy between tests.)

- [ ] **Step 2:** run → FAIL.

- [ ] **Step 3: memo.** In each of the four files: `import { memo, … } from "react"` and `export const X = memo(function X({ … }: Props) { … });` — body untouched, named inner function kept for devtools.

- [ ] **Step 4: prop identity in `App.tsx`.** Read every prop passed to the four components and to `StatusBar` and classify it: primitive / state / `useMemo` / `useCallback` / **fresh per render**. Fix only the fresh ones:
  - The six `StatusBar` groups are fresh object literals built below the phase early return, which defeats `StatusBar`'s existing `memo`. Move the block above the early return and wrap each group in `useMemo` with exact deps (the five overlay toggles call stable state setters, so `statusOverlays` depends only on `gridVisible` and the five booleans). Only three consts the groups need sit below the return — `current`, `currentRating`, `statusBarImg` — and none depends on anything computed below it; move those up (everything else referenced is already above). The inline arrows inside the groups (`toggle` ×5, `openActions`) become part of the memoized objects.
  - `useChipsTooltipVisibility` (`src/hooks/useChipsTooltipVisibility.ts:57-61`) returns a fresh object with a fresh nested `hoverProps` every render; it rides inside `statusFilter`, so without fixing it `StatusBar` never bails. Memoize `hoverProps` and the returned object there (`useMemo`, exact deps). Hooks must end up unconditional — `react-hooks/rules-of-hooks` is the check. Replace the comment that says "no useMemo available".
  - Anything else you find fresh (an inline arrow or object literal passed to one of the four views): stabilise it with `useCallback`/`useMemo`, and list each one in your report. If everything else is already stable, say so with the evidence.
  - Expectation to record, not fix: the pre-flight fact-check found every prop of the four views already stable (primitive / state / `useMemo` / `useCallback`). During folder-open `metadata`, `suggestions`, `bursts` and `similar` still change once per flush, so the strips bail on zoom/pan/feedback/save churn, not during the load.
  - Do **not** narrow the strips' `metadata` prop in this task; Task 7's numbers decide whether that is worth doing.

- [ ] **Step 5:** gate green (`pnpm lint` must show no new `exhaustive-deps` warnings). Commit 1: `perf(views): memo ThumbStrip, CompareStrip, CompareView, ExifRail`. Commit 2: `perf(app): status-bar prop groups are memoized above the phase return`.

---

### Task 6: Progress fill animates `transform`, not `width`

**Files:**
- Modify: `src/App.tsx:1400-1403`, `src/styles/chrome.css:598-600`

- [ ] **Step 1:** TSX — the determinate fill keeps its classes; the style becomes a slide of a full-width fill inside the clipping track (the track already has `overflow: hidden` and the radius, so the leading edge keeps its 2 px radius — no visual change):

```tsx
style={{ transform: `translateX(${(progress.done / progress.total) * 100 - 100}%)` }}
```

- [ ] **Step 2:** CSS:

```css
.cull-progress__fill {
  width: 100%;
  transition: transform 150ms ease-out;
}
```

Check nothing else sets `width` on `.cull-progress__fill` (`grep -rn "cull-progress__fill" src`), and that `.cull-progress__indeterminate` (its own 35 % width + keyframes) is untouched.

- [ ] **Step 3:** `pnpm lint:css && pnpm lint && pnpm typecheck && pnpm test && pnpm build`. Commit: `perf(css): analyze progress fill animates transform`.

---

### Task 7 (controller): Measure before/after and publish

Not a subagent task. Only while the PC is idle (check `GetLastInputInfo` ≥ 10 min and no full-screen foreground app before every GUI step); abort and defer otherwise, as in Phase 0.

- [ ] Scratch shoot: hard-link (no copy, no writes to the source) the 2,726 CR3s of `C:\Canon Media\2026\2026-04-20` into `%LOCALAPPDATA%\Temp\cull-phase2\shoot` with `New-Item -ItemType HardLink`. The app only reads CR3s; sidecars, if any were ever written, would be new files in the scratch folder. No rating key is sent at any point.
- [ ] **Before** = the Task 1 commit (meter present, nothing else changed): `git worktree add ../cull-before <task-1-sha>`, `pnpm install --frozen-lockfile`, run with `CARGO_TARGET_DIR` pointing at the main checkout's `src-tauri/target` (Rust is identical in this phase — no rebuild) and, from Git Bash, `VITE_CULL_DEVHUD=1 pnpm tauri dev` (PowerShell: `$env:VITE_CULL_DEVHUD="1"; pnpm tauri dev`).
- [ ] Open the scratch folder through the native picker (recipe in `~/.claude/plans/cull-audit-2026-09-13/live-check/`), begin culling, wait until the HUD reads `cache … thumb 2726`, screenshot, read the `react` row. Two runs (cold, warm).
- [ ] **After** = branch HEAD, same procedure, two runs.
- [ ] Also at HEAD: hold-pan on a zoomed frame for ~3 s and note the commit delta (memo check: strips and status bar should not add cost), screenshot.
- [ ] Publish the table (commits · Σ ms · max ms · derives · seconds to full thumbs) in this document's implementation note and in the PR body. If `derives` after the fix is still within 2× of `commits`, or the strips dominate the after-profile, open a follow-up item (narrow the strips' `metadata` prop to an `lrcRating` map) rather than widening this PR.
- [ ] Remove the worktree; leave the scratch shoot for the Phase 0 live check that is still owed.

---

## Deliberately not in this phase

- `useSmartCulling`'s `setScores` batching — already chunked (6–16 frames per update, a few per second); revisit only if Task 7 shows it.
- `MidSweep.pick()` resumable pointer — load-bounded, idle-only, no measured cost; touching the read pipeline for it is not justified.
- `withChanges(ratings, changes)` and replacing the decide tests' line citations with symbol names — Phase 4 (tests), where those files are opened anyway.
- The class ↔ rule census — Phase 3, with the rest of the CSS work.

---

## Implementation note (2026-09-19)

Executed with subagent-driven development: a fresh implementer and a fresh reviewer per task, a pre-flight fact-check of this plan against the code (4 blockers and 3 should-fixes corrected before Task 1), fix rounds on Tasks 2 and 3, and a whole-branch review on the strongest model followed by one fix wave.

### Measured result

2,726-frame shoot (2026-04-20), hard-linked scratch copy, dev build, dev HUD `react` row, read when `cache … thumb` reached 2,726. Display: 3840×2160 @ 240 Hz. No rating key was sent at any point.

| At t = 10 s after "begin culling" | Before (Task 1 only) | Per-frame batching | 100 ms window (shipped) |
|---|---|---|---|
| React commits | 1,833 | 1,550 | **97** |
| Render time, Σ | 2,857 ms | 1,891 ms | **166 ms** |
| Slowest commit | 9.8 ms | 9.7 ms | 9.6 ms |
| `burstData` re-derivations | 1,226 | 1,009 | **34** |
| Thumbs loaded at t = 5 s | 2,028 | 2,395 | **2,726 (all)** |
| Nav read average (HUD) | 72 ms | 44 ms | 34 ms |

A second before-run reproduced the first (1,877 commits / 3,236 ms / 1,255 derivations at t = 30 s). "Derives" counts `burstData` recomputations only. Evidence screenshots: `~/.claude/plans/cull-audit-2026-09-13/phase-2-shots/`.

**The plan was wrong about the clock.** The audit's sketch and this plan batched per `requestAnimationFrame`, assuming a 60 Hz frame. On a 240 Hz panel rAF fires every 4.2 ms while thumbnails land at roughly 480 per second, so a frame coalesced about two deliveries. The measurement caught it; the flush now runs on a fixed window, `META_FLUSH_MS = 100`, independent of refresh rate. Cost: a just-landed frame's EXIF and badges can appear up to 100 ms later.

### Rulings made during execution

- The batcher lives in `imageStore` (not in `useImageStoreWiring`, as the audit sketched) so `forget()`, `reset()` and `hardReset()` own the pending queue. `reset()` keeps it (thumbs survive `reset()` and are never re-fetched, so dropping a pending delivery would lose that frame's pHash for the session); `hardReset()` clears it; a sink detach keeps it and re-arms when a sink returns.
- `EMPTY_METADATA` moved to `src/types/image.ts` as the one all-null template; the plan's instruction to copy a test helper contradicted the const's own "one place" comment.
- Task 3's review found that only success landings were tombstoned. Error landings for a moved file re-queued the read (up to four backend reads of a missing file), recorded errors, and with four or more rejects could latch the "folder unreachable" chip after an ordinary Move. All four tiers now drop both landings; the latch has a regression test.
- `useFolderTrouble` still resets on `images` identity: after a Move the folder just proved reachable.
- The zoomed hold-pan memo check was not run by the controller: it needs synthetic zoom and drag input on a frame, and the no-stray-keys rule outweighs a confirmation the prop audit and unit tests already give. It is on Oliver's walk list.
- Dropped as not worth doing: a stable `scores` identity on a no-op prune (`images` identity changes in the same commit, so derivations re-run anyway).

### Oliver's walk (real verification — no screenshot gate ran beyond the HUD readings)

Open a large folder and begin culling: the strip and grid should fill without hitching and the EXIF rail should populate as before. Zoom into a frame and drag: the filmstrip and footer should stay still. Analyze-progress bar on open: fills left to right as before. After a cull with smart culling on, Move rejects: suggestions and badges on the remaining frames stay, the "analyzing" progress does not restart, and no "folder unreachable" chip appears.

### Left for later phases

- Pre-existing, found by the final review: the first staged frame can lose its LrC star (the begin-culling seed spread lets a thumb delivery's null `lrcRating` win; fold the seed through `mergeMeta`); the `/not found/` test that latches `midUnsupported` can fire from any vanished file.
- The AF zoom-origin can jump if a frame's first metadata lands mid-zoom (pre-existing; the window is now up to 100 ms). Latch the origin at zoom start if it is ever seen.
- Request entry points and `rearm()` do not consult the tombstones, so a stale request for a moved path costs one doomed read before it is dropped.
- `App.tsx` is ~1,980 lines; the status-bar group block extracts cleanly into a `useStatusBarGroups()` hook.
- Still open from earlier phases: `withChanges` and symbol-name citations in the decide tests (Phase 4); the class ↔ rule census (Phase 3); `MidSweep.pick()` pointer and `setScores` batching only if a measurement ever asks for them.
- The Phase 0 live check on a scratch copy is still owed before PR #3 merges.
