/**
 * One image record in the staged set. `id` is assigned at scan time and is
 * stable across re-sorts, so the rating map keyed by `id` stays valid even
 * when the visible order changes (capture-time / filename / rating sort).
 */
export type Img = {
  id: number;
  path: string;
  filename: string;
};

/** Preview load state per path — drives the loupe's loading placeholder. */
export type PreviewEntry =
  | { status: "loading" }
  | { status: "ready"; url: string }
  | { status: "error"; error: string };

/**
 * EXIF subset shown in the (i) panel. Mirrors the Rust `meta::ImageMetadata`
 * shape on the wire (camelCase). Optional throughout because not every CR3
 * carries every field — GPS especially is often absent.
 */
export type ImageMetadata = {
  capturedAt: string | null;
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
};
