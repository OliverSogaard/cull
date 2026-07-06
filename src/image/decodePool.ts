/**
 * decodePool.ts — the decode-ahead warm pool (pipeline Phase 5).
 *
 * A small set of DETACHED image elements pre-decoding the cursor's
 * neighbourhood so the presenter's per-layer `decode()` resolves from the
 * engine's decoded-image cache (~instant): neighbour taps snap inside the
 * 48 ms window and warm-scrub steps win the one-frame race — sharp scrub.
 *
 * The pool is ADVISORY (plan contract): both engines may evict decoded
 * rasters under memory pressure (WKWebView's policy is opaque), so nothing
 * here is load-bearing for correctness — the presenter's decode gate is the
 * truth. Holding the element references merely makes warmth overwhelmingly
 * likely. NOT createImageBitmap: its resize options are unsupported on
 * WKWebView and bitmaps double decoded memory off the display path.
 *
 * Decoded RGBA is the real budget (preview ≈ 7 MB, full ≈ 130 MB at
 * 32.5 MP) — caps live in the performance profiles (decodedPoolPreviews /
 * decodedPoolFulls) and are passed per retain() call.
 *
 * Remedy B (mid-dims-bug-report §4/§7B): a cursor-band re-aim that drops a
 * path mid-decode used to clear `src` immediately, which ABORTS the
 * in-flight decode. That abort was identified as the highest-frequency seed
 * of a WKWebView blob-poisoning defect: the engine can retain the aborted,
 * partially-decoded raster keyed by the (still store-valid, still-offered)
 * blob URL, later re-presenting it as a bottom-cropped frame. `release()`
 * now defers the `src` clear until the decode settles (resolve OR reject) —
 * the element just finishes decoding into memory nobody reads, instead of
 * being yanked mid-flight.
 */

import { dlog } from "../utils/dlog";

/** Structural slice of HTMLImageElement the pool needs (test-injectable). */
export type PoolImage = { src: string; decode(): Promise<void> };

export type PoolTier = "preview" | "full";

export type PoolEntry = { path: string; url: string };

type Slot = {
  url: string;
  el: PoolImage;
  /** Flips true once this slot's decode() has resolved or rejected. */
  settled: boolean;
  /** Set by release() when the slot is dropped while still mid-decode — the
   *  actual `src = ""` is deferred to the decode's settle handler. */
  releasePending: boolean;
};

export class DecodePool {
  /** key `${tier}\0${path}` → the held element + its blob url + decode state.
   *  NUL can't occur in a path, so the key never collides across tiers. */
  private slots = new Map<string, Slot>();
  /** key → blob url whose decode REJECTED. Never re-attempted for the SAME
   *  url (an undecodable payload won't fix itself, and the band re-aims on
   *  every cursor move — retrying would burn a decode per scrub step). A
   *  refetch mints a NEW blob url, which is the natural retry signal. */
  private failed = new Map<string, string>();

  constructor(private readonly createImage: () => PoolImage) {}

  /**
   * Keep `entries` (priority order, first = highest) decoded for `tier`;
   * everything else in that tier is released. Already-warm path+url slots
   * are kept untouched — re-retaining never restarts a decode (a same-url
   * `src` set would). Entries beyond `cap` are ignored.
   */
  retain(tier: PoolTier, entries: PoolEntry[], cap: number): void {
    const desired = new Map<string, string>(); // path → url, capped
    for (const e of entries) {
      if (desired.size >= cap) break;
      if (!desired.has(e.path)) desired.set(e.path, e.url);
    }
    const prefix = `${tier}\0`;
    for (const [key, slot] of this.slots) {
      if (!key.startsWith(prefix)) continue;
      const path = key.slice(prefix.length);
      const want = desired.get(path);
      if (want === slot.url) {
        desired.delete(path); // warm — nothing to do
      } else {
        this.release(key); // left the band, or the blob was replaced
      }
    }
    for (const [path, url] of desired) {
      const key = prefix + path;
      if (this.failed.get(key) === url) continue; // known-bad blob — skip
      const el = this.createImage();
      const slot: Slot = { url, el, settled: false, releasePending: false };
      this.slots.set(key, slot);
      el.src = url;
      el.decode().then(
        () => this.onSettle(key, slot),
        () => this.onSettle(key, slot, url),
      );
    }
  }

  /** Fires once a slot's decode() resolves or rejects. `failedUrl` is set
   *  only on rejection. Handles both the still-normal in-band case (existing
   *  failed-tracking behavior, unchanged) and the Remedy-B deferred-release
   *  case (a release() that happened while this decode was still in-flight). */
  private onSettle(key: string, slot: Slot, failedUrl?: string): void {
    slot.settled = true;
    if (slot.releasePending) {
      // Deferred from release(): safe to drop the src now — the decode
      // already ran to completion, so clearing it here can't abort anything.
      slot.el.src = "";
      return;
    }
    if (failedUrl === undefined) return; // resolved — still retained, nothing else to do
    // Rejected while still retained: release + remember as known-bad, unless
    // a newer slot has already taken the key out from under this one.
    if (this.slots.get(key) === slot) {
      this.slots.delete(key);
      this.failed.set(key, failedUrl);
      slot.el.src = "";
    }
  }

  /** Live slot counts per tier (dev HUD). */
  counts(): { previews: number; fulls: number } {
    let previews = 0;
    let fulls = 0;
    for (const key of this.slots.keys()) {
      if (key.startsWith("preview\0")) previews++;
      else fulls++;
    }
    return { previews, fulls };
  }

  /** Release everything (session change — the blob URLs are being revoked). */
  clear(): void {
    for (const key of [...this.slots.keys()]) this.release(key);
    this.failed.clear();
  }

  private release(key: string): void {
    const slot = this.slots.get(key);
    if (!slot) return;
    this.slots.delete(key);
    if (!slot.settled) {
      // Remedy B: don't clear src while the decode is in-flight — that abort
      // is the poisoning seed (mid-dims-bug-report §4/§7B). Defer to
      // onSettle(); the element just finishes decoding into memory nobody
      // else reads.
      slot.releasePending = true;
      const sep = key.indexOf("\0");
      dlog("pool", "deferred release (decode in-flight)", {
        tier: key.slice(0, sep),
        path: key.slice(sep + 1),
      });
      return;
    }
    // Decode already settled — dropping the src just releases the element's
    // hold on the decoded raster (no abort possible at this point).
    slot.el.src = "";
  }
}
