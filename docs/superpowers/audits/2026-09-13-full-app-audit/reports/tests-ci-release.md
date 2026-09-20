# CULL — Testing, CI, Release & Repo Hygiene Audit (reviewer's findings, transcribed)

Repo `C:\Users\OSA\Developer\cull`, HEAD `f0e6ce7`, 272 commits, version 0.1.0 (frontend, Cargo, tauri.conf all consistent). Read-only.

## Summary verdict
Pure-logic test layer (487 Vitest + 109 Rust, all green, ~3.6 s frontend) is strong: deterministic, injectable clocks/rAF, tests named after the real bugs they pin. Lint, both typecheck lanes, stylelint all clean. Gaps are structural: zero UI/integration coverage above the pure layer; CI never compiles the macOS backend; CI never runs the production `pnpm build`; `main` has no branch protection; 43 MB dead ONNX blob in history. No secrets, no injection-class issues. **Verdict: WARN, no CRITICAL.**

## Genuinely excellent
1. Pass-by-skip corpus gating (`CULL_TEST_CR3_DIR`) keeps CI green without fixtures, documented in TESTING.md.
2. Timer/rAF injection discipline (`useHeldRepeat.test.ts`, `decodePool.test.ts`) — the flaky-timer class of bugs is designed out.
3. Tests document the bug they pin (e.g. "8-away flash" section in `imageStore.test.ts`).
4. README claims verified: Linux compile-blocked (`lib.rs:28-29`), trash-only deletes (`file_ops.rs`), no runtime HTTP client anywhere in `src-tauri/src`.
5. `pnpm audit`/`outdated`/lint/typecheck/stylelint/vitest baseline is healthy.

## Findings
**H1** `.github/workflows/ci.yml:18-19` backend job is `windows-latest` only; macOS-only code (`lib.rs:153`, `memory_pressure.rs:71` jetsam watcher, `ml_models.rs:56` CoreML EP) first compiles at release-tag time. Fix: add a `macos-latest` leg (at least `cargo check`/clippy).
**H2** `ci.yml:14-17` never runs `pnpm build` (`tsc && vite build`), the exact command `release.yml` depends on via `beforeBuildCommand`. Fix: add the step.
**H3** `main` has no branch protection (`gh api .../branches/main/protection` → 404); CI is advisory. Fix: required status checks when it matters.
**M1** 43 MB `dinov2s.onnx` blob remains in history (commit `b0d4434`, "forward-only"); `.git` is 46 MB, ~93 % that blob. Fix only via `git filter-repo` + force-push, if/when a second clone matters.
**M2** `.dev-logs/` ignored only in `.git/info/exclude`, not the tracked `.gitignore`. Fix: move it.
**M3** `pnpm audit`: 23 findings (16 high, 6 moderate, 1 low), all devDependencies. `vite@7.3.3` is in the GHSA-fx2h-pf6j-xcff range; `pnpm update vite` (in-range `^7.0.4`) fixes it.
**M4** `imageStore.test.ts:1237` uses a real 50 ms `setTimeout` for a negative assertion; the rest of the file uses fake timers. Fix: fake-timer pattern.
**M5** No UI/integration layer: 0 of 21 component files tested (documented policy), and `App.tsx` keyboard wiring (the product's vocabulary) has no automated coverage. Realistic fix: Vitest + RTL + `@tauri-apps/api/mocks` `mockIPC` (the `invoke` seam already exists, `imageStore.test.ts` already mocks it), not `tauri-driver`.
**L1** No CHANGELOG; release notes are the tag name. **L2** README says Node 20+/pnpm 9+, CI tests only 22/10. **L3** No `cargo-audit`; `ort` pinned `=2.0.0-rc.12` deliberately, Rust CVE exposure unchecked.

## Coverage map
Strong: `src/smart/*` (8 files), `src/image/*` (10), `src/utils/*` (13), `src/overlays/*` (3), `xmp.rs`, `io_gate.rs`, `tier_cache.rs`, `phash.rs`, `file_ops.rs`. Good-but-corpus-gated: `cr3.rs`, `bundle.rs`, `analyze.rs`, `midtier.rs`, `faces.rs`, `embed.rs` (~8 tests skip in CI). Partial: `src/hooks/*` (2 of several), `src/app/*` (1 of 14). None: `src/components/**` (by design), `App.tsx`, macOS halves of `memory_pressure.rs`/`ml_models.rs` (never compiled in CI).

## CI / release gap table
Frontend CI ubuntu-only (fine). Backend CI windows-only (H1). Lint/fmt/clippy `-D warnings` present and strict. Typecheck two lanes (good). Production build not in CI (H2). No dependency audit step. Caching correct (pnpm + swatinem/rust-cache). No branch protection (H3). Release on `v*` tags, draft releases, unsigned/unnotarized (documented), no updater, `THIRD_PARTY_NOTICES.md` covers the 4 models but not the JS/Rust trees, `fetch-models.sh` sha256-pinned + atomic.

## Top 10
1 macOS CI leg. 2 `pnpm build` in CI. 3 `pnpm update vite`. 4 Track `.dev-logs/` in `.gitignore`. 5 Decide branch protection. 6 Prototype mocked-IPC keyboard-wiring tests for `App.tsx`. 7 Fix the real-timer assertion. 8 Minimal CHANGELOG. 9 Decide the 43 MB history blob. 10 `pnpm audit --audit-level=high` as an informational CI step.
