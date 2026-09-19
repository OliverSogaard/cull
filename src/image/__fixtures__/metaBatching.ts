import { vi } from "vitest";
import type { FlushScheduler, MetaBatch } from "../metaBatcher";

/**
 * Shared fixtures for the metadata-batching tests (metaBatcher.test.ts and the
 * store-level suite), so both drive the flush the same way.
 */

/** A FlushScheduler whose window only closes when the test calls
 *  `flushWindow()` — named so it can't be mistaken for the store suite's
 *  microtask-draining `flush()` helper. */
export function manualScheduler() {
  let queued: (() => void) | null = null;
  const scheduler: FlushScheduler = {
    request: (cb) => {
      queued = cb;
      return 1;
    },
    cancel: () => {
      queued = null;
    },
  };
  return {
    scheduler,
    flushWindow: () => queued?.(),
    hasPendingFlush: () => queued !== null,
  };
}

/** Typed sink spy: a bare vi.fn() types mock.calls as any[][] and fails the
 *  no-unsafe-* lint rules that stay on for test files. */
export const makeSink = () => vi.fn((_batch: MetaBatch) => {});
