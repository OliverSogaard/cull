import { vi } from "vitest";

/**
 * The repo's first shared test kit: one place that knows what a mounted CULL
 * tree asks of Tauri and of the DOM.
 *
 * HOISTING: a `vi.mock` factory may not reference a module-scope import, so a
 * consumer writes the ASYNC form, which imports this file from inside the
 * factory:
 *
 *   vi.mock("@tauri-apps/api/window", async () =>
 *     (await import("./test/tauriMocks")).windowMock());
 *
 * This file is NOT excluded from `tsconfig.json` (which excludes only
 * `*.test.ts*`), so `pnpm typecheck` and `pnpm build` check it and the strict
 * eslint block lints it. Keep it clean rather than widening either config.
 */

export type InvokeRouter = (cmd: string, args?: Record<string, unknown>) => unknown;

/**
 * The MODULE default, in force until a test calls `setInvokeRouter`. It throws
 * rather than resolving `undefined`: a test that forgot to install a router
 * would otherwise watch every command succeed with `undefined`, and the app
 * would fail far downstream — a store tier error, a phase that never arrives —
 * with nothing pointing back at the missing router.
 *
 * This is NOT the same as a routed test's `default:` arm returning `undefined`.
 * That is correct: `begin_session`, `set_io_profile` and the sidecar writes are
 * genuinely void commands. The distinction is "no table installed" versus "this
 * table deliberately says nothing comes back".
 *
 * It throws synchronously, so it surfaces even at a `void invoke(…)` call site
 * that never awaits. An `async` caller turns it into a rejection by itself.
 */
let router: InvokeRouter = (cmd) => {
  throw new Error(`tauriMocks: no invoke router installed (${cmd})`);
};

/** Point `invoke` at a table for this test. Call it in `beforeEach`. */
export function setInvokeRouter(next: InvokeRouter): void {
  router = next;
}

/** The shared `invoke` spy. One per test FILE (Vitest gives each file its own
 *  module registry), so `mockClear` between tests is the caller's job. */
export const invoke = vi.fn((cmd: string, args?: Record<string, unknown>) =>
  Promise.resolve(router(cmd, args)),
);

export function coreMock() {
  return { invoke };
}

/** `listen` must return a PROMISE that resolves to an unlisten function:
 *  App.tsx:427-429 does `un.then((f) => f())` and
 *  useSessionLifecycle.ts:506 calls the resolved value unguarded. */
export function eventMock() {
  return { listen: () => Promise.resolve(() => {}) };
}

/** Every window method the mounted tree touches. The three `on…` registrars
 *  are THENABLE (useQuitGuard.ts:31-41, useDragAndDrop.ts:35-70 and
 *  WindowControls' effect all chain `.then`), and `isMaximized` resolves. */
export function windowMock() {
  return {
    getCurrentWindow: () => ({
      isMaximized: () => Promise.resolve(false),
      isFullscreen: () => Promise.resolve(false),
      onResized: () => Promise.resolve(() => {}),
      onCloseRequested: () => Promise.resolve(() => {}),
      onDragDropEvent: () => Promise.resolve(() => {}),
      minimize: () => Promise.resolve(),
      toggleMaximize: () => Promise.resolve(),
      close: () => Promise.resolve(),
      destroy: () => Promise.resolve(),
    }),
  };
}

export const dialogOpen = vi.fn((..._args: unknown[]) => Promise.resolve<unknown>(null));

export function dialogMock() {
  return { open: dialogOpen };
}

/**
 * A binary read frame: `u32` LE header length, that many bytes of JSON, then
 * `payloadLen` bytes standing in for a JPEG. The wire format is documented at
 * src/utils/bundle.ts:22-29 and parsed at :51-68; handing `invoke` anything
 * else throws inside `new DataView(buf)`.
 *
 * The payload opens with a real JPEG SOI marker (FF D8) when there is room for
 * it, and pads with FF after that. Nothing in the test path decodes these bytes
 * — `logBlobIntegrity` is behind `dlogEnabled()`, and the stubbed
 * `HTMLImageElement.decode` resolves without looking — but a payload that
 * claims to be a JPEG should start like one, so a future test that does look
 * finds the marker it expects instead of two filler bytes.
 */
export function frame(header: object, payloadLen: number): ArrayBuffer {
  const bytes = new TextEncoder().encode(JSON.stringify(header));
  const buf = new ArrayBuffer(4 + bytes.length + payloadLen);
  new DataView(buf).setUint32(0, bytes.length, true);
  new Uint8Array(buf, 4, bytes.length).set(bytes);
  const payload = new Uint8Array(buf, 4 + bytes.length);
  payload.fill(0xff);
  if (payload.length >= 2) payload[1] = 0xd8; // payload[0] is already FF — that is SOI
  return buf;
}

