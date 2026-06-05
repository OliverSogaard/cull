/**
 * Pure per-pixel scanners for the analysis-overlay masks (clipping, focus
 * peaking). Read an RGBA `src` buffer and write into an RGBA `m` (mask) buffer.
 *
 * Extracted so the clipping and peaking generators share one implementation
 * (they differ ONLY in this loop) and so the same code can later run inside an
 * OffscreenCanvas Web Worker — these functions touch no DOM and no React.
 */
export type MaskKind = "clip" | "peak";

/**
 * Clipping mask: diagonal stripes where ALL THREE channels are blown (≥250 →
 * red, 45°) or crushed (≤5 → blue, −45°). All-three-channel detection avoids
 * false positives on saturated colours (a yellow flower ≈ R255 G210 B0 would
 * trip a single-channel blue=0 test).
 */
function clipScan(src: Uint8ClampedArray, m: Uint8ClampedArray, w: number, h: number): void {
  const PERIOD = 8;
  const STRIPE = 3;
  for (let i = 0; i < src.length; i += 4) {
    const r = src[i];
    const g = src[i + 1];
    const b = src[i + 2];
    const idx = i >> 2;
    const x = idx % w;
    const y = (idx / w) | 0;
    if (r >= 250 && g >= 250 && b >= 250) {
      if ((x + y) % PERIOD < STRIPE) {
        m[i] = 239;
        m[i + 1] = 68;
        m[i + 2] = 68;
        m[i + 3] = 215;
      }
    } else if (r <= 5 && g <= 5 && b <= 5) {
      if ((x - y + h) % PERIOD < STRIPE) {
        m[i] = 59;
        m[i + 1] = 130;
        m[i + 2] = 246;
        m[i + 3] = 215;
      }
    }
  }
}

/**
 * Focus peaking: warm-yellow stipple on pixels whose luminance gradient is
 * strong (in-focus edges). Luminance via cheap (R + 2G + B)/4; central
 * differences; borders left transparent (they'd false-trigger on the letterbox).
 */
function peakScan(src: Uint8ClampedArray, m: Uint8ClampedArray, w: number, h: number): void {
  const THRESHOLD = 60;
  for (let y = 1; y < h - 1; y++) {
    const rowAbove = (y - 1) * w * 4;
    const rowBelow = (y + 1) * w * 4;
    const row = y * w * 4;
    for (let x = 1; x < w - 1; x++) {
      const ixL = row + (x - 1) * 4;
      const ixR = row + (x + 1) * 4;
      const ixU = rowAbove + x * 4;
      const ixD = rowBelow + x * 4;
      const lumL = (src[ixL] + 2 * src[ixL + 1] + src[ixL + 2]) >> 2;
      const lumR = (src[ixR] + 2 * src[ixR + 1] + src[ixR + 2]) >> 2;
      const lumU = (src[ixU] + 2 * src[ixU + 1] + src[ixU + 2]) >> 2;
      const lumD = (src[ixD] + 2 * src[ixD + 1] + src[ixD + 2]) >> 2;
      const grad = Math.abs(lumR - lumL) + Math.abs(lumD - lumU);
      if (grad > THRESHOLD) {
        const o = row + x * 4;
        m[o] = 252; // R
        m[o + 1] = 211; // G
        m[o + 2] = 77; // B (warm yellow)
        m[o + 3] = 215; // alpha
      }
    }
  }
}

export function runMaskScan(
  kind: MaskKind,
  src: Uint8ClampedArray,
  m: Uint8ClampedArray,
  w: number,
  h: number,
): void {
  if (kind === "clip") clipScan(src, m, w, h);
  else peakScan(src, m, w, h);
}
