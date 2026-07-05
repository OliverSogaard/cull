//! Smart-culling Phase 1: classical per-file quality metrics (SMART_CULLING_PLAN.md).
//!
//! The backend computes RAW PER-FILE METRICS ONLY — all cross-frame derivation
//! (burst grouping, winner selection, verdicts) lives in pure TS over the
//! accumulated scores, so it is chunk-boundary-safe and re-derives instantly on
//! settings changes. Nothing here writes anything, anywhere: the never-modify-CR3
//! and never-auto-rate invariants are structural (this module has no write path).
//!
//! Metric core is pure functions over decoded RGB buffers (fully unit-testable
//! without files); the chunk driver takes the per-file fetch as an injected
//! closure so cancellation and decode-failure semantics are testable the same way.
//! The [`analyze_quality`] command runs one chunk under ONE IoGate permit with
//! the Full-tier timeout (chunks are small by frontend contract); each file's
//! bytes come from [`crate::bundle::fetch_decoded_preview`] — prvw tier-cache
//! probe first, one `read_preview_bundle` head read on miss (which also
//! piggy-back-fills the cache, pre-warming navigation).

use std::sync::Arc;
use tauri::State;

use crate::bundle;
use crate::io_gate::{IoGate, SessionGate, Tier};
use crate::tier_cache::TierCache;

/// All-3-channel clip thresholds — faithful port of `clipScan`'s test
/// (`src/overlays/maskScans.ts`): a pixel is blown/crushed only when EVERY
/// channel crosses, so saturated single hues never count.
const CLIP_HIGH: u8 = 250;
const CLIP_LOW: u8 = 5;
/// Motion-blur heuristic: handheld reciprocal rule, blur_thresh ≈ 1/(K·focal).
const HANDHELD_RECIPROCAL_K: f64 = 1.0;
/// AF crop is a square of `AF_CROP_FRAC · min(w, h)` centred on the mapped AF point.
const AF_CROP_FRAC: f32 = 0.20;
/// Sharpness normalization: af_sharpness = clamp(log1p(varLap / max(floor, EPS)) / SCALE).
/// SCALE starting value from synthetic calibration; the Phase-1 corpus calibration
/// harness re-tunes it against real PRVWs.
const LOG_SHARP_SCALE: f32 = 12.0;
const NOISE_FLOOR_EPS: f64 = 1e-3;
/// Noise floor = median Laplacian variance over this many lowest-variance tiles.
const NOISE_TILES: usize = 16;
/// Tile edge for the noise-floor scan (PRVW is 1620×1080 → ~13×8 grid of 128px tiles).
const NOISE_TILE_PX: usize = 128;

/// Raw per-file metrics + the per-file inputs TS-side grouping needs, echoed
/// from the same head read. Wire shape is pinned by SMART_CULLING_PLAN.md —
/// camelCase, mirrors `meta.rs`.
#[derive(Clone, Debug, serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImageScore {
    /// ABSOLUTE input-order index into the dispatched full list
    /// (`chunk_start` + within-chunk offset).
    pub index: usize,
    // Tier 1 (classical, MVP)
    pub af_sharpness: f32,
    pub af_valid: bool,
    pub af_texture: f32,
    pub global_sharpness: f32,
    pub noise_floor: f32,
    pub blown_pct: f32,
    pub crushed_pct: f32,
    pub exposure_score: f32,
    pub motion_blur_likelihood: f32,
    /// Sobel cross-check for `af_sharpness`, same normalization — TS lowers
    /// confidence when the two sharpness signals disagree hard (plan formula;
    /// the field was implied but missing from the plan's first struct draft).
    pub tenengrad: f32,
    // Per-file inputs for TS-side burst grouping (the frontend holds no timestamps).
    pub mtime_ms: i64,
    pub drive_mode: Option<u32>,
    pub focal_length_mm: Option<f32>,
    pub shutter_seconds: Option<f64>,
    pub iso: Option<u32>,
    pub sub_sec_ms: Option<u16>,
    /// captured_at + SubSec combined to ms (camera local clock; deltas only).
    /// None ⇒ TS burst grouping falls back to mtime deltas for this frame.
    pub captured_at_ms: Option<i64>,
    // Tier 2 (ML, later) — present now so the wire contract is stable.
    pub faces: Vec<FaceScore>,
    pub aesthetic: Option<f32>,
    pub decode_ok: bool,
}

#[derive(Clone, Debug, serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FaceScore {
    pub bbox: [f32; 4],
    pub eyes_open: f32,
    pub face_sharpness: f32,
}

/// One decoded preview + the metadata the metrics and TS grouping consume.
/// Produced by the command's fetch path (tier-cache probe → `read_preview_bundle`);
/// injected into [`score_chunk`] as a closure result so tests never touch disk.
pub(crate) struct DecodedInput {
    pub rgb: Vec<u8>, // tightly packed RGB8, w*h*3
    pub w: usize,
    pub h: usize,
    pub orientation: u32,
    pub af_x_pct: Option<f32>, // display coords, 0..100 (meta.rs convention)
    pub af_y_pct: Option<f32>,
    pub mtime_ms: i64,
    pub drive_mode: Option<u32>,
    pub focal_length_mm: Option<f32>,
    pub shutter_seconds: Option<f64>,
    pub iso: Option<u32>,
    pub sub_sec_ms: Option<u16>,
    pub captured_at: Option<String>,
}

/// Inclusive-exclusive pixel rect in SENSOR (decoded-buffer) coordinates.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Rect {
    pub x0: usize,
    pub y0: usize,
    pub x1: usize,
    pub y1: usize,
}

/// Interior of `rect` clamped one pixel inside the buffer, so 3×3 kernels
/// never read out of bounds. Returns None when nothing remains.
fn kernel_interior(w: usize, h: usize, rect: Rect) -> Option<Rect> {
    let x0 = rect.x0.max(1);
    let y0 = rect.y0.max(1);
    let x1 = rect.x1.min(w.saturating_sub(1));
    let y1 = rect.y1.min(h.saturating_sub(1));
    (x1 > x0 && y1 > y0).then_some(Rect { x0, y0, x1, y1 })
}

