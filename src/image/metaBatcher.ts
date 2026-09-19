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
    ? {
        request: (cb) => requestAnimationFrame(() => cb()),
        cancel: (h) => cancelAnimationFrame(h),
      }
    : {
        request: (cb) => setTimeout(cb, 16),
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
