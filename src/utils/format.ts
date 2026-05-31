/**
 * Display formatters for EXIF / file fields surfaced in the (i) overlay.
 *
 * Each returns `null` when the input is missing or unusable, so the call site
 * can just `filter(Boolean).join(...)` to compose lines without juggling
 * empty strings.
 */

/** `1/250s` for fast shutters; `1.6s` for long exposures. */
export function formatShutter(seconds: number | null): string | null {
  if (seconds == null || seconds <= 0) return null;
  if (seconds >= 1) return `${seconds.toFixed(1)}s`;
  return `1/${Math.round(1 / seconds)}s`;
}

/** Human-readable local time. Falls back to the raw input if it doesn't parse. */
export function formatCaptureTime(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** `+0.7 EV`, `-1.3 EV`, `±0 EV`. */
export function formatExposureBias(ev: number | null): string | null {
  if (ev == null) return null;
  if (Math.abs(ev) < 0.05) return "±0 EV";
  return `${ev > 0 ? "+" : ""}${ev.toFixed(1)} EV`;
}

/** Canon WhiteBalance enum → label. 0 = auto, 1 = manual; anything else → null. */
export function formatWhiteBalance(v: number | null): string | null {
  if (v == null) return null;
  return v === 0 ? "AWB" : v === 1 ? "WB manual" : null;
}

/**
 * Canon ContinuousDrive → coarse label. 0/6/9 are single variants, 1/3/4/5/8/10
 * are continuous. We surface only the reliable coarse distinction, never the
 * specific sub-mode (which can vary by body firmware).
 */
export function formatDrive(v: number | null): string | null {
  if (v == null) return null;
  if (v === 0 || v === 6 || v === 9) return "single";
  if ([1, 3, 4, 5, 8, 10].includes(v)) return "continuous";
  return null;
}

/** `6000 × 4000 · 24 MP`. */
export function formatDimensions(w: number | null, h: number | null): string | null {
  if (!w || !h) return null;
  return `${w} × ${h} · ${((w * h) / 1e6).toFixed(0)} MP`;
}

/** `12.4 MB` for small files, `134 MB` for big ones (no decimal once we're past 100). */
export function formatFileSize(bytes: number | null): string | null {
  if (bytes == null || bytes <= 0) return null;
  const mb = bytes / 1048576;
  return mb >= 100 ? `${mb.toFixed(0)} MB` : `${mb.toFixed(1)} MB`;
}
