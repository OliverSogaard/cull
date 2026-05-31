import type { ImageMetadata } from "../types";
import {
  formatCaptureTime,
  formatDimensions,
  formatDrive,
  formatExposureBias,
  formatFileSize,
  formatShutter,
  formatWhiteBalance,
} from "../utils/format";

/**
 * Shared EXIF readout (filename + grid + RGB histogram). Used by single view
 * and both compare panels so the (i) overlay is byte-for-byte identical
 * wherever it appears.
 *
 * Missing fields collapse silently — every formatter returns `null` for
 * absent inputs, and the lines join with `filter(Boolean)`.
 */
export function ExifPanel({
  filename,
  metadata,
  histogramUrl,
}: {
  filename: string;
  metadata: ImageMetadata | undefined;
  histogramUrl: string | undefined;
}) {
  const captureTime = formatCaptureTime(metadata?.capturedAt ?? null);
  const shutter = formatShutter(metadata?.shutterSeconds ?? null);
  const exposureLine = [
    formatExposureBias(metadata?.exposureBias ?? null),
    formatWhiteBalance(metadata?.whiteBalance ?? null),
    formatDrive(metadata?.driveMode ?? null),
  ]
    .filter(Boolean)
    .join("  ·  ");
  const fileLine = [
    formatDimensions(metadata?.pixelWidth ?? null, metadata?.pixelHeight ?? null),
    formatFileSize(metadata?.fileSize ?? null),
  ]
    .filter(Boolean)
    .join("  ·  ");
  return (
    <div className="cull-exif">
      <div className="cull-exif__filename">{filename}</div>
      {metadata ? (
        <div className="cull-exif__grid">
          {metadata.camera && <span>{metadata.camera}</span>}
          {(metadata.lens || metadata.focalLengthMm != null) && (
            <span>
              {metadata.lens ?? "—"}
              {metadata.focalLengthMm != null && ` @ ${metadata.focalLengthMm.toFixed(0)}mm`}
            </span>
          )}
          <span>
            {metadata.aperture != null && `ƒ/${metadata.aperture}`}
            {shutter && ` · ${shutter}`}
            {metadata.iso != null && ` · ISO ${metadata.iso}`}
          </span>
          {exposureLine && <span>{exposureLine}</span>}
          {captureTime && <span className="cull-exif__row--dim">{captureTime}</span>}
          {fileLine && <span className="cull-exif__row--dim">{fileLine}</span>}
          {metadata.gpsLat != null && metadata.gpsLon != null && (
            <span className="cull-exif__row--dim">
              {metadata.gpsLat.toFixed(4)}, {metadata.gpsLon.toFixed(4)}
            </span>
          )}
        </div>
      ) : (
        <div className="cull-exif__grid cull-exif__row--dim">reading metadata…</div>
      )}
      {histogramUrl && <img className="cull-histogram" src={histogramUrl} alt="RGB histogram" />}
    </div>
  );
}
