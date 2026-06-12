//! Mid-tier generation (pipeline Phase 8): the display-adaptive ≤2560 px tier.
//!
//! Pure CPU pipeline, no I/O: `zune-jpeg` decode → `fast_image_resize` SIMD
//! Lanczos3 resize to ≤[`MID_LONG_EDGE`] long edge → `jpeg-encoder` q[`MID_QUALITY`]
//! encode → splice the SOURCE's EXIF orientation with
//! [`crate::cr3::with_exif_orientation`]. The decoder outputs UNROTATED pixels
//! and the re-encode emits no EXIF, so the splice is mandatory — the webview
//! rotates on display; pixels are NEVER rotated (the plan's invariant, and the
//! reason a portrait frame served from the mid cache renders correctly).
//!
//! Callers (bundle.rs):
//! - `read_mid` miss on the LOCAL profile — exact-range full read, then this.
//! - opportunistic generation in `read_fullres` — the full's bytes are already
//!   in memory from the zoom read, zero extra I/O.
//! - `generate_mid` — the frontend's local-profile idle sweep.
//!
//! [`MidGen`] is the generation-concurrency gate (1 network / 2 local, the
//! plan's profile table): a semaphore over the CPU work plus a per-path
//! pending set so concurrent callers never generate the same mid twice.
//!
//! Encoder decision (benchmarked at implementation time, see the gated
//! `encoder_benchmark` test + the Phase 8 plan note): `jpeg-encoder` (simd).

use std::collections::HashSet;
use std::sync::{Arc, Mutex, RwLock};

use fast_image_resize::images::Image;
use fast_image_resize::{FilterType, PixelType, ResizeAlg, ResizeOptions, Resizer};
use jpeg_encoder::{ColorType, Encoder};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use zune_jpeg::zune_core::bytestream::ZCursor;
use zune_jpeg::zune_core::colorspace::ColorSpace;
use zune_jpeg::zune_core::options::DecoderOptions;
use zune_jpeg::JpegDecoder;

use crate::cr3::with_exif_orientation;

/// Long-edge cap of the generated tier (the plan's tier ladder).
pub const MID_LONG_EDGE: u32 = 2560;
/// JPEG quality of the generated tier.
pub const MID_QUALITY: u8 = 80;

/// Generation concurrency (the plan's profile table: mid-gen 1 / 2).
const NETWORK_GEN_PERMITS: usize = 1;
const LOCAL_GEN_PERMITS: usize = 2;

