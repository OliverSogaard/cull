import { useMemo } from "react";
import { stripExt } from "../utils/path";
import type { ImageMetadata, Rating } from "../types";
import type { Suggestion } from "../smart/deriveVerdict";
import type { BurstCtx } from "../smart/groupBursts";
import type { SimilarCtx } from "../smart/groupSimilar";
import {
  formatAperture,
  formatExposureBiasShort,
  formatFocal,
  formatImageSize,
  formatIso,
  formatShutter,
  formatTime,
  formatWhiteBalance,
} from "../utils/format";
import { hasLrcRating } from "../utils/ratingColor";

/**
 * Loupe-side EXIF rail. A 290-px column glued to the right
 * edge of the photo stage when (i) is on. Three sections — Frame, Exposure,
 * Histogram — each labelled with the mono champagne uppercase eyebrow.
 *
 * The rail mounts as a sibling of the photo stage so the photo area shrinks when
 * info is on, rather than floating over the photo.
 */
export function ExifRail({
  metadata,
  histogramUrl,
  cullRating,
  suggestion,
  burst,
  similar,
}: {
  metadata: ImageMetadata | undefined;
  histogramUrl: string | undefined;
  cullRating?: Rating;
  /** Smart-culling suggestion for the current frame — the ONLY place
   *  confidence is shown. Rendered only while the frame is unrated. */
  suggestion?: Suggestion | null;
  /** Burst membership — shown regardless of rating/verdict, so the analysis
   *  is visible even when it has nothing to suggest. */
  burst?: BurstCtx | null;
  /** Similar set membership — shown regardless of rating/verdict, so the analysis
   *  is visible even when it has nothing to suggest. */
  similar?: SimilarCtx | null;
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
    ? date.toLocaleDateString(undefined, { year: "numeric", month: "2-digit", day: "2-digit" })
    : null;
  const imageSize = formatImageSize(
    meta?.pixelWidth ?? null,
    meta?.pixelHeight ?? null,
    meta?.fileSize ?? null,
  );
  const lrc = meta?.lrcRating ?? null;
  const showLrc = hasLrcRating(lrc);

  // Exposure section
  const shutter = formatShutter(meta?.shutterSeconds ?? null);
  const aperture = formatAperture(meta?.aperture ?? null);
  const iso = formatIso(meta?.iso ?? null);
  const focal = formatFocal(meta?.focalLengthMm ?? null);
  // The row label is already "EV", so use the suffix-less formatter.
  const ev = formatExposureBiasShort(meta?.exposureBias ?? null);
  const wb = formatWhiteBalance(meta?.whiteBalance ?? null);

  const ghost = !cullRating && suggestion?.verdict ? suggestion : null;

  return (
    <aside className="cull-exif-rail" aria-label="Image info">
      {ghost && (
        <div className="cull-exif-rail__section">
          <div className="cull-exif-rail__label">Suggestion</div>
          <div className="cull-exif-rail__rows">
            <div className="cull-exif-rail__row">
              <span className={`cull-exif-rail__k cull-exif-rail__suggest--${ghost.verdict}`}>
                {ghost.verdict === "reject"
                  ? "Reject"
                  : ghost.verdict === "favorite"
                    ? "Favorite"
                    : "Keep"}{" "}
                · {Math.round(ghost.confidence * 100)}%
              </span>
              <span className="cull-exif-rail__v cull-exif-rail__v--dim">
                {ghost.reasons.join(", ")}
              </span>
            </div>
          </div>
        </div>
      )}
      <div className="cull-exif-rail__section">
        <div className="cull-exif-rail__label">Frame</div>
        <div className="cull-exif-rail__rows">
          {body && <RailRow k="Body" v={body} />}
          {lens && <RailRow k="Lens" v={lens} />}
          {timeStr && <RailRow k="Time" v={timeStr} />}
          {dateStr && <RailRow k="Date" v={dateStr} />}
          {imageSize && <RailRow k="Image" v={imageSize} />}
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
          {!body && !lens && !timeStr && !dateStr && !imageSize && !showLrc && (
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

      {/* Burst membership — its own section at the BOTTOM: bursts are a fact
          about the shoot (shown with smart culling off too), not a suggestion. */}
      {burst && (
        <div className="cull-exif-rail__section">
          <div className="cull-exif-rail__label">Burst</div>
          <div className="cull-exif-rail__rows">
            <RailRow k="Frame" v={`${burst.pos} of ${burst.len}`} />
          </div>
        </div>
      )}

      {/* Similar set membership — its own section: similar sets are ALSO a
          standing fact about the shoot, like bursts (the pHash tier rides
          every frame's thumbnail), so this renders with smart culling off too. */}
      {similar && (
        <div className="cull-exif-rail__section">
          <div className="cull-exif-rail__label">Similar set</div>
          <div className="cull-exif-rail__rows">
            <RailRow k="Frame" v={`${similar.pos} of ${similar.len}`} />
          </div>
        </div>
      )}
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
  championSuggestion,
  challengerSuggestion,
}: {
  championName: string;
  challengerName: string;
  championMeta: ImageMetadata | undefined;
  challengerMeta: ImageMetadata | undefined;
  /** Smart-culling suggestions per side (unrated frames only) — rendered as
   *  a two-column Suggestion section at the top, mirroring the loupe rail. */
  championSuggestion?: Suggestion | null;
  challengerSuggestion?: Suggestion | null;
}) {
  // Build comparable string values for each row, allowing diff detection.
  // Memoized so the ~14 formatter calls don't re-run on every App re-render
  // (each keystroke / champShot/chalShot store-notify); the per-path meta objects
  // keep a stable ref once loaded, so this bails out unless these two frames change.
  const { frameRows, lrcRow, exposureRows } = useMemo(() => {
    const champTime = formatTime(championMeta?.capturedAt ?? null);
    const challTime = formatTime(challengerMeta?.capturedAt ?? null);
    const frameRows: { k: string; a: string; b: string }[] = [
      { k: "File", a: stripExt(championName), b: stripExt(challengerName) },
      { k: "Body", a: championMeta?.camera ?? "—", b: challengerMeta?.camera ?? "—" },
      { k: "Lens", a: championMeta?.lens ?? "—", b: challengerMeta?.lens ?? "—" },
      { k: "Time", a: champTime ?? "—", b: challTime ?? "—" },
      {
        k: "Image",
        a:
          formatImageSize(
            championMeta?.pixelWidth ?? null,
            championMeta?.pixelHeight ?? null,
            championMeta?.fileSize ?? null,
          ) ?? "—",
        b:
          formatImageSize(
            challengerMeta?.pixelWidth ?? null,
            challengerMeta?.pixelHeight ?? null,
            challengerMeta?.fileSize ?? null,
          ) ?? "—",
      },
    ];

    const lrcA = championMeta?.lrcRating ?? null;
    const lrcB = challengerMeta?.lrcRating ?? null;
    const showLrcA = hasLrcRating(lrcA);
    const showLrcB = hasLrcRating(lrcB);
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
  }, [championName, challengerName, championMeta, challengerMeta]);

  return (
    <aside className="cull-exif-rail cull-exif-rail--compare" aria-label="Compare info">
      <div className="cull-cr-rail__head">
        <span />
        <span className="cull-cr-rail__col cull-cr-rail__col--champion">Champion</span>
        <span className="cull-cr-rail__col cull-cr-rail__col--challenger">Challenger</span>
      </div>

      {(championSuggestion?.verdict || challengerSuggestion?.verdict) && (
        <div className="cull-exif-rail__section">
          <div className="cull-exif-rail__label">Suggestion</div>
          <div className="cull-exif-rail__rows">
            <div className="cull-cr-rail__row">
              <span className="cull-cr-rail__k">Verdict</span>
              <SuggestCell s={championSuggestion} />
              <SuggestCell s={challengerSuggestion} />
            </div>
            <div className="cull-cr-rail__row">
              <span className="cull-cr-rail__k">Why</span>
              <span className="cull-cr-rail__v cull-exif-rail__v--dim">
                {championSuggestion?.verdict ? championSuggestion.reasons.join(", ") : "—"}
              </span>
              <span className="cull-cr-rail__v cull-exif-rail__v--dim">
                {challengerSuggestion?.verdict ? challengerSuggestion.reasons.join(", ") : "—"}
              </span>
            </div>
          </div>
        </div>
      )}

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

/** One side's verdict cell: colored like the loupe rail's Suggestion line. */
function SuggestCell({ s }: { s?: Suggestion | null }) {
  if (!s?.verdict) return <span className="cull-cr-rail__v">—</span>;
  return (
    <span className={`cull-cr-rail__v cull-exif-rail__suggest--${s.verdict}`}>
      {s.verdict === "reject" ? "Reject" : s.verdict === "favorite" ? "Favorite" : "Keep"} ·{" "}
      {Math.round(s.confidence * 100)}%
    </span>
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

