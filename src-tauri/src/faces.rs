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

#[cfg(feature = "smart-ml")]
pub use ml::{detect_faces, detector_ready, init_detector};

#[cfg(feature = "smart-ml")]
mod ml {
    use super::*;
    use std::path::PathBuf;
    use std::sync::{Mutex, OnceLock};

    /// Lazy global session: initialized with the resolved model path at setup,
    /// session created on first detect (so app boot never pays for ONNX init).
    static MODEL_PATH: OnceLock<PathBuf> = OnceLock::new();
    static SESSION: OnceLock<Option<Mutex<ort::session::Session>>> = OnceLock::new();

    pub fn init_detector(model_path: PathBuf) {
        let _ = MODEL_PATH.set(model_path);
    }

    fn build_session(path: &std::path::Path) -> Result<ort::session::Session, ort::Error> {
        #[allow(unused_mut)]
        let mut b = ort::session::Session::builder()?;
        // Platform EP with silent CPU fallback (registration failure at
        // session-run level falls back internally; hard errors surface here).
        #[cfg(target_os = "macos")]
        {
            b = b.with_execution_providers([ort::ep::CoreML::default().build()])?;
        }
        #[cfg(target_os = "windows")]
        {
            b = b.with_execution_providers([ort::ep::DirectML::default().build()])?;
        }
        b.commit_from_file(path)
    }

    fn session() -> Option<&'static Mutex<ort::session::Session>> {
        SESSION
            .get_or_init(|| {
                let path = MODEL_PATH.get()?;
                match build_session(path) {
                    Ok(s) => Some(Mutex::new(s)),
                    Err(e) => {
                        dlog!("[cull] yunet session init failed: {e}");
                        None
                    }
                }
            })
            .as_ref()
    }

    /// Did the ONNX session actually come up? (Smoke-test discriminator —
    /// detect_faces returns empty BOTH for "no faces" and "no session".)
    pub fn detector_ready() -> bool {
        session().is_some()
    }

    /// Detect faces on a decoded RGB8 preview. Failures are empty results —
    /// face data is advisory enrichment, never worth failing a score over.
    pub fn detect_faces(rgb: &[u8], w: usize, h: usize) -> Vec<Detection> {
        let Some(lock) = session() else { return Vec::new() };
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
    }
}