/// Variance of the 4-neighbour Laplacian over `rect` of a luma buffer
/// (Welford one-pass). Flat input → ~0. Higher = more edge energy.
pub(crate) fn var_laplacian(luma: &[u8], w: usize, h: usize, rect: Rect) -> f64 {
    let Some(r) = kernel_interior(w, h, rect) else { return 0.0 };
    let (mut n, mut mean, mut m2) = (0f64, 0f64, 0f64);
    for y in r.y0..r.y1 {
        for x in r.x0..r.x1 {
            let c = luma[y * w + x] as f64;
            let lap = 4.0 * c
                - luma[(y - 1) * w + x] as f64
                - luma[(y + 1) * w + x] as f64
                - luma[y * w + x - 1] as f64
                - luma[y * w + x + 1] as f64;
            n += 1.0;
            let d = lap - mean;
            mean += d / n;
            m2 += d * (lap - mean);
        }
    }
    if n < 2.0 { 0.0 } else { m2 / n }
}

/// Tenengrad (mean squared Sobel magnitude) over `rect` — the cross-check signal.
pub(crate) fn tenengrad(luma: &[u8], w: usize, h: usize, rect: Rect) -> f64 {
    let Some(r) = kernel_interior(w, h, rect) else { return 0.0 };
    let px = |x: usize, y: usize| luma[y * w + x] as f64;
    let (mut sum, mut n) = (0f64, 0f64);
    for y in r.y0..r.y1 {
        for x in r.x0..r.x1 {
            let gx = px(x + 1, y - 1) + 2.0 * px(x + 1, y) + px(x + 1, y + 1)
                - px(x - 1, y - 1)
                - 2.0 * px(x - 1, y)
                - px(x - 1, y + 1);
            let gy = px(x - 1, y + 1) + 2.0 * px(x, y + 1) + px(x + 1, y + 1)
                - px(x - 1, y - 1)
                - 2.0 * px(x, y - 1)
                - px(x + 1, y - 1);
            sum += gx * gx + gy * gy;
            n += 1.0;
        }
    }
    if n == 0.0 { 0.0 } else { sum / n }
}

/// Noise floor: LOWER median Laplacian variance over the [`NOISE_TILES`]
/// lowest-variance [`NOISE_TILE_PX`] tiles — an estimate of how much variance a
/// FLAT region carries (the sensor-noise contribution at this ISO/processing).
/// Lower-median on purpose: the floor should under-estimate, never over-estimate,
/// or real detail gets discounted as noise.
pub(crate) fn noise_floor(luma: &[u8], w: usize, h: usize) -> f64 {
    let mut vars: Vec<f64> = Vec::new();
    let (tx, ty) = (w / NOISE_TILE_PX, h / NOISE_TILE_PX);
    for j in 0..ty {
        for i in 0..tx {
            vars.push(var_laplacian(
                luma,
                w,
                h,
                Rect {
                    x0: i * NOISE_TILE_PX,
                    y0: j * NOISE_TILE_PX,
                    x1: (i + 1) * NOISE_TILE_PX,
                    y1: (j + 1) * NOISE_TILE_PX,
                },
            ));
        }
    }
    if vars.is_empty() {
        // Buffer smaller than one tile: the whole frame is the only sample.
        return var_laplacian(luma, w, h, Rect { x0: 0, y0: 0, x1: w, y1: h });
    }
    vars.sort_by(|a, b| a.total_cmp(b));
    let k = vars.len().min(NOISE_TILES);
    vars[(k - 1) / 2]
}

/// Noise-normalized 0..1 sharpness: clamp(log1p(var / max(floor, EPS)) / LOG_SHARP_SCALE).
pub(crate) fn normalize_sharpness(var: f64, floor: f64) -> f32 {
    let ratio = var / floor.max(NOISE_FLOOR_EPS);
    ((ratio.ln_1p() / LOG_SHARP_SCALE as f64) as f32).clamp(0.0, 1.0)
}

/// AF-crop judgeability: p95 − p5 luma spread over `rect`, 0..1. Low spread ⇒
/// smooth subject (skin/sky/bokeh) ⇒ sharpness there is unjudgeable.
pub(crate) fn texture_spread(luma: &[u8], w: usize, h: usize, rect: Rect) -> f32 {
    let mut hist = [0u32; 256];
    let mut n = 0u32;
    for y in rect.y0..rect.y1.min(h) {
        for x in rect.x0..rect.x1.min(w) {
            hist[luma[y * w + x] as usize] += 1;
            n += 1;
        }
    }
    if n == 0 {
        return 0.0;
    }
    let pct = |target: u32| -> u8 {
        let mut acc = 0u32;
        for (v, &c) in hist.iter().enumerate() {
            acc += c;
            if acc >= target {
                return v as u8;
            }
        }
        255
    };
    let p5 = pct(n.div_ceil(20)); // 5%
    let p95 = pct(n - n / 20); // 95%
    (p95.saturating_sub(p5)) as f32 / 255.0
}

/// All-3-channel blown/crushed fractions over the RGB buffer, 0..1 each.
pub(crate) fn clip_pcts(rgb: &[u8]) -> (f32, f32) {
    let n = rgb.len() / 3;
    if n == 0 {
        return (0.0, 0.0);
    }
    let (mut blown, mut crushed) = (0usize, 0usize);
    for p in rgb.chunks_exact(3) {
        if p[0] >= CLIP_HIGH && p[1] >= CLIP_HIGH && p[2] >= CLIP_HIGH {
            blown += 1;
        } else if p[0] <= CLIP_LOW && p[1] <= CLIP_LOW && p[2] <= CLIP_LOW {
            crushed += 1;
        }
    }
    (blown as f32 / n as f32, crushed as f32 / n as f32)
}

/// 0..1 exposure quality from a 64-bin luma histogram: peaks when the
/// distribution centres mid-tone (~118), falls linearly toward the extremes.
pub(crate) fn exposure_score(luma: &[u8]) -> f32 {
    if luma.is_empty() {
        return 0.0;
    }
    let mut bins = [0u64; 64];
    for &v in luma {
        bins[(v >> 2) as usize] += 1;
    }
    let total: u64 = bins.iter().sum();
    let mean: f64 = bins
        .iter()
        .enumerate()
        .map(|(b, &c)| (b as f64 * 4.0 + 2.0) * c as f64)
        .sum::<f64>()
        / total as f64;
    const MID: f64 = 118.0;
    (1.0 - ((mean - MID).abs() / (255.0 - MID)) as f32).clamp(0.0, 1.0)
}

