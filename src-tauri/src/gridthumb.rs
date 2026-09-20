//! Grid-thumbnail generation (Phase 3B): the sharp contact-sheet tier.
//!
//! The grid used to paint the CR3's embedded THMB (160×120). At DPR 1.5 a
//! 161-px frame is already a 1.5× upscale, and the Large grid size would make
//! it 2.4× — visibly soft on exactly the screen this app is used on. This tier
//! is [`GRID_LONG_EDGE`] px on the long edge, q[`GRID_QUALITY`], generated from
//! the CR3's embedded 1620×1080 PRVW preview (which `read_preview` has already
//! read and cached, so the grid tier costs CPU, not a second source read).
//!
//! Same pure pipeline as [`crate::midtier`], one tier down: `zune-jpeg` decode
//! → `fast_image_resize` SIMD Lanczos3 → `jpeg-encoder` → splice the SOURCE's
//! EXIF orientation with [`crate::cr3::with_exif_orientation`]. The decoder
//! ignores the PRVW's own APP1 and the re-encode emits none, so THE SPLICE IS
//! MANDATORY — without it every portrait frame in the grid is sideways.
//!
//! A separate module rather than a parameter on `midtier`: that tier's numbers
//! are `pub` and asserted by name, and it serves a 250–400 ms job where this is
//! ~20 ms. The generation-concurrency GATE is shared ([`crate::midtier::MidGen`])
//! so the two tiers cannot oversubscribe the CPU against each other.

use fast_image_resize::images::Image;
use fast_image_resize::{FilterType, PixelType, ResizeAlg, ResizeOptions, Resizer};
use jpeg_encoder::{ColorType, Encoder};

use crate::cr3::with_exif_orientation;

/// Long-edge cap of the grid tier. 512 covers the Large grid cell (279 CSS px
/// frame → 419 device px at DPR 1.5) with headroom, at ~35 KB per frame.
pub const GRID_LONG_EDGE: u32 = 512;
/// JPEG quality of the grid tier. A notch above the mid tier's 80: these are
/// small files where a little extra quality costs kilobytes, not megabytes.
pub const GRID_QUALITY: u8 = 82;