/// A generated mid-tier JPEG plus its (unrotated) pixel dimensions.
#[derive(Debug)]
pub struct MidJpeg {
    /// q80 JPEG with the source's orientation APP1 spliced in.
    pub jpeg: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

/// Target dimensions for a mid generated from a `w`×`h` source: long edge
/// scaled to exactly [`MID_LONG_EDGE`], short edge rounded, aspect preserved.
/// `None` when the source's long edge is already ≤ the cap — such a source
/// needs no mid (the full IS mid-sized; zoom serves it), and re-encoding it
/// would only burn CPU for a quality loss.
pub fn mid_dims(w: u32, h: u32) -> Option<(u32, u32)> {
    let long = w.max(h);
    if long <= MID_LONG_EDGE || w == 0 || h == 0 {
        return None;
    }
    let short = w.min(h);
    // Round-half-up in u64 so 32 MP sources can't overflow the multiply.
    let scaled = ((short as u64 * MID_LONG_EDGE as u64 + long as u64 / 2) / long as u64) as u32;
    let scaled = scaled.max(1);
    Some(if w >= h { (MID_LONG_EDGE, scaled) } else { (scaled, MID_LONG_EDGE) })
}

/// Decode → resize → encode → orientation splice. `cancelled` is polled
/// between the pipeline stages (decode/resize/encode are each indivisible) —
/// a superseded generation dies at the next stage boundary and returns the
/// `"cancelled"` sentinel the command layer drops quietly.
pub fn generate_mid_jpeg(
    full_jpeg: &[u8],
    orientation: u32,
    cancelled: &dyn Fn() -> bool,
) -> Result<MidJpeg, String> {
    if cancelled() {
        return Err("cancelled".into());
    }
    // Decode to RGB8 regardless of the source's internal colorspace (Canon
    // fulls are YCbCr; zune converts on output).
    let opts = DecoderOptions::default().jpeg_set_out_colorspace(ColorSpace::RGB);
    let mut decoder = JpegDecoder::new_with_options(ZCursor::new(full_jpeg), opts);
    let pixels = decoder.decode().map_err(|e| format!("mid decode: {e:?}"))?;
    let info = decoder.info().ok_or("mid decode: no header info")?;
    let (w, h) = (info.width as u32, info.height as u32);
    if pixels.len() != (w as usize) * (h as usize) * 3 {
        return Err(format!(
            "mid decode: unexpected buffer ({} bytes for {w}x{h} RGB)",
            pixels.len()
        ));
    }
    let Some((tw, th)) = mid_dims(w, h) else {
        return Err(format!("source not larger than mid tier ({w}x{h})"));
    };

    if cancelled() {
        return Err("cancelled".into());
    }
    let src = Image::from_vec_u8(w, h, pixels, PixelType::U8x3)
        .map_err(|e| format!("mid resize src: {e}"))?;
    let mut dst = Image::new(tw, th, PixelType::U8x3);
    Resizer::new()
        .resize(
            &src,
            &mut dst,
            &ResizeOptions::new().resize_alg(ResizeAlg::Convolution(FilterType::Lanczos3)),
        )
        .map_err(|e| format!("mid resize: {e}"))?;
    drop(src); // the ~100 MB source raster — release before the encode allocates

    if cancelled() {
        return Err("cancelled".into());
    }
    let mut out = Vec::new();
    Encoder::new(&mut out, MID_QUALITY)
        .encode(dst.buffer(), tw as u16, th as u16, ColorType::Rgb)
        .map_err(|e| format!("mid encode: {e}"))?;

    // Same orientation mechanism as every other tier: splice the source's
    // EXIF Orientation APP1; the webview rotates on display.
    let jpeg = with_exif_orientation(out, orientation);
    Ok(MidJpeg { jpeg, width: tw, height: th })
}

/// Generation-concurrency gate: a swap-on-profile semaphore over the CPU work
/// (mirrors [`crate::io_gate::IoGate`]'s wholesale-replacement contract — an
/// in-flight permit releases into the old instance harmlessly) plus a pending
/// set so the opportunistic path never queues the same path twice.
pub struct MidGen {
    sem: RwLock<Arc<Semaphore>>,
    pending: Mutex<HashSet<String>>,
}

impl MidGen {
    pub fn new() -> Self {
        MidGen {
            // Conservative single-permit default until the frontend pushes a
            // profile (set_io_profile) — same "unset is generous to the user,
            // stingy with resources" stance as IoGate's unset timeouts.
            sem: RwLock::new(Arc::new(Semaphore::new(NETWORK_GEN_PERMITS))),
            pending: Mutex::new(HashSet::new()),
        }
    }

    /// Swap the generation cap for a storage-mode change (1 network / 2 local).
    pub fn set_profile(&self, network: bool) {
        let permits = if network { NETWORK_GEN_PERMITS } else { LOCAL_GEN_PERMITS };
        let mut sem = match self.sem.write() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        *sem = Arc::new(Semaphore::new(permits));
    }

    /// Acquire an owned generation permit (moved into the blocking task).
    pub async fn acquire(&self) -> OwnedSemaphorePermit {
        let sem = match self.sem.read() {
            Ok(guard) => Arc::clone(&guard),
            Err(poisoned) => Arc::clone(&poisoned.into_inner()),
        };
        sem.acquire_owned().await.expect("MidGen semaphore closed")
    }

    /// Claim `path` for a generation attempt; false when one is already
    /// pending (the caller skips — dedup for the opportunistic spawns).
    pub fn try_begin(&self, path: &str) -> bool {
        match self.pending.lock() {
            Ok(mut p) => p.insert(path.to_string()),
            Err(_) => false,
        }
    }

