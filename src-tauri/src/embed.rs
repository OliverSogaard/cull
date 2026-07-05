//! DINOv2 embeddings + CLIP/LAION aesthetic (smart-culling 3d/3c, feature
//! `smart-ml`). Pure preprocessing is always compiled (unit-tested); session
//! glue mirrors faces.rs via ml_models::LazySession. All inference runs on the
//! already-decoded PRVW buffer — never a second read.

pub const EMBED_SIDE: usize = 224;
pub const DINOV2_MEAN: [f32; 3] = [0.485, 0.456, 0.406];
pub const DINOV2_STD: [f32; 3] = [0.229, 0.224, 0.225];
pub const CLIP_MEAN: [f32; 3] = [0.481_454_66, 0.457_827_5, 0.408_210_73];
pub const CLIP_STD: [f32; 3] = [0.268_629_54, 0.261_302_58, 0.275_777_11];
/// DINOv2-small hidden size (the CLS slice we keep).
pub const EMBED_DIM: usize = 384;

/// Tightly-packed RGB8 (224×224) → normalized RGB f32 CHW.
pub fn preprocess_norm(rgb224: &[u8], mean: [f32; 3], std: [f32; 3]) -> Vec<f32> {
    let n = EMBED_SIDE * EMBED_SIDE;
    let mut out = vec![0f32; 3 * n];
    for c in 0..3 {
        let plane = &mut out[c * n..(c + 1) * n];
        for i in 0..n {
            plane[i] = (rgb224[i * 3 + c] as f32 / 255.0 - mean[c]) / std[c];
        }
    }
    out
}

pub fn l2_normalize(v: &mut [f32]) {
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 1e-12 {
        v.iter_mut().for_each(|x| *x /= norm);
    }
}

#[cfg(feature = "smart-ml")]
pub use ml::{aesthetic, embedding, init_aesthetic, init_embedder};
#[cfg(all(feature = "smart-ml", test))]
pub use ml::{aesthetic_ready, embedder_ready};

#[cfg(feature = "smart-ml")]
mod ml {
    use super::*;
    use crate::faces::resize_rgb_bilinear;
    use crate::ml_models::LazySession;
    use std::path::PathBuf;

    static DINOV2: LazySession = LazySession::new("dinov2");
    static CLIP: LazySession = LazySession::new("clip");
    static LAION: LazySession = LazySession::new("laion");

    pub fn init_embedder(path: PathBuf) {
        DINOV2.init(path);
    }
    pub fn init_aesthetic(clip: PathBuf, head: PathBuf) {
        CLIP.init(clip);
        LAION.init(head);
    }
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn embedder_ready() -> bool {
        DINOV2.ready()
    }
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn aesthetic_ready() -> bool {
        CLIP.ready() && LAION.ready()
    }

    /// Run one 224×224 single-input graph, return the flattened f32 output.
    fn run_224(
        sess_lock: &std::sync::Mutex<ort::session::Session>,
        rgb: &[u8],
        w: usize,
        h: usize,
        mean: [f32; 3],
        std: [f32; 3],
    ) -> Option<Vec<f32>> {
        let resized = resize_rgb_bilinear(rgb, w, h, EMBED_SIDE, EMBED_SIDE);
        let chw = preprocess_norm(&resized, mean, std);
        let input =
            ort::value::Tensor::from_array(([1usize, 3, EMBED_SIDE, EMBED_SIDE], chw)).ok()?;
        let mut sess = sess_lock.lock().ok()?;
        let input_name = sess.inputs().first()?.name().to_string();
        let outputs = sess.run(ort::inputs![input_name.as_str() => input]).ok()?;
        let (_, v) = outputs.iter().next()?;
        let arr = v.try_extract_array::<f32>().ok()?;
        Some(arr.iter().copied().collect())
    }

    /// L2-normalized 384-d DINOv2 CLS embedding, or None (no model / failure).
    pub fn embedding(rgb: &[u8], w: usize, h: usize) -> Option<Vec<f32>> {
        let out = run_224(DINOV2.get()?, rgb, w, h, DINOV2_MEAN, DINOV2_STD)?;
        // Output is [1, tokens, 384]; CLS is the first token → first 384 floats.
        if out.len() < EMBED_DIM {
            return None;
        }
        let mut cls = out[..EMBED_DIM].to_vec();
        l2_normalize(&mut cls);
        Some(cls)
    }

