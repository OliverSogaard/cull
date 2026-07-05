# Smart Culling Phase 3d + 3c Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Near-duplicate ("Similar ×N") grouping via always-on pHash + ML-gated DINOv2 embeddings, and an aesthetic-driven capped "favorite" suggestion via CLIP ViT-B/32 + LAION head — per the approved spec `SMART_CULLING_PHASE3_DESIGN.md`.

**Architecture:** One enriched pass — everything computes inside the existing `analyze_quality` chunk on the same single cache-routed read + decode per file. New fields ride `ImageScore`; ALL cross-frame derivation (similar grouping, winners, favorite capping) is pure TS in `src/smart/`. Models are self-exported from official weights (parity-checked vs PyTorch), bundled in the installer; the 175 MB CLIP tower lives on a `models-v1` GitHub release (not git) and is fetched by script/CI.

**Tech Stack:** Rust (Tauri 2 backend, `ort` 2.0.0-rc.12 behind cargo feature `smart-ml`), React 19 + TS (vitest), Python one-off export script (uv, dev-only).

## Global Constraints

- **Advisory-only invariant:** no code in this plan writes ANY file to a photo folder (no `.xmp`, no sidecars). Structurally there is still no write path in `analyze.rs`.
- **Never-modify-CR3 invariant:** unchanged, structural.
- **One read per file:** all new signals compute on the buffer `fetch_decoded_preview` already returns — no second read, no second decode anywhere.
- **Cross-frame derivation in TS only:** the Rust side stays per-file.
- **Platforms:** Windows + macOS ONLY. Never add Linux handling.
- **TDD:** every task writes the failing test first. Frontend suite: `pnpm test` (vitest). Backend: `cd src-tauri && cargo test` (and `cargo test --features smart-ml` where noted). Type gate: `pnpm exec tsc --noEmit`. Zero new Rust warnings (`cargo clippy -- -D warnings` mindset).
- **False-reject bias:** every new verdict gate biases toward silence; thresholds cite the calibration harness, not feel.
- **Existing test counts at plan time:** 283 frontend + 80 Rust — all must stay green after every task.
- **Commit style:** conventional commits (`feat:`/`refactor:`/`docs:`/`ci:`), no attribution footer.
- **Wire naming:** Rust `snake_case` struct fields serialize `camelCase` (serde `rename_all`), TS mirrors in `src/types/ipc.ts`.
- **64-bit pHash crosses the wire as a 16-char lowercase hex STRING** (`Option<String>`) — a JSON number would silently lose bits past 2^53 in JS. TS compares via `BigInt`.

---

### Task 1: pHash pure math (`phash.rs`)

Always-compiled pure Rust (no feature flag), mirroring how `faces.rs` keeps decode math unconditional.

**Files:**
- Create: `src-tauri/src/phash.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod phash;` beside `mod faces;`)
- Test: inline `#[cfg(test)]` in `phash.rs`

**Interfaces:**
- Produces: `pub fn phash64(luma: &[u8], w: usize, h: usize) -> u64` (DCT pHash of any luma buffer), `pub fn hamming(a: u64, b: u64) -> u32`. Task 2 calls `phash64` from `score_one` with the existing Rec.601 luma buffer.

- [ ] **Step 1: Write the failing tests**

```rust
// src-tauri/src/phash.rs — start with just the test module and unimplemented fns
//! 64-bit DCT perceptual hash (smart-culling Phase 3d, always-on).
//!
//! Classic pHash recipe: luma → area-average to 32×32 → 2-D DCT-II → take the
//! 8×8 low-frequency block (skipping the DC term for the median) → each bit =
//! coefficient > median. Robust to re-encode/resize/small exposure shifts;
//! Hamming distance ≤ ~10 ⇒ near-exact duplicate.

/// 64-bit DCT pHash of a tightly-packed luma buffer.
pub fn phash64(luma: &[u8], w: usize, h: usize) -> u64 {
    todo!()
}

/// Hamming distance between two hashes.
pub fn hamming(a: u64, b: u64) -> u32 {
    (a ^ b).count_ones()
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
```

Also expose the internal DCT for the unit test: declare `pub(crate) fn dct32(px: &[f32]) -> Vec<f32>` (32×32 in, 32×32 coefficients out) as `todo!()` for now.

- [ ] **Step 2: Register the module and run tests to verify they fail**

In `src-tauri/src/lib.rs`, next to the existing `mod faces;` line, add:

```rust
mod phash;
```

Run: `cd src-tauri && cargo test phash`
Expected: FAIL (panics on `todo!()`).

- [ ] **Step 3: Implement**

```rust
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test phash`
Expected: 5 tests PASS. Then `cargo test` — all 80+5 green, zero warnings.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/phash.rs src-tauri/src/lib.rs
git commit -m "feat: 64-bit DCT pHash core (always-on, pure math)"
```

---

### Task 2: `phash` on the wire

**Files:**
- Modify: `src-tauri/src/analyze.rs` (struct at :49, `score_one` at :347)
- Modify: `src/types/ipc.ts` (ImageScore at :30)
- Test: inline in `analyze.rs`

**Interfaces:**
- Produces: `ImageScore.phash: Option<String>` — 16-char lowercase hex of the pHash, `None` only on decode failure (default). TS type gains `phash: string | null`. Task 6 (groupSimilar) consumes it via `BigInt("0x" + phash)`.

- [ ] **Step 1: Write the failing test** (in `analyze.rs` `#[cfg(test)]`, near `score_one_echoes_grouping_inputs_and_sets_decode_ok` at :811 — reuse that test's `DecodedInput` fixture helper)

```rust
#[test]
fn score_one_computes_a_hex_phash() {
    let input = decoded_fixture(); // the existing helper the :811 test uses
    let s = score_one(&input, 0);
    let hex = s.phash.expect("phash set on every decoded frame");
    assert_eq!(hex.len(), 16);
    assert!(hex.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    // Deterministic: same buffer, same hash.
    assert_eq!(score_one(&input, 0).phash, Some(hex));
}
```

(If the :811 test builds its `DecodedInput` inline rather than via a helper, extract that construction into `fn decoded_fixture() -> DecodedInput` first — mechanical, keeps both tests DRY.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd src-tauri && cargo test score_one_computes_a_hex_phash`
Expected: FAIL — `phash` field doesn't exist (compile error).

- [ ] **Step 3: Implement**

In the `ImageScore` struct (after `tenengrad`, before the grouping-inputs block):

```rust
    /// 64-bit DCT pHash as 16 lowercase hex chars — STRING because JSON
    /// numbers lose bits past 2^53 in JS. None ⇒ decode failure.
    pub phash: Option<String>,
```

In `score_one` (it already computes `luma`), add to the returned struct:

```rust
        phash: Some(format!("{:016x}", crate::phash::phash64(&luma, w, h))),
```

In `src/types/ipc.ts` after `tenengrad`:

```typescript
  /** 64-bit DCT pHash, 16 lowercase hex chars (string: JS numbers lose 64-bit
   *  precision). null ⇒ decode failure. Compare via BigInt. */
  phash: string | null;
```

Fix the two TS test fixture files that build full `ImageScore` objects (`src/smart/testScores.ts` — add `phash: null` to the base fixture).

- [ ] **Step 4: Run tests**

Run: `cd src-tauri && cargo test` then `pnpm test` and `pnpm exec tsc --noEmit`
Expected: all green (Default derive gives `phash: None` for the decode-failure path automatically).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/analyze.rs src/types/ipc.ts src/smart/testScores.ts
git commit -m "feat: phash rides ImageScore as hex string"
```

---

### Task 3: `ml_models.rs` — LazySession extraction (refactor, no behavior change)

Five ONNX sessions will exist after this plan (YuNet, OCEC, DINOv2, CLIP, LAION head). `faces.rs` currently copy-pastes the lazy-session pattern twice (`SESSION`/`OCEC_SESSION`, :235-310). Extract once.

**Files:**
- Create: `src-tauri/src/ml_models.rs`
- Modify: `src-tauri/src/faces.rs` (`ml` module :228-405), `src-tauri/src/lib.rs`
- Test: existing `faces.rs` tests + corpus smoke stay green

**Interfaces:**
- Produces (all `#[cfg(feature = "smart-ml")]`):

```rust
pub struct LazySession { /* private */ }
impl LazySession {
    pub const fn new(name: &'static str) -> Self;
    pub fn init(&self, model_path: std::path::PathBuf);       // setup-time, idempotent
    pub fn get(&self) -> Option<&Mutex<ort::session::Session>>; // lazy build, None on failure
    pub fn ready(&self) -> bool;                                // smoke-test discriminator
}
```

Tasks 4–5 declare `static DINOV2: LazySession`, `static CLIP: LazySession`, `static LAION: LazySession` with it.

- [ ] **Step 1: Write the module** (refactor task — the "failing test" is the existing suite against the new plumbing)

```rust
// src-tauri/src/ml_models.rs
//! Shared lazy ONNX session plumbing (feature `smart-ml`).
//!
//! Every model follows the same lifecycle: path registered at Tauri setup,
//! session built on FIRST use (app boot never pays ONNX init), per-OS EP
//! (CoreML / DirectML) with silent CPU fallback, init failure = advisory
//! feature quietly off (logged), never an error surface.
#![cfg(feature = "smart-ml")]

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

pub struct LazySession {
    name: &'static str,
    path: OnceLock<PathBuf>,
    session: OnceLock<Option<Mutex<ort::session::Session>>>,
}

impl LazySession {
    pub const fn new(name: &'static str) -> Self {
        Self { name, path: OnceLock::new(), session: OnceLock::new() }
    }

    pub fn init(&self, model_path: PathBuf) {
        let _ = self.path.set(model_path);
    }

    pub fn get(&self) -> Option<&Mutex<ort::session::Session>> {
        self.session
            .get_or_init(|| {
                let path = self.path.get()?;
                match build_session(path) {
                    Ok(s) => Some(Mutex::new(s)),
                    Err(e) => {
                        dlog!("[cull] {} session init failed: {e}", self.name);
                        None
                    }
                }
            })
            .as_ref()
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn ready(&self) -> bool {
        self.get().is_some()
    }
}

/// Platform EP with silent CPU fallback (moved verbatim from faces.rs).
fn build_session(path: &std::path::Path) -> Result<ort::session::Session, ort::Error> {
    #[allow(unused_mut)]
    let mut b = ort::session::Session::builder()?;
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
```

Check how `dlog!` is imported in `faces.rs`'s `ml` module and mirror it (it's a crate-level macro — `use crate::dlog;` or `#[macro_use]`; copy whatever `faces.rs` does).

