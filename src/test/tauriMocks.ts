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

let router: InvokeRouter = () => undefined;

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
 * `payloadLen` bytes standing in for a JPEG (SOI + a filler byte). The wire
 * format is documented at src/utils/bundle.ts:22-29 and parsed at :51-68;
 * handing `invoke` anything else throws inside `new DataView(buf)`.
 */
export function frame(header: object, payloadLen: number): ArrayBuffer {
  const bytes = new TextEncoder().encode(JSON.stringify(header));
  const buf = new ArrayBuffer(4 + bytes.length + payloadLen);
  new DataView(buf).setUint32(0, bytes.length, true);
  new Uint8Array(buf, 4, bytes.length).set(bytes);
  new Uint8Array(buf, 4 + bytes.length).fill(0xff);
  return buf;
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
 * Call from `beforeEach`; `vi.unstubAllGlobals()` in `afterEach` undoes the
 * first two, and the caller restores the URL pair and `decode` (each is a
 * property assignment on an object Vitest does not track).
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
  globalThis.URL.createObjectURL = vi.fn(() => `blob:mock-${++n}`);
  globalThis.URL.revokeObjectURL = vi.fn(() => {});
  HTMLImageElement.prototype.decode = vi.fn(() => Promise.resolve());
}