    /// Release the claim (success or failure — the next caller may retry).
    pub fn end(&self, path: &str) {
        if let Ok(mut p) = self.pending.lock() {
            p.remove(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    /// Deterministic photo-ish RGB: red ramps along x, green along y, blue on
    /// the diagonal, plus a small position hash so the entropy isn't
    /// gradient-trivial. Asymmetric per channel ON PURPOSE: a channel-order
    /// bug (RGB↔BGR) in the pipeline would shift sampled values massively.
    fn synth_rgb(w: u32, h: u32) -> Vec<u8> {
        let mut px = Vec::with_capacity((w * h * 3) as usize);
        for y in 0..h {
            for x in 0..w {
                let n = ((x.wrapping_mul(31)).wrapping_add(y.wrapping_mul(17)) % 13) as u8;
                px.push(((x * 255 / w.max(1)) as u8).wrapping_add(n));
                px.push((y * 255 / h.max(1)) as u8);
                px.push(((x + y) * 255 / (w + h).max(1)) as u8);
            }
        }
        px
    }

    fn synth_jpeg(w: u32, h: u32, quality: u8) -> Vec<u8> {
        let mut out = Vec::new();
        Encoder::new(&mut out, quality)
            .encode(&synth_rgb(w, h), w as u16, h as u16, ColorType::Rgb)
            .expect("synth encode");
        out
    }

    fn decode_rgb(jpeg: &[u8]) -> (Vec<u8>, u32, u32) {
        let opts = DecoderOptions::default().jpeg_set_out_colorspace(ColorSpace::RGB);
        let mut d = JpegDecoder::new_with_options(ZCursor::new(jpeg), opts);
        let px = d.decode().expect("decode");
        let info = d.info().expect("info");
        (px, info.width as u32, info.height as u32)
    }

    #[test]
    fn mid_dims_scales_long_edge_to_2560_preserving_aspect() {
        // R6 III sensor: 6960×4640 (3:2) → 2560×1707.
        assert_eq!(mid_dims(6960, 4640), Some((2560, 1707)));
        // Portrait-shaped source transposes.
        assert_eq!(mid_dims(4640, 6960), Some((1707, 2560)));
        assert_eq!(mid_dims(4000, 4000), Some((2560, 2560)));
        // Rounding: 2561×1000 → short = 1000*2560/2561 = 999.6 → 1000.
        assert_eq!(mid_dims(2561, 1000), Some((2560, 1000)));
        // At or under the cap (and degenerate inputs): no mid.
        assert_eq!(mid_dims(2560, 1440), None);
        assert_eq!(mid_dims(1620, 1080), None);
        assert_eq!(mid_dims(0, 4000), None);
    }

    #[test]
    fn generate_resizes_reencodes_and_preserves_pixels() {
        let input = synth_jpeg(3000, 2000, 90);
        let m = generate_mid_jpeg(&input, 1, &|| false).expect("generate");
        assert_eq!((m.width, m.height), (2560, 1707));
        assert_eq!(&m.jpeg[..2], &[0xFF, 0xD8], "SOI");
        assert_eq!(&m.jpeg[m.jpeg.len() - 2..], &[0xFF, 0xD9], "EOI");
        // Orientation 1 splices nothing: jpeg-encoder's JFIF APP0 leads.
        assert_eq!(m.jpeg[3], 0xE0, "no APP1 for upright frames");

        let (px, w, h) = decode_rgb(&m.jpeg);
        assert_eq!((w, h), (2560, 1707));
        // Channel sanity at an asymmetric point — mid (1920, 427) maps back
        // to source (2250, 500): R = 2250·255/3000 ≈ 191, G = 500·255/2000
        // ≈ 64, B = 2750·255/5000 ≈ 140. A swapped channel order (RGB↔BGR)
        // would put ~64 where ~191 belongs. Tolerance covers q80 +
        // resampling + the synth noise.
        let (sx, sy) = (1920usize, 427usize);
        let i = (sy * 2560 + sx) * 3;
        let (r, g, b) = (px[i] as i32, px[i + 1] as i32, px[i + 2] as i32);
        assert!((r - 191).abs() < 20, "R at 3/4-x should be ≈191, got {r}");
        assert!((g - 64).abs() < 20, "G at 1/4-y should be ≈64, got {g}");
        assert!((b - 140).abs() < 20, "B on the diagonal should be ≈140, got {b}");
    }

    #[test]
    fn generate_refuses_sources_not_larger_than_mid() {
        let input = synth_jpeg(2000, 1500, 85);
        let err = generate_mid_jpeg(&input, 1, &|| false).unwrap_err();
        assert!(err.contains("not larger"), "got: {err}");
    }

    /// The plan's portrait case: a rotated (orientation 6/8) source must come
    /// out with OUR orientation APP1 spliced right after SOI — unrotated
    /// pixels, webview rotates — exactly like every other tier.
    #[test]
    fn generate_splices_source_orientation_app1() {
        let input = synth_jpeg(3000, 2000, 90);
        for orient in [3u32, 6, 8] {
            let m = generate_mid_jpeg(&input, orient, &|| false).expect("generate");
            // build_orientation_app1 layout, spliced at byte 2: marker at
            // [2..4], the SHORT value's low byte lands at absolute offset 30.
            assert_eq!(&m.jpeg[2..4], &[0xFF, 0xE1], "orient {orient}: APP1 marker");
            assert_eq!(&m.jpeg[6..12], b"Exif\0\0", "orient {orient}: EXIF header");
            assert_eq!(m.jpeg[30] as u32, orient, "orient {orient}: tag value");
            // Pixels stay unrotated: dims are the resize output, not swapped.
            let (_, w, h) = decode_rgb(&m.jpeg);
            assert_eq!((w, h), (2560, 1707), "orient {orient}: pixels never rotate");
        }
    }

    #[test]
    fn generate_bails_on_cancellation() {
        let input = synth_jpeg(3000, 2000, 90);
        let err = generate_mid_jpeg(&input, 1, &|| true).unwrap_err();
        assert_eq!(err, "cancelled");
    }

    /// End-to-end over the real corpus (mirrors the Phase 2 gate style): every
    /// sample CR3's full generates a valid mid that decodes at the expected
    /// dims, fits the tier cache's 4 MiB per-entry cap, and carries the
    /// source's orientation. Gated: `CULL_TEST_CR3_DIR=path cargo test -- --nocapture`.
    #[test]
    fn mid_generation_over_sample_dir() {
        let Ok(dir) = std::env::var("CULL_TEST_CR3_DIR") else {
            eprintln!("skip: set CULL_TEST_CR3_DIR to a folder of .CR3 files");
            return;
        };
        let mut paths: Vec<_> = walkdir::WalkDir::new(&dir)
            .into_iter()
            .flatten()
            .filter(|e| e.file_type().is_file())
            .map(|e| e.path().to_path_buf())
            .filter(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("cr3")))
            .collect();
        paths.sort();
        assert!(!paths.is_empty(), "no CR3 files under {dir}");

        eprintln!("{:<16} {:>6} {:>9} {:>9} {:>8}", "file", "orient", "fullKB", "midKB", "genMs");
        for p in &paths {
            let ps = p.to_string_lossy().to_string();
            let (full, orient) = crate::cr3::read_fullres_scan(&ps)
                .unwrap_or_else(|e| panic!("{ps}: full scan {e}"));
            let t0 = Instant::now();
            let m = generate_mid_jpeg(&full, orient, &|| false)
                .unwrap_or_else(|e| panic!("{ps}: generate {e}"));
            let ms = t0.elapsed().as_millis();
            // Valid JPEG at ≤2560 long edge, aspect preserved within a pixel.
            let img = image::load_from_memory(&m.jpeg)
                .unwrap_or_else(|e| panic!("{ps}: mid decode {e}"));
            assert_eq!(img.width().max(img.height()), 2560, "{ps}: long edge");
            assert_eq!((img.width(), img.height()), (m.width, m.height), "{ps}: header dims");
            let ar = img.width() as f64 / img.height() as f64;
            let src_ar = if m.width >= m.height { 3.0 / 2.0 } else { 2.0 / 3.0 };
            assert!((ar - src_ar).abs() < 0.01, "{ps}: aspect drifted to {ar}");
            // Fits the mid tier's per-entry cap with the prelude + header.
            assert!(
                m.jpeg.len() as u64 + 4096 < 4 * 1024 * 1024,
                "{ps}: mid {}B vs 4 MiB cap",
                m.jpeg.len()
            );
            // Orientation spliced for the rotating values.
            if matches!(orient, 3 | 6 | 8) {
                assert_eq!(&m.jpeg[2..4], &[0xFF, 0xE1], "{ps}: APP1");
                assert_eq!(m.jpeg[30] as u32, orient, "{ps}: orientation");
            }
            eprintln!(
                "{:<16} {:>6} {:>9} {:>9} {:>8}",
                p.file_name().unwrap().to_string_lossy(),
                orient,
                full.len() / 1024,
                m.jpeg.len() / 1024,
                ms
            );
        }
    }

    /// Encoder decision gate (the plan: "benchmark jpeg-encoder vs zenjpeg at
    /// implementation time"). Times the q80 encode of the SAME resized
    /// 2560-long-edge RGB buffer through both encoders (plus the decode +
    /// resize stages once, for the pipeline-cost claim). Uses a real corpus
    /// full when CULL_TEST_CR3_DIR is set, else a synthetic 6960×4640 frame.
    /// Gated: `CULL_BENCH=1 cargo test encoder_benchmark -- --nocapture`.
    #[test]
    fn encoder_benchmark() {
        if std::env::var("CULL_BENCH").is_err() {
            eprintln!("skip: set CULL_BENCH=1 (and optionally CULL_TEST_CR3_DIR) to run");
            return;
        }
        let full: Vec<u8> = match std::env::var("CULL_TEST_CR3_DIR") {
            Ok(dir) => {
                let p = walkdir::WalkDir::new(&dir)
                    .into_iter()
                    .flatten()
                    .find(|e| {
                        e.file_type().is_file()
                            && e.path()
                                .extension()
                                .is_some_and(|x| x.eq_ignore_ascii_case("cr3"))
                    })
                    .expect("a CR3 under CULL_TEST_CR3_DIR");
                let ps = p.path().to_string_lossy().to_string();
                eprintln!("source: {ps}");
                crate::cr3::read_fullres_scan(&ps).expect("full scan").0
            }
            Err(_) => {
                eprintln!("source: synthetic 6960x4640 (corpus not set)");
                synth_jpeg(6960, 4640, 92)
            }
        };

        let t = Instant::now();
        let (px, w, h) = decode_rgb(&full);
        eprintln!("decode  {}x{}: {} ms", w, h, t.elapsed().as_millis());

        let (tw, th) = mid_dims(w, h).expect("dims");
        let src = Image::from_vec_u8(w, h, px, PixelType::U8x3).unwrap();
        let mut dst = Image::new(tw, th, PixelType::U8x3);
        let t = Instant::now();
        Resizer::new()
            .resize(
                &src,
                &mut dst,
                &ResizeOptions::new().resize_alg(ResizeAlg::Convolution(FilterType::Lanczos3)),
            )
            .unwrap();
        eprintln!("resize  → {}x{}: {} ms (Lanczos3 SIMD)", tw, th, t.elapsed().as_millis());
        let rgb = dst.buffer();

        const ITERS: usize = 8;
        let mut je_ms = Vec::new();
        let mut je_len = 0usize;
        for _ in 0..ITERS {
            let t = Instant::now();
            let mut out = Vec::new();
            Encoder::new(&mut out, MID_QUALITY)
                .encode(rgb, tw as u16, th as u16, ColorType::Rgb)
                .unwrap();
            je_ms.push(t.elapsed().as_millis());
            je_len = out.len();
        }
        let mut zj_ms = Vec::new();
        let mut zj_len = 0usize;
        for _ in 0..ITERS {
            use zenjpeg::encoder::{ChromaSubsampling, EncoderConfig, PixelLayout, Unstoppable};
            let t = Instant::now();
            let mut enc = EncoderConfig::ycbcr(MID_QUALITY, ChromaSubsampling::Quarter)
                .encode_from_bytes(tw, th, PixelLayout::Rgb8Srgb)
                .unwrap();
            enc.push_packed(rgb, Unstoppable).unwrap();
            let out = enc.finish().unwrap();
            zj_ms.push(t.elapsed().as_millis());
            zj_len = out.len();
        }
        je_ms.sort_unstable();
        zj_ms.sort_unstable();
        eprintln!(
            "jpeg-encoder(simd) q80: min {} / med {} ms → {} KB",
            je_ms[0], je_ms[ITERS / 2], je_len / 1024
        );
        eprintln!(
            "zenjpeg q80 4:2:0:      min {} / med {} ms → {} KB",
            zj_ms[0], zj_ms[ITERS / 2], zj_len / 1024
        );
    }
}