/**
 * What `installDomStubs` displaced, so `restoreDomStubs` can put it back.
 *
 * All three are kept as DESCRIPTORS, not values. That distinguishes "absent"
 * from "present and undefined" — jsdom defines no `decode` at all, so only a
 * descriptor can express restoring it to absence — and it keeps this file off
 * `@typescript-eslint/unbound-method`, which fires on a bare
 * `URL.createObjectURL` reference. The kit is not a `*.test.ts` file, so it
 * gets the STRICT eslint block with no test relaxations (a deliberate ruling:
 * a broken kit should fail the ordinary gate).
 */
let domStubsInstalled = false;
let priorCreateObjectURL: PropertyDescriptor | undefined;
let priorRevokeObjectURL: PropertyDescriptor | undefined;
let priorDecode: PropertyDescriptor | undefined;

/** Put one property back exactly as it was — including not being there. */
function restoreProp(target: object, key: string, prior: PropertyDescriptor | undefined): void {
  if (prior) Object.defineProperty(target, key, prior);
  else delete (target as Record<string, unknown>)[key];
}

/**
 * The browser APIs a mounted CULL tree reaches that need help under jsdom.
 *  - `matchMedia`: NOT implemented by jsdom 30 (contradicting the Phase 4
 *    scout, which said it was). useImageStoreWiring.ts:88-102 arms one on
 *    mount and calls addEventListener/removeEventListener on the result, so
 *    without this stub App throws on render.
 *  - `ResizeObserver`: also not implemented. The grid and the loupe stage
 *    observe (App.tsx:454, useImageStoreWiring.ts:78) — both phase-gated, so
 *    the start screen never reaches them; stubbed anyway.
 *  - `URL.createObjectURL` / `revokeObjectURL`: these DO exist under Vitest's
 *    jsdom environment (it installs a Node-backed compat URL). They are
 *    replaced with spies so a test can count blob churn — not because they
 *    are missing.
 *  - `HTMLImageElement.prototype.decode`: jsdom implements no image decoder at
 *    all, so the property is absent. The presenter's injected decode does
 *    `el.src = url; await el.decode()` for every offered tier
 *    (usePresent.ts:80-90), so on the culling phase each offer rejects with
 *    "el.decode is not a function" — outside any promise chain the app
 *    catches, which Vitest reports as an unhandled rejection. Resolving takes
 *    the presenter down its normal success path.
 * Call from `beforeEach` and pair it with `restoreDomStubs()` in `afterEach`.
 * Only the first two go through `vi.stubGlobal`; the URL pair and `decode` are
 * plain property assignments on objects Vitest does not track, so the originals
 * are recorded here and put back by hand.
 */
export function installDomStubs(): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  let n = 0;
  priorCreateObjectURL = Object.getOwnPropertyDescriptor(globalThis.URL, "createObjectURL");
  priorRevokeObjectURL = Object.getOwnPropertyDescriptor(globalThis.URL, "revokeObjectURL");
  globalThis.URL.createObjectURL = vi.fn(() => `blob:mock-${++n}`);
  globalThis.URL.revokeObjectURL = vi.fn(() => {});
  // `undefined` under jsdom, which never defines `decode` at all.
  priorDecode = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "decode");
  HTMLImageElement.prototype.decode = vi.fn(() => Promise.resolve());
  domStubsInstalled = true;
}

/**
 * The other half of `installDomStubs`. Puts `matchMedia` and `ResizeObserver`
 * back via Vitest's own registry, restores the object-URL pair by value, and
 * returns `decode` to exactly what it was — which under jsdom means DELETING
 * it, so `"decode" in HTMLImageElement.prototype` reads false again and a later
 * test in the same file cannot silently inherit this file's stub.
 *
 * Safe to call without a matching install (it no-ops), so an `afterEach` that
 * runs after a failed `beforeEach` does not itself throw.
 */
export function restoreDomStubs(): void {
  if (!domStubsInstalled) return;
  domStubsInstalled = false;
  vi.unstubAllGlobals();
  restoreProp(globalThis.URL, "createObjectURL", priorCreateObjectURL);
  restoreProp(globalThis.URL, "revokeObjectURL", priorRevokeObjectURL);
  restoreProp(HTMLImageElement.prototype, "decode", priorDecode);
  priorCreateObjectURL = undefined;
  priorRevokeObjectURL = undefined;
  priorDecode = undefined;
}
