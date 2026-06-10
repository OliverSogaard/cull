/**
 * Display formatters for EXIF / file fields surfaced in the (i) overlay.
 *
 * Each returns `null` when the input is missing or unusable, so the call site
 * can just `filter(Boolean).join(...)` to compose lines without juggling
 * empty strings.
 */

import { basename } from "./path";

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

/** `6000 × 4000` from pixel dims (true × sign); null if either missing. */
function formatDimensions(w: number | null, h: number | null): string | null {
  if (w == null || h == null || w <= 0 || h <= 0) return null;
  return `${w} × ${h}`;
}

/** `42.3 MB` from bytes (1 MB = 1048576 B); null if missing / non-positive. */
function formatFileSize(bytes: number | null): string | null {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return null;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/** One-liner combining pixel dims + file size — `6000 × 4000, 42.3 MB`. Drops
 *  whichever half is missing; null if both are. Shared by the loupe + compare rails. */
export function formatImageSize(
  w: number | null,
  h: number | null,
  bytes: number | null,
): string | null {
  const dims = formatDimensions(w, h);
  const size = formatFileSize(bytes);
  if (dims && size) return `${dims}, ${size}`;
  return dims ?? size;
}

/** Capture time `HH:MM:SS` in the user's locale, from an ISO string. */
export function formatTime(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/**
 * Casual relative-time formatter for the home-screen recents list. Uses a
 * friendly tone ("2 hours ago", "yesterday", "3 days ago") rather than the
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
 * Render a session's folder set as folder NAMES, not paths — `wedding-d1 +
 * wedding-d2` — for the home-screen recents list and the staged summary. When
 * the full join would blow the char budget, show as many leading names as fit
 * and count the rest: `wedding-d1 +2 more`. The first name always renders
 * (middle-truncated if it alone overflows a single-folder row), so a row is
 * never just "+3 more". Duplicate basenames (two folders both named `RAW`)
 * render as-is — the full-path tooltip at the call site disambiguates.
 */
export function formatFolderSet(paths: string[], maxChars = 52): string {
  const names = paths.map(basename);
  if (names.length === 0) return "";
  if (names.length === 1) return middleTruncate(names[0], maxChars);
  const full = names.join(" + ");
  if (full.length <= maxChars) return full;
  // Greedy: take leading names while the join + a " +N more" suffix still
  // fits. The suffix is reserved per step because once we stop, the names we
  // dropped must be counted.
  let acc = names[0];
  let shown = 1;
  for (let i = 1; i < names.length; i++) {
    const candidate = `${acc} + ${names[i]}`;
    const remaining = names.length - (i + 1);
    const suffix = remaining > 0 ? ` +${remaining} more` : "";
    if (candidate.length + suffix.length > maxChars) break;
    acc = candidate;
    shown++;
  }
  const suffix = ` +${names.length - shown} more`;
  // An overlong FIRST name can't be dropped (the row must say *something*), so
  // it shrinks instead — same middle-truncation as the single-folder case.
  if (shown === 1 && acc.length + suffix.length > maxChars) {
    acc = middleTruncate(acc, Math.max(1, maxChars - suffix.length));
  }
  return `${acc}${suffix}`;
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
