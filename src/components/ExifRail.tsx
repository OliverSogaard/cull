import type { ImageMetadata, Rating } from "../types";
import {
  formatExposureBias,
  formatShutter,
  formatWhiteBalance,
} from "../utils/format";
import { hasLrcRating } from "../utils/ratingColor";

/**
 * Loupe-side EXIF rail (mockup .exif-rail). A 290-px column glued to the right
 * edge of the photo stage when (i) is on. Three sections — Frame, Exposure,
 * Histogram — each labelled with the mono champagne uppercase eyebrow.
 *
 * Designed to replace the old floating `ExifPanel`. The rail mounts as a sibling
 * of the photo stage so the photo area shrinks when info is on, instead of
 * letting the panel float over the photo.
 */
export function ExifRail({
  metadata,
  histogramUrl,
  cullRating,
}: {
  metadata: ImageMetadata | undefined;
  histogramUrl: string | undefined;
  cullRating?: Rating;
}) {
  const meta = metadata ?? null;
  // Frame section
  const body = meta?.camera ?? null;
  const lens = meta?.lens ?? null;
  const captured = meta?.capturedAt ?? null;
  const date = captured ? new Date(captured) : null;
  const dateOK = date && !Number.isNaN(date.getTime());
  const timeStr = dateOK
    ? date!.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : null;
  const dateStr = dateOK
    ? date!.toLocaleDateString(undefined, { year: "numeric", month: "2-digit", day: "2-digit" })
    : null;
  const lrc = meta?.lrcRating ?? null;
  const showLrc = hasLrcRating(lrc, cullRating);

  // Exposure section
  const shutter = formatShutter(meta?.shutterSeconds ?? null);
  const aperture = meta?.aperture != null ? `ƒ/${meta.aperture}` : null;
  const iso = meta?.iso != null ? `${meta.iso}` : null;
  const focal = meta?.focalLengthMm != null ? `${meta.focalLengthMm.toFixed(0)} mm` : null;
  // The row label is already "EV", so drop the redundant " EV" suffix
  // formatExposureBias appends. Leaves the sign / ±0 intact.
  const evRaw = formatExposureBias(meta?.exposureBias ?? null);
  const ev = evRaw ? evRaw.replace(/ EV$/, "") : null;
  const wb = formatWhiteBalance(meta?.whiteBalance ?? null);

  return (
    <aside className="cull-exif-rail" aria-label="Image info">
      <div className="cull-exif-rail__section">
        <div className="cull-exif-rail__label">Frame</div>
        <div className="cull-exif-rail__rows">
          {body && <RailRow k="Body" v={body} />}
          {lens && <RailRow k="Lens" v={lens} />}
          {timeStr && <RailRow k="Time" v={timeStr} />}
          {dateStr && <RailRow k="Date" v={dateStr} />}
          {showLrc && lrc != null && (
            <div className="cull-exif-rail__row">
              <span className="cull-exif-rail__k">LrC rating</span>
              <span
                className="cull-exif-rail__v cull-exif-rail__lrc"
                aria-label={`${lrc} of 5 stars`}
              >
                <span className="cull-exif-rail__lrc-filled">{"★".repeat(lrc)}</span>
                <span className="cull-exif-rail__lrc-dim">{"★".repeat(5 - lrc)}</span>
              </span>
            </div>
          )}
          {!body && !lens && !timeStr && !dateStr && !showLrc && (
            <div className="cull-exif-rail__row">
              <span className="cull-exif-rail__k">—</span>
              <span className="cull-exif-rail__v cull-exif-rail__v--dim">reading…</span>
            </div>
          )}
        </div>
      </div>

      <div className="cull-exif-rail__section">
        <div className="cull-exif-rail__label">Exposure</div>
        <div className="cull-exif-rail__rows">
          {shutter && <RailRow k="Shutter" v={shutter} />}
          {aperture && <RailRow k="Aperture" v={aperture} />}
          {iso && <RailRow k="ISO" v={iso} />}
          {focal && <RailRow k="Focal" v={focal} />}
          {ev && <RailRow k="EV" v={ev} />}
          {wb && <RailRow k="WB" v={wb} />}
          {!shutter && !aperture && !iso && !focal && !ev && !wb && (
            <div className="cull-exif-rail__row">
              <span className="cull-exif-rail__k">—</span>
              <span className="cull-exif-rail__v cull-exif-rail__v--dim">no exposure data</span>
            </div>
          )}
        </div>
      </div>

      <div className="cull-exif-rail__section">
        <div className="cull-exif-rail__label">Histogram</div>
        <div className="cull-exif-rail__hist">
          {histogramUrl ? (
            <img src={histogramUrl} alt="RGB histogram" />
          ) : (
            <div className="cull-exif-rail__hist-placeholder" />
          )}
        </div>
      </div>
    </aside>
  );
}

function RailRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="cull-exif-rail__row">
      <span className="cull-exif-rail__k">{k}</span>
      <span className="cull-exif-rail__v">{v}</span>
    </div>
  );
}

