/**
 * Main-thread client for the overlay-mask Web Worker. Owns a single lazily-
 * created worker, correlates replies by id, and degrades gracefully: if the
 * runtime lacks Worker/OffscreenCanvas/createImageBitmap, or the worker ever
 * errors, it marks the worker dead and every caller falls back to the inline
 * main-thread path. So the worst case is "no worse than the pre-worker behaviour".
 */
import type { MaskKind } from "./maskScans";

let worker: Worker | null = null;
let workerDead = false;
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
    w.onmessage = (e: MessageEvent<{ id: number; blob?: Blob; error?: string }>) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if (e.data.blob) p.resolve(e.data.blob);
      else p.reject(new Error(e.data.error ?? "mask worker error"));
    };
    const die = () => {
      // Never retry the worker this session — every caller falls back to inline.
      workerDead = true;
      for (const [, p] of pending) p.reject(new Error("mask worker crashed"));
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

export function maskWorkerAvailable(): boolean {
  return ensureWorker() != null;
}

/**
 * Encode an overlay mask off the main thread. Resolves with the same PNG `data:`
 * URL the inline path produces; rejects if the worker is unavailable or errors
 * (the caller then falls back to the main-thread path). `bitmap` is transferred,
 * so the caller must not use it afterwards.
 */
export function requestMaskOffThread(kind: MaskKind, bitmap: ImageBitmap, max: number): Promise<string> {
  const w = ensureWorker();
  if (!w) {
    bitmap.close();
    return Promise.reject(new Error("mask worker unavailable"));
  }
  const id = ++seq;
  return new Promise<Blob>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, kind, bitmap, max }, [bitmap]);
  }).then(
    (blob) =>
      new Promise<string>((resolve, reject) => {
        // Blob → data: URL (cheap base64 of a small PNG) so the cache stays
        // data URLs — no object-URL revoke lifecycle to manage.
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      }),
  );
}
