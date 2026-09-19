import { vi } from "vitest";
import type { FrameScheduler, MetaBatch } from "../metaBatcher";

/**
 * Shared fixtures for the metadata-batching tests (metaBatcher.test.ts and the
 * store-level suite), so both drive the flush the same way.
 */

/** A FrameScheduler whose frame only runs when the test calls `frame()`. */
export function manualScheduler() {
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

/** Typed sink spy: a bare vi.fn() types mock.calls as any[][] and fails the
 *  no-unsafe-* lint rules that stay on for test files. */
export const makeSink = () => vi.fn((_batch: MetaBatch) => {});