/**
 * Compare-mode rail: two-column comparison of champion vs challenger metadata.
 * Differences are highlighted in champagne. Same Frame + Exposure section spec
 * as the loupe rail.
 */
export function CompareExifRail({
  championName,
  challengerName,
  championMeta,
  challengerMeta,
  championRating,
  challengerRating,
}: {
  championName: string;
  challengerName: string;
  championMeta: ImageMetadata | undefined;
  challengerMeta: ImageMetadata | undefined;
  championRating?: Rating;
  challengerRating?: Rating;
}) {
  // Build comparable string values for each row, allowing diff detection.
  const champTime = formatTime(championMeta?.capturedAt ?? null);
  const challTime = formatTime(challengerMeta?.capturedAt ?? null);
  const frameRows: { k: string; a: string; b: string }[] = [
    { k: "File", a: stripExtName(championName), b: stripExtName(challengerName) },
    { k: "Body", a: championMeta?.camera ?? "—", b: challengerMeta?.camera ?? "—" },
    { k: "Lens", a: championMeta?.lens ?? "—", b: challengerMeta?.lens ?? "—" },
    { k: "Time", a: champTime ?? "—", b: challTime ?? "—" },
  ];

  const lrcA = championMeta?.lrcRating ?? null;
  const lrcB = challengerMeta?.lrcRating ?? null;
  const showLrcA = hasLrcRating(lrcA, championRating);
  const showLrcB = hasLrcRating(lrcB, challengerRating);
  const lrcRow =
    showLrcA || showLrcB
      ? {
          k: "LrC rating",
          a: showLrcA && lrcA != null ? `${lrcA}★` : "—",
          b: showLrcB && lrcB != null ? `${lrcB}★` : "—",
        }
      : null;

  const exposureRows: { k: string; a: string; b: string }[] = [
    {
      k: "Shutter",
      a: formatShutter(championMeta?.shutterSeconds ?? null) ?? "—",
      b: formatShutter(challengerMeta?.shutterSeconds ?? null) ?? "—",
    },
    {
      k: "Aperture",
      a: championMeta?.aperture != null ? `ƒ/${championMeta.aperture}` : "—",
      b: challengerMeta?.aperture != null ? `ƒ/${challengerMeta.aperture}` : "—",
    },
    {
      k: "ISO",
      a: championMeta?.iso != null ? `${championMeta.iso}` : "—",
      b: challengerMeta?.iso != null ? `${challengerMeta.iso}` : "—",
    },
    {
      k: "Focal",
      a: championMeta?.focalLengthMm != null ? `${championMeta.focalLengthMm.toFixed(0)} mm` : "—",
      b:
        challengerMeta?.focalLengthMm != null
          ? `${challengerMeta.focalLengthMm.toFixed(0)} mm`
          : "—",
    },
    {
      k: "EV",
      // Drop the redundant " EV" suffix — the row label already says EV.
      a: (formatExposureBias(championMeta?.exposureBias ?? null) ?? "—").replace(/ EV$/, ""),
      b: (formatExposureBias(challengerMeta?.exposureBias ?? null) ?? "—").replace(/ EV$/, ""),
    },
    {
      k: "WB",
      a: formatWhiteBalance(championMeta?.whiteBalance ?? null) ?? "—",
      b: formatWhiteBalance(challengerMeta?.whiteBalance ?? null) ?? "—",
    },
  ];

  return (
    <aside className="cull-exif-rail cull-exif-rail--compare" aria-label="Compare info">
      <div className="cull-cr-rail__head">
        <span />
        <span className="cull-cr-rail__col cull-cr-rail__col--champion">Champion</span>
        <span className="cull-cr-rail__col cull-cr-rail__col--challenger">Challenger</span>
      </div>

      <div className="cull-exif-rail__section">
        <div className="cull-exif-rail__label">Frame</div>
        <div className="cull-exif-rail__rows">
          {frameRows.map((r) => (
            <CompareRow key={r.k} k={r.k} a={r.a} b={r.b} />
          ))}
          {lrcRow && <CompareRow k={lrcRow.k} a={lrcRow.a} b={lrcRow.b} />}
        </div>
      </div>

      <div className="cull-exif-rail__section">
        <div className="cull-exif-rail__label">Exposure</div>
        <div className="cull-exif-rail__rows">
          {exposureRows.map((r) => (
            <CompareRow key={r.k} k={r.k} a={r.a} b={r.b} />
          ))}
        </div>
      </div>
    </aside>
  );
}

function CompareRow({ k, a, b }: { k: string; a: string; b: string }) {
  const diff = a !== b && a !== "—" && b !== "—";
  return (
    <div className={`cull-cr-rail__row${diff ? " is-diff" : ""}`}>
      <span className="cull-cr-rail__k">{k}</span>
      <span className="cull-cr-rail__v">{a}</span>
      <span className="cull-cr-rail__v">{b}</span>
    </div>
  );
}

function formatTime(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function stripExtName(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(0, dot) : filename;
}
