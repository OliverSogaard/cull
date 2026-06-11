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
 */

/** Structural slice of HTMLImageElement the pool needs (test-injectable). */
export type PoolImage = { src: string; decode(): Promise<void> };

export type PoolTier = "preview" | "full";

export type PoolEntry = { path: string; url: string };

export class DecodePool {
  /** key `${tier}\0${path}` → the held element and the blob url it decodes.
   *  NUL can't occur in a path, so the key never collides across tiers. */
  private slots = new Map<string, { url: string; el: PoolImage }>();
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
      this.slots.set(key, { url, el });
      el.src = url;
      el.decode().catch(() => {
        // Undecodable (or revoked underneath us): release and remember the
        // bad url so the per-cursor-move re-aim doesn't retry it forever —
        // unless a newer slot already took the key.
        const cur = this.slots.get(key);
        if (cur && cur.el === el) {
          this.slots.delete(key);
          this.failed.set(key, url);
          el.src = "";
        }
      });
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
    // Dropping the src releases the element's hold on the decoded raster
    // (and aborts an in-flight decode, which rejects its promise — handled).
    slot.el.src = "";
  }
}