- [ ] **Step 2: Rewire `faces.rs` onto it**

In `faces.rs`'s `ml` module: delete `MODEL_PATH`/`SESSION`/`build_session`/`session()` and `OCEC_MODEL_PATH`/`OCEC_SESSION`/`ocec_session()` (keep `OCEC_IN_DIMS`); replace with:

```rust
    use crate::ml_models::LazySession;

    static YUNET: LazySession = LazySession::new("yunet");
    static OCEC: LazySession = LazySession::new("ocec");

    pub fn init_detector(model_path: PathBuf) {
        YUNET.init(model_path);
    }
    pub fn init_eye_classifier(model_path: PathBuf) {
        OCEC.init(model_path);
    }
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn detector_ready() -> bool {
        YUNET.ready()
    }
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn eyes_ready() -> bool {
        OCEC.ready()
    }
```

Then substitute `session()` → `YUNET.get()` and `ocec_session()` → `OCEC.get()` at their two call sites (`detect_faces` :356, `eye_open_prob` :321). Add `mod ml_models;` to `lib.rs` (gate the declaration the same way `faces.rs`'s ml internals are gated — the file itself carries `#![cfg(feature = "smart-ml")]`, so a plain `mod ml_models;` works).

- [ ] **Step 3: Verify no behavior change**

Run: `cd src-tauri && cargo test && cargo test --features smart-ml`
And with the corpus: `CULL_TEST_CR3_DIR=<corpus> cargo test --features smart-ml corpus_smoke_runs_the_real_model -- --nocapture`
Expected: all green, `detector_ready`/`eyes_ready` still assert true.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/ml_models.rs src-tauri/src/faces.rs src-tauri/src/lib.rs
git commit -m "refactor: extract LazySession registry from faces.rs (5 models incoming)"
```

---

### Task 4: Model export + fetch scripts, models committed/released

Dev-side task — no app code. Produces the three ONNX files and their pinned sha256s.

**Files:**
- Create: `scripts/export-models.py`, `scripts/fetch-models.sh`
- Modify: `.gitignore` (ignore the CLIP tower), `SMART_CULLING_PHASE3_DESIGN.md` (record sha256s + parity numbers)
- Commit: `src-tauri/models/dinov2s.onnx` (~43 MB), `src-tauri/models/laion_aesthetic.onnx` (<2 MB)
- Release asset: `src-tauri/models/clip_vitb32_visual.onnx` (~175 MB) on GitHub release `models-v1`

**Interfaces:**
- Produces: three ONNX graphs with FIXED contracts consumed by Task 5:
  - `dinov2s.onnx` — input `pixel_values` f32 `[1,3,224,224]` (RGB, /255, mean `[0.485,0.456,0.406]`, std `[0.229,0.224,0.225]`); output: last-hidden-state — Task 5 takes the CLS token (first 384 floats) and L2-normalizes.
  - `clip_vitb32_visual.onnx` — input `pixel_values` f32 `[1,3,224,224]` (RGB, /255, mean `[0.48145466,0.4578275,0.40821073]`, std `[0.26862954,0.26130258,0.27577711]`); output: 512-f32 image embedding (unnormalized).
  - `laion_aesthetic.onnx` — input `embedding` f32 `[1,512]` (the CLIP embedding L2-NORMALIZED — that is what the LAION head was trained on); output: scalar f32, the 1–10 aesthetic score.

- [ ] **Step 1: Write `scripts/export-models.py`**

```python
#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "torch>=2.4", "transformers>=4.44", "onnx>=1.16",
#   "onnxruntime>=1.19", "onnxconverter-common>=1.14",
#   "open_clip_torch>=2.26", "pillow>=10", "numpy>=1.26", "requests>=2.31",
# ]
# ///
"""One-off exporter for CULL's Tier-2 phase 3d/3c models (dev-only, never shipped).

Exports from OFFICIAL weights and parity-checks every ONNX graph against the
PyTorch original on real corpus previews BEFORE anything is committed:
  - DINOv2-small  (facebook/dinov2-small, Apache-2.0)  -> dinov2s.onnx (fp16)
  - CLIP ViT-B/32 image tower (openai, MIT via open_clip) -> clip_vitb32_visual.onnx (fp16)
  - LAION improved-aesthetic-predictor head (Apache-2.0)  -> laion_aesthetic.onnx (fp32, tiny)

Usage:  CULL_TEST_JPEG_DIR=<dir with a few .jpg previews> ./scripts/export-models.py
Gates:  embedding cosine >= 0.999, |aesthetic delta| < 0.05, else non-zero exit.
"""
import hashlib, os, sys
from pathlib import Path

import numpy as np
import onnxruntime as ort
import torch
from PIL import Image

OUT = Path(__file__).resolve().parent.parent / "src-tauri" / "models"
SAMPLES_DIR = os.environ.get("CULL_TEST_JPEG_DIR")

def sample_images(n=5):
    if not SAMPLES_DIR:
        sys.exit("set CULL_TEST_JPEG_DIR to a folder of real preview JPEGs")
    paths = sorted(Path(SAMPLES_DIR).glob("*.jpg"))[:n]
    if len(paths) < 3:
        sys.exit(f"need >=3 jpegs in {SAMPLES_DIR}, found {len(paths)}")
    return [Image.open(p).convert("RGB").resize((224, 224), Image.BILINEAR) for p in paths]

def to_tensor(img, mean, std):
    x = np.asarray(img, dtype=np.float32) / 255.0
    x = (x - np.array(mean, dtype=np.float32)) / np.array(std, dtype=np.float32)
    return torch.from_numpy(x.transpose(2, 0, 1)[None])  # [1,3,224,224]

def fp16_convert(path):
    import onnx
    from onnxconverter_common import float16
    m = onnx.load(str(path))
    onnx.save(float16.convert_float_to_float16(m, keep_io_types=True), str(path))

def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def cosine(a, b):
    a, b = a.flatten(), b.flatten()
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))

def export_dinov2(imgs):
    from transformers import AutoModel
    model = AutoModel.from_pretrained("facebook/dinov2-small").eval()
    mean, std = [0.485, 0.456, 0.406], [0.229, 0.224, 0.225]
    path = OUT / "dinov2s.onnx"
    ex = to_tensor(imgs[0], mean, std)
    torch.onnx.export(
        model, (ex,), str(path), input_names=["pixel_values"],
        output_names=["last_hidden_state"], opset_version=17,
        dynamo=False,
    )
    fp16_convert(path)
    sess = ort.InferenceSession(str(path))
    worst = 1.0
    for img in imgs:
        x = to_tensor(img, mean, std)
        with torch.no_grad():
            ref = model(pixel_values=x).last_hidden_state[0, 0].numpy()  # CLS token
        out = sess.run(None, {"pixel_values": x.numpy()})[0][0, 0]
        worst = min(worst, cosine(ref, out))
    assert worst >= 0.999, f"DINOv2 parity FAILED: worst cosine {worst}"
    print(f"dinov2s.onnx  OK  worst-cosine={worst:.5f}  sha256={sha256(path)}")

