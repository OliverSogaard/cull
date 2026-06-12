import { invoke } from "@tauri-apps/api/core";
import type { ImageMetadata } from "../types";

/**
 * Parse the binary frame shared by the navigation-tier commands.
 *
 * Wire format: `u32 LE` header length, that many bytes of JSON, then
 * `previewLen` bytes of JPEG. One IPC, no base64 — we slice the `ArrayBuffer`
 * directly and wrap the JPEG in a Blob URL. `read_preview` (Phase 2+) adds
 * `orientation` + the zoom tier's exact-range hint to the header; the legacy
 * `read_bundle` header lacks them, so they parse as null.
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
  /** EXIF orientation, echoed back to `read_fullres` (null on legacy). */
  orientation: number | null;
  /** Exact byte range of the full-res mdat JPEG (null = backend will scan). */
  fullOffset: number | null;
  fullLen: number | null;
  /** True when served by the legacy `read_bundle` (old backend): the blob is
   *  the 32 MP full, not the PRVW, and there is no separate zoom tier. */
  legacy: boolean;
};

/** Which command serves navigation reads. Flips to the legacy `read_bundle`
 *  ONCE, on the first unknown-command error (Phase 2/3 shipped out of order
 *  — old backend, new frontend); never per-call error matching after that. */
let navCommand: "read_preview" | "read_bundle" = "read_preview";

/** Test-only: restore the native-first routing between tests. */
export function resetNavCommandForTests(): void {
  navCommand = "read_preview";
}

const isUnknownCommand = (e: unknown): boolean =>
  /not found|unknown command|no handler/i.test(String(e));

/** Navigation-tier read: PRVW preview + metadata + zoom hint (or the legacy
 *  full-res bundle on an old backend). `gen` is the imageStore session
 *  generation — the backend cancels superseded chunked reads against it. */
export async function fetchNav(path: string, gen: number): Promise<NavResult> {
  for (;;) {
    const legacy = navCommand === "read_bundle";
    try {
      const buf = await invoke<ArrayBuffer>(
        navCommand,
        legacy ? { path } : { path, gen },
      );
      const view = new DataView(buf);
      const headerLen = view.getUint32(0, true);
      const header = JSON.parse(
        new TextDecoder().decode(new Uint8Array(buf, 4, headerLen)),
      ) as NavHeader;
      const previewUrl = URL.createObjectURL(
        new Blob([new Uint8Array(buf, 4 + headerLen, header.previewLen)], {
          type: "image/jpeg",
        }),
      );
      return {
        previewUrl,
        meta: header.meta,
        orientation: header.orientation ?? null,
        fullOffset: header.fullOffset ?? null,
        fullLen: header.fullLen ?? null,
        legacy,
      };
    } catch (e) {
      if (!legacy && isUnknownCommand(e)) {
        navCommand = "read_bundle";
        continue;
      }
      throw e;
    }
  }
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
  const url = URL.createObjectURL(
    new Blob([new Uint8Array(buf, 4 + headerLen, header.fullLen)], { type: "image/jpeg" }),
  );
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
  const url = URL.createObjectURL(
    new Blob([new Uint8Array(buf, 4 + headerLen, header.midLen)], { type: "image/jpeg" }),
  );
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
  const url = URL.createObjectURL(
    new Blob([new Uint8Array(buf, 4 + headerLen, header.jpegLen)], { type: "image/jpeg" }),
  );
  return { url, width: header.width, height: header.height, meta: header.meta ?? null };
}
