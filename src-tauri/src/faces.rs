//! YuNet face detection (smart-culling Phase 3a, feature `smart-ml`).
//!
//! The DECODE is pure math compiled unconditionally (fully unit-tested against
//! synthetic head tensors — the correctness core); only the ONNX session/infer
//! glue is behind the `smart-ml` cargo feature, so default builds stay free of
//! the native onnxruntime dependency. Decode math verified against OpenCV's
//! reference implementation (modules/objdetect/src/face_detect.cpp):
//! per stride s ∈ {8,16,32}, outputs cls/obj (hw×1), bbox (hw×4), kps (hw×10);
//! score = sqrt(cls·obj); cx=(col+bbox0)·s, cy=(row+bbox1)·s, w=exp(bbox2)·s,
//! h=exp(bbox3)·s; landmark n = ((kps[2n]+col)·s, (kps[2n+1]+row)·s); then IoU
//! NMS. Input: BGR f32 CHW, zero-padded to /32 (no mean/scale normalization).

/// One decoded face in PIXEL coordinates of the (unpadded) input image.
#[derive(Clone, Debug, PartialEq)]
pub struct Detection {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    pub score: f32,
    /// 5 landmarks (right eye, left eye, nose, right/left mouth corner) as
    /// x,y pairs — unused until Phase 3b (eye state) but decoded for free.
    pub kps: [f32; 10],
}

/// One stride's raw output slices, laid out row-major over the padded grid.
pub struct RawHead<'a> {
    pub stride: usize,
    pub cls: &'a [f32],
    pub obj: &'a [f32],
    pub bbox: &'a [f32],
    pub kps: &'a [f32],
}

pub const SCORE_THRESHOLD: f32 = 0.7;
pub const NMS_IOU: f32 = 0.3;
pub const TOP_K: usize = 32;

pub fn decode_heads(
    heads: &[RawHead],
    pad_w: usize,
    pad_h: usize,
    score_threshold: f32,
) -> Vec<Detection> {
    let mut out = Vec::new();
    for head in heads {
        let cols = pad_w / head.stride;
        let rows = pad_h / head.stride;
        let hw = cols * rows;
        if head.cls.len() < hw || head.obj.len() < hw {
            continue; // malformed head — skip rather than index out of bounds
        }
        for idx in 0..hw {
            let cls = head.cls[idx].clamp(0.0, 1.0);
            let obj = head.obj[idx].clamp(0.0, 1.0);
            let score = (cls * obj).sqrt();
            if score < score_threshold {
                continue;
            }
            let (row, col) = (idx / cols, idx % cols);
            let s = head.stride as f32;
            let b = &head.bbox[idx * 4..idx * 4 + 4];
            let cx = (col as f32 + b[0]) * s;
            let cy = (row as f32 + b[1]) * s;
            let w = b[2].exp() * s;
            let h = b[3].exp() * s;
            let mut kps = [0f32; 10];
            for n in 0..5 {
                kps[2 * n] = (head.kps[idx * 10 + 2 * n] + col as f32) * s;
                kps[2 * n + 1] = (head.kps[idx * 10 + 2 * n + 1] + row as f32) * s;
            }
            out.push(Detection { x: cx - w / 2.0, y: cy - h / 2.0, w, h, score, kps });
        }
    }
    out
}

/// Greedy IoU NMS, highest score first, capped at `top_k`.
pub fn nms(mut dets: Vec<Detection>, iou_threshold: f32, top_k: usize) -> Vec<Detection> {
    dets.sort_by(|a, b| b.score.total_cmp(&a.score));
    let iou = |a: &Detection, b: &Detection| -> f32 {
        let x0 = a.x.max(b.x);
        let y0 = a.y.max(b.y);
        let x1 = (a.x + a.w).min(b.x + b.w);
        let y1 = (a.y + a.h).min(b.y + b.h);
        let inter = (x1 - x0).max(0.0) * (y1 - y0).max(0.0);
        let union = a.w * a.h + b.w * b.h - inter;
        if union <= 0.0 { 0.0 } else { inter / union }
    };
    let mut kept: Vec<Detection> = Vec::new();
    for d in dets {
        if kept.len() >= top_k {
            break;
        }
        if kept.iter().all(|k| iou(k, &d) <= iou_threshold) {
            kept.push(d);
        }
    }
    kept
}