/// Map a DISPLAY-coordinate AF point (percent, orientation-applied — see
/// `af_display` in cr3.rs) back through the INVERSE of `orientation` into the
/// un-rotated sensor frame of the decoded PRVW, and build the AF crop rect.
/// Returns `(rect, af_valid)`; AF absent → centred crop + `false`.
/// Orientations 6/8 swap the axes — the correctness trap the plan calls out.
pub(crate) fn af_crop(
    orientation: u32,
    af_x_pct: Option<f32>,
    af_y_pct: Option<f32>,
    w: usize,
    h: usize,
) -> (Rect, bool) {
    let side = ((AF_CROP_FRAC * w.min(h) as f32) as usize).clamp(1, w.min(h));
    let (cx, cy, valid) = match (af_x_pct, af_y_pct) {
        (Some(xp), Some(yp)) => {
            let (xd, yd) = ((xp / 100.0).clamp(0.0, 1.0), (yp / 100.0).clamp(0.0, 1.0));
            // Inverse of the display mapping with_exif_orientation implies:
            //   o=6: display = sensor rotated 90° CW  (xd = 1−ys, yd = xs)
            //   o=8: display = sensor rotated 90° CCW (xd = ys,   yd = 1−xs)
            let (xs, ys) = match orientation {
                3 => (1.0 - xd, 1.0 - yd),
                6 => (yd, 1.0 - xd),
                8 => (1.0 - yd, xd),
                _ => (xd, yd), // 1 + the never-emitted mirror values
            };
            (xs * w as f32, ys * h as f32, true)
        }
        _ => (w as f32 / 2.0, h as f32 / 2.0, false),
    };
    let x0 = ((cx - side as f32 / 2.0).round().max(0.0) as usize).min(w - side);
    let y0 = ((cy - side as f32 / 2.0).round().max(0.0) as usize).min(h - side);
    (Rect { x0, y0, x1: x0 + side, y1: y0 + side }, valid)
}

/// Motion-blur likelihood: clamp(shutter / blur_thresh) · (1 − global_sharpness),
/// blur_thresh = HANDHELD_RECIPROCAL_K / focal_mm. Missing shutter/focal → 0.
pub(crate) fn motion_blur_likelihood(
    shutter_seconds: Option<f64>,
    focal_length_mm: Option<f32>,
    global_sharpness: f32,
) -> f32 {
    let (Some(shutter), Some(focal)) = (shutter_seconds, focal_length_mm) else {
        return 0.0;
    };
    if focal <= 0.0 || shutter <= 0.0 {
        return 0.0;
    }
    let blur_thresh = HANDHELD_RECIPROCAL_K / focal as f64;
    ((shutter / blur_thresh).clamp(0.0, 1.0) as f32) * (1.0 - global_sharpness.clamp(0.0, 1.0))
}

/// Combine `captured_at` ("YYYY-MM-DDTHH:MM:SS", camera local clock) with the
/// SubSec fraction into one epoch-style millisecond value for TS burst deltas.
/// Only DELTAS are ever taken, so the missing timezone is irrelevant. None when
/// the datetime is absent/unparseable; a missing SubSec contributes 0 (second
/// precision — TS falls back to mtime deltas for the fine gap in that case).
pub(crate) fn captured_at_ms(captured_at: Option<&str>, sub_sec_ms: Option<u16>) -> Option<i64> {
    let dt = chrono::NaiveDateTime::parse_from_str(captured_at?, "%Y-%m-%dT%H:%M:%S").ok()?;
    Some(dt.and_utc().timestamp_millis() + sub_sec_ms.unwrap_or(0) as i64)
}

/// Rec.601 integer luma of a packed RGB8 buffer.
fn luma_of(rgb: &[u8]) -> Vec<u8> {
    rgb.chunks_exact(3)
        .map(|p| ((77 * p[0] as u32 + 150 * p[1] as u32 + 29 * p[2] as u32) >> 8) as u8)
        .collect()
}

/// Full metric pass over one decoded preview.
pub(crate) fn score_one(input: &DecodedInput, index: usize) -> ImageScore {
    let (w, h) = (input.w, input.h);
    let luma = luma_of(&input.rgb);
    let full = Rect { x0: 0, y0: 0, x1: w, y1: h };
    let floor = noise_floor(&luma, w, h);
    let (af_rect, af_valid) = af_crop(input.orientation, input.af_x_pct, input.af_y_pct, w, h);

    let af_sharpness = normalize_sharpness(var_laplacian(&luma, w, h, af_rect), floor);
    let global_sharpness = normalize_sharpness(var_laplacian(&luma, w, h, full), floor);
    // Same normalization family for the cross-check: Sobel energy relative to
    // the Sobel energy of the flat tiles' Laplacian floor is not meaningful, so
    // Tenengrad normalizes against its own full-frame flat estimate (the
    // Laplacian floor is a fine proxy — both are noise-driven on flat tiles).
    let tenengrad_norm = normalize_sharpness(tenengrad(&luma, w, h, af_rect), floor.max(1.0));
    let (blown_pct, crushed_pct) = clip_pcts(&input.rgb);

    ImageScore {
        index,
        af_sharpness,
        af_valid,
        af_texture: texture_spread(&luma, w, h, af_rect),
        global_sharpness,
        noise_floor: floor as f32,
        blown_pct,
        crushed_pct,
        exposure_score: exposure_score(&luma),
        motion_blur_likelihood: motion_blur_likelihood(
            input.shutter_seconds,
            input.focal_length_mm,
            global_sharpness,
        ),
        tenengrad: tenengrad_norm,
        mtime_ms: input.mtime_ms,
        drive_mode: input.drive_mode,
        focal_length_mm: input.focal_length_mm,
        shutter_seconds: input.shutter_seconds,
        iso: input.iso,
        sub_sec_ms: input.sub_sec_ms,
        captured_at_ms: captured_at_ms(input.captured_at.as_deref(), input.sub_sec_ms),
        faces: Vec::new(),
        aesthetic: None,
        decode_ok: true,
    }
}

