import { useMemo } from "react";
import type { ImageMetadata, Rating } from "../types";
import {
  formatAperture,
  formatDimensions,
  formatExposureBiasShort,
  formatFileSize,
  formatFocal,
  formatIso,
  formatShutter,
  formatTime,
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
  const timeStr = formatTime(captured);
  const date = captured ? new Date(captured) : null;
  const dateOK = date && !Number.isNaN(date.getTime());
  const dateStr = dateOK
    ? date!.toLocaleDateString(undefined, { year: "numeric", month: "2-digit", day: "2-digit" })
    : null;
  const dimensions = formatDimensions(meta?.pixelWidth ?? null, meta?.pixelHeight ?? null);
  const size = formatFileSize(meta?.fileSize ?? null);
  const lrc = meta?.lrcRating ?? null;
  const showLrc = hasLrcRating(lrc, cullRating);

  // Exposure section
  const shutter = formatShutter(meta?.shutterSeconds ?? null);
  const aperture = formatAperture(meta?.aperture ?? null);
  const iso = formatIso(meta?.iso ?? null);
  const focal = formatFocal(meta?.focalLengthMm ?? null);
  // The row label is already "EV", so use the suffix-less formatter.
  const ev = formatExposureBiasShort(meta?.exposureBias ?? null);
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
          {dimensions && <RailRow k="Dimensions" v={dimensions} />}
          {size && <RailRow k="Size" v={size} />}
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
          {!body && !lens && !timeStr && !dateStr && !dimensions && !size && !showLrc && (
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
  // Memoized so the ~14 formatter calls don't re-run on every App re-render
  // (each keystroke / champShot/chalShot store-notify); the per-path meta objects
  // keep a stable ref once loaded, so this bails out unless these two frames change.
  const { frameRows, lrcRow, exposureRows } = useMemo(() => {
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
        a: formatAperture(championMeta?.aperture ?? null) ?? "—",
        b: formatAperture(challengerMeta?.aperture ?? null) ?? "—",
      },
      {
        k: "ISO",
        a: formatIso(championMeta?.iso ?? null) ?? "—",
        b: formatIso(challengerMeta?.iso ?? null) ?? "—",
      },
      {
        k: "Focal",
        a: formatFocal(championMeta?.focalLengthMm ?? null) ?? "—",
        b: formatFocal(challengerMeta?.focalLengthMm ?? null) ?? "—",
      },
      {
        k: "EV",
        // Row label already says EV → suffix-less formatter.
        a: formatExposureBiasShort(championMeta?.exposureBias ?? null) ?? "—",
        b: formatExposureBiasShort(challengerMeta?.exposureBias ?? null) ?? "—",
      },
      {
        k: "WB",
        a: formatWhiteBalance(championMeta?.whiteBalance ?? null) ?? "—",
        b: formatWhiteBalance(challengerMeta?.whiteBalance ?? null) ?? "—",
      },
    ];
    return { frameRows, lrcRow, exposureRows };
  }, [
    championName,
    challengerName,
    championMeta,
    challengerMeta,
    championRating,
    challengerRating,
  ]);

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

function stripExtName(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(0, dot) : filename;
}
