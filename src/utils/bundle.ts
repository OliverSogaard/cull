import { invoke } from "@tauri-apps/api/core";
import type { ImageMetadata } from "../types";
import { dlog, dlogEnabled } from "./dlog";

/**
 * mid-dims-bug-report §6.4 — blob-creation integrity check, all four tiers.
 * Logs the sliced payload's byte length and whether it ends with the JPEG
 * EOI marker (FFD9). This is purely diagnostic: it permanently excludes wire
 * truncation as a cause for any future report of the bottom-cut defect (§2
 * of that report already verified the pipeline is truncation-free, but a
 * live log beats re-deriving that by hand every time). Guarded by
 * `dlogEnabled()` so production pays only the cached boolean check — the
 * byte-ends scan never runs with the flag off.
 */
function logBlobIntegrity(tier: string, bytes: Uint8Array): void {
  if (!dlogEnabled()) return;
  const len = bytes.length;
  const endsWithFFD9 = len >= 2 && bytes[len - 2] === 0xff && bytes[len - 1] === 0xd9;
  dlog("blob", `${tier} blob created`, { len, endsWithFFD9 });
}

/**
 * Parse the binary frame returned by `read_preview`, the navigation-tier read.
 *
 * Wire format: `u32 LE` header length, that many bytes of JSON, then
 * `previewLen` bytes of JPEG. One IPC, no base64 — we slice the `ArrayBuffer`
 * directly and wrap the JPEG in a Blob URL. `read_preview` supplies
 * `orientation` + the zoom tier's exact-range hint in the header.
 */
type NavHeader = {
  meta: ImageMetadata | null;
  previewLen: number;
  orientation?: number;
  fullOffset?: number | null;
  fullLen?: number | null;
};

export type NavResult = {
  previewUrl: string;
  meta: ImageMetadata | null;
  /** EXIF orientation, echoed back to `read_fullres`. */
  orientation: number | null;
  /** Exact byte range of the full-res mdat JPEG (null = backend will scan). */
  fullOffset: number | null;
  fullLen: number | null;
};

/** Navigation-tier read: PRVW preview + metadata + zoom hint. `gen` is the
 *  imageStore session generation — the backend cancels superseded chunked
 *  reads against it. */
export async function fetchNav(path: string, gen: number): Promise<NavResult> {
  const buf = await invoke<ArrayBuffer>("read_preview", { path, gen });
  const view = new DataView(buf);
  const headerLen = view.getUint32(0, true);
  const header = JSON.parse(
    new TextDecoder().decode(new Uint8Array(buf, 4, headerLen)),
  ) as NavHeader;
  const previewBytes = new Uint8Array(buf, 4 + headerLen, header.previewLen);
  logBlobIntegrity("preview", previewBytes);
  const previewUrl = URL.createObjectURL(new Blob([previewBytes], { type: "image/jpeg" }));
  return {
    previewUrl,
    meta: header.meta,
    orientation: header.orientation ?? null,
    fullOffset: header.fullOffset ?? null,
    fullLen: header.fullLen ?? null,
  };
}

/** Zoom-tier read: the full-res mdat JPEG via the exact-range hint (backend
 *  falls back to its mdat scan on a mismatch or a missing hint). */
type FullresHeader = { fullLen: number };

export async function fetchFullres(
  path: string,
  gen: number,
  /** `orientation: null` → the backend scans and derives it from the file's
   *  own moov (never assume 1 — a rotated frame would cache unrotated). */
  hint: { fullOffset: number | null; fullLen: number | null; orientation: number | null },
): Promise<{ url: string }> {
  const buf = await invoke<ArrayBuffer>("read_fullres", {
    path,
    gen,
    fullOffset: hint.fullOffset,
    fullLen: hint.fullLen,
    orientation: hint.orientation,
  });
  const view = new DataView(buf);
  const headerLen = view.getUint32(0, true);
  const header = JSON.parse(
    new TextDecoder().decode(new Uint8Array(buf, 4, headerLen)),
  ) as FullresHeader;
  const fullBytes = new Uint8Array(buf, 4 + headerLen, header.fullLen);
  logBlobIntegrity("fullres", fullBytes);
  const url = URL.createObjectURL(new Blob([fullBytes], { type: "image/jpeg" }));
  return { url };
}

