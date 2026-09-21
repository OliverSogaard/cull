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

## Reading source files in tests

`@types/node` is not installed, so frontend tests never import `node:fs` /
`node:path` to read a source file. Where a test needs a stylesheet's or
module's actual text (e.g. `motion.test.ts` scanning for `@keyframes`, or a
design-token assertion), it reads it via Vite's raw-import glob instead:

```ts
const sheets = import.meta.glob<string>("./**/*.css", {
  query: "?raw",
  eager: true,
  import: "default",
});
```

`vite.config.ts`'s `test.css.include` is scoped to `/\.css\?.*\braw\b/` so
only these explicit `?raw` reads get real CSS content — Vitest's default
`css.include: []` would otherwise stub out all CSS, `?raw` included. A
component test that side-effect-imports a stylesheet (e.g. via `App.tsx`
importing `styles/index.css`) still gets the cheap default stub, since its
import has no `?raw` query.

## The keymap harness

`src/app/useCullKeymap.test.tsx` drives the hook under `renderHook`, built
from a props factory typed as `Parameters<typeof useCullKeymap>[0]` — the
hook's own props type, so a new prop or a rename is a compile error in the
test file instead of a silently stale mock.

Three mechanics make a keymap test lie if you miss them:

- Every `KeyboardEvent` needs `cancelable: true`. Without it `preventDefault()`
  is a silent no-op and every `defaultPrevented` assertion passes vacuously.
- Escape's `defaultPrevented` is **always** true, in every phase — a
  capture-phase listener swallows every Escape before the rest of the keymap
  ever sees it — so it proves nothing except in the one test written to pin
  that listener.
- `afterEach(cleanup)` is load-bearing. Vitest runs without `globals`, so
  React Testing Library's auto-cleanup never registers; an un-unmounted hook
  leaves its `window` listeners attached, and the next test's keypress fires
  this test's spies too.

Ordering claims — "X happens before Y" — are asserted with
`mock.invocationCallOrder`, never by checking that both mocks were merely
called; two calls in either order both satisfy a "both were called"
assertion.

## The CR3 mutation fuzzer

`mutation_fuzz_never_panics_hangs_or_returns_an_oversized_result` is a plain
`#[test]` inside `cr3.rs`'s own test module — zero extra dependencies,
ungated by any env var or corpus, so it runs in CI alongside every other Rust
test with no fixtures required. It's deterministic: every input the fuzzer
tries is a pure function of `(seed, iteration)`, and nothing else feeds the
mutations — the test itself always reads the three env vars below and always
clocks each input against a per-input budget, but neither of those changes
what gets generated. Per input it asserts the parser never panics,
never hangs (a worker thread acks each input; a missed ack past its
per-input budget fails the test naming the culprit), and never returns a
size that couldn't fit the buffer it was handed.

`CULL_FUZZ_SEED` accepts decimal (`20000`) or hex (`0xc0ffee150feed000`,
either case) — exactly the form the failure line prints it in — and panics
on anything else instead of silently falling back to the default seed,
since a silent fallback would run a different input stream than the one
being reproduced.

To reproduce a red run, verbatim (Git Bash / POSIX):

```bash
CULL_FUZZ_SEED=<seed> CULL_FUZZ_FROM=<iteration> CULL_FUZZ_ITERS=1 \
  cargo test mutation_fuzz -- --nocapture
```

PowerShell — quote the seed, or PowerShell reads an unquoted `0x…` as a
signed number and the run stops with "is not a u64":

```powershell
$env:CULL_FUZZ_SEED='<seed>'; $env:CULL_FUZZ_FROM='<iteration>'; $env:CULL_FUZZ_ITERS='1'; `
  cargo test mutation_fuzz -- --nocapture
```

The failing input is DERIVED from `(seed, iteration)` rather than replayed
from a saved corpus, so one iteration reproduces that exact input on its own
— nothing has to be checked in for a bug report to be actionable. Its limits
are real, though: random mutation of a well-formed head can flip bits and
counts, but it cannot CONSTRUCT an adversarial-but-well-formed input such as
a JPEG built of thousands of tiny repeated segments — that class of bug
needs a hand-written test, not this fuzzer.

## The mock kit

`src/test/tauriMocks.ts` is the shared Tauri + DOM kit: an `invoke` spy
routed per test, `listen`/window-command stubs, and `installDomStubs()` /
`restoreDomStubs()` for the DOM globals jsdom doesn't provide (`matchMedia`,
`ResizeObserver`, `HTMLImageElement.prototype.decode` — none of which jsdom
implements; `URL.createObjectURL`/`revokeObjectURL` ARE implemented under
Vitest's jsdom, but the kit swaps them for spies anyway to count blob
churn). Call `installDomStubs()` in `beforeEach` and `restoreDomStubs()` in
`afterEach`.

A `vi.mock` factory can't reference a module-scope import, so a consumer
uses the async form that imports the kit from inside the factory itself:

```ts
vi.mock("@tauri-apps/api/window", async () =>
  (await import("./test/tauriMocks")).windowMock());
