/**
 * Main-thread client for the overlay Web Worker (masks + histogram). Owns a
 * single lazily-created worker, correlates replies by id, and degrades
 * gracefully: if the runtime lacks Worker/OffscreenCanvas/createImageBitmap,
 * or the worker ever errors, it marks the worker dead and every caller falls
 * back to the inline main-thread path. So the worst case is "no worse than the
 * pre-worker behaviour".
 *
 * The HISTOGRAM op is additionally gated on the worker's boot-time capability
 * probe (1×1 OffscreenCanvas convertToBlob — "test before trust" on WKWebView,
 * plan Phase 6): histogramWorkerAvailable() stays false until the probe's OK
 * arrives, and callers fall back inline until then. Masks pre-date the probe
 * and keep their per-request fallback unchanged.
 */
import type { MaskKind } from "./maskScans";

type OverlayReply = { id?: number; blob?: Blob; error?: string; probe?: boolean; ok?: boolean };

let worker: Worker | null = null;
let workerDead = false;
/** Set by the boot probe's answer; histogram requests are refused until true. */
let histogramCapable = false;
let seq = 0;
const pending = new Map<number, { resolve: (blob: Blob) => void; reject: (e: unknown) => void }>();

function supported(): boolean {
  return (
    typeof Worker !== "undefined" &&
    typeof OffscreenCanvas !== "undefined" &&
    typeof createImageBitmap !== "undefined"
  );
}

function ensureWorker(): Worker | null {
  if (workerDead || !supported()) return null;
  if (worker) return worker;
  try {
    const w = new Worker(new URL("./maskWorker.ts", import.meta.url), { type: "module" });
    w.onmessage = (e: MessageEvent<OverlayReply>) => {
      if (e.data.probe) {
        histogramCapable = e.data.ok === true;
        return;
      }
      if (e.data.id === undefined) return;
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if (e.data.blob) p.resolve(e.data.blob);
      else p.reject(new Error(e.data.error ?? "overlay worker error"));
    };
    const die = () => {
      // Never retry the worker this session — every caller falls back to inline.
      workerDead = true;
      histogramCapable = false;
      for (const [, p] of pending) p.reject(new Error("overlay worker crashed"));
      pending.clear();
      try {
        w.terminate();
      } catch {
        /* ignore */
      }
      worker = null;
    };
    w.onerror = die;
    w.onmessageerror = die;
    worker = w;
  } catch {
    workerDead = true;
    return null;
  }
  return worker;
}

/** Boot the worker now (app startup) so the capability probe has answered by
 *  the time the first histogram is requested. Safe no-op when unsupported. */
export function primeOverlayWorker(): void {
  ensureWorker();
}

export function maskWorkerAvailable(): boolean {
  return ensureWorker() != null;
}

/** True once the worker is alive AND its boot probe confirmed OffscreenCanvas
 *  2d + convertToBlob. False while the probe is still in flight — callers fall
 *  back to the inline histogram rather than wait. */
export function histogramWorkerAvailable(): boolean {
  return ensureWorker() != null && histogramCapable;
}

/** Blob → data: URL (cheap base64 of a small PNG) so the overlay caches stay
 *  data URLs — no object-URL revoke lifecycle to manage. */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error(reader.error?.message ?? "FileReader failed"));
    reader.readAsDataURL(blob);
  });
}

function requestBlob(message: Record<string, unknown>, bitmap: ImageBitmap): Promise<Blob> {
  const w = ensureWorker();
  if (!w) {
    bitmap.close();
    return Promise.reject(new Error("overlay worker unavailable"));
  }
  const id = ++seq;
  return new Promise<Blob>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, ...message, bitmap }, [bitmap]);
  });
}

/**
 * Encode an overlay mask off the main thread. Resolves with the same PNG `data:`
 * URL the inline path produces; rejects if the worker is unavailable or errors
 * (the caller then falls back to the main-thread path). `bitmap` is transferred,
 * so the caller must not use it afterwards.
 */
export function requestMaskOffThread(kind: MaskKind, bitmap: ImageBitmap, max: number): Promise<string> {
  return requestBlob({ op: "mask", kind, max }, bitmap).then(blobToDataUrl);
}

/**
 * Render the RGB histogram off the main thread (Phase 6). Same contract as the
 * mask request: PNG `data:` URL out, rejection → caller falls back inline,
 * `bitmap` is transferred. Callers should check histogramWorkerAvailable()
 * first — this also rejects when the boot probe hasn't confirmed capability.
 */
export function requestHistogramOffThread(bitmap: ImageBitmap): Promise<string> {
  if (!histogramCapable) {
    bitmap.close();
    return Promise.reject(new Error("histogram worker not capable"));
  }
  return requestBlob({ op: "histogram" }, bitmap).then(blobToDataUrl);
}
