//! 64-bit DCT perceptual hash (smart-culling Phase 3d, always-on).
//!
//! Classic pHash recipe: luma → area-average to 32×32 → 2-D DCT-II → take the
//! 8×8 low-frequency block (skipping the DC term for the median) → each bit =
//! coefficient > median. Robust to re-encode/resize/small exposure shifts;
//! Hamming distance ≤ ~10 ⇒ near-exact duplicate.

/// 64-bit DCT pHash of a tightly-packed luma buffer.
pub fn phash64(luma: &[u8], w: usize, h: usize) -> u64 {
    if w == 0 || h == 0 || luma.len() < w * h {
        return 0;
    }
    let small = shrink32(luma, w, h);
    let d = dct32(&small);
    // 8×8 low-frequency block; median EXCLUDES the DC term [0][0].
    let mut block = [0f32; 64];
    for v in 0..8 {
        for u in 0..8 {
            block[v * 8 + u] = d[v * 32 + u];
        }
    }
    let mut ac: Vec<f32> = block[1..].to_vec();
    ac.sort_by(|a, b| a.total_cmp(b));
    let median = (ac[31] + ac[32]) / 2.0;
    let mut hash = 0u64;
    for (i, &c) in block.iter().enumerate() {
        if c > median {
            hash |= 1 << i;
        }
    }
    hash
}

/// Hamming distance between two hashes.
pub fn hamming(a: u64, b: u64) -> u32 {
    (a ^ b).count_ones()
}

/// Area-average (box-filter) downscale to 32×32 — cheap and alias-resistant
/// for a hash (bilinear would be fine too; area is the classic pHash choice).
fn shrink32(luma: &[u8], w: usize, h: usize) -> Vec<f32> {
    const N: usize = 32;
    let mut out = vec![0f32; N * N];
    for oy in 0..N {
        let y0 = oy * h / N;
        let y1 = ((oy + 1) * h / N).max(y0 + 1).min(h);
        for ox in 0..N {
            let x0 = ox * w / N;
            let x1 = ((ox + 1) * w / N).max(x0 + 1).min(w);
            let mut sum = 0u32;
            for y in y0..y1 {
                for x in x0..x1 {
                    sum += luma[y * w + x] as u32;
                }
            }
            out[oy * N + ox] = sum as f32 / ((y1 - y0) * (x1 - x0)) as f32;
        }
    }
    out
}

/// 2-D DCT-II of a 32×32 buffer (separable, O(N³) — 32³ ≈ 33k mults, ~free).
pub(crate) fn dct32(px: &[f32]) -> Vec<f32> {
    const N: usize = 32;
    // Precompute cos table: cos[(2x+1)uπ / 2N] indexed [u][x].
    let mut cos = [[0f32; N]; N];
    for (u, row) in cos.iter_mut().enumerate() {
        for (x, c) in row.iter_mut().enumerate() {
            *c = (std::f32::consts::PI * (2.0 * x as f32 + 1.0) * u as f32 / (2.0 * N as f32)).cos();
        }
    }
    // Rows, then columns.
    let mut tmp = vec![0f32; N * N];
    for y in 0..N {
        for u in 0..N {
            let mut s = 0f32;
            for x in 0..N {
                s += px[y * N + x] * cos[u][x];
            }
            tmp[y * N + u] = s;
        }
    }
    let mut out = vec![0f32; N * N];
    for u in 0..N {
        for v in 0..N {
            let mut s = 0f32;
            for y in 0..N {
                s += tmp[y * N + u] * cos[v][y];
            }
            out[v * N + u] = s;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Deterministic LCG (same recipe as analyze.rs tests).
    struct Lcg(u64);
    impl Lcg {
        fn next_u8(&mut self) -> u8 {
            self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (self.0 >> 33) as u8
        }
    }

    /// Structured test image: smooth gradient + a few hard rectangles, so the
    /// hash has real low-frequency content (a pure-noise image is a bad pHash
    /// subject — its low frequencies are all ~0).
    fn scene(w: usize, h: usize, seed: u64) -> Vec<u8> {
        let mut lcg = Lcg(seed);
        let mut out = vec![0u8; w * h];
        for y in 0..h {
            for x in 0..w {
                let grad = (255 * x / w.max(1)) as i32;
                let block = if (x / (w / 4).max(1) + y / (h / 4).max(1)) % 2 == 0 { 60 } else { -60 };
                let noise = (lcg.next_u8() % 8) as i32;
                out[y * w + x] = (grad + block + noise).clamp(0, 255) as u8;
            }
        }
        out
    }

    #[test]
    fn identical_buffers_hash_identically() {
        let a = scene(320, 200, 1);
        assert_eq!(phash64(&a, 320, 200), phash64(&a, 320, 200));
        assert_eq!(hamming(phash64(&a, 320, 200), phash64(&a, 320, 200)), 0);
    }

    #[test]
    fn resized_copy_stays_near() {
        // Same scene rendered at two sizes — pHash is resolution-invariant by
        // construction (everything funnels through 32×32).
        let a = scene(320, 200, 1);
        let b = scene(640, 400, 1);
        let d = hamming(phash64(&a, 320, 200), phash64(&b, 640, 400));
        assert!(d <= 10, "resize should stay near: hamming={d}");
    }

    #[test]
    fn small_noise_stays_near_but_different_scenes_are_far() {
        let a = scene(320, 200, 1);
        let noisy = scene(320, 200, 2); // different noise seed, same structure
        let d_noise = hamming(phash64(&a, 320, 200), phash64(&noisy, 320, 200));
        assert!(d_noise <= 6, "noise-only change: hamming={d_noise}");

        // Structurally different scene: invert the gradient direction.
        let mut inv = a.clone();
        for y in 0..200 {
            for x in 0..320 {
                inv[y * 320 + x] = a[y * 320 + (319 - x)];
            }
        }
        let d_diff = hamming(phash64(&a, 320, 200), phash64(&inv, 320, 200));
        assert!(d_diff > 16, "mirrored scene must be far: hamming={d_diff}");
    }

    #[test]
    fn flat_buffer_is_stable_not_panicky() {
        // All-flat input: every AC coefficient ~0 → hash is all-zeros-vs-median
        // degenerate but must not panic and must be deterministic.
        let flat = vec![128u8; 64 * 64];
        assert_eq!(phash64(&flat, 64, 64), phash64(&flat, 64, 64));
    }

    #[test]
    fn dct_of_constant_signal_is_dc_only() {
        // Unit check on the internal DCT: constant input → only [0][0] non-zero.
        let d = dct32(&[1.0f32; 32 * 32]);
        assert!(d[0].abs() > 1.0);
        assert!(d[1].abs() < 1e-3 && d[32].abs() < 1e-3);
    }
}