/** Header for `read_mid` (Phase 8): JPEG length + (unrotated) pixel dims. */
type MidHeader = { midLen: number; width: number; height: number };

/** Matches the backend's quiet-miss sentinel: no cached mid and this profile
 *  may not generate one (network hard rule / another producer pending). The
 *  store treats it as "stay on preview", never as a tier failure. */
export const MID_UNCACHED_RE = /mid uncached/i;

/** Mid-tier read (Phase 8): the generated ≤2560px JPEG from the disk cache;
 *  on the local profile a miss generates inline (exact-range full read →
 *  decode → resize → q80 encode → orientation splice). Hint semantics match
 *  `fetchFullres` (null orientation → backend self-derives via scan). */
export async function fetchMid(
  path: string,
  gen: number,
  hint: { fullOffset: number | null; fullLen: number | null; orientation: number | null },
): Promise<{ url: string; width: number; height: number }> {
  const buf = await invoke<ArrayBuffer>("read_mid", {
    path,
    gen,
    fullOffset: hint.fullOffset,
    fullLen: hint.fullLen,
    orientation: hint.orientation,
  });
  const view = new DataView(buf);
  const headerLen = view.getUint32(0, true);
  const header = JSON.parse(
    new TextDecoder().decode(new Uint8Array(buf, 4, headerLen)),
  ) as MidHeader;
  const midBytes = new Uint8Array(buf, 4 + headerLen, header.midLen);
  logBlobIntegrity("mid", midBytes);
  const url = URL.createObjectURL(new Blob([midBytes], { type: "image/jpeg" }));
  return { url, width: header.width, height: header.height };
}

/** Idle-sweep generation (Phase 8, local profile only): generate + cache the
 *  mid without shipping bytes back. True = a current mid is cached; false =
 *  skipped (another producer holds the path's pending claim). */
export async function invokeGenerateMid(
  path: string,
  gen: number,
  hint: { fullOffset: number | null; fullLen: number | null; orientation: number | null },
): Promise<boolean> {
  return invoke<boolean>("generate_mid", {
    path,
    gen,
    fullOffset: hint.fullOffset,
    fullLen: hint.fullLen,
    orientation: hint.orientation,
  });
}

/**
 * Parse the binary frame from `extract_thumbnail`: `u32 LE` header length, that
 * many bytes of JSON (`{ width, height, jpegLen }`), then `jpegLen` bytes of
 * THMB JPEG. The display dims drive a correctly-shaped placeholder before any
 * raster decodes.
 */
type ThumbHeader = {
  width: number | null;
  height: number | null;
  jpegLen: number;
  /** Full metadata on fresh parses (Phase 2 metadata fast path) AND on v2
   *  disk-cache hits (the stored header carries it — Phase 7); null only on
   *  old backends. */
  meta?: ImageMetadata | null;
};

/** Per-image display dimensions (orientation-adjusted), for placeholder aspect. */
export type ImageDims = { w: number; h: number };

export type ThumbResult = {
  /** Blob URL of the embedded THMB JPEG. */
  url: string;
  /** Display pixel dimensions (orientation-adjusted), or null if EXIF lacked them. */
  width: number | null;
  height: number | null;
  /** Full metadata — fresh parses and v2 cache hits alike (null on old backends). */
  meta: ImageMetadata | null;
};

export async function fetchThumbnail(path: string): Promise<ThumbResult> {
  const buf = await invoke<ArrayBuffer>("extract_thumbnail", { path });
  const view = new DataView(buf);
  const headerLen = view.getUint32(0, true);
  const header = JSON.parse(
    new TextDecoder().decode(new Uint8Array(buf, 4, headerLen)),
  ) as ThumbHeader;
  const thumbBytes = new Uint8Array(buf, 4 + headerLen, header.jpegLen);
  logBlobIntegrity("thumb", thumbBytes);
  const url = URL.createObjectURL(new Blob([thumbBytes], { type: "image/jpeg" }));
  return { url, width: header.width, height: header.height, meta: header.meta ?? null };
}
