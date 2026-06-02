import { invoke } from "@tauri-apps/api/core";
import type { ImageMetadata } from "../types";

/**
 * Parse the binary frame from the `read_bundle` Tauri command.
 *
 * Wire format: `u32 LE` header length, that many bytes of JSON
 * (`{ meta, previewLen }`), then `previewLen` bytes of preview JPEG. One IPC,
 * no base64 — we slice the `ArrayBuffer` directly and wrap the preview in a
 * Blob URL. Thumbnails are fetched separately via the thumbnail pool.
 */
type BundleHeader = { meta: ImageMetadata | null; previewLen: number };

export async function fetchBundle(
  path: string,
): Promise<{ previewUrl: string; meta: ImageMetadata | null }> {
  const buf = await invoke<ArrayBuffer>("read_bundle", { path });
  const view = new DataView(buf);
  const headerLen = view.getUint32(0, true);
  const header = JSON.parse(
    new TextDecoder().decode(new Uint8Array(buf, 4, headerLen)),
  ) as BundleHeader;
  const previewUrl = URL.createObjectURL(
    new Blob([new Uint8Array(buf, 4 + headerLen, header.previewLen)], { type: "image/jpeg" }),
  );
  return { previewUrl, meta: header.meta };
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
};

/** Per-image display dimensions (orientation-adjusted), for placeholder aspect. */
export type ImageDims = { w: number; h: number };

export type ThumbResult = {
  /** Blob URL of the embedded THMB JPEG. */
  url: string;
  /** Display pixel dimensions (orientation-adjusted), or null if EXIF lacked them. */
  width: number | null;
  height: number | null;
};

export async function fetchThumbnail(path: string): Promise<ThumbResult> {
  const buf = await invoke<ArrayBuffer>("extract_thumbnail", { path });
  const view = new DataView(buf);
  const headerLen = view.getUint32(0, true);
  const header = JSON.parse(
    new TextDecoder().decode(new Uint8Array(buf, 4, headerLen)),
  ) as ThumbHeader;
  const url = URL.createObjectURL(
    new Blob([new Uint8Array(buf, 4 + headerLen, header.jpegLen)], { type: "image/jpeg" }),
  );
  return { url, width: header.width, height: header.height };
}