/// Tightly-packed RGB8 → BGR f32 CHW, zero-padded right/bottom to (pad_w, pad_h).
pub fn rgb_to_bgr_chw_padded(
    rgb: &[u8],
    w: usize,
    h: usize,
    pad_w: usize,
    pad_h: usize,
) -> Vec<f32> {
    let mut out = vec![0f32; 3 * pad_w * pad_h];
    // BGR channel order: out channel 0 ← RGB channel 2, 1 ← 1, 2 ← 0.
    for (ch_out, ch_in) in [(0usize, 2usize), (1, 1), (2, 0)] {
        let plane = &mut out[ch_out * pad_w * pad_h..(ch_out + 1) * pad_w * pad_h];
        for y in 0..h {
            for x in 0..w {
                plane[y * pad_w + x] = rgb[(y * w + x) * 3 + ch_in] as f32;
            }
        }
    }
    out
}

/// Next multiple of 32 (YuNet requires /32-aligned input dims).
pub fn pad32(v: usize) -> usize {
    v.div_ceil(32) * 32
}

// ── OCEC eye-state (Phase 3b) — pure math, always compiled ────────────────
//
// Open/Closed Eye Classification (github.com/PINTO0309/OCEC, MIT): 24×40 RGB
// eye crops → sigmoid `prob_open`. Crops are built around YuNet's eye
// landmarks (kps 0/1), sized from the interocular distance, preprocessed
// per the reference demo (RGB, bilinear resize, /255, CHW f32).

/// OCEC model input (H, W) — fallback when the graph reports dynamic dims.
pub const OCEC_IN_H: usize = 24;
pub const OCEC_IN_W: usize = 40;
/// Eye crop width as a fraction of the interocular distance.
pub const EYE_CROP_INTEROCULAR_FRAC: f32 = 0.55;
/// Below this crop width the classifier sees mush — stay unknown instead.
pub const MIN_EYE_CROP_W: usize = 10;

/// Pixel crop box around an eye center: width = 0.55 × interocular, aspect
/// locked to the OCEC input (40:24), clamped fully inside the image. `None`
/// for degenerate geometry or crops too small to classify.
pub fn eye_crop_box(
    ex: f32,
    ey: f32,
    interocular: f32,
    img_w: usize,
    img_h: usize,
) -> Option<(usize, usize, usize, usize)> {
    if !interocular.is_finite() || interocular <= 0.0 || !ex.is_finite() || !ey.is_finite() {
        return None;
    }
    let w = (interocular * EYE_CROP_INTEROCULAR_FRAC) as usize;
    let h = w * OCEC_IN_H / OCEC_IN_W;
    if w < MIN_EYE_CROP_W || h == 0 || w > img_w || h > img_h {
        return None;
    }
    let x = ((ex as isize) - (w as isize) / 2).clamp(0, (img_w - w) as isize) as usize;
    let y = ((ey as isize) - (h as isize) / 2).clamp(0, (img_h - h) as isize) as usize;
    Some((x, y, w, h))
}

/// Tightly-packed RGB8 crop (caller guarantees the box is in-bounds).
pub fn crop_rgb(rgb: &[u8], w: usize, _h: usize, x: usize, y: usize, cw: usize, ch: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(cw * ch * 3);
    for row in y..y + ch {
        let start = (row * w + x) * 3;
        out.extend_from_slice(&rgb[start..start + cw * 3]);
    }
    out
}