/// Chunk driver: for each path fetch → decode → score, checking `cancelled`
/// BETWEEN files (a folder switch kills the pass within ~one file — whole-chunk
/// `Err("cancelled")`, partial results are dropped like every other gated read).
/// A per-file fetch/decode failure is NOT a chunk failure: it yields a score
/// with `decode_ok = false` and the pass moves on. Indices are ABSOLUTE
/// (`chunk_start + i`).
pub(crate) fn score_chunk(
    paths: &[String],
    chunk_start: usize,
    fetch: &dyn Fn(&str) -> Result<DecodedInput, String>,
    cancelled: &dyn Fn() -> bool,
    // Tier-2 enrichment (faces today): runs on every successfully decoded
    // frame with the input still in hand — a no-op closure when ML is off.
    enrich: &dyn Fn(&DecodedInput, &mut ImageScore),
) -> Result<Vec<ImageScore>, String> {
    let mut out = Vec::with_capacity(paths.len());
    for (i, path) in paths.iter().enumerate() {
        if cancelled() {
            return Err("cancelled".to_string());
        }
        let index = chunk_start + i;
        match fetch(path) {
            Ok(input) => {
                let mut score = score_one(&input, index);
                enrich(&input, &mut score);
                out.push(score);
            }
            Err(_) => out.push(ImageScore { index, decode_ok: false, ..ImageScore::default() }),
        }
    }
    // A cancel that lands during the LAST file must not hand back a chunk
    // computed for a dead generation (frontend gen-guard is the second net).
    if cancelled() {
        return Err("cancelled".to_string());
    }
    Ok(out)
}

/// Chunked quality scoring. `paths` is the CHUNK's paths only — there is no
/// full-list pass anywhere (SMART_CULLING_PLAN.md, final review (a)). `gen` is
/// the session generation: checked between files, threaded into each read, so a
/// folder switch kills the pass within ~one file and the permit frees for the
/// new folder's interactive reads. Progress is frontend-derived from each
/// chunk's return — no event channel needed at these chunk sizes.
#[tauri::command]
pub(crate) async fn analyze_quality(
    paths: Vec<String>,
    chunk_start: usize,
    gen: u64,
    ml: Option<bool>,
    gate: State<'_, Arc<IoGate>>,
    session: State<'_, Arc<SessionGate>>,
    cache: State<'_, Arc<TierCache>>,
) -> Result<Vec<ImageScore>, String> {
    let session = Arc::clone(&session);
    let cache = Arc::clone(&cache);
    let label = format!("analyze_quality({} files @ {chunk_start})", paths.len());
    // Tier-2 opt-in: face detection runs only when the frontend asks AND the
    // build carries the smart-ml feature — otherwise `faces` stays empty on
    // the wire and the flag is silently inert (older/lean builds degrade to
    // Tier-1 with no error surface).
    let want_ml = ml.unwrap_or(false);
    bundle::gated(&gate, Tier::Full, label, move || {
        score_chunk(
            &paths,
            chunk_start,
            &|p| bundle::fetch_decoded_preview(p, gen, &session, &cache),
            &|| session.is_cancelled(gen),
            &|input, score| {
                #[cfg(feature = "smart-ml")]
                if want_ml {
                    attach_faces(input, score);
                }
                #[cfg(not(feature = "smart-ml"))]
                let _ = (input, score, want_ml);
            },
        )
    })
    .await
}

