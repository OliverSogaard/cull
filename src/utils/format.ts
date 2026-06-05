/**
 * Display formatters for EXIF / file fields surfaced in the (i) overlay.
 *
 * Each returns `null` when the input is missing or unusable, so the call site
 * can just `filter(Boolean).join(...)` to compose lines without juggling
 * empty strings.
 */

/** `1/250s` for fast shutters; `1.6s` for long exposures. */
export function formatShutter(seconds: number | null): string | null {
  // Guard NaN/Infinity too: `NaN <= 0` is false, so a NaN would otherwise slip
  // through and render the literal "1/NaNs".
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return null;
  if (seconds >= 1) return `${seconds.toFixed(1)}s`;
  return `1/${Math.round(1 / seconds)}s`;
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

/** `ƒ/2.8`. */
export function formatAperture(f: number | null): string | null {
  return f != null ? `ƒ/${f}` : null;
}

/** ISO as a plain string — `400`. */
export function formatIso(iso: number | null): string | null {
  return iso != null ? `${iso}` : null;
}

/** Focal length, no decimals — `50 mm`. */
export function formatFocal(mm: number | null): string | null {
  return mm != null ? `${mm.toFixed(0)} mm` : null;
}

/** Exposure bias without the trailing " EV" — for rows already labelled "EV". */
export function formatExposureBiasShort(ev: number | null): string | null {
  const s = formatExposureBias(ev);
  return s ? s.replace(/ EV$/, "") : null;
}

/** Capture time `HH:MM:SS` in the user's locale, from an ISO string. */
export function formatTime(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/**
 * Casual relative-time formatter for the home-screen recents list. Matches the
 * mockup's tone ("2 hours ago", "yesterday", "3 days ago") rather than the
 * precise EXIF-time formatter.
 *
 * Takes an ISO string (what {@link Date.toISOString} produces) and the current
 * Date (defaulted so tests can pin time). Returns `null` only if the input
 * isn't parseable — the home screen would just hide the row in that case.
 *
 * Buckets, smallest first:
 *  - <60s        → "just now"
 *  - <60min      → "N minutes ago" / "1 minute ago"
 *  - <24h        → "N hours ago" / "1 hour ago"
 *  - <48h        → "yesterday"
 *  - <7d         → "N days ago"
 *  - <5w         → "N weeks ago" (1w → "last week")
 *  - else        → localized short date (no time)
 */
export function formatRelativeTime(iso: string, now: Date = new Date()): string | null {
  if (!iso) return null;
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return null;
  const seconds = Math.round((now.getTime() - then.getTime()) / 1000);
  if (seconds < 0) return "just now"; // clock skew → clamp
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  if (days < 2) return "yesterday";
  if (days < 7) return `${days} days ago`;
  const weeks = Math.floor(days / 7);
  if (weeks === 1) return "last week";
  if (weeks < 5) return `${weeks} weeks ago`;
  return then.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/**
 * Middle-truncation: shrink `text` until it fits in `maxChars`, replacing the
 * middle with an ellipsis. Keeps both the head (drive letter / leading
 * segment) and the tail (filename / leaf folder) visible, which is what the
 * recents list wants on the home screen.
 *
 * If the input already fits, returns it unchanged.
 *
 * Examples (maxChars=30):
 *  - "C:\\Shoots\\2026-05-28 Greg & Lou Wedding\\Day 2"
 *    → "C:\\Shoots\\2026-05…\\Day 2"
 *  - short paths returned verbatim.
 */
export function middleTruncate(text: string, maxChars: number): string {
  if (maxChars <= 1) return text.slice(0, 1);
  if (text.length <= maxChars) return text;
  const halfA = Math.ceil((maxChars - 1) / 2);
  const halfB = maxChars - 1 - halfA;
  return text.slice(0, halfA) + "…" + text.slice(text.length - halfB);
}
