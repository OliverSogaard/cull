import type { ImageMetadata } from "../types";
import { mergeMeta } from "../utils/mergeMeta";

export type MetaBatch = ReadonlyMap<string, ImageMetadata>;
export type MetaBatchSink = (batch: MetaBatch) => void;
/** Whatever `setTimeout` hands back here — a number in the webview, a Timeout
 *  object under node. Named so nothing has to guess which. */
export type FlushHandle = ReturnType<typeof setTimeout>;
export type FlushScheduler = {
  request: (cb: () => void) => FlushHandle;
  cancel: (handle: FlushHandle) => void;
};

/**
 * How long deliveries accumulate before one flush reaches React.
 *
 * This was one animation frame until it was measured on the real machine: the
 * panel runs at 240 Hz, so rAF fires every 4.2 ms while the thumb sweep lands
 * ~480 images/s — about TWO deliveries per frame, which is barely any
 * coalescing at all (2 726-frame shoot, dev build: 1 833 → 1 550 commits,
 * 2 857 → 1 891 ms render). A fixed window is independent of refresh rate:
 * 100 ms caps React at 10 metadata updates/s no matter what panel is attached.
 *
 * The only cost is latency — a just-landed frame's EXIF row and LrC badge
 * appear up to 100 ms after its thumbnail does, which is below the threshold
 * where the two look out of step.
 *
 * A hidden window THROTTLES background timers to roughly 1 s rather than
 * pausing them (unlike rAF, which stops entirely), so a backgrounded window
 * still drains its pending deliveries — nothing is lost, it just arrives in
 * bigger, rarer batches.
 */
export const META_FLUSH_MS = 100;

/** Timer-only: the flush clock is deliberately NOT tied to the refresh rate
 *  (see META_FLUSH_MS). Tests inject a manual scheduler instead. */
export const defaultFlushScheduler: FlushScheduler = {
  request: (cb) => setTimeout(cb, META_FLUSH_MS),
  cancel: (h) => clearTimeout(h),
};

/**
 * Coalesces per-image metadata deliveries into one sink call per META_FLUSH_MS
 * window. The background thumbnail sweep delivers once per image; handing each
 * one to React cloned the whole metadata map and re-ran burst/similar
 * grouping over the whole shoot per image (audit 2026-09-13, performance
 * HIGH). Lives in the store so reset paths own the pending queue the way
 * they own every other per-path record.
 *
 * Trailing edge: the first push arms one timer and the flush takes everything
 * that arrived during the window, so a steady stream costs exactly one React
 * update per window and a lone delivery still lands within one.
 */
export class MetaBatcher {
  private pending = new Map<string, ImageMetadata>();
  private handle: FlushHandle | null = null;
  private sink: MetaBatchSink | undefined;

  constructor(private readonly scheduler: FlushScheduler = defaultFlushScheduler) {}

  /** Detaching the sink CANCELS the pending flush but KEEPS the deliveries:
   *  the thumbs behind them already landed and are never re-fetched, so
   *  dropping them would lose their phash for the rest of the session (the
   *  same loss `reset()` goes out of its way to avoid). Re-attaching a sink
   *  re-arms the window, so an unmount/remount of the wiring effect costs
   *  nothing. Only `clear()` — i.e. `hardReset`, which revokes the thumbs
   *  too — discards them. */
  setSink(sink: MetaBatchSink | undefined): void {
    this.sink = sink;
    if (!sink) {
      this.cancelFlush();
      return;
    }
    if (this.pending.size > 0) this.scheduleFlush();
  }

  push(path: string, meta: ImageMetadata): void {
    if (!this.sink) return;
    // Fold same-window deliveries with the sink's own rule, so a thumb's phash
    // survives a preview delivery that lands in the same window.
    this.pending.set(path, mergeMeta(this.pending.get(path), meta));
    this.scheduleFlush();
  }

  forget(gone: ReadonlySet<string>): void {
    for (const p of gone) this.pending.delete(p);
  }

  clear(): void {
    this.pending.clear();
    this.cancelFlush();
  }

  private scheduleFlush(): void {
    if (this.handle === null) this.handle = this.scheduler.request(() => this.flush());
  }

  private cancelFlush(): void {
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