/// Run YuNet on the decoded preview and attach per-face metrics. Face
/// sharpness reuses the Tier-1 machinery: variance-of-Laplacian over the face
/// rect, normalized against the frame's already-computed noise floor — so face
/// and AF sharpness are directly comparable (the TS burst tiebreak relies on
/// that). `eyes_open` (Phase 3b) = min(left, right) OCEC `prob_open` from
/// crops around YuNet's eye landmarks; −1 stays whenever either eye is
/// unclassifiable (no model, degenerate geometry, run failure) — unknown,
/// never a guess.
#[cfg(feature = "smart-ml")]
fn attach_faces(input: &DecodedInput, score: &mut ImageScore) {
    if !score.decode_ok {
        return;
    }
    let dets = crate::faces::detect_faces(&input.rgb, input.w, input.h);
    if dets.is_empty() {
        return;
    }
    let luma = luma_of(&input.rgb);
    let (w, h) = (input.w, input.h);
    score.faces = dets
        .iter()
        .map(|d| {
            let rect = Rect {
                x0: d.x.max(0.0) as usize,
                y0: d.y.max(0.0) as usize,
                x1: ((d.x + d.w) as usize).min(w),
                y1: ((d.y + d.h) as usize).min(h),
            };
            let sharp = normalize_sharpness(
                var_laplacian(&luma, w, h, rect),
                score.noise_floor as f64,
            );
            // Phase 3b: OCEC on both eye landmarks (kps 0/1 = right/left eye).
            let inter = ((d.kps[0] - d.kps[2]).powi(2) + (d.kps[1] - d.kps[3]).powi(2)).sqrt();
            let eye_prob = |ex: f32, ey: f32| -> Option<f32> {
                let crop = crate::faces::eye_crop_box(ex, ey, inter, w, h)?;
                crate::faces::eye_open_prob(&input.rgb, w, h, crop)
            };
            let eyes_open = match (eye_prob(d.kps[0], d.kps[1]), eye_prob(d.kps[2], d.kps[3])) {
                (Some(l), Some(r)) => l.min(r),
                _ => -1.0,
            };
            FaceScore {
                bbox: [
                    d.x / w as f32,
                    d.y / h as f32,
                    d.w / w as f32,
                    d.h / h as f32,
                ],
                eyes_open,
                face_sharpness: sharp,
            }
        })
        .collect();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    // ── Synthetic buffers (deterministic, no files) ────────────────────────

    /// Deterministic LCG so "noise" is reproducible.
    struct Lcg(u64);
    impl Lcg {
        fn next_u8(&mut self) -> u8 {
            self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (self.0 >> 33) as u8
        }
    }

    fn flat(w: usize, h: usize, v: u8) -> Vec<u8> {
        vec![v; w * h]
    }

    /// Hard 2px checkerboard — maximal legitimate detail.
    fn checkerboard(w: usize, h: usize) -> Vec<u8> {
        let mut b = vec![0u8; w * h];
        for y in 0..h {
            for x in 0..w {
                b[y * w + x] = if ((x / 2) + (y / 2)) % 2 == 0 { 30 } else { 220 };
            }
        }
        b
    }

    /// Box-blur of a buffer (radius 2) — "the same scene, softer".
    fn blur(src: &[u8], w: usize, h: usize) -> Vec<u8> {
        let r = 2i32;
        let mut out = vec![0u8; w * h];
        for y in 0..h as i32 {
            for x in 0..w as i32 {
                let (mut sum, mut n) = (0u32, 0u32);
                for dy in -r..=r {
                    for dx in -r..=r {
                        let (nx, ny) = (x + dx, y + dy);
                        if nx >= 0 && ny >= 0 && nx < w as i32 && ny < h as i32 {
                            sum += src[(ny as usize) * w + nx as usize] as u32;
                            n += 1;
                        }
                    }
                }
                out[(y as usize) * w + x as usize] = (sum / n) as u8;
            }
        }
        out
    }

    fn uniform_noise(w: usize, h: usize, seed: u64) -> Vec<u8> {
        let mut lcg = Lcg(seed);
        (0..w * h).map(|_| lcg.next_u8()).collect()
    }

    fn full_rect(w: usize, h: usize) -> Rect {
        Rect { x0: 0, y0: 0, x1: w, y1: h }
    }

    fn rgb_solid(w: usize, h: usize, rgb: [u8; 3]) -> Vec<u8> {
        (0..w * h).flat_map(|_| rgb).collect()
    }

    fn input_from_luma(luma: Vec<u8>, w: usize, h: usize) -> DecodedInput {
        DecodedInput {
            rgb: luma.iter().flat_map(|&v| [v, v, v]).collect(),
            w,
            h,
            orientation: 1,
            af_x_pct: Some(50.0),
            af_y_pct: Some(50.0),
            mtime_ms: 1_000,
            drive_mode: Some(1),
            focal_length_mm: Some(85.0),
            shutter_seconds: Some(1.0 / 500.0),
            iso: Some(400),
            sub_sec_ms: Some(470),
            captured_at: Some("2026-06-11T18:07:30".to_string()),
        }
    }

    // ── Sharpness ──────────────────────────────────────────────────────────

    #[test]
    fn var_laplacian_ranks_sharp_above_blurred_and_flat_near_zero() {
        let (w, h) = (128, 96);
        let sharp = checkerboard(w, h);
        let soft = blur(&sharp, w, h);
        let r = full_rect(w, h);

        let v_sharp = var_laplacian(&sharp, w, h, r);
        let v_soft = var_laplacian(&soft, w, h, r);
        let v_flat = var_laplacian(&flat(w, h, 128), w, h, r);

        assert!(v_sharp > v_soft * 2.0, "sharp {v_sharp} must dominate blurred {v_soft}");
        assert!(v_soft > v_flat, "blurred detail still beats flat");
        assert!(v_flat < 1e-6, "flat field has ~zero Laplacian variance, got {v_flat}");
    }

    #[test]
    fn tenengrad_agrees_with_laplacian_ordering() {
        let (w, h) = (128, 96);
        let sharp = checkerboard(w, h);
        let soft = blur(&sharp, w, h);
        let r = full_rect(w, h);
        assert!(tenengrad(&sharp, w, h, r) > tenengrad(&soft, w, h, r));
        assert!(tenengrad(&flat(w, h, 77), w, h, r) < 1e-6);
    }

    #[test]
    fn noise_normalization_discounts_pure_noise_but_keeps_real_detail() {
        let (w, h) = (512, 384); // several 128px noise tiles
        // Pure noise: raw Laplacian variance is HIGH everywhere, but so is the
        // noise floor → normalized sharpness must stay low.
        let noise = uniform_noise(w, h, 42);
        let nf_noise = noise_floor(&noise, w, h);
        let v_noise = var_laplacian(&noise, w, h, full_rect(w, h));
        let s_noise = normalize_sharpness(v_noise, nf_noise);

        // Real detail: checkerboard centre on an otherwise flat frame — floor
        // comes from the flat tiles, variance from the detail ⇒ high normalized.
        let mut scene = flat(w, h, 128);
        let cb = checkerboard(256, 192);
        for y in 0..192 {
            for x in 0..256 {
                scene[(y + 96) * w + (x + 128)] = cb[y * 256 + x];
            }
        }
        let nf_scene = noise_floor(&scene, w, h);
        let centre = Rect { x0: 128, y0: 96, x1: 384, y1: 288 };
        let s_scene = normalize_sharpness(var_laplacian(&scene, w, h, centre), nf_scene);

        assert!(nf_noise > nf_scene, "noise field has the higher floor");
        assert!(
            s_scene > s_noise + 0.2,
            "real detail ({s_scene}) must clearly outrank pure noise ({s_noise})"
        );
        assert!(s_noise < 0.35, "pure noise must normalize low, got {s_noise}");
        assert!((0.0..=1.0).contains(&s_scene) && (0.0..=1.0).contains(&s_noise));
    }

    // ── Texture gate ───────────────────────────────────────────────────────

    #[test]
    fn texture_spread_low_on_flat_and_smooth_gradient_high_on_detail() {
        let (w, h) = (128, 96);
        let r = full_rect(w, h);
        // Smooth vertical gradient across a small luma range — "smooth skin".
        let gradient: Vec<u8> =
            (0..w * h).map(|i| 110 + ((i / w) * 20 / h.max(1)) as u8).collect();

        let t_flat = texture_spread(&flat(w, h, 128), w, h, r);
        let t_grad = texture_spread(&gradient, w, h, r);
        let t_detail = texture_spread(&checkerboard(w, h), w, h, r);

        assert!(t_flat < 0.05, "flat has ~no spread, got {t_flat}");
        assert!(t_grad < 0.15, "smooth gradient stays low, got {t_grad}");
        assert!(t_detail > 0.5, "checkerboard spans the range, got {t_detail}");
    }

    // ── Clipping (all-3-channel port) ──────────────────────────────────────

    #[test]
    fn clipping_requires_all_three_channels() {
        let (w, h) = (32, 32);
        let (blown, _) = clip_pcts(&rgb_solid(w, h, [255, 255, 255]));
        assert!(blown > 0.99, "all-white is fully blown, got {blown}");

        let (_, crushed) = clip_pcts(&rgb_solid(w, h, [0, 0, 0]));
        assert!(crushed > 0.99, "all-black is fully crushed, got {crushed}");

        // Saturated yellow: R and G at ceiling, B at floor — NEITHER blown nor
        // crushed (the all-3-channel rule; validates the clipScan port).
        let (blown_y, crushed_y) = clip_pcts(&rgb_solid(w, h, [255, 210, 0]));
        assert!(blown_y < 0.01, "saturated yellow is not blown, got {blown_y}");
        assert!(crushed_y < 0.01, "saturated yellow is not crushed, got {crushed_y}");

        let (blown_m, crushed_m) = clip_pcts(&rgb_solid(w, h, [128, 128, 128]));
        assert!(blown_m < 0.01 && crushed_m < 0.01, "mid-gray clips nothing");
    }

    // ── Exposure ───────────────────────────────────────────────────────────

    #[test]
    fn exposure_score_peaks_at_mid_and_falls_toward_extremes() {
        let (w, h) = (64, 64);
        let e_mid = exposure_score(&flat(w, h, 118));
        let e_dark = exposure_score(&flat(w, h, 25));
        let e_black = exposure_score(&flat(w, h, 2));
        let e_bright = exposure_score(&flat(w, h, 235));

        assert!(e_mid > e_dark, "mid ({e_mid}) beats dark ({e_dark})");
        assert!(e_dark > e_black, "dark ({e_dark}) beats black ({e_black})");
        assert!(e_mid > e_bright, "mid ({e_mid}) beats near-white ({e_bright})");
        assert!((0.0..=1.0).contains(&e_mid) && (0.0..=1.0).contains(&e_black));
    }

    // ── AF crop orientation mapping ────────────────────────────────────────

    /// Display-space AF point at (25%, 10%) — top-left-ish — mapped back into the
    /// un-rotated sensor frame for each orientation with_exif_orientation emits.
    /// Sensor buffer is 1000×600 (landscape, like every PRVW); crop is
    /// 0.20·min = 120px square, centred on the mapped point (clamped in-bounds).
    #[test]
    fn af_crop_inverts_each_display_orientation() {
        let (w, h) = (1000usize, 600usize);
        let centre_of = |r: Rect| (((r.x0 + r.x1) / 2) as f32, ((r.y0 + r.y1) / 2) as f32);

        // o=1: display == sensor → (250, 60).
        let (r1, valid) = af_crop(1, Some(25.0), Some(10.0), w, h);
        assert!(valid);
        let (cx, cy) = centre_of(r1);
        assert!((cx - 250.0).abs() <= 1.0 && (cy - 60.0).abs() <= 1.0, "o1 got ({cx},{cy})");

        // o=3 (180°): sensor = (1−x, 1−y) → (750, 540).
        let (r3, _) = af_crop(3, Some(25.0), Some(10.0), w, h);
        let (cx, cy) = centre_of(r3);
        assert!((cx - 750.0).abs() <= 1.0 && (cy - 540.0).abs() <= 1.0, "o3 got ({cx},{cy})");

        // o=6 (sensor rotated 90° CW for display): display (xd,yd) ← sensor via
        // xd = 1−ys, yd = xs  ⇒  inverse: xs = yd, ys = 1−xd.
        // (25%, 10%) → sensor (10%, 75%) → (100, 450).
        let (r6, _) = af_crop(6, Some(25.0), Some(10.0), w, h);
        let (cx, cy) = centre_of(r6);
        assert!((cx - 100.0).abs() <= 1.0 && (cy - 450.0).abs() <= 1.0, "o6 got ({cx},{cy})");

        // o=8 (90° CCW): xd = ys, yd = 1−xs ⇒ inverse: xs = 1−yd, ys = xd.
        // (25%, 10%) → sensor (90%, 25%) → (900, 150).
        let (r8, _) = af_crop(8, Some(25.0), Some(10.0), w, h);
        let (cx, cy) = centre_of(r8);
        assert!((cx - 900.0).abs() <= 1.0 && (cy - 150.0).abs() <= 1.0, "o8 got ({cx},{cy})");

        // Crop size: 0.20 · min(1000,600) = 120px square (all orientations).
        for r in [r1, r3, r6, r8] {
            assert_eq!(r.x1 - r.x0, 120, "crop width");
            assert_eq!(r.y1 - r.y0, 120, "crop height");
        }
    }

    #[test]
    fn af_crop_without_af_point_centres_and_flags_invalid() {
        let (rect, valid) = af_crop(6, None, None, 1000, 600);
        assert!(!valid);
        let (cx, cy) = (((rect.x0 + rect.x1) / 2) as i64, ((rect.y0 + rect.y1) / 2) as i64);
        assert!((cx - 500).abs() <= 1 && (cy - 300).abs() <= 1, "centred, got ({cx},{cy})");
    }

    #[test]
    fn af_crop_clamps_to_buffer_at_edges() {
        // AF point in the extreme display corner must yield an in-bounds rect.
        let (rect, _) = af_crop(1, Some(0.0), Some(0.0), 1000, 600);
        assert_eq!((rect.x0, rect.y0), (0, 0));
        assert_eq!(rect.x1 - rect.x0, 120);
        assert_eq!(rect.y1 - rect.y0, 120);
        let (rect, _) = af_crop(1, Some(100.0), Some(100.0), 1000, 600);
        assert_eq!((rect.x1, rect.y1), (1000, 600));
    }

    // ── Motion blur ────────────────────────────────────────────────────────

    #[test]
    fn motion_blur_needs_slow_shutter_and_low_sharpness() {
        // 1/15s at 85mm, soft: strongly likely motion blur.
        let slow_soft = motion_blur_likelihood(Some(1.0 / 15.0), Some(85.0), 0.1);
        // 1/1000s at 85mm, equally soft: NOT motion blur (missed focus instead).
        let fast_soft = motion_blur_likelihood(Some(1.0 / 1000.0), Some(85.0), 0.1);
        // 1/15s but tack sharp: the (1−sharpness) factor mutes it.
        let slow_sharp = motion_blur_likelihood(Some(1.0 / 15.0), Some(85.0), 0.95);

        assert!(slow_soft > 0.7, "slow+soft is likely blur, got {slow_soft}");
        assert!(fast_soft < 0.15, "fast shutter exonerates, got {fast_soft}");
        assert!(slow_sharp < 0.15, "sharp frame can't be motion-blurred, got {slow_sharp}");
        assert_eq!(motion_blur_likelihood(None, Some(85.0), 0.1), 0.0, "missing shutter → 0");
        assert_eq!(motion_blur_likelihood(Some(0.1), None, 0.1), 0.0, "missing focal → 0");
    }

    // ── score_one glue ─────────────────────────────────────────────────────

    #[test]
    fn score_one_echoes_grouping_inputs_and_sets_decode_ok() {
        let (w, h) = (256, 192);
        let s = score_one(&input_from_luma(checkerboard(w, h), w, h), 7);
        assert_eq!(s.index, 7);
        assert!(s.decode_ok);
        assert_eq!(s.mtime_ms, 1_000);
        assert_eq!(s.drive_mode, Some(1));
        assert_eq!(s.focal_length_mm, Some(85.0));
        assert_eq!(s.iso, Some(400));
        assert_eq!(s.sub_sec_ms, Some(470));
        assert!(s.af_valid);
        assert!(s.faces.is_empty() && s.aesthetic.is_none(), "Tier-2 fields stay empty in MVP");
        assert!(s.af_sharpness > 0.0 && s.af_texture > 0.5, "checkerboard scores sharp+textured");
        // The Tenengrad cross-check must reach TS on the wire (plan formula:
        // "large disagreement lowers TS confidence") — same normalization scale.
        assert!(
            (0.0..=1.0).contains(&s.tenengrad) && s.tenengrad > 0.0,
            "tenengrad on the wire, normalized, got {}",
            s.tenengrad
        );
    }

    // ── captured_at_ms combine ─────────────────────────────────────────────

    #[test]
    fn captured_at_ms_combines_datetime_and_subsec() {
        // 12 fps burst crossing a second boundary: :30.920 → :31.003 = 83 ms.
        let a = captured_at_ms(Some("2026-06-11T18:07:30"), Some(920)).expect("a");
        let b = captured_at_ms(Some("2026-06-11T18:07:31"), Some(3)).expect("b");
        assert_eq!(b - a, 83, "sub-second delta across the boundary");
        // Missing SubSec → second precision (fraction 0), still usable coarsely.
        let c = captured_at_ms(Some("2026-06-11T18:07:31"), None).expect("c");
        assert_eq!(c - a, 80, ":31.000 − :30.920");
        // Absent / malformed datetime → None (mtime fallback territory).
        assert_eq!(captured_at_ms(None, Some(500)), None);
        assert_eq!(captured_at_ms(Some("not a date"), Some(500)), None);
    }

    // ── Chunk driver ───────────────────────────────────────────────────────

    fn ok_fetch(w: usize, h: usize) -> impl Fn(&str) -> Result<DecodedInput, String> {
        move |_p: &str| Ok(input_from_luma(checkerboard(w, h), w, h))
    }

    // Real R6 III corpus, end to end: fetch (cold + cache-hit) → decode → score.
    // Gated: CULL_TEST_CR3_DIR=… cargo test — the same gate as cr3's corpus tests.
    #[test]
    fn corpus_end_to_end_fetch_and_score() {
        let Ok(dir) = std::env::var("CULL_TEST_CR3_DIR") else {
            eprintln!("skip: set CULL_TEST_CR3_DIR to a folder of .CR3 files");
            return;
        };
        let mut paths: Vec<String> = std::fs::read_dir(&dir)
            .expect("read dir")
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("cr3")))
            .map(|p| p.to_string_lossy().into_owned())
            .collect();
        paths.sort();
        paths.truncate(3);
        assert!(!paths.is_empty(), "no CR3 files in {dir}");

        let session = crate::io_gate::SessionGate::new();
        session.begin(1);
        let tmp = std::env::temp_dir().join(format!("cull-analyze-test-{}", std::process::id()));
        let cache = crate::tier_cache::TierCache::new(tmp.clone());
        let fetch =
            |p: &str| crate::bundle::fetch_decoded_preview(p, 1, &session, &cache);

        let scores = score_chunk(&paths, 0, &fetch, &|| false, &|_, _| {}).expect("cold chunk");
        for s in &scores {
            assert!(s.decode_ok, "corpus file must decode");
            assert!(s.mtime_ms > 0, "mtime echoed for TS grouping");
            for v in [s.af_sharpness, s.af_texture, s.global_sharpness, s.tenengrad] {
                assert!((0.0..=1.0).contains(&v), "metric out of range: {v}");
            }
            eprintln!(
                "corpus idx {}: sharp {:.3} tex {:.3} ten {:.3} exp {:.2} blown {:.3} \
                 sub {:?} drive {:?} iso {:?}",
                s.index, s.af_sharpness, s.af_texture, s.tenengrad, s.exposure_score,
                s.blown_pct, s.sub_sec_ms, s.drive_mode, s.iso,
            );
        }
        // Run 2 must serve from the prvw cache — the stored wire header carries
        // the full metadata, so scores must be IDENTICAL, not merely close.
        let scores2 = score_chunk(&paths, 0, &fetch, &|| false, &|_, _| {}).expect("cached chunk");
        for (a, b) in scores.iter().zip(&scores2) {
            assert_eq!(a.iso, b.iso, "meta survives the cache round-trip");
            assert_eq!(a.sub_sec_ms, b.sub_sec_ms);
            assert_eq!(a.drive_mode, b.drive_mode);
            assert!((a.af_sharpness - b.af_sharpness).abs() < 1e-6, "identical scores");
        }
        let _ = std::fs::remove_dir_all(tmp);
    }

    // ── Calibration harness (Phase 1 skeleton) ─────────────────────────────
    // `CULL_CALIB=1 CULL_TEST_CR3_DIR=… cargo test calibration_report -- --nocapture`
    // Scores every CR3 under the dir (recursive), joins each file's sidecar
    // verdict as ground truth, applies the Tier-1 STAND-IN cascade (soft-focus
    // only — the burst rule lives in TS grouping, Phase 2), and prints the
    // confusion matrix + the FALSE-REJECT list (the costly error). Threshold
    // tuning cites this output, not feel (plan § Verification).
    #[test]
    fn calibration_report() {
        if std::env::var("CULL_CALIB").is_err() {
            eprintln!("skip: set CULL_CALIB=1 (+ CULL_TEST_CR3_DIR) for the calibration report");
            return;
        }
        let dir = std::env::var("CULL_TEST_CR3_DIR").expect("CULL_CALIB needs CULL_TEST_CR3_DIR");
        let mut paths: Vec<String> = walkdir::WalkDir::new(&dir)
            .into_iter()
            .flatten()
            .filter(|e| {
                e.path().extension().is_some_and(|x| x.eq_ignore_ascii_case("cr3"))
            })
            .map(|e| e.path().to_string_lossy().into_owned())
            .collect();
        paths.sort();
        assert!(!paths.is_empty(), "no CR3 files under {dir}");

        // STAND-IN thresholds — the TS cascade owns the real ones (Phase 2).
        const SHARP_REJECT: f32 = 0.15;
        const TEXTURE_MIN: f32 = 0.12;

        let session = crate::io_gate::SessionGate::new();
        session.begin(1);
        let tmp = std::env::temp_dir().join(format!("cull-calib-{}", std::process::id()));
        let cache = crate::tier_cache::TierCache::new(tmp.clone());
        let fetch = |p: &str| crate::bundle::fetch_decoded_preview(p, 1, &session, &cache);
        let scores = score_chunk(&paths, 0, &fetch, &|| false, &|_, _| {}).expect("calibration chunk");

        // Confusion counts: [suggested-reject][user-kept] etc.
        let (mut hit, mut false_rej, mut miss, mut quiet, mut unlabeled) = (0, 0, 0, 0, 0);
        let mut false_rejects: Vec<&str> = Vec::new();
        eprintln!(
            "{:<28} {:>6} {:>5} {:>5} {:>5} {:>6}  {:<8} {:<8}",
            "file", "sharp", "tex", "ten", "exp", "blown", "suggest", "user"
        );
        for (s, p) in scores.iter().zip(&paths) {
            let name = std::path::Path::new(p)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            let (user, _lrc) = crate::xmp::read_ratings(p);
            let suggest_reject =
                s.decode_ok && s.af_sharpness < SHARP_REJECT && s.af_texture >= TEXTURE_MIN;
            let suggest = if suggest_reject { "reject" } else { "-" };
            eprintln!(
                "{:<28} {:>6.3} {:>5.2} {:>5.2} {:>5.2} {:>6.3}  {:<8} {:<8}",
                name,
                s.af_sharpness,
                s.af_texture,
                s.tenengrad,
                s.exposure_score,
                s.blown_pct,
                suggest,
                user.as_deref().unwrap_or("?")
            );
            match (suggest_reject, user.as_deref()) {
                (_, None) => unlabeled += 1,
                (true, Some("reject")) => hit += 1,
                (true, Some(_)) => {
                    false_rej += 1;
                    false_rejects.push(p);
                }
                (false, Some("reject")) => miss += 1,
                (false, Some(_)) => quiet += 1,
            }
        }
        eprintln!(
            "\nconfusion: hit(rej/rej)={hit} FALSE-REJECT(rej/kept)={false_rej} \
             miss(-/rej)={miss} quiet(-/kept)={quiet} unlabeled={unlabeled}"
        );
        for p in &false_rejects {
            eprintln!("FALSE-REJECT: {p}");
        }
        let _ = std::fs::remove_dir_all(tmp);
    }

    #[test]
    fn score_chunk_assigns_absolute_indices() {
        let paths: Vec<String> = (0..3).map(|i| format!("p{i}.CR3")).collect();
        let scores = score_chunk(&paths, 40, &ok_fetch(64, 48), &|| false, &|_, _| {}).expect("chunk ok");
        let idx: Vec<usize> = scores.iter().map(|s| s.index).collect();
        assert_eq!(idx, vec![40, 41, 42], "index = chunk_start + offset");
    }

    #[test]
    fn score_chunk_bails_between_files_when_cancelled() {
        let paths: Vec<String> = (0..5).map(|i| format!("p{i}.CR3")).collect();
        let fetches = Cell::new(0usize);
        let fetch = |_p: &str| {
            fetches.set(fetches.get() + 1);
            Ok(input_from_luma(checkerboard(64, 48), 64, 48))
        };
        // Cancel flips true after the first file completes.
        let cancelled = || fetches.get() >= 1;

        let err = score_chunk(&paths, 0, &fetch, &cancelled, &|_, _| {}).expect_err("must cancel");
        assert!(err.contains("cancelled"), "cancel error, got {err}");
        assert!(
            fetches.get() <= 2,
            "must stop between files, not run the chunk out ({} fetches)",
            fetches.get()
        );
    }

    #[test]
    fn score_chunk_rejects_when_cancel_lands_during_the_last_file() {
        // The frontend gen-guard would drop these anyway, but the backend must
        // not return an Ok chunk it computed for a dead generation.
        let paths: Vec<String> = (0..3).map(|i| format!("p{i}.CR3")).collect();
        let fetches = Cell::new(0usize);
        let fetch = |_p: &str| {
            fetches.set(fetches.get() + 1);
            Ok(input_from_luma(checkerboard(64, 48), 64, 48))
        };
        let cancelled = || fetches.get() >= 3; // flips true mid-final-file
        let err = score_chunk(&paths, 0, &fetch, &cancelled, &|_, _| {}).expect_err("stale chunk rejected");
        assert!(err.contains("cancelled"));
    }

    #[test]
    fn score_chunk_marks_decode_failure_and_continues() {
        let paths: Vec<String> = (0..3).map(|i| format!("p{i}.CR3")).collect();
        let fetch = |p: &str| {
            if p == "p1.CR3" {
                Err("no PRVW".to_string())
            } else {
                Ok(input_from_luma(checkerboard(64, 48), 64, 48))
            }
        };
        let scores = score_chunk(&paths, 10, &fetch, &|| false, &|_, _| {}).expect("chunk survives");
        assert_eq!(scores.len(), 3, "failed file still yields a score");
        assert!(scores[0].decode_ok && scores[2].decode_ok);
        assert!(!scores[1].decode_ok, "p1 marked decode_ok=false");
        assert_eq!(scores[1].index, 11, "failed file keeps its absolute index");
    }
}