/// Bilinear resize of tightly-packed RGB8 (center-aligned sampling — the
/// same convention as cv2.resize INTER_LINEAR in the OCEC reference demo).
pub fn resize_rgb_bilinear(rgb: &[u8], w: usize, h: usize, out_w: usize, out_h: usize) -> Vec<u8> {
    if w == out_w && h == out_h {
        return rgb.to_vec();
    }
    let mut out = vec![0u8; out_w * out_h * 3];
    let sx = w as f32 / out_w as f32;
    let sy = h as f32 / out_h as f32;
    for oy in 0..out_h {
        // Source coordinate of this output pixel's center.
        let fy = ((oy as f32 + 0.5) * sy - 0.5).max(0.0);
        let y0 = (fy as usize).min(h - 1);
        let y1 = (y0 + 1).min(h - 1);
        let dy = fy - y0 as f32;
        for ox in 0..out_w {
            let fx = ((ox as f32 + 0.5) * sx - 0.5).max(0.0);
            let x0 = (fx as usize).min(w - 1);
            let x1 = (x0 + 1).min(w - 1);
            let dx = fx - x0 as f32;
            for c in 0..3 {
                let p = |yy: usize, xx: usize| rgb[(yy * w + xx) * 3 + c] as f32;
                let top = p(y0, x0) * (1.0 - dx) + p(y0, x1) * dx;
                let bot = p(y1, x0) * (1.0 - dx) + p(y1, x1) * dx;
                out[(oy * out_w + ox) * 3 + c] = (top * (1.0 - dy) + bot * dy).round() as u8;
            }
        }
    }
    out
}

/// Tightly-packed RGB8 → RGB f32 CHW, /255 (OCEC preprocessing — RGB order,
/// unlike YuNet's BGR).
pub fn rgb_to_chw_f32_norm(rgb: &[u8], w: usize, h: usize) -> Vec<f32> {
    let mut out = vec![0f32; 3 * w * h];
    for c in 0..3 {
        let plane = &mut out[c * w * h..(c + 1) * w * h];
        for i in 0..w * h {
            plane[i] = rgb[i * 3 + c] as f32 / 255.0;
        }
    }
    out
}

#[cfg(feature = "smart-ml")]
pub use ml::{detect_faces, eye_open_prob, init_detector, init_eye_classifier};
/// Smoke-test discriminators (detect/eye calls return empty/None both for
/// "nothing found" and "no session" — tests need to tell those apart).
#[cfg(all(feature = "smart-ml", test))]
pub use ml::{detector_ready, eyes_ready};

#[cfg(feature = "smart-ml")]
mod ml {
    use super::*;
    use crate::ml_models::LazySession;
    use std::path::PathBuf;
    use std::sync::OnceLock;

    static YUNET: LazySession = LazySession::new("yunet");
    static OCEC: LazySession = LazySession::new("ocec");

    pub fn init_detector(model_path: PathBuf) {
        YUNET.init(model_path);
    }

    /// Did the ONNX session actually come up? (Smoke-test discriminator —
    /// detect_faces returns empty BOTH for "no faces" and "no session".)
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn detector_ready() -> bool {
        YUNET.ready()
    }

    // ── OCEC eye-state session (Phase 3b) ─────────────────────────────
    /// (H, W) the loaded graph actually wants — read once from the session's
    /// input shape (falls back to the documented 24×40 on dynamic dims).
    static OCEC_IN_DIMS: OnceLock<(usize, usize)> = OnceLock::new();

    pub fn init_eye_classifier(model_path: PathBuf) {
        OCEC.init(model_path);
    }

