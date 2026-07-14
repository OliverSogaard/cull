# Testing

CULL has two test suites, plus an env-var-gated corpus layer and a
calibration harness for the smart-culling thresholds.

## The two suites

```bash
pnpm test                                          # frontend (Vitest)
cargo test --manifest-path src-tauri/Cargo.toml    # backend (Rust)
```

Type checking is part of the frontend gate:

```bash
pnpm exec tsc --noEmit
```

## Pass-by-skip philosophy

Tests that need real photo fixtures **never fail when the fixtures are
absent** — they print a `skip: …` line and pass. CI therefore stays green
without any corpus checked in, while a developer with real CR3s gets the
full validation depth locally. If you see `skip:` lines in test output,
that's this layer telling you what it would have covered.

## Env-var-gated corpus tests

Real Canon CR3 files are not committed (see `.gitignore`'s `sample_cr3s`
entry). Point the gates at a local folder to activate the corpus layer:

| Variable | What it activates |
| --- | --- |
| `CULL_TEST_CR3_DIR=<folder of .CR3>` | Parser sweeps over a real shoot (`cr3.rs`: preview extraction, zoom-tier range reads vs the legacy scan, moov hint validation), bundle command round-trips (`bundle.rs`), mid-tier generation with orientation checks (`midtier.rs`), classical metrics over the corpus (`analyze.rs`), and — on `smart-ml` builds — the YuNet (`faces.rs`) and embedding/aesthetic (`embed.rs`) graph-contract smoke tests. |
| `CULL_TEST_CR3=<path to one .CR3>` | Single-file parser deep-dive in `cr3.rs`. |
| `CULL_BENCH=1` | The mid-tier encoder benchmark (`midtier.rs`, `encoder_benchmark`); uses a real full from `CULL_TEST_CR3_DIR` when set, else a synthetic 6960×4640 frame. |

Example:

```bash
CULL_TEST_CR3_DIR=sample_cr3s cargo test --manifest-path src-tauri/Cargo.toml -- --nocapture
```

### Lightroom Classic sidecar fixtures (path-gated)

The XMP compatibility tests validate against real Lightroom Classic 15.3
sidecars. They are gated on a path, not an env var: if
`sample_cr3s/sample_LrCFlaggedCR3s/` exists, `classifies_real_lrc_sidecars`
(`xmp.rs`) checks CULL's classification of LrC-authored Default / KeepFlagged
/ RejectFlagged / Fav1Star sidecars; absent, it skips with a reason.

## Calibration harness (smart-culling thresholds)

Every threshold in `src/smart/deriveVerdict.ts` cites a corpus frame, and
**only this harness may change them** — threshold edits cite the report, not
feel. It runs the full analysis over a folder you have already culled and
prints a confusion matrix of suggestion × your real restored rating,
including the critical **false-reject list** (frames you kept that the model
would reject). Invocation, verbatim:

```bash
CULL_CALIB=1 CULL_TEST_CR3_DIR=<corpus> cargo test --features smart-ml calibration_report -- --nocapture
```

(Run from `src-tauri/`, or add `--manifest-path src-tauri/Cargo.toml`.
`smart-ml` is a default feature, so `--features smart-ml` is belt-and-
suspenders; it matters only if you have been building with
`--no-default-features`.)

## Model-export parity gates (dev-only)

`scripts/export-models.py` re-exports the ONNX models from official weights
and refuses to succeed unless every graph parity-checks against the PyTorch
original on real preview JPEGs (embedding cosine ≥ 0.999, |aesthetic delta|
< 0.05):

```bash
CULL_TEST_JPEG_DIR=<dir with a few .jpg previews> ./scripts/export-models.py
```

This is a development tool for regenerating models — it is never part of a
build or CI run. The build-time model fetch is `scripts/fetch-models.sh`
(sha256-pinned; see README's `scripts/` section). Run it once per clone
before the corpus-gated ML smoke tests: `clip_vitb32_visual.onnx` and
`dinov2s.onnx` live on the `models-v1` release, not in git, and the
`embed.rs` tests load them from `src-tauri/models/` at runtime.