```

The default `invoke` router THROWS `tauriMocks: no invoke router installed
(<cmd>)` rather than resolving `undefined`, so a test that forgot to install
a router fails at the call site instead of far downstream with nothing to
point at the real cause.

## Store timer hygiene

Every wall-clock timer inside `ImageStore` goes through its private
`later()` wrapper — or, for the one exception, its own directly-tracked
handle: `gridThumbPendingRetry`, cleared from the three sites that need to
disarm it. Either way, `reset()` and `hardReset()` can actually cancel
what's pending, instead of just changing a generation counter that a stale
callback would still see fire. `MidSweep` keeps its own one handle the same
way. `imageStore.test.ts`'s `timer hygiene` describe enforces this by
reading both source files raw, stripping comments, and counting every
`setTimeout`/`setInterval` call: `imageStore.ts` is allowed exactly two (one
inside `later()`, one for the grid retry); `midSweep.ts` exactly one. The
reason it matters: the old by-generation silencing couldn't tell a
scheduled timer from a leaked one — a stale `setTimeout` fired, no-oped on a
dead generation, and looked exactly like nothing had happened. Cancelling
the handle is the only way to prove nothing is still armed.

## Coverage

```bash
pnpm test:coverage
```

Uses the v8 provider with text + html reporters; `coverage/` is git-ignored.
There is no threshold, in config or in CI — Phase 4 measured for the first
time, and the numbers are recorded in this phase's implementation note
(`docs/superpowers/plans/2026-09-21-phase-4-tests-and-ci.md`,
"Implementation note" section) once the branch lands. Per-directory floors
are a later call, once real numbers exist to set them against.

## Stylesheet guards

Phase 3B leaned on the `?raw` glob pattern above harder than anything before
it — the "Reading source files in tests" mechanism itself didn't change, but
three new test files use it to keep a CSS number and the JS constant that
computes against it from drifting apart:

- **`src/styles/layout.test.ts`** — reads the app's stylesheets raw and
  checks that every layout token it covers (`--bar-h`, `--winbtn-w`,
  `--rail-w`, `--rail-w-compare`) is actually referenced somewhere, and that
  the footer's, rail's and home screen's picked window-WIDTH breakpoints
  (1360 / 1240 / 1200 / 1120 / 2000 px) exist in the stylesheet at the exact
  width each was picked for, plus the filmstrip's scrub-speed chip anchor
  (`--cell-h`, `strip.css`). `--strip-h` / `--cell-w` / `--cell-h` themselves
  are NOT this file's concern — see `metrics.test.ts` below.
- **`src/components/strip/metrics.test.ts`** — asserts `STRIP_SMALL` /
  `STRIP_LARGE` are the numbers the design board picked, that `strip.css`'s
  `.cull-thumbs` rule agrees with `metrics.ts`'s arithmetic for `stripH`, and
  that `tokens.css`'s `:root` fallbacks for `--strip-h` / `--cell-w` /
  `--cell-h` match `STRIP_SMALL`. The filmstrip's own window-HEIGHT
  breakpoint (1200 px) lives in `useStripMetrics.ts`'s `matchMedia` query, a
  JS string rather than a stylesheet rule, so it falls outside this raw-CSS
  pattern entirely.
- **`src/image/gridThumbRule.test.ts`** — asserts `GRID_CELL_PADDING` (the
  constant the request-rule math uses) equals the padding `grid.css` actually
  draws on `.cull-grid__cell`.

`layout.test.ts`'s footer assertions slice the raw CSS between tier
boundaries (`statusbar.indexOf("@media (width < 1360px) {")` through the
`1240px` one, and so on) — the slicing is keyed to exactly THREE footer
breakpoints (1360 / 1240 / 1120), so inserting a new one between them would
break the slice silently. That is why the Rejects tab (Phase 3C) paid for
its footer space by adding rules inside the existing `< 1360` tier instead
of opening a fourth breakpoint.

The rule this pattern exists to enforce: **a regex over raw CSS text must not
be satisfiable by a comment.** A rule like `/--strip-h:\s*83px/` matches a
`/* --strip-h: 83px */` explanation just as happily as the real declaration,
so a test asserting a token's value has to anchor on the selector the
declaration lives under (see `ruleBody`/`px` helpers in the files above),
never a bare property-name search across the whole stylesheet — otherwise the
guard can pass green while the CSS and the JS constant have already
diverged.

## Env-var-gated corpus tests

Real Canon CR3 files are not committed (see `.gitignore`'s `sample_cr3s`
entry). Point the gates at a local folder to activate the corpus layer:

| Variable | What it activates |
| --- | --- |
| `CULL_TEST_CR3_DIR=<folder of .CR3>` | Parser sweeps over a real shoot (`cr3.rs`: preview extraction, zoom-tier range reads vs the legacy scan, moov hint validation), bundle command round-trips (`bundle.rs`), mid-tier generation with orientation checks (`midtier.rs`), classical metrics over the corpus (`analyze.rs`), and — on `smart-ml` builds — the YuNet (`faces.rs`) and embedding/aesthetic (`embed.rs`) graph-contract smoke tests. |
| `CULL_TEST_CR3=<path to one .CR3>` | Single-file parser deep-dive in `cr3.rs`. |
| `CULL_BENCH=1` | The mid-tier encoder benchmark (`midtier.rs`, `encoder_benchmark`); uses a real full from `CULL_TEST_CR3_DIR` when set, else a synthetic 6960×4640 frame. |
| `CULL_FUZZ_SEED` / `CULL_FUZZ_FROM` / `CULL_FUZZ_ITERS` | The opposite of the rows above: the CR3 mutation fuzzer (see "The CR3 mutation fuzzer") runs unconditionally in CI with no corpus; these three only NARROW its seed and iteration range, to reproduce one exact failing input locally. |

Example:

```bash
CULL_TEST_CR3_DIR=sample_cr3s cargo test --manifest-path src-tauri/Cargo.toml -- --nocapture
```

Not every head-only reader needs the corpus, though: `cr3::read_capture_time`
(Phase 3C) is covered by a SYNTHETIC CR3 head assembled by hand in `cr3.rs`'s
own test module (a minimal `ftyp` + `moov` > `uuid` > `CMT2` box carrying a
hand-built little-endian TIFF), so its whole parse path — DateTimeOriginal,
SubSecTimeOriginal, and the "no moov" / "moov but no tags" edge cases — runs
in CI with no corpus at all. That is the pattern to copy for any future
head-only reader: build the smallest byte string the parser actually walks
rather than gating the test on `CULL_TEST_CR3_DIR`.

The mtime-fallback chain that key feeds (`fallback_deltas` / `capture_keys`,
`scan.rs`) is tested the same corpus-free way, as pure vector tests over
hand-built `i64` timestamps — no file, no CR3, no window: a folder's whole
clock offset recovered exactly (including the owner's own Tokyo-body-shot-
from-Los-Angeles case), the median ignoring a decade-off outlier and a
copy-rewritten mtime, a directory with no EXIF of its own borrowing the
whole shoot's median, a shoot with no EXIF anywhere falling back to the
machine's local clock, and pathological `i64::MIN` / `i64::MAX` clocks
proving the arithmetic saturates instead of panicking or wrapping.

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

## Measuring render cost

No unit test can tell you what a cull actually costs the React tree — the dev
HUD can. Enable it either way. From devtools, in any build (then reload):

```js
localStorage["cull:devhud"] = "1";
```

Or from the environment, in a **dev build only** — `VITE_*` is baked in at
build time, and `main.tsx` gates this switch on `import.meta.env.DEV` so a
release built from a shell that exported it does not ship the HUD on:

```bash
VITE_CULL_DEVHUD=1 pnpm tauri dev
```

The HUD's `react` row is the render meter (`src/utils/renderMeter.ts`), fed by
the `<Profiler>` that wraps `<App>` in `main.tsx`:

| Field | Meaning |
| --- | --- |
| `commits` | React commits to the App tree since the cull began |
| `Σ …ms` | Total committed render time |
| `max …ms` | The single most expensive commit — the visible-stutter suspect |
| `derive` | Full `burstData` re-derivations (`useSmartDerivations`) |
| `…s` | Seconds since `renderMeter.reset()`, i.e. since begin culling |

Two caveats before quoting a number. React's production build never calls
the Profiler, so `commits`, `Σ` and `max` all read 0 in a release build (only
`derive` and the seconds survive) — measure in a dev build. And the counters start climbing the moment the session starts, so
read them only once the session has settled: the `cache … thumb` figure two
rows down equalling the folder's frame count is the signal that background
thumb fill is finished and nothing is still committing behind your back.