    /// Smoke-test discriminator, mirroring `detector_ready`.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn eyes_ready() -> bool {
        OCEC.ready()
    }

    /// Sigmoid `prob_open` for one eye crop of a decoded RGB8 preview, or
    /// `None` when the model is unavailable / the run fails — the caller
    /// keeps the −1 unknown sentinel, never a guess.
    pub fn eye_open_prob(
        rgb: &[u8],
        w: usize,
        h: usize,
        crop: (usize, usize, usize, usize),
    ) -> Option<f32> {
        let lock = OCEC.get()?;
        let (cx, cy, cw, ch) = crop;
        if cx + cw > w || cy + ch > h {
            return None;
        }
        let mut sess = lock.lock().ok()?;
        let (in_h, in_w) = *OCEC_IN_DIMS.get_or_init(|| {
            // Static graphs report [1, 3, H, W]; anything dynamic (-1) falls
            // back to the documented default.
            let dims: Option<(usize, usize)> = sess.inputs().first().and_then(|i| {
                let shape = i.dtype().tensor_shape()?;
                let d: Vec<i64> = shape.iter().copied().collect();
                if d.len() == 4 && d[2] > 0 && d[3] > 0 {
                    Some((d[2] as usize, d[3] as usize))
                } else {
                    None
                }
            });
            dims.unwrap_or((OCEC_IN_H, OCEC_IN_W))
        });
        let eye = crop_rgb(rgb, w, h, cx, cy, cw, ch);
        let resized = resize_rgb_bilinear(&eye, cw, ch, in_w, in_h);
        let chw = rgb_to_chw_f32_norm(&resized, in_w, in_h);
        let input = ort::value::Tensor::from_array(([1usize, 3, in_h, in_w], chw)).ok()?;
        let input_name = sess.inputs().first()?.name().to_string();
        let outputs = sess.run(ort::inputs![input_name.as_str() => input]).ok()?;
        // Single sigmoid output (`prob_open`) — take the first output, first value.
        let (_, v) = outputs.iter().next()?;
        let arr = v.try_extract_array::<f32>().ok()?;
        arr.iter().next().copied().map(|p| p.clamp(0.0, 1.0))
    }

    /// Detect faces on a decoded RGB8 preview. Failures are empty results —
    /// face data is advisory enrichment, never worth failing a score over.
    pub fn detect_faces(rgb: &[u8], w: usize, h: usize) -> Vec<Detection> {
        let Some(lock) = YUNET.get() else { return Vec::new() };
        let (pw, ph) = (pad32(w), pad32(h));
        let chw = rgb_to_bgr_chw_padded(rgb, w, h, pw, ph);
        let Ok(input) = ort::value::Tensor::from_array(([1usize, 3, ph, pw], chw)) else {
            return Vec::new();
        };
        let Ok(mut sess) = lock.lock() else { return Vec::new() };
        let input_name = match sess.inputs().first() {
            Some(i) => i.name().to_string(),
            None => return Vec::new(),
        };
        let Ok(outputs) = sess.run(ort::inputs![input_name.as_str() => input]) else {
            return Vec::new();
        };
        let grab = |name: &str| -> Option<Vec<f32>> {
            outputs
                .get(name)
                .and_then(|v| v.try_extract_array::<f32>().ok())
                .map(|a| a.iter().copied().collect())
        };
        let mut bufs: Vec<(usize, Vec<f32>, Vec<f32>, Vec<f32>, Vec<f32>)> = Vec::new();
        for s in [8usize, 16, 32] {
            let (Some(cls), Some(obj), Some(bbox), Some(kps)) = (
                grab(&format!("cls_{s}")),
                grab(&format!("obj_{s}")),
                grab(&format!("bbox_{s}")),
                grab(&format!("kps_{s}")),
            ) else {
                return Vec::new();
            };
            bufs.push((s, cls, obj, bbox, kps));
        }
        let heads: Vec<RawHead> = bufs
            .iter()
            .map(|(s, cls, obj, bbox, kps)| RawHead { stride: *s, cls, obj, bbox, kps })
            .collect();
        let dets = decode_heads(&heads, pw, ph, SCORE_THRESHOLD);
        nms(dets, NMS_IOU, TOP_K)
            .into_iter()
            // Padding is virtual — clamp boxes back into the real image.
            .map(|mut d| {
                d.x = d.x.clamp(0.0, w as f32);
                d.y = d.y.clamp(0.0, h as f32);
                d.w = d.w.min(w as f32 - d.x);
                d.h = d.h.min(h as f32 - d.y);
                d
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn head_with_hit(
        stride: usize,
        cols: usize,
        rows: usize,
        idx: usize,
        bbox: [f32; 4],
    ) -> (Vec<f32>, Vec<f32>, Vec<f32>, Vec<f32>) {
        let hw = cols * rows;
        let mut cls = vec![0.0; hw];
        let mut obj = vec![0.0; hw];
        let mut bb = vec![0.0; hw * 4];
        let kps = vec![0.25; hw * 10];
        cls[idx] = 1.0;
        obj[idx] = 1.0;
        bb[idx * 4..idx * 4 + 4].copy_from_slice(&bbox);
        let _ = stride;
        (cls, obj, bb, kps)
    }

    #[test]
    fn decodes_a_cell_hit_with_opencv_reference_math() {
        // 32×32 padded input, stride 8 → 4×4 grid. Hit at (row 1, col 1):
        // cx=(1+0.5)*8=12, cy=12, w=exp(ln 2)*8=16, h=exp(ln 3)*8=24
        // → x = 12−8 = 4, y = 12−12 = 0; score = sqrt(1·1) = 1.
        let (cls, obj, bbox, kps) =
            head_with_hit(8, 4, 4, 5, [0.5, 0.5, (2f32).ln(), (3f32).ln()]);
        let heads = [RawHead { stride: 8, cls: &cls, obj: &obj, bbox: &bbox, kps: &kps }];
        let dets = decode_heads(&heads, 32, 32, 0.7);
        assert_eq!(dets.len(), 1, "only the hit cell passes the threshold");
        let d = &dets[0];
        assert!((d.x - 4.0).abs() < 1e-4 && (d.y - 0.0).abs() < 1e-4, "{d:?}");
        assert!((d.w - 16.0).abs() < 1e-4 && (d.h - 24.0).abs() < 1e-4);
        assert!((d.score - 1.0).abs() < 1e-5);
        // Landmark 0: (kps + col) * stride = (0.25 + 1) * 8 = 10.
        assert!((d.kps[0] - 10.0).abs() < 1e-4 && (d.kps[1] - 10.0).abs() < 1e-4);
    }

    #[test]
    fn score_is_geometric_mean_and_clamped_inputs_stay_sane() {
        let (mut cls, obj, bbox, kps) = head_with_hit(8, 4, 4, 0, [0.0; 4]);
        cls[0] = 0.64;
        let heads = [RawHead { stride: 8, cls: &cls, obj: &obj, bbox: &bbox, kps: &kps }];
        let dets = decode_heads(&heads, 32, 32, 0.7);
        assert_eq!(dets.len(), 1);
        assert!((dets[0].score - 0.8).abs() < 1e-5, "sqrt(0.64·1.0) = 0.8");
        // Below threshold → filtered.
        assert!(decode_heads(&heads, 32, 32, 0.81).is_empty());
    }

    #[test]
    fn nms_keeps_the_best_of_overlapping_boxes_and_all_disjoint_ones() {
        let boxed = |x: f32, score: f32| Detection {
            x,
            y: 0.0,
            w: 10.0,
            h: 10.0,
            score,
            kps: [0.0; 10],
        };
        let kept = nms(
            vec![boxed(0.0, 0.9), boxed(1.0, 0.8), boxed(100.0, 0.7)],
            0.3,
            32,
        );
        assert_eq!(kept.len(), 2, "overlapping pair collapses, disjoint survives");
        assert!((kept[0].score - 0.9).abs() < 1e-6, "best first");
        assert!((kept[1].x - 100.0).abs() < 1e-6);
        // top_k caps the survivors.
        assert_eq!(nms(vec![boxed(0.0, 0.9), boxed(100.0, 0.7)], 0.3, 1).len(), 1);
    }

    #[test]
    fn bgr_chw_padding_layout_is_exact() {
        // 2×1 RGB image: px0 = (10,20,30), px1 = (40,50,60), padded to 32×32.
        let rgb = [10u8, 20, 30, 40, 50, 60];
        let chw = rgb_to_bgr_chw_padded(&rgb, 2, 1, 32, 32);
        assert_eq!(chw.len(), 3 * 32 * 32);
        // Channel 0 = B: px0 → 30, px1 → 60; rest of the row zero padding.
        assert_eq!(chw[0], 30.0);
        assert_eq!(chw[1], 60.0);
        assert_eq!(chw[2], 0.0);
        // Channel 1 = G at offset 32·32.
        assert_eq!(chw[32 * 32], 20.0);
        assert_eq!(chw[32 * 32 + 1], 50.0);
        // Channel 2 = R.
        assert_eq!(chw[2 * 32 * 32], 10.0);
        // Second padded row of channel 0 is all zeros.
        assert_eq!(chw[32], 0.0);
    }

    #[test]
    fn pad32_rounds_up_to_the_next_multiple() {
        assert_eq!(pad32(1620), 1632);
        assert_eq!(pad32(1080), 1088);
        assert_eq!(pad32(32), 32);
    }

    #[test]
    fn eye_crop_box_is_centered_with_ocec_aspect_and_interocular_scale() {
        // Interocular 100 → crop w = 55 (0.55×), h = 33 (w × 24/40), centered.
        let (x, y, w, h) = eye_crop_box(200.0, 150.0, 100.0, 1620, 1080).unwrap();
        assert_eq!(w, 55);
        assert_eq!(h, 33);
        assert_eq!(x, 200 - 55 / 2);
        assert_eq!(y, 150 - 33 / 2);
    }

    #[test]
    fn eye_crop_box_clamps_inside_the_image() {
        // Eye near the top-left corner: box shifts to stay in-bounds, size kept.
        let (x, y, w, h) = eye_crop_box(5.0, 3.0, 100.0, 1620, 1080).unwrap();
        assert_eq!((x, y), (0, 0));
        assert_eq!((w, h), (55, 33));
        // Near the bottom-right corner.
        let (x2, y2, w2, h2) = eye_crop_box(1618.0, 1078.0, 100.0, 1620, 1080).unwrap();
        assert_eq!((w2, h2), (55, 33));
        assert_eq!(x2 + w2, 1620);
        assert_eq!(y2 + h2, 1080);
    }

    #[test]
    fn eye_crop_box_rejects_tiny_and_degenerate_inputs() {
        // Interocular so small the crop would be classifier mush (< 10 px wide).
        assert!(eye_crop_box(200.0, 150.0, 12.0, 1620, 1080).is_none());
        // Non-finite / non-positive interocular.
        assert!(eye_crop_box(200.0, 150.0, 0.0, 1620, 1080).is_none());
        assert!(eye_crop_box(200.0, 150.0, f32::NAN, 1620, 1080).is_none());
        // Image smaller than the crop.
        assert!(eye_crop_box(10.0, 10.0, 100.0, 40, 20).is_none());
    }

    #[test]
    fn crop_rgb_extracts_exact_pixels() {
        // 3×2 image, pixel value = its index for traceability.
        #[rustfmt::skip]
        let rgb: Vec<u8> = (0..3 * 2 * 3).map(|v| v as u8).collect();
        let c = crop_rgb(&rgb, 3, 2, 1, 0, 2, 2);
        // Rows: px(1,0)=[3,4,5], px(2,0)=[6,7,8], px(1,1)=[12,13,14], px(2,1)=[15,16,17]
        assert_eq!(c, vec![3, 4, 5, 6, 7, 8, 12, 13, 14, 15, 16, 17]);
    }

    #[test]
    fn bilinear_resize_identity_and_downsample_average() {
        let rgb = [10u8, 0, 0, 20, 0, 0, 30, 0, 0, 40, 0, 0]; // 2×2, R only
        // Identity: same dims → same pixels.
        assert_eq!(resize_rgb_bilinear(&rgb, 2, 2, 2, 2), rgb.to_vec());
        // 2×2 → 1×1 samples the center → average of the four corners.
        let one = resize_rgb_bilinear(&rgb, 2, 2, 1, 1);
        assert_eq!(one.len(), 3);
        assert!((one[0] as i32 - 25).abs() <= 1, "R ≈ (10+20+30+40)/4, got {}", one[0]);
    }

    #[test]
    fn ocec_input_layout_is_rgb_chw_normalized() {
        // 2×1 RGB: px0 = (255, 0, 51), px1 = (0, 255, 102).
        let rgb = [255u8, 0, 51, 0, 255, 102];
        let chw = rgb_to_chw_f32_norm(&rgb, 2, 1);
        assert_eq!(chw.len(), 6);
        // Channel 0 = R (NOT BGR — OCEC eats RGB): [1.0, 0.0]
        assert!((chw[0] - 1.0).abs() < 1e-6 && chw[1].abs() < 1e-6);
        // Channel 1 = G: [0.0, 1.0]
        assert!(chw[2].abs() < 1e-6 && (chw[3] - 1.0).abs() < 1e-6);
        // Channel 2 = B: [0.2, 0.4]
        assert!((chw[4] - 51.0 / 255.0).abs() < 1e-6 && (chw[5] - 102.0 / 255.0).abs() < 1e-6);
    }

    // End-to-end model smoke over the real corpus (feature + env gated):
    // proves the ONNX session initializes, the input/output tensor names and
    // shapes match the real graph, and the whole detect path runs. The seal
    // corpus has no human faces, so ZERO detections is a pass — detection
    // QUALITY is validated live on people shots (Phase 3a manual gate).
    #[cfg(feature = "smart-ml")]
    #[test]
    fn corpus_smoke_runs_the_real_model() {
        let Ok(dir) = std::env::var("CULL_TEST_CR3_DIR") else {
            eprintln!("skip: set CULL_TEST_CR3_DIR for the yunet smoke test");
            return;
        };
        init_detector(
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("models/face_detection_yunet_2023mar.onnx"),
        );
        let path = std::fs::read_dir(&dir)
            .expect("read dir")
            .flatten()
            .map(|e| e.path())
            .find(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("cr3")))
            .expect("a CR3 in the corpus");
        let b = crate::cr3::read_preview_bundle(path.to_str().unwrap(), &|| false)
            .expect("preview bundle");
        use zune_jpeg::zune_core::bytestream::ZCursor;
        use zune_jpeg::zune_core::colorspace::ColorSpace;
        use zune_jpeg::zune_core::options::DecoderOptions;
        let opts = DecoderOptions::default().jpeg_set_out_colorspace(ColorSpace::RGB);
        let mut dec = zune_jpeg::JpegDecoder::new_with_options(ZCursor::new(&b.preview[..]), opts);
        let rgb = dec.decode().expect("decode preview");
        let info = dec.info().expect("dims");
        let (w, h) = (info.width as usize, info.height as usize);

        assert!(detector_ready(), "ONNX session failed to initialize — check model path/ort build");
        let dets = detect_faces(&rgb, w, h);
        eprintln!("yunet smoke: {} face(s) on {} ({w}x{h})", dets.len(), path.display());
        for d in &dets {
            assert!(d.x >= 0.0 && d.y >= 0.0 && d.x + d.w <= w as f32 + 1.0);
            assert!(d.score >= SCORE_THRESHOLD && d.score <= 1.0);
        }

        // Phase 3b: the OCEC graph contract — session up, and a crop runs end
        // to end (an arbitrary region works; the seal corpus has no faces, so
        // classification QUALITY is validated live on people shots).
        init_eye_classifier(
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("models/ocec_s.onnx"),
        );
        assert!(eyes_ready(), "OCEC session failed to initialize");
        let crop = eye_crop_box(w as f32 / 2.0, h as f32 / 2.0, 100.0, w, h).unwrap();
        let prob = eye_open_prob(&rgb, w, h, crop);
        eprintln!("ocec smoke: prob_open = {prob:?}");
        assert!(
            prob.is_some_and(|p| (0.0..=1.0).contains(&p)),
            "OCEC run failed — input name/shape or output extraction mismatch: {prob:?}"
        );
    }
}