def export_clip(imgs):
    import open_clip
    model, _, _ = open_clip.create_model_and_transforms("ViT-B-32", pretrained="openai")
    model = model.eval()
    visual = model.visual
    mean = [0.48145466, 0.4578275, 0.40821073]
    std = [0.26862954, 0.26130258, 0.27577711]
    path = OUT / "clip_vitb32_visual.onnx"
    ex = to_tensor(imgs[0], mean, std)
    torch.onnx.export(
        visual, (ex,), str(path), input_names=["pixel_values"],
        output_names=["embedding"], opset_version=17, dynamo=False,
    )
    fp16_convert(path)
    sess = ort.InferenceSession(str(path))
    worst = 1.0
    embeds = []
    for img in imgs:
        x = to_tensor(img, mean, std)
        with torch.no_grad():
            ref = visual(x)[0].numpy()
        out = sess.run(None, {"pixel_values": x.numpy()})[0][0]
        worst = min(worst, cosine(ref, out))
        embeds.append(ref)
    assert worst >= 0.999, f"CLIP parity FAILED: worst cosine {worst}"
    print(f"clip_vitb32_visual.onnx  OK  worst-cosine={worst:.5f}  sha256={sha256(path)}")
    return embeds

def export_laion_head(clip_embeds):
    import requests
    # Official weights from LAION-AI/aesthetic-predictor (improved v1, ViT-B/32 head).
    url = ("https://github.com/LAION-AI/aesthetic-predictor/raw/main/"
           "sa_0_4_vit_b_32_linear.pth")
    w = Path("/tmp/laion_vitb32_head.pth")
    if not w.exists():
        w.write_bytes(requests.get(url, timeout=60).content)
    head = torch.nn.Linear(512, 1)
    head.load_state_dict(torch.load(w, map_location="cpu", weights_only=True))
    head = head.eval()
    path = OUT / "laion_aesthetic.onnx"
    ex = torch.randn(1, 512)
    torch.onnx.export(head, (ex,), str(path), input_names=["embedding"],
                      output_names=["score"], opset_version=17, dynamo=False)
    sess = ort.InferenceSession(str(path))
    worst = 0.0
    for e in clip_embeds:
        x = torch.from_numpy(e[None] / np.linalg.norm(e))  # L2-normalized input!
        with torch.no_grad():
            ref = float(head(x)[0, 0])
        out = float(sess.run(None, {"embedding": x.numpy()})[0][0, 0])
        worst = max(worst, abs(ref - out))
        print(f"  aesthetic sample: {ref:.3f}")
    assert worst < 0.05, f"LAION head parity FAILED: worst delta {worst}"
    print(f"laion_aesthetic.onnx  OK  worst-delta={worst:.5f}  sha256={sha256(path)}")

if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    imgs = sample_images()
    export_dinov2(imgs)
    embeds = export_clip(imgs)
    export_laion_head(embeds)
    print("ALL PARITY CHECKS PASSED")
```

**Note for the executor:** if the LAION weight file at that URL is a plain `nn.Linear` state dict it loads directly as above; if the repo instead ships the MLP variant ("improved-aesthetic-predictor", 768→…→1 for ViT-L), the ViT-B/32 file is the *linear* one — confirm the downloaded state dict's keys (`weight` [1,512], `bias` [1]) before exporting, and if they differ, adjust the module to match the actual keys. The parity gate is the arbiter either way.

- [ ] **Step 2: Prepare sample previews and run the exporter**

Extract a handful of preview JPEGs from the local corpus first (any tool works; simplest is the app's own cache or `exiftool -b -PreviewImage`):

```bash
mkdir -p /tmp/cull-export-samples
# from the sample_cr3s corpus on this Mac:
for f in sample_cr3s/*.CR3; do exiftool -b -PreviewImage "$f" > "/tmp/cull-export-samples/$(basename "$f" .CR3).jpg"; done
CULL_TEST_JPEG_DIR=/tmp/cull-export-samples ./scripts/export-models.py
```

Expected: three `OK worst-cosine=…/worst-delta=…` lines, `ALL PARITY CHECKS PASSED`, three files in `src-tauri/models/`. If `exiftool` is missing: `brew install exiftool`.

- [ ] **Step 3: Record sha256s + parity numbers in the design doc**

Append to `SMART_CULLING_PHASE3_DESIGN.md` under `## Models` a `**Export record (filled at export time):**` list with each file's sha256 and worst parity number, from Step 2's output. These sha256s are ALSO consumed by Task 5's smoke test and `fetch-models.sh` — keep them identical in all three places.

- [ ] **Step 4: Create the `models-v1` release and upload the CLIP tower; gitignore it**

```bash
gh release create models-v1 --title "Model assets v1" \
  --notes "Self-exported ONNX models too large for git. clip_vitb32_visual.onnx sha256=<paste from step 3>" \
  src-tauri/models/clip_vitb32_visual.onnx
echo "src-tauri/models/clip_vitb32_visual.onnx" >> .gitignore
```

- [ ] **Step 5: Write `scripts/fetch-models.sh`**

```bash
#!/usr/bin/env bash
# Fetch model assets too large for git (sha256-pinned). Run once per clone;
# release CI runs it before tauri build. Windows runners execute this via git-bash.
set -euo pipefail
cd "$(dirname "$0")/../src-tauri/models"

CLIP_SHA="<paste sha256 from Task 4 Step 3>"
FILE="clip_vitb32_visual.onnx"
URL="https://github.com/OliverSogaard/cull/releases/download/models-v1/$FILE"

have_sha() { [ -f "$FILE" ] && shasum -a 256 "$FILE" 2>/dev/null | grep -q "^$CLIP_SHA " ; }

if have_sha; then
  echo "$FILE already present and verified"
  exit 0
fi
echo "downloading $FILE ..."
curl -fL --retry 3 -o "$FILE.tmp" "$URL"
echo "$CLIP_SHA  $FILE.tmp" | shasum -a 256 -c -
mv "$FILE.tmp" "$FILE"
echo "$FILE fetched and verified"
```

```bash
chmod +x scripts/fetch-models.sh scripts/export-models.py
./scripts/fetch-models.sh   # verifies the already-present local copy fast-path
```

Expected: `clip_vitb32_visual.onnx already present and verified`.

- [ ] **Step 6: Commit**

```bash
git add scripts/export-models.py scripts/fetch-models.sh .gitignore \
  src-tauri/models/dinov2s.onnx src-tauri/models/laion_aesthetic.onnx \
  SMART_CULLING_PHASE3_DESIGN.md
git commit -m "feat: self-exported dinov2/clip/laion models + parity-checked export & fetch scripts"
```

(~45 MB commit — expected and approved; the 175 MB tower stays out of git.)

---

### Task 5: DINOv2 embedding + CLIP/LAION aesthetic in the enrich hook

**Files:**
- Create: `src-tauri/src/embed.rs`
- Modify: `src-tauri/src/analyze.rs` (struct, enrich closure at :460-467), `src-tauri/src/lib.rs` (setup :90 area + `mod embed;`), `src/types/ipc.ts`, `src/smart/testScores.ts`
- Test: inline in `embed.rs` (pure preprocessing) + corpus smoke extension in `analyze.rs` or `embed.rs`

**Interfaces:**
- Consumes: `LazySession` (Task 3), model files (Task 4), `resize_rgb_bilinear` from `faces.rs` (public already).
- Produces:
  - `embed.rs` pure (always compiled): `pub fn preprocess_norm(rgb224: &[u8], mean: [f32;3], std: [f32;3]) -> Vec<f32>` (RGB8 224×224 → normalized CHW f32), `pub const DINOV2_MEAN/STD`, `pub const CLIP_MEAN/STD`, `pub fn l2_normalize(v: &mut [f32])`.
  - `embed.rs` ml (feature-gated): `pub fn init_embedder(path: PathBuf)`, `pub fn init_aesthetic(clip: PathBuf, head: PathBuf)`, `pub fn embedding(rgb: &[u8], w: usize, h: usize) -> Option<Vec<f32>>` (384-d, L2-normalized), `pub fn aesthetic(rgb: &[u8], w: usize, h: usize) -> Option<f32>` (0..1), plus `embedder_ready()`/`aesthetic_ready()` test discriminators.
  - Wire: `ImageScore.embedding: Option<Vec<f32>>`; `aesthetic` now populated (0..1 = LAION 1–10 divided by 10, clamped).

- [ ] **Step 1: Write the failing pure-math tests**

```rust
// src-tauri/src/embed.rs (test module first)
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
```

- [ ] **Step 2: Run to verify failure**

Run: `cd src-tauri && cargo test embed`
Expected: FAIL (module/functions don't exist). Add `mod embed;` to `lib.rs` when creating the file.

- [ ] **Step 3: Implement `embed.rs`**

```rust
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
```

(If `faces.rs`'s `resize_rgb_bilinear` is not already `pub`, it is — see `faces.rs:178`.)

- [ ] **Step 4: Wire into `analyze.rs` + the wire types**

Struct: after `aesthetic`:

```rust
    /// L2-normalized 384-d DINOv2 embedding (feature smart-ml + ml flag only;
    /// ~4 KB JSON per frame — accepted, spec'd). None otherwise.
    pub embedding: Option<Vec<f32>>,
```

Enrich closure at :460 becomes:

```rust
            &|input, score| {
                #[cfg(feature = "smart-ml")]
                if want_ml {
                    attach_faces(input, score);
                    attach_embeddings(input, score);
                }
                #[cfg(not(feature = "smart-ml"))]
                let _ = (input, score, want_ml);
            },
```

New fn next to `attach_faces`:

```rust
/// DINOv2 embedding (near-dupe grouping) + CLIP/LAION aesthetic, same decoded
/// buffer. Failures stay None — advisory enrichment, never worth an error.
#[cfg(feature = "smart-ml")]
fn attach_embeddings(input: &DecodedInput, score: &mut ImageScore) {
    if !score.decode_ok {
        return;
    }
    score.embedding = crate::embed::embedding(&input.rgb, input.w, input.h);
    score.aesthetic = crate::embed::aesthetic(&input.rgb, input.w, input.h);
}
```

`lib.rs` setup (:90 area, beside `init_eye_classifier`) — mirror exactly how the YuNet/OCEC model paths are resolved (`p` is the resolved models dir path in that closure):

```rust
                embed::init_embedder(p.join("dinov2s.onnx"));
                embed::init_aesthetic(p.join("clip_vitb32_visual.onnx"), p.join("laion_aesthetic.onnx"));
```

(Read the surrounding lines first — if `p` is the full YuNet file path rather than the dir, derive the dir with `p.parent()` consistently with how `init_eye_classifier(p)` gets its path.)

`src/types/ipc.ts` after `aesthetic`:

```typescript
  /** L2-normalized 384-d DINOv2 embedding (ML builds only). */
  embedding: number[] | null;
