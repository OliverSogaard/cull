//! Shared test fixtures (cfg(test) only — never compiled into the app).
//!
//! One home for the synthetic-image generators the per-module test suites
//! used to carry as private copies (`bundle`, `midtier`, `phash`, `analyze`).

use jpeg_encoder::{ColorType, Encoder};

/// Deterministic photo-ish RGB: red ramps along x, green along y, blue on
/// the diagonal, plus a small position hash so the entropy isn't
/// gradient-trivial. Asymmetric per channel ON PURPOSE: a channel-order
/// bug (RGB↔BGR) in the pipeline would shift sampled values massively.
pub(crate) fn synth_rgb(w: u32, h: u32) -> Vec<u8> {
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

/// [`synth_rgb`] encoded as a real JPEG at the given quality.
pub(crate) fn synth_jpeg(w: u32, h: u32, quality: u8) -> Vec<u8> {
    let mut out = Vec::new();
    Encoder::new(&mut out, quality)
        .encode(&synth_rgb(w, h), w as u16, h as u16, ColorType::Rgb)
        .expect("synth encode");
    out
}

/// Deterministic LCG so test "noise" is reproducible across runs and
/// platforms (Knuth's MMIX multiplier).
pub(crate) struct Lcg(pub u64);

impl Lcg {
    pub(crate) fn next_u8(&mut self) -> u8 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (self.0 >> 33) as u8
    }
}