    /// LAION aesthetic on the CLIP embedding, rescaled 1–10 → 0..1.
    pub fn aesthetic(rgb: &[u8], w: usize, h: usize) -> Option<f32> {
        let mut clip = run_224(CLIP.get()?, rgb, w, h, CLIP_MEAN, CLIP_STD)?;
        l2_normalize(&mut clip); // the head is trained on normalized embeddings
        let dim = clip.len(); // 512
        let input = ort::value::Tensor::from_array(([1usize, dim], clip)).ok()?;
        let lock = LAION.get()?;
        let mut sess = lock.lock().ok()?;
        let input_name = sess.inputs().first()?.name().to_string();
        let outputs = sess.run(ort::inputs![input_name.as_str() => input]).ok()?;
        let (_, v) = outputs.iter().next()?;
        let raw = v.try_extract_array::<f32>().ok()?.iter().next().copied()?;
        Some(((raw - 1.0) / 9.0).clamp(0.0, 1.0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preprocess_applies_mean_std_in_chw_rgb_order() {
        // One-pixel "image" replicated to 224×224: RGB = (255, 0, 128).
        let mut rgb = Vec::with_capacity(224 * 224 * 3);
        for _ in 0..224 * 224 {
            rgb.extend_from_slice(&[255u8, 0, 128]);
        }
        let chw = preprocess_norm(&rgb, DINOV2_MEAN, DINOV2_STD);
        assert_eq!(chw.len(), 3 * 224 * 224);
        // R plane: (1.0 − 0.485) / 0.229
        assert!((chw[0] - (1.0 - 0.485) / 0.229).abs() < 1e-5);
        // G plane at offset 224²: (0.0 − 0.456) / 0.224
        assert!((chw[224 * 224] - (0.0 - 0.456) / 0.224).abs() < 1e-5);
        // B plane: (128/255 − 0.406) / 0.225
        assert!((chw[2 * 224 * 224] - (128.0 / 255.0 - 0.406) / 0.225).abs() < 1e-4);
    }

    #[test]
    fn l2_normalize_makes_unit_length_and_survives_zero() {
        let mut v = vec![3.0f32, 4.0];
        l2_normalize(&mut v);
        assert!((v[0] - 0.6).abs() < 1e-6 && (v[1] - 0.8).abs() < 1e-6);
        let mut z = vec![0.0f32; 4];
        l2_normalize(&mut z); // must not NaN
        assert!(z.iter().all(|x| x.is_finite()));
    }
}

#[cfg(all(feature = "smart-ml", test))]
mod smoke {
    use super::*;

    #[test]
    fn corpus_smoke_embeddings_and_aesthetic() {
        let Ok(dir) = std::env::var("CULL_TEST_CR3_DIR") else {
            eprintln!("skip: set CULL_TEST_CR3_DIR for the embed smoke test");
            return;
        };
        let models = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("models");
        init_embedder(models.join("dinov2s.onnx"));
        init_aesthetic(models.join("clip_vitb32_visual.onnx"), models.join("laion_aesthetic.onnx"));
        // Decode one corpus preview — same preamble as
        // faces.rs::corpus_smoke_runs_the_real_model.
        let path = std::fs::read_dir(&dir)
            .expect("read dir")
            .flatten()
            .map(|e| e.path())
            .find(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("cr3")))
            .expect("a CR3 in the corpus");
        let b = crate::cr3::read_preview_bundle(path.to_str().unwrap(), &|| false).expect("bundle");
        use zune_jpeg::zune_core::bytestream::ZCursor;
        use zune_jpeg::zune_core::colorspace::ColorSpace;
        use zune_jpeg::zune_core::options::DecoderOptions;
        let opts = DecoderOptions::default().jpeg_set_out_colorspace(ColorSpace::RGB);
        let mut dec = zune_jpeg::JpegDecoder::new_with_options(ZCursor::new(&b.preview[..]), opts);
        let rgb = dec.decode().expect("decode");
        let info = dec.info().expect("dims");
        let (w, h) = (info.width as usize, info.height as usize);

        assert!(embedder_ready(), "DINOv2 session failed to init");
        assert!(aesthetic_ready(), "CLIP/LAION sessions failed to init");
        let e = embedding(&rgb, w, h).expect("embedding");
        assert_eq!(e.len(), EMBED_DIM);
        let norm: f32 = e.iter().map(|x| x * x).sum::<f32>().sqrt();
        assert!((norm - 1.0).abs() < 1e-3, "embedding must be L2-normalized: {norm}");
        // Same frame twice → cosine ≈ 1 (determinism / graph sanity).
        let e2 = embedding(&rgb, w, h).expect("embedding 2");
        let cos: f32 = e.iter().zip(&e2).map(|(a, b)| a * b).sum();
        assert!(cos > 0.999, "same-frame cosine: {cos}");
        let a = aesthetic(&rgb, w, h).expect("aesthetic");
        assert!((0.0..=1.0).contains(&a), "aesthetic 0..1: {a}");
        eprintln!("embed smoke: cosine={cos:.4} aesthetic={a:.3}");
    }
}