```

`src/smart/testScores.ts`: add `embedding: null` to the base fixture.

- [ ] **Step 5: Extend the corpus smoke test**

In `faces.rs`'s `corpus_smoke_runs_the_real_model` (or a sibling test in `embed.rs` reusing the same decode preamble — prefer a sibling `#[cfg(all(feature = "smart-ml", test))]` test in `embed.rs` to keep files focused):

```rust
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
        // Decode one corpus preview — copy the exact preamble from
        // faces.rs::corpus_smoke_runs_the_real_model (read_preview_bundle + zune decode).
        let path = std::fs::read_dir(&dir).expect("read dir").flatten()
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
```

- [ ] **Step 6: Run everything**

```bash
cd src-tauri && cargo test && cargo test --features smart-ml
CULL_TEST_CR3_DIR=<corpus> cargo test --features smart-ml corpus_smoke -- --nocapture
cd .. && pnpm test && pnpm exec tsc --noEmit
```

Expected: all green (default build untouched: no ort dep, `embedding` stays `None`).

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/embed.rs src-tauri/src/analyze.rs src-tauri/src/lib.rs src/types/ipc.ts src/smart/testScores.ts
git commit -m "feat: DINOv2 embeddings + CLIP/LAION aesthetic in the enrich hook"
```

---

### Task 6: `pickWinner.ts` extraction (refactor)

**Files:**
- Create: `src/smart/pickWinner.ts`, `src/smart/pickWinner.test.ts`
- Modify: `src/smart/groupBursts.ts` (move `beats` + the winner loop out of `flush`)

**Interfaces:**
- Produces:

```typescript
export function pickWinner(
  ids: readonly number[],
  sharp: Readonly<Record<number, SharpInput>> | undefined,
  eligible: Readonly<Record<number, boolean>> | undefined,
): { winnerIdx: number; winnerAf: number } // winnerIdx −1 ⇒ no winner
```

`beats` and `EYES_OPEN_MIN` move here (re-export `EYES_OPEN_MIN` from `groupBursts.ts` so existing imports keep working). Task 7 (groupSimilar) uses `pickWinner` for identical ladder semantics.

- [ ] **Step 1: Write the failing tests** (`src/smart/pickWinner.test.ts`)

```typescript
import { describe, expect, test } from "vitest";
import { pickWinner } from "./pickWinner";
import type { SharpInput } from "./groupBursts";

const sharp = (af: number, extra?: Partial<SharpInput>): SharpInput => ({
  afSharpness: af,
  globalSharpness: af,
  clipSum: 0,
  faceSharpness: null,
  eyesOpen: null,
  ...extra,
});

