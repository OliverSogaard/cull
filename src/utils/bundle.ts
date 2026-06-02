import { invoke } from "@tauri-apps/api/core";
import { decode as decodeBlurhash } from "blurhash";
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
 * many bytes of JSON (`{ blurhash, width, height, jpegLen }`), then `jpegLen`
 * bytes of THMB JPEG. The blurhash + display dims drive an instant,
 * correctly-shaped scrub placeholder before any raster decodes.
 */
type ThumbHeader = {
  blurhash: string | null;
  width: number | null;
  height: number | null;
  jpegLen: number;
};

/** Per-image BlurHash placeholder data: the hash + display dims (w/h). */
export type BlurInfo = { hash: string; w: number; h: number };

export type ThumbResult = {
  /** Blob URL of the embedded THMB JPEG. */
  url: string;
  /** BlurHash string (already rotated to display orientation), or null. */
  blurhash: string | null;
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
  return { url, blurhash: header.blurhash, width: header.width, height: header.height };
}

/** Just the BlurHash + display dims for one CR3 (no JPEG) — for the background
 * warm pass that pre-populates placeholders for the whole shoot. */
export async function fetchBlurhash(
  path: string,
): Promise<{ blurhash: string | null; width: number | null; height: number | null }> {
  return invoke("extract_blurhash", { path });
}

/**
 * Decode a BlurHash into a small blurred PNG data URL (the caller caches it).
 * The decode resolution is intentionally tiny — a blurhash is low-frequency, so
 * ~32px on the long edge upscales smoothly under CSS. `aspect` is width/height.
 * Returns null on any decode/canvas failure (caller falls back to the thumb).
 */
export function blurhashToDataUrl(hash: string, aspect: number): string | null {
  const LONG = 32;
  const a = aspect > 0 && Number.isFinite(aspect) ? aspect : 1;
  const w = a >= 1 ? LONG : Math.max(8, Math.round(LONG * a));
  const h = a >= 1 ? Math.max(8, Math.round(LONG / a)) : LONG;
  try {
    const pixels = decodeBlurhash(hash, w, h);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const imageData = ctx.createImageData(w, h);
    imageData.data.set(pixels);
    ctx.putImageData(imageData, 0, 0);
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}