/// A generated grid-tier JPEG plus its (unrotated) pixel dimensions.
#[derive(Debug)]
pub struct GridThumb {
    /// q82 JPEG with the source's orientation APP1 spliced in.
    pub jpeg: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

/// Target dimensions for a grid thumb from a `w`×`h` source: long edge scaled
/// to exactly [`GRID_LONG_EDGE`], short edge rounded, aspect preserved. `None`
/// when the source's long edge is already ≤ the cap — such a source needs no
/// grid thumb (the command answers the quiet sentinel and the cell keeps its
/// THMB), and re-encoding it would only burn CPU for a quality loss.
pub fn grid_dims(w: u32, h: u32) -> Option<(u32, u32)> {
    let long = w.max(h);
    if long <= GRID_LONG_EDGE || w == 0 || h == 0 {
        return None;
    }
    let short = w.min(h);
    // Round-half-up in u64 for symmetry with midtier::mid_dims (no overflow
    // risk at this size, but the two formulas must not drift).
    let scaled = ((short as u64 * GRID_LONG_EDGE as u64 + long as u64 / 2) / long as u64) as u32;
    let scaled = scaled.max(1);
    Some(if w >= h {
        (GRID_LONG_EDGE, scaled)
    } else {
        (scaled, GRID_LONG_EDGE)
    })
}

/// Decode → resize → encode → orientation splice. `cancelled` is polled
/// between the pipeline stages (each is indivisible) — a superseded generation
/// dies at the next stage boundary and returns the `"cancelled"` sentinel the
/// command layer drops quietly.
pub fn generate_grid_thumb_jpeg(
    preview_jpeg: &[u8],
    orientation: u32,
    cancelled: &dyn Fn() -> bool,
) -> Result<GridThumb, String> {
    if cancelled() {
        return Err("cancelled".into());
    }
    let (pixels, w, h) =
        crate::jpeg_rgb::decode_rgb(preview_jpeg).map_err(|e| format!("grid thumb {e}"))?;
    let (w, h) = (w as u32, h as u32);
    let Some((tw, th)) = grid_dims(w, h) else {
        return Err(format!("source not larger than grid tier ({w}x{h})"));
    };

    if cancelled() {
        return Err("cancelled".into());
    }
    let src = Image::from_vec_u8(w, h, pixels, PixelType::U8x3)
        .map_err(|e| format!("grid thumb resize src: {e}"))?;
    let mut dst = Image::new(tw, th, PixelType::U8x3);
    Resizer::new()
        .resize(
            &src,
            &mut dst,
            &ResizeOptions::new().resize_alg(ResizeAlg::Convolution(FilterType::Lanczos3)),
        )
        .map_err(|e| format!("grid thumb resize: {e}"))?;
    drop(src);

    if cancelled() {
        return Err("cancelled".into());
    }
    let mut out = Vec::new();
    Encoder::new(&mut out, GRID_QUALITY)
        .encode(dst.buffer(), tw as u16, th as u16, ColorType::Rgb)
        .map_err(|e| format!("grid thumb encode: {e}"))?;

    let jpeg = with_exif_orientation(out, orientation);
    Ok(GridThumb {
        jpeg,
        width: tw,
        height: th,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::synth_jpeg;

    fn decode_rgb(jpeg: &[u8]) -> (Vec<u8>, u32, u32) {
        let (px, w, h) = crate::jpeg_rgb::decode_rgb(jpeg).expect("decode");
        (px, w as u32, h as u32)
    }

    #[test]
    fn grid_dims_scales_long_edge_to_512_preserving_aspect() {
        // The PRVW this tier is generated from: 1620×1080 (3:2) → 512×341.
        assert_eq!(grid_dims(1620, 1080), Some((512, 341)));
        // A portrait-shaped source transposes.
        assert_eq!(grid_dims(1080, 1620), Some((341, 512)));
        assert_eq!(grid_dims(1000, 1000), Some((512, 512)));
        // Rounding: 513×200 → short = 200*512/513 = 199.6 → 200.
        assert_eq!(grid_dims(513, 200), Some((512, 200)));
        // At or under the cap (and degenerate inputs): no grid thumb.
        assert_eq!(grid_dims(512, 342), None);
        assert_eq!(grid_dims(160, 120), None);
        assert_eq!(grid_dims(0, 1080), None);
    }

    #[test]
    fn generate_resizes_reencodes_and_preserves_pixels() {
        let input = synth_jpeg(1620, 1080, 90);
        let g = generate_grid_thumb_jpeg(&input, 1, &|| false).expect("generate");
        assert_eq!((g.width, g.height), (512, 341));
        assert_eq!(&g.jpeg[..2], &[0xFF, 0xD8], "SOI");
        assert_eq!(&g.jpeg[g.jpeg.len() - 2..], &[0xFF, 0xD9], "EOI");
        // Orientation 1 splices nothing: jpeg-encoder's JFIF APP0 leads.
        assert_eq!(g.jpeg[3], 0xE0, "no APP1 for upright frames");

        let (px, w, h) = decode_rgb(&g.jpeg);
        assert_eq!((w, h), (512, 341));
        // Channel sanity at an asymmetric point — grid (384, 85) maps back to
        // source (1215, 269): R = 1215·255/1620 ≈ 191, G = 269·255/1080 ≈ 64,
        // B = 1484·255/2700 ≈ 140. A swapped channel order would put ~64
        // where ~191 belongs. Tolerance covers q82 + resampling + synth noise.
        let i = (85usize * 512 + 384) * 3;
        let (r, g_, b) = (px[i] as i32, px[i + 1] as i32, px[i + 2] as i32);
        assert!((r - 191).abs() < 20, "R at 3/4-x should be ≈191, got {r}");
        assert!((g_ - 64).abs() < 20, "G at 1/4-y should be ≈64, got {g_}");
        assert!(
            (b - 140).abs() < 20,
            "B on the diagonal should be ≈140, got {b}"
        );
    }

    #[test]
    fn generate_refuses_sources_not_larger_than_the_tier() {
        let input = synth_jpeg(400, 300, 85);
        let err = generate_grid_thumb_jpeg(&input, 1, &|| false).unwrap_err();
        assert!(err.contains("not larger"), "got: {err}");
    }

    /// A rotated source must come out with OUR orientation APP1 spliced right
    /// after SOI — unrotated pixels, webview rotates — like every other tier.
    /// Without this, every portrait frame in the grid is sideways.
    #[test]
    fn generate_splices_source_orientation_app1() {
        let input = synth_jpeg(1620, 1080, 90);
        for orient in [3u32, 6, 8] {
            let g = generate_grid_thumb_jpeg(&input, orient, &|| false).expect("generate");
            assert_eq!(&g.jpeg[2..4], &[0xFF, 0xE1], "orient {orient}: APP1 marker");
            assert_eq!(&g.jpeg[6..12], b"Exif\0\0", "orient {orient}: EXIF header");
            assert_eq!(g.jpeg[30] as u32, orient, "orient {orient}: tag value");
            let (_, w, h) = decode_rgb(&g.jpeg);
            assert_eq!((w, h), (512, 341), "orient {orient}: pixels never rotate");
        }
    }

    #[test]
    fn generate_bails_on_cancellation() {
        let input = synth_jpeg(1620, 1080, 90);
        let err = generate_grid_thumb_jpeg(&input, 1, &|| true).unwrap_err();
        assert_eq!(err, "cancelled");
    }

    #[test]
    fn generate_refuses_undecodable_bytes() {
        let err = generate_grid_thumb_jpeg(b"not a jpeg", 1, &|| false).unwrap_err();
        assert!(err.starts_with("grid thumb "), "got: {err}");
    }
}