describe("pickWinner", () => {
  test("sharpest eligible member wins; ties go to the earliest", () => {
    const s = { 1: sharp(0.5), 2: sharp(0.9), 3: sharp(0.9) };
    expect(pickWinner([1, 2, 3], s, undefined)).toEqual({ winnerIdx: 1, winnerAf: 0.9 });
  });

  test("no winner while any member is unscored", () => {
    expect(pickWinner([1, 2], { 1: sharp(0.5) }, undefined).winnerIdx).toBe(-1);
  });

  test("no winner when nobody is eligible", () => {
    const s = { 1: sharp(0.5), 2: sharp(0.9) };
    expect(pickWinner([1, 2], s, { 1: false, 2: false }).winnerIdx).toBe(-1);
  });

  test("eyes-open beats sharper-but-blinking (both known, opposite sides)", () => {
    const s = {
      1: sharp(0.9, { eyesOpen: 0.1 }),
      2: sharp(0.6, { eyesOpen: 0.9 }),
    };
    expect(pickWinner([1, 2], s, undefined).winnerIdx).toBe(1);
  });

  test("face sharpness outranks af sharpness when both frames carry faces", () => {
    const s = {
      1: sharp(0.9, { faceSharpness: 0.3 }),
      2: sharp(0.6, { faceSharpness: 0.8 }),
    };
    expect(pickWinner([1, 2], s, undefined).winnerIdx).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test pickWinner`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement by MOVING, not copying**

Create `src/smart/pickWinner.ts`: move `EYES_OPEN_MIN` and the whole `beats` function from `groupBursts.ts` verbatim (with their comments), then:

```typescript
import type { SharpInput } from "./groupBursts";

/** prob_open at or above this counts as "eyes open" for the winner tiebreak. */
export const EYES_OPEN_MIN = 0.5;

// ... `beats` moved verbatim from groupBursts.ts ...

/**
 * The ONE winner ladder for every group kind (bursts, similar sets) — extracted
 * so the two structurally cannot drift. Winner requires EVERY member scored
 * (a half-scored group has no winner yet) and at least one eligible member
 * (nobody clears the keep bar → no winner: winners are smart culling's call).
 */
export function pickWinner(
  ids: readonly number[],
  sharp: Readonly<Record<number, SharpInput>> | undefined,
  eligible: Readonly<Record<number, boolean>> | undefined,
): { winnerIdx: number; winnerAf: number } {
  const sharps = ids.map((id) => sharp?.[id]);
  if (!sharps.every((s) => s != null)) return { winnerIdx: -1, winnerAf: 0 };
  let w = -1;
  for (let i = 0; i < ids.length; i++) {
    if (eligible && !eligible[ids[i]]) continue;
    if (w === -1 || beats(sharps[i]!, sharps[w]!)) w = i;
  }
  return { winnerIdx: w, winnerAf: w >= 0 ? sharps[w]!.afSharpness : 0 };
}
```

In `groupBursts.ts`: delete `beats` and the local `EYES_OPEN_MIN`; add `import { pickWinner } from "./pickWinner";` and `export { EYES_OPEN_MIN } from "./pickWinner";` (keeps existing importers working). Rewrite `flush`'s winner block:

```typescript
  const flush = () => {
    if (run.length >= 2) {
      const ids = run.map((r) => r.id);
      const { winnerIdx: w, winnerAf } = pickWinner(ids, sharp, eligible);
      run.forEach((r, i) => {
        out.set(r.id, {
          group: groupId,
          pos: i + 1,
          len: run.length,
          isWinner: i === w,
          marginToWinner: w >= 0 && i !== w ? winnerAf - sharp![r.id]!.afSharpness : 0,
        });
      });
      groupId += 1;
    }
    run = [];
  };
```

- [ ] **Step 4: Run the full frontend suite**

Run: `pnpm test && pnpm exec tsc --noEmit`
Expected: all green — `groupBursts.test.ts` is the real regression net for the move.

- [ ] **Step 5: Commit**

```bash
git add src/smart/pickWinner.ts src/smart/pickWinner.test.ts src/smart/groupBursts.ts
git commit -m "refactor: extract the winner ladder into pickWinner.ts (shared by bursts + similar sets)"
```

---

### Task 7: `groupSimilar.ts` — time-local adjacency clustering

**Files:**
- Create: `src/smart/groupSimilar.ts`, `src/smart/groupSimilar.test.ts`

**Interfaces:**
- Consumes: `ImageScore` (with `phash`, `embedding`, `capturedAtMs`, `mtimeMs`), `BurstCtx` map (to exclude burst members), `SharpInput`/`eligible` maps (same ones App already builds), `pickWinner`.
- Produces:

```typescript
export type SimilarCtx = BurstCtx; // identical shape: group/pos/len/isWinner/marginToWinner
export function groupSimilar(
  images: readonly Img[],
  scores: Readonly<Record<number, ImageScore>>,
  bursts: ReadonlyMap<number, BurstCtx>,
  sharp: Readonly<Record<number, SharpInput>>,
  eligible: Readonly<Record<number, boolean>>,
): Map<number, SimilarCtx>
export const SIMILAR_WINDOW_MS = 300_000;
export const PHASH_NEAR = 10;
export const SIMILAR_COSINE = 0.92;
```

- [ ] **Step 1: Write the failing tests** (`src/smart/groupSimilar.test.ts`)

```typescript
import { describe, expect, test } from "vitest";
import { groupSimilar, PHASH_NEAR, SIMILAR_COSINE, SIMILAR_WINDOW_MS } from "./groupSimilar";
import type { BurstCtx } from "./groupBursts";
import type { Img } from "../types/image";
import { baseScore } from "./testScores"; // the existing fixture builder

const img = (id: number): Img => ({ id, srcFolder: "/a" }) as Img;

/** Orthogonal unit embeddings for "unrelated"; same vector for "identical". */
const e = (dir: number): number[] => {
  const v = new Array(8).fill(0);
  v[dir] = 1;
  return v;
};

const score = (
  id: number,
  t: number,
  overrides: Partial<ReturnType<typeof baseScore>> = {},
) => ({
  ...baseScore(),
  index: id,
  capturedAtMs: t,
  subSecMs: 0,
  mtimeMs: t,
  phash: "0000000000000000",
  embedding: null,
  ...overrides,
});

const NO_BURSTS: ReadonlyMap<number, BurstCtx> = new Map();

describe("groupSimilar", () => {
  test("near-identical pHash neighbors group; distant hashes don't", () => {
    const images = [img(1), img(2), img(3)];
    const scores = {
      1: score(1, 0, { phash: "0000000000000000" }),
      2: score(2, 1000, { phash: "0000000000000003" }), // hamming 2 ≤ PHASH_NEAR
      3: score(3, 2000, { phash: "ffffffffffffffff" }), // hamming 62 — far
    };
    const out = groupSimilar(images, scores, NO_BURSTS, {}, {});
    expect(out.get(1)?.group).toBe(out.get(2)?.group);
    expect(out.get(1)?.len).toBe(2);
    expect(out.has(3)).toBe(false);
  });

  test("embedding cosine links what pHash misses", () => {
    const images = [img(1), img(2)];
    const scores = {
      1: score(1, 0, { phash: "0000000000000000", embedding: e(0) }),
      2: score(2, 1000, { phash: "ffffffffffffffff", embedding: e(0) }), // cosine 1
    };
    const out = groupSimilar(images, scores, NO_BURSTS, {}, {});
    expect(out.get(1)?.group).toBe(out.get(2)?.group);
  });

  test("time window splits: same look, too far apart never groups", () => {
    const images = [img(1), img(2)];
    const scores = {
      1: score(1, 0),
      2: score(2, SIMILAR_WINDOW_MS + 1),
    };
    expect(groupSimilar(images, scores, NO_BURSTS, {}, {}).size).toBe(0);
  });

  test("adjacency chaining: a stray frame splits the group in two", () => {
    const images = [img(1), img(2), img(3)];
    const scores = {
      1: score(1, 0, { phash: "0000000000000000" }),
      2: score(2, 1000, { phash: "ffffffffffffffff" }), // the stray
      3: score(3, 2000, { phash: "0000000000000000" }),
    };
    const out = groupSimilar(images, scores, NO_BURSTS, {}, {});
    expect(out.size).toBe(0); // 1 and 3 alike but not ADJACENT — no group (MVP semantics)
  });

  test("burst members never join a similar group", () => {
    const images = [img(1), img(2)];
    const scores = { 1: score(1, 0), 2: score(2, 1000) };
    const bursts = new Map<number, BurstCtx>([
      [2, { group: 0, pos: 1, len: 3, isWinner: false, marginToWinner: 0 }],
    ]);
    expect(groupSimilar(images, scores, bursts, {}, {}).size).toBe(0);
  });

  test("unscored frames are transparent walls (mirror groupBursts)", () => {
    const images = [img(1), img(2), img(3)];
    const scores = { 1: score(1, 0), 3: score(3, 2000) }; // 2 unscored
    expect(groupSimilar(images, scores, NO_BURSTS, {}, {}).size).toBe(0);
  });

  test("winner rides the shared ladder and self-corrects as scores land", () => {
    const images = [img(1), img(2)];
    const scores = { 1: score(1, 0), 2: score(2, 1000) };
    const sharp = {
      1: { afSharpness: 0.9, globalSharpness: 0.9, clipSum: 0, faceSharpness: null, eyesOpen: null },
      2: { afSharpness: 0.5, globalSharpness: 0.5, clipSum: 0, faceSharpness: null, eyesOpen: null },
    };
    const out = groupSimilar(images, scores, NO_BURSTS, sharp, { 1: true, 2: true });
    expect(out.get(1)?.isWinner).toBe(true);
    expect(out.get(2)?.isWinner).toBe(false);
    expect(out.get(2)?.marginToWinner).toBeCloseTo(0.4);
    // Nobody eligible → no winner at all.
    const none = groupSimilar(images, scores, NO_BURSTS, sharp, { 1: false, 2: false });
    expect(none.get(1)?.isWinner).toBe(false);
  });

  test("different srcFolder never groups", () => {
    const images = [img(1), { id: 2, srcFolder: "/b" } as Img];
    const scores = { 1: score(1, 0), 2: score(2, 1000) };
    expect(groupSimilar(images, scores, NO_BURSTS, {}, {}).size).toBe(0);
  });
});
```

(Check `src/smart/testScores.ts` for the actual fixture-builder name and `Img` construction used by `groupBursts.test.ts` — mirror those; if the fixture is named differently, adapt the import, not the semantics.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test groupSimilar`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```typescript
// src/smart/groupSimilar.ts
import type { Img } from "../types/image";
import type { ImageScore } from "../types/ipc";
import type { BurstCtx, SharpInput } from "./groupBursts";
import { pickWinner } from "./pickWinner";

/** Same ctx shape as bursts — the UI treats both group kinds identically. */
export type SimilarCtx = BurstCtx;

/** Frames whose neighbors are further apart than this never chain (time-local
 *  only, per the spec: a worked scene, not whole-folder lookalikes). */
export const SIMILAR_WINDOW_MS = 300_000;
/** pHash Hamming distance at or under this ⇒ near-exact duplicate. */
export const PHASH_NEAR = 10;
/** DINOv2 cosine at or above this ⇒ lookalike (ML builds only). */
export const SIMILAR_COSINE = 0.92;

/** Hamming distance between two 16-hex-char pHashes via BigInt (64-bit safe). */
export function phashDistance(a: string, b: string): number {
  let x = BigInt("0x" + a) ^ BigInt("0x" + b);
  let n = 0;
  while (x > 0n) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}

function cosine(a: readonly number[], b: readonly number[]): number {
  // Embeddings arrive L2-normalized — the dot product IS the cosine.
  let s = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) s += a[i] * b[i];
  return s;
}

/** Capture-time for chaining: SubSec-precise clock preferred, mtime fallback
 *  (both frames must use the SAME source or the delta is meaningless). */
function timeOf(s: ImageScore): number | null {
  return s.capturedAtMs ?? (s.mtimeMs || null);
}

/** Does frame `b` extend a chain ending at frame `a`? (Adjacent-only test.) */
function linked(a: ImageScore, b: ImageScore): boolean {
  const ta = timeOf(a);
  const tb = timeOf(b);
  if (ta == null || tb == null || Math.abs(tb - ta) > SIMILAR_WINDOW_MS) return false;
  if (a.phash != null && b.phash != null && phashDistance(a.phash, b.phash) <= PHASH_NEAR) {
    return true;
  }
  if (a.embedding != null && b.embedding != null) {
    return cosine(a.embedding, b.embedding) >= SIMILAR_COSINE;
  }
  return false;
}

/**
 * Time-local near-duplicate grouping (spec: SMART_CULLING_PHASE3_DESIGN.md).
 * Pure derivation, mirrors groupBursts: adjacent frames chain when EITHER the
 * pHash tier (always available) or the embedding tier (ML builds) links them;
 * unscored frames and burst members are transparent walls; winner comes from
 * the SAME ladder as bursts (pickWinner) so the two cannot drift.
 */
export function groupSimilar(
  images: readonly Img[],
  scores: Readonly<Record<number, ImageScore>>,
  bursts: ReadonlyMap<number, BurstCtx>,
  sharp: Readonly<Record<number, SharpInput>>,
  eligible: Readonly<Record<number, boolean>>,
): Map<number, SimilarCtx> {
  const out = new Map<number, SimilarCtx>();
  let run: number[] = [];
  let groupId = 0;

  const flush = () => {
    if (run.length >= 2) {
      const { winnerIdx: w, winnerAf } = pickWinner(run, sharp, eligible);
      run.forEach((id, i) => {
        out.set(id, {
          group: groupId,
          pos: i + 1,
          len: run.length,
          isWinner: i === w,
          marginToWinner: w >= 0 && i !== w ? winnerAf - sharp[id]!.afSharpness : 0,
        });
      });
      groupId += 1;
    }
    run = [];
  };

  let prev: { img: Img; score: ImageScore } | null = null;
  for (const img of images) {
    const score = scores[img.id];
    // Transparent walls: unscored, decode-failed, and burst members all split.
    if (!score || !score.decodeOk || bursts.has(img.id)) {
      flush();
      prev = null;
      continue;
    }
    if (prev && prev.img.srcFolder === img.srcFolder && linked(prev.score, score)) {
      if (run.length === 0) run = [prev.img.id];
      run.push(img.id);
    } else {
      flush();
    }
    prev = { img, score };
  }
  flush();
  return out;
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm test groupSimilar && pnpm exec tsc --noEmit`
Expected: all PASS. Also run the timeOf edge mentally against the tests: `mtimeMs: 0` is falsy — test frames use `t=0` with `capturedAtMs` set, so chaining uses the capture clock; that's the intended precedence.

- [ ] **Step 5: Commit**

```bash
git add src/smart/groupSimilar.ts src/smart/groupSimilar.test.ts
git commit -m "feat: time-local near-duplicate grouping (pHash tier + embedding tier)"
```

---

### Task 8: `deriveVerdict` — similar-loser reason + similar-winner keep

**Files:**
- Modify: `src/smart/deriveVerdict.ts`, `src/smart/deriveVerdict.test.ts`

**Interfaces:**
- Consumes: `SimilarCtx` (Task 7).
- Produces: new signature `deriveVerdict(score, burst, similar, level)` — the `similar` param is `SimilarCtx | undefined`. New constants `SIMILAR_MARGIN_SCALE = 0.35`, `SIMILAR_MARGIN_FLOOR = 0.05`. All call sites updated (App.tsx passes `similarCtx.get(id)` — Task 9; tests pass `undefined`).

- [ ] **Step 1: Write the failing tests** (append to `deriveVerdict.test.ts`, using its existing score-fixture style)

```typescript
describe("similar-set verdicts", () => {
  const similarLoser = (margin: number) => ({
    group: 0, pos: 2, len: 3, isWinner: false, marginToWinner: margin,
  });

  test("clear similar-set loser gets a margin-scaled reject reason", () => {
    const s = deriveVerdict(baseScore(), undefined, similarLoser(0.4), "low");
    expect(s.reasons).toContain("not best of similar set (2 of 3)");
    expect(s.verdict).toBe("reject");
  });

  test("near-tie similar loser stays silent (stricter floor than bursts)", () => {
    const s = deriveVerdict(baseScore(), undefined, similarLoser(0.04), "low");
    expect(s.reasons).not.toContain("not best of similar set (2 of 3)");
    expect(s.confidence).toBe(0);
  });

  test("similar margin confidence is weaker than the same burst margin", () => {
    const burstLoser = { group: 0, pos: 2, len: 3, isWinner: false, marginToWinner: 0.2 };
    const viaBurst = deriveVerdict(baseScore(), burstLoser, undefined, "low");
    const viaSimilar = deriveVerdict(baseScore(), undefined, similarLoser(0.2), "low");
    expect(viaSimilar.confidence).toBeLessThan(viaBurst.confidence);
  });

  test("similar winner's keep says so", () => {
    const winner = { group: 0, pos: 1, len: 3, isWinner: true, marginToWinner: 0 };
    const s = deriveVerdict(keepableScore(), undefined, winner, "low");
    expect(s.verdict).toBe("keep");
    expect(s.reasons).toContain("best of similar set");
  });
});
```

(`baseScore()`/`keepableScore()` — use the file's existing fixture helpers; `keepableScore` means whatever existing keep-verdict tests use for a frame that passes `keepEligible`.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test deriveVerdict`
Expected: FAIL (deriveVerdict takes 3 args / reasons missing).

- [ ] **Step 3: Implement**

Constants (after `MARGIN_SCALE`):

```typescript
/** Similar-set loser: a lookalike group is WEAKER evidence than a camera-
 *  clocked burst — bigger divisor (lower confidence per margin) and a hard
 *  near-tie floor below which we say nothing at all. */
export const SIMILAR_MARGIN_SCALE = 0.35;
export const SIMILAR_MARGIN_FLOOR = 0.05;
```

Signature + Rule 3s (insert between Rule 3 burst-loser and Rule 3b eyes; include `similarConf` as a fourth entry in the combiner sort):

```typescript
export function deriveVerdict(
  score: ImageScore,
  burst: BurstCtx | undefined,
  similar: SimilarCtx | undefined,
  level: SmartLevel,
): Suggestion {
```

```typescript
  // Rule 3s — similar-set loser: like the burst rule but stricter (floor +
  // bigger scale), because grouping came from lookalike heuristics, not the
  // camera's burst clock.
  let similarConf = 0;
  if (similar && !similar.isWinner && similar.marginToWinner > SIMILAR_MARGIN_FLOOR) {
    similarConf = clamp01((similar.marginToWinner - SIMILAR_MARGIN_FLOOR) / SIMILAR_MARGIN_SCALE);
    if (similarConf > 0) {
      reasons.push(`not best of similar set (${similar.pos} of ${similar.len})`);
    }
  }
```

Combiner becomes (max-plus-bump semantics unchanged, one more signal):

```typescript
  const [c0, c1, c2, c3] = [softConf, burstConf, eyesConf, similarConf].sort((a, b) => b - a);
  let conf = c0 + 0.1 * c1 + 0.05 * c2 + 0.05 * c3;
```

Keep-side (Rule 4) reasons:

```typescript
    const keepReasons = ["sharp, well exposed"];
    if (burst?.isWinner) keepReasons.unshift("best of burst");
    if (similar?.isWinner) keepReasons.unshift("best of similar set");
```

Import `SimilarCtx` from `./groupSimilar`. Update every existing `deriveVerdict(` call site in tests to pass `undefined` as the new third arg (mechanical; `App.tsx` is Task 9).

- [ ] **Step 4: Run tests**

Run: `pnpm test && pnpm exec tsc --noEmit`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/smart/deriveVerdict.ts src/smart/deriveVerdict.test.ts
git commit -m "feat: similar-set loser reason + similar-winner keep in the verdict cascade"
```

---

### Task 9: `capFavorites.ts` + App wiring (similar ctx + favorites)

**Files:**
- Create: `src/smart/capFavorites.ts`, `src/smart/capFavorites.test.ts`
- Modify: `src/App.tsx` (memos at :266-292)

**Interfaces:**
- Produces:

```typescript
// capFavorites.ts
export const FAVORITE_AESTHETIC = 0.55;
export function capFavorites(
  scores: Readonly<Record<number, ImageScore>>,
  suggestions: Readonly<Record<number, Suggestion>>,
  level: SmartLevel,
): Set<number>
```

- App: new `similarCtx` memo (Map<number, SimilarCtx>), `suggestions` memo extended to thread `similar` + upgrade capped favorites' verdict to `"favorite"` with reason `"standout aesthetic"`.

- [ ] **Step 1: Write the failing tests** (`src/smart/capFavorites.test.ts`)

```typescript
import { describe, expect, test } from "vitest";
import { capFavorites, FAVORITE_AESTHETIC } from "./capFavorites";
import { baseScore } from "./testScores";
import type { Suggestion } from "./deriveVerdict";

const keep: Suggestion = { verdict: "keep", confidence: 0.8, reasons: ["sharp, well exposed"] };
const reject: Suggestion = { verdict: "reject", confidence: 0.9, reasons: ["soft focus"] };

const scored = (n: number, aesthetic: (i: number) => number | null) => {
  const scores: Record<number, ReturnType<typeof baseScore>> = {};
  const sugg: Record<number, Suggestion> = {};
  for (let i = 1; i <= n; i++) {
    scores[i] = { ...baseScore(), index: i, aesthetic: aesthetic(i) };
    sugg[i] = keep;
  }
  return { scores, sugg };
};

describe("capFavorites", () => {
  test("keep-verdict frames above the aesthetic bar become favorites, ranked, capped", () => {
    // 100 analyzed frames, aesthetic descending 0.99..0 — cap = clamp(max(3, 5%), 3, 15) = 5.
    const { scores, sugg } = scored(100, (i) => (100 - i) / 100);
    const fav = capFavorites(scores, sugg, "medium");
    expect(fav.size).toBe(5);
    expect(fav.has(1)).toBe(true); // best aesthetic
    expect(fav.has(6)).toBe(false); // first one past the cap
  });

  test("negative verdicts and null aesthetics never qualify", () => {
    const { scores, sugg } = scored(4, () => 0.9);
    sugg[2] = reject;
    scores[3] = { ...scores[3], aesthetic: null };
    const fav = capFavorites(scores, sugg, "medium");
    expect(fav.has(2)).toBe(false);
    expect(fav.has(3)).toBe(false);
  });

  test("below the aesthetic bar never qualifies even under the cap", () => {
    const { scores, sugg } = scored(4, () => FAVORITE_AESTHETIC - 0.01);
    expect(capFavorites(scores, sugg, "medium").size).toBe(0);
  });

  test("small sets keep the floor of 3 (when enough qualify)", () => {
    const { scores, sugg } = scored(10, (i) => 0.6 + i / 100);
    expect(capFavorites(scores, sugg, "medium").size).toBe(3);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test capFavorites`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```typescript
// src/smart/capFavorites.ts
import type { ImageScore } from "../types/ipc";
import type { SmartLevel, Suggestion } from "./deriveVerdict";

/** Aesthetic bar (0..1 scale) a frame must clear to be favorite-eligible.
 *  Calibration-dependent (LAION scores compress mid-scale) — cite the harness
 *  before moving it. */
export const FAVORITE_AESTHETIC = 0.55;
/** Session cap: top max(3, 5% of analyzed), clamped to 15 — favorites must
 *  stay RARE to mean anything. */
const CAP_PCT = 0.05;
const CAP_MIN = 3;
const CAP_MAX = 15;

/**
 * The favorite verdict Tier 1 withholds (spec 3c): candidate = keep-verdict
 * frame (already sharp, nothing negative — deriveVerdict enforced that) with
 * a standout aesthetic; survivors = the session's top-N by aesthetic.
 */
export function capFavorites(
  scores: Readonly<Record<number, ImageScore>>,
  suggestions: Readonly<Record<number, Suggestion>>,
  _level: SmartLevel,
): Set<number> {
  const analyzed = Object.keys(scores).length;
  const cap = Math.min(CAP_MAX, Math.max(CAP_MIN, Math.ceil(analyzed * CAP_PCT)));
  const candidates = Object.entries(scores)
    .map(([idStr, s]) => ({ id: Number(idStr), aesthetic: s.aesthetic }))
    .filter(
      (c): c is { id: number; aesthetic: number } =>
        c.aesthetic != null &&
        c.aesthetic >= FAVORITE_AESTHETIC &&
        suggestions[c.id]?.verdict === "keep",
    )
    .sort((a, b) => b.aesthetic - a.aesthetic);
  return new Set(candidates.slice(0, cap).map((c) => c.id));
}
```

(`_level` is accepted for signature stability — per-level favorite bars are a
calibration follow-up; remove the underscore only when it's actually used.)

- [ ] **Step 4: Wire into `App.tsx`**

After the `burstCtx` memo (:272-279), add:

```typescript
  const similarCtx = useMemo(() => {
    if (!settings.smartCulling) return new Map<number, SimilarCtx>();
    const eligible: Record<number, boolean> = {};
    for (const [idStr, sc] of Object.entries(qualityScores)) {
      eligible[Number(idStr)] = keepEligible(sc, settings.smartCullingConfidence);
    }
    return groupSimilar(images, qualityScores, burstCtx, burstData.sharp, eligible);
  }, [images, qualityScores, burstCtx, burstData.sharp, settings.smartCulling, settings.smartCullingConfidence]);
```

(If the existing `burstCtx` memo already builds the same `eligible` record, extract it into its own `useMemo` above both and share — don't compute it twice.)

Extend the `suggestions` memo (:288-292) to thread `similar` and overlay favorites:

```typescript
  const suggestions = useMemo(() => {
    if (!settings.smartCulling) return {};
    const out: Record<number, Suggestion> = {};
    for (const [idStr, s] of Object.entries(qualityScores)) {
      const id = Number(idStr);
      out[id] = deriveVerdict(s, burstCtx.get(id), similarCtx.get(id), settings.smartCullingConfidence);
    }
    for (const id of capFavorites(qualityScores, out, settings.smartCullingConfidence)) {
      out[id] = {
        ...out[id],
        verdict: "favorite",
        reasons: ["standout aesthetic", ...out[id].reasons],
      };
    }
    return out;
  }, [qualityScores, burstCtx, similarCtx, settings.smartCulling, settings.smartCullingConfidence]);
```

(Adapt to the memo's ACTUAL existing shape at :288 — keep its current iteration/keying style, only adding the `similar` arg and the favorites overlay. `"favorite"` must be a valid `Rating` — check `src/types/rating.ts`; `verdictGlyph` already renders ★.)

- [ ] **Step 5: Run everything**

Run: `pnpm test && pnpm exec tsc --noEmit`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/smart/capFavorites.ts src/smart/capFavorites.test.ts src/App.tsx
git commit -m "feat: session-capped favorite suggestions + similar ctx threaded through the app"
```

---

### Task 10: "Similar ×N" boxes in strip, grid, and compare

**Files:**
- Modify: `src/components/strip/burstSegments.ts` (+ its test), `src/components/strip/BurstBoxes.tsx`, `src/components/strip/PhotoStrip.tsx`, `src/components/GridView.tsx`, `src/components/CompareStrip.tsx` (wherever it passes `bursts`), `src/App.tsx` (pass `similar` maps down), `src/App.css`

**Interfaces:**
- Consumes: `similarCtx` (Task 9).
- Produces: `computeBurstSegments(ids, bursts, similar?)` — segments gain `kind: "burst" | "similar"`; box components render `cull-burst-box--similar` + legend `Similar ×N`.

- [ ] **Step 1: Write the failing segment tests** (append to `src/components/strip/burstSegments.test.ts`, matching its existing style)

```typescript
test("similar groups yield their own segments, kind-tagged, burst wins overlaps", () => {
  const bursts = new Map([[1, ctx(0, 1, 2)], [2, ctx(0, 2, 2)]]);
  const similar = new Map([[3, ctx(0, 1, 2)], [4, ctx(0, 2, 2)]]);
  const { segs } = computeBurstSegments([1, 2, 3, 4], bursts, similar);
  expect(segs).toHaveLength(2);
  expect(segs[0]).toMatchObject({ start: 0, end: 1, kind: "burst" });
  expect(segs[1]).toMatchObject({ start: 2, end: 3, kind: "similar" });
});

test("similar-only strips still get gap prefixes", () => {
  const similar = new Map([[1, ctx(0, 1, 2)], [2, ctx(0, 2, 2)]]);
  const { segs, prefix } = computeBurstSegments([1, 2], undefined, similar);
  expect(segs[0].kind).toBe("similar");
  expect(prefix).toBeDefined();
});
```

(`ctx(group, pos, len)` — reuse/extend the test file's existing ctx-builder helper.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test burstSegments`
Expected: FAIL (`kind` missing / third arg unknown).

- [ ] **Step 3: Implement the segment generalization**

In `burstSegments.ts`: add `kind: "burst" | "similar"` to `BurstSegment`; give `computeBurstSegments` an optional third param `similar?: Map<number, BurstCtx>`. Internally, resolve each id through a combined lookup — bursts take precedence (they can't overlap by construction — groupSimilar excludes burst members — but precedence makes that structural):

```typescript
export function computeBurstSegments(
  ids: readonly number[],
  bursts: Map<number, BurstCtx> | undefined,
  similar?: Map<number, BurstCtx>,
): { segs: BurstSegment[]; prefix: number[] | undefined } {
  const lookup = (id: number): { c: BurstCtx; kind: "burst" | "similar" } | undefined => {
    const b = bursts?.get(id);
    if (b) return { c: b, kind: "burst" };
    const s = similar?.get(id);
    return s ? { c: s, kind: "similar" } : undefined;
  };
```

Adjust the loop: a segment breaks when kind OR group changes (namespace the `labeledGroups` set and the open-segment identity by `` `${kind}:${group}` ``). Everything else (breath prefix math) is untouched — it operates on segments, not kinds.

- [ ] **Step 4: Render the kind**

- `BurstBoxes.tsx` (the strip's fieldset renderer) and the GridView fieldset block (:231-263): add the modifier class and swap the legend word:

```tsx
className={`cull-burst-box ${seg.kind === "similar" ? "cull-burst-box--similar" : ""} …existing modifiers…`}
…
<legend className="cull-burst-box__count">
  {seg.kind === "similar" ? "Similar" : "Burst"} ×{s.label}
</legend>
```

- `App.css` after `.cull-burst-box__count` (:2825): a visually distinct tint — same box language, different hue (bursts keep their existing accent; similar sets go a cooler neutral):

```css
/* Similar-set boxes: same run-box language as bursts, cooler hue so lookalike
   groups and camera bursts read differently at a glance. */
.cull-burst-box--similar {
  border-color: color-mix(in oklch, var(--cull-accent, #7aa2f7) 35%, #8a8f98);
}
.cull-burst-box--similar > .cull-burst-box__count {
  color: color-mix(in oklch, var(--cull-accent, #7aa2f7) 35%, #8a8f98);
}
```

(Read the existing `.cull-burst-box` rules at :2801-2825 first and express the similar tint with the SAME custom properties/color system they use — the block above shows intent; match the file's actual token names. Verify with a screenshot, not by eye-balling code: `pnpm tauri dev` + a folder with lookalikes, per the visual-work lesson in the plan doc.)

- Thread the map: `PhotoStrip`/`GridView`/`CompareStrip` each already take `bursts` — add a sibling optional `similar?: Map<number, BurstCtx>` prop, pass it to `computeBurstSegments`, and pass `similarCtx` down from `App.tsx` at the three existing `bursts={burstCtx}` sites (:3451, :3465, :3586) plus GridView's.

- [ ] **Step 5: Run tests + visual check**

Run: `pnpm test && pnpm exec tsc --noEmit`
Expected: green. Then `pnpm tauri dev` against a folder with a worked scene (or temporarily lower `SIMILAR_COSINE`/raise `PHASH_NEAR` to force groups on the corpus): Similar boxes render in strip + grid + compare, legend cuts the line, winner border appears once per group.

- [ ] **Step 6: Commit**

```bash
git add src/components/strip/burstSegments.ts src/components/strip/burstSegments.test.ts \
  src/components/strip/BurstBoxes.tsx src/components/strip/PhotoStrip.tsx \
  src/components/GridView.tsx src/components/CompareStrip.tsx src/App.tsx src/App.css
git commit -m "feat: Similar ×N run boxes (shared burst-box machinery, kind-tagged)"
```

---

### Task 11: ExifRail + settings copy

**Files:**
- Modify: `src/components/ExifRail.tsx` (Burst section :150-156 area + call sites), `src/components/SettingsDialog.tsx` (ML toggle copy :185 area), `src/App.tsx` (pass `similar` to ExifRail at :3209 area)

**Interfaces:**
- Consumes: `similarCtx` (Task 9). No new exports.

- [ ] **Step 1: ExifRail — generalize the factual group section**

`ExifRail` takes `burst?: BurstCtx | null` (:40). Add `similar?: SimilarCtx | null` and render a parallel section (bursts keep precedence order — burst section first if both somehow present):

```tsx
      {similar && (
        <div className="cull-exif-rail__section">
          <div className="cull-exif-rail__label">Similar set</div>
          <RailRow k="Frame" v={`${similar.pos} of ${similar.len}`} />
        </div>
      )}
```

(Mirror the EXACT markup of the Burst section at :150-156 — same wrapper classes, same `RailRow` usage, whatever extra rows it shows (winner status etc.) duplicated with "similar" wording.)

The Suggestion row already renders `reasons`/`confidence` — "not best of similar set (2 of 4)", "standout aesthetic", and the ★ favorite ghost all flow through with zero changes (verdictGlyph renders ★ for `favorite` already).

In `App.tsx` at the ExifRail call site (:3209): add `similar={similarCtx.get(current.id) ?? null}`.

- [ ] **Step 2: Settings copy**

In `SettingsDialog.tsx`, the `smartCullingML` toggle's description text (right around :185): update to name what ML adds now. Find the existing description string for the toggle and replace it with:

```
Face + eye checks, look-alike grouping, and a few starred picks. Runs fully on this machine.
```

(Match the terse professional register of the surrounding settings copy — if the current ML description already has a sentence shape, keep its shape and update the content.)

- [ ] **Step 3: Tests + visual check**

Run: `pnpm test && pnpm exec tsc --noEmit` — green.
`pnpm tauri dev`: rail shows "Similar set · Frame 2 of 4" on a grouped frame; settings copy reads right; a favorite frame shows the hollow ★ ghost in the dot slot and "standout aesthetic" in the Suggestion row.

- [ ] **Step 4: Commit**

```bash
git add src/components/ExifRail.tsx src/components/SettingsDialog.tsx src/App.tsx
git commit -m "feat: similar-set rail section + ML settings copy (eyes, lookalikes, favorites)"
```

---

### Task 12: CI fetch step + calibration harness extension

**Files:**
- Modify: `.github/workflows/release.yml`, `src-tauri/src/analyze.rs` (calibration test), `SMART_CULLING_PLAN.md` (implementation note)

- [ ] **Step 1: CI fetch step**

In `release.yml`, after the `pnpm install --frozen-lockfile` step and before `tauri-apps/tauri-action`, add:

```yaml
      - name: Fetch model assets (too large for git)
        shell: bash
        run: ./scripts/fetch-models.sh
```

(`shell: bash` makes the script run under git-bash on the windows-latest runner; `shasum` exists there. Verify the script is executable in git: `git ls-files -s scripts/fetch-models.sh` should show mode `100755`.)

**Note:** release builds currently compile WITHOUT `--features smart-ml` (check the tauri-action `args`); if ML is meant to ship in release builds, that decision + the feature flag in the bundler config is a SEPARATE follow-up with Oliver — this plan only guarantees the models are present for whichever build carries the feature.

- [ ] **Step 2: Calibration harness extension**

Find the existing `calibration_report` test in `analyze.rs` (env-gated `CULL_CALIB=1`). Extend its per-folder pass to ALSO print neighbor-pair similarity stats so `SIMILAR_WINDOW_MS`/`PHASH_NEAR`/`SIMILAR_COSINE`/`FAVORITE_AESTHETIC` tuning cites data:

```rust
        // Phase 3d/3c calibration: adjacent-pair signals + aesthetic spread.
        // (Grouping itself is TS-side; this prints the raw signals the TS
        // thresholds gate on, over a REAL shoot, in shoot order.)
        for pair in scored.windows(2) {
            let (a, b) = (&pair[0], &pair[1]);
            let dt = match (a.captured_at_ms, b.captured_at_ms) {
                (Some(x), Some(y)) => (y - x).abs(),
                _ => -1,
            };
            let ham = match (&a.phash, &b.phash) {
                (Some(x), Some(y)) => {
                    let (x, y) = (u64::from_str_radix(x, 16).unwrap(), u64::from_str_radix(y, 16).unwrap());
                    crate::phash::hamming(x, y) as i64
                }
                _ => -1,
            };
            let cos = match (&a.embedding, &b.embedding) {
                (Some(x), Some(y)) => x.iter().zip(y).map(|(p, q)| p * q).sum::<f32>(),
                _ => f32::NAN,
            };
            println!("CALIB3D dt_ms={dt} hamming={ham} cosine={cos:.4} aes_a={:?} aes_b={:?}", a.aesthetic, b.aesthetic);
        }
```

(Adapt variable names to the harness's actual structure — it already iterates scores with ground-truth ratings; add the windows(2) pass alongside. For embeddings/aesthetic to be non-None, the harness run needs `--features smart-ml`.)

Run it once on the corpus and eyeball: `CULL_CALIB=1 CULL_TEST_CR3_DIR=<corpus> cargo test --features smart-ml calibration_report -- --nocapture`. Sanity: burst neighbors should show hamming ≤ ~10 / cosine ≥ 0.95; scene changes should show hamming > 20 / cosine < 0.8. If the corpus contradicts the seed thresholds, adjust `PHASH_NEAR`/`SIMILAR_COSINE` in `groupSimilar.ts` NOW and note the numbers.

- [ ] **Step 3: Implementation note in the plan doc**

Append a dated implementation note under `SMART_CULLING_PLAN.md`'s 3d/3c bullets (the cross-machine handoff channel) summarizing: what landed, the final threshold values, the calibration numbers observed, and any deviations from this plan.

- [ ] **Step 4: Full gate**

```bash
cd src-tauri && cargo test && cargo test --features smart-ml && cd ..
pnpm test && pnpm exec tsc --noEmit && pnpm build
```

Expected: everything green; note the gzip bundle size (embedding maps are backend-side, bundle should barely move).

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/release.yml src-tauri/src/analyze.rs SMART_CULLING_PLAN.md
git commit -m "ci: fetch model assets in release builds; feat: 3d/3c calibration signals in the harness"
```

---

### Task 13: Live E2E gate (Oliver, manual — the plan's exit criterion)

No code. Run `pnpm tauri dev` (and once with `--features smart-ml` via `src-tauri` cargo config or `pnpm tauri dev -- --features smart-ml`) against a real shoot:

- [ ] Similar boxes appear on a worked scene; legend reads "Similar ×N"; tint differs from bursts; one winner border per group.
- [ ] ML off → pHash-only near-exact groups still appear.
- [ ] Favorites: a handful of ★ ghosts, capped, on genuinely good frames.
- [ ] Advisory-only proof: `ls -la` mtime diff on the folder — NO `.xmp` created/modified by the pass; a keypress writes as before.
- [ ] Folder-switch race: open A, immediately open B mid-pass → no A scores/groups on B.
- [ ] NAS responsiveness with three extra models in the pass.
- [ ] Rides together with the still-outstanding 3a/3b people-shoot validation.

Findings feed threshold tuning (calibration harness re-run) — expect one tuning commit after this gate.

---

## Self-review record (done at plan time)

- **Spec coverage:** models/export/parity → Task 4; repo mechanics/fetch/CI → Tasks 4+12; pHash always-on → Tasks 1-2; LazySession refactor → Task 3; embedding+aesthetic enrich → Task 5; pickWinner extraction → Task 6; groupSimilar semantics (adjacency, window, two-tier, burst precedence, transparent walls) → Task 7; similar-loser + similar-winner keep → Task 8; capFavorites + favorite ghost → Task 9 (+11 for rail); Similar boxes UI → Task 10; rail + settings copy → Task 11; calibration extension → Task 12; E2E gate → Task 13. fp16-on-DirectML risk: accepted in spec as decide-if-it-bites; the export script's `keep_io_types=True` keeps I/O fp32 already.
- **Type consistency:** `SimilarCtx = BurstCtx` alias used everywhere; `phash` is `Option<String>`/`string | null` in both type systems; `embedding` `Option<Vec<f32>>`/`number[] | null`; `deriveVerdict(score, burst, similar, level)` in Tasks 8+9.
- **Known executor freedoms (deliberate, not placeholders):** exact fixture-helper names in test files (`decoded_fixture`, `baseScore`, `ctx`) must be matched to what the test files actually export; App.tsx memo shapes must be adapted to the live code at the cited lines; CSS tokens must match `.cull-burst-box`'s actual system. In each case the plan states the semantics and the file:line to read.
