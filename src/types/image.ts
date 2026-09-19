/**
 * One image record in the staged set. `id` is assigned at scan time and is
 * stable across re-sorts, so the rating map keyed by `id` stays valid even
 * when the visible order changes (capture-time / filename / rating sort).
 */
export type Img = {
  id: number;
  path: string;
  filename: string;
  /**
   * Absolute path of the folder this image was scanned from. A staged set can
   * span several folders ("open another folder"), so recents reports per-folder
   * counts from this rather than the merged total.
   */
  srcFolder: string;
};

/**
 * EXIF subset shown in the (i) panel. Mirrors the Rust `meta::ImageMetadata`
 * shape on the wire (camelCase). Optional throughout because not every CR3
 * carries every field — GPS especially is often absent.
 */
export type ImageMetadata = {
  capturedAt: string | null;
  /** Sub-second fraction of capturedAt in ms (EXIF SubSecTimeOriginal) —
   *  the fine burst cadence. On the wire since the smart-culling backend. */
  subSecMs: number | null;
  camera: string | null;
  lens: string | null;
  focalLengthMm: number | null;
  aperture: number | null;
  shutterSeconds: number | null;
  iso: number | null;
  gpsLat: number | null;
  gpsLon: number | null;
  /** Active AF point, % of displayed image, top-left origin. */
  afXPct: number | null;
  afYPct: number | null;
  /** Signed EV. */
  exposureBias: number | null;
  /** Canon WhiteBalance: 0 = auto, 1 = manual. */
  whiteBalance: number | null;
  /** Canon ContinuousDrive raw value. */
  driveMode: number | null;
  pixelWidth: number | null;
  pixelHeight: number | null;
  /** CR3 file size on disk. */
  fileSize: number | null;
  /**
   * Lightroom Classic 1–5★ rating from the `.xmp` sidecar. Surfaced so the
   * (i) panel can show a "LrC rating ★★★☆☆" row and the grid / strip can
   * render a tiny corner badge. `null` for unrated.
   *
   * Note: when CULL writes a favorite it stamps `xmp:Rating="1"` — so a lone
   * 1★ on a frame whose CULL rating is "favorite" is just CULL's own mark.
   * The UI filters that case by comparing this to the CULL rating before
   * rendering the badge.
   */
  lrcRating: number | null;
  /**
   * 64-bit DCT pHash of the DECODED THUMBNAIL, 16 lowercase hex chars (string:
   * JS numbers lose 64-bit precision). This is the STANDING near-duplicate
   * signal — always available once a frame's thumbnail has decoded,
   * independent of smart culling — that `groupSimilar` chains on. `null` on a
   * thumb decode failure.
   *
   * NEVER the same source as `ImageScore.phash` (computed from the PRVW
   * decode, a different resolution): the two must never be Hamming-compared
   * against each other. `ImageScore.phash` stays on the wire only for the
   * calibration harness.
   */
  phash: string | null;
};

/**
 * All-null ImageMetadata template. Seeds a grid badge from a known LrC star
 * before the per-image bundle read fills in real EXIF — kept centralized (and
 * frozen) so adding a metadata field only touches one place, not every seed.
 * Lives beside the type so the test fixtures can share it too.
 */
export const EMPTY_METADATA: ImageMetadata = Object.freeze({
  capturedAt: null,
  subSecMs: null,
  camera: null,
  lens: null,
  focalLengthMm: null,
  aperture: null,
  shutterSeconds: null,
  iso: null,
  gpsLat: null,
  gpsLon: null,
  afXPct: null,
  afYPct: null,
  exposureBias: null,
  whiteBalance: null,
  driveMode: null,
  pixelWidth: null,
  pixelHeight: null,
  fileSize: null,
  lrcRating: null,
  phash: null,
});
