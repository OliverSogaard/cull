# Phase 4 — Tests & CI: design

Fourth phase of the 2026-09-13 audit plan. Every choice here is a ruling under Oliver's standing instruction (2026-09-20) to make the calls and keep moving. Facts, file:line evidence and the full assertion list come from a read-only scout of main `7b4df25`: `~/.claude/plans/cull-audit-2026-09-13/phase-4-scout.txt`.

## The one real bug — fix it first

`Tiff::rationals` (`src-tauri/src/cr3.rs`, about :261) iterates a file-supplied IFD `count` (a raw u32, up to 4.29 billion) with `filter_map`, which skips out-of-bounds reads instead of stopping. A CR3 whose GPS IFD declares a huge RATIONAL count spins ~1.6–1.9 s per file, on every read path, for GPS data the UI never shows. Fix once, in `find_entry`: clamp the returned count to what the buffer can hold for that entry's type (`remaining_bytes / type_size`), so every caller is bounded. Then prove it and keep it proven — see the fuzzer.

Also harden while there: `top_box_content_start` returns an offset before validating `size >= hdr`; `full_jpeg_location` is `pub` with an undocumented `moov_end <= d.len()` precondition that panics in `boxes()` if violated — validate it.

## 1 · A mutation fuzzer for the CR3 parser

A hand-rolled, deterministic fuzzer as an ordinary `#[test]` in `cr3.rs`'s test module: zero new dependencies, runs on stable inside the existing `cargo test` step on both CI runners, and gets arithmetic-overflow panics for free (the dev profile keeps overflow checks). Ruling: not `cargo fuzz` (nightly + libFuzzer + a crate linking tauri and ort; he would run it once), not `proptest` (ten crates and a generator re-implementing the synthetic heads the tests already build).

- xorshift64* from a constant seed; seeds are the synthetic CR3 heads and the sample JPEG the tests already build; 1–6 mutations per input from {bit flip, byte → {0, 0xFF, 1, 8}, truncate, overwrite an aligned 4-byte window with a big-endian u32 from {0xFFFFFFFF, 0x7FFFFFFF, 1, 0, 8}, fourcc swap, insert}; inputs capped at 256 KiB; every `&[u8]` parse entry point called on each input.
- Invariants: never panics; never hangs — each input runs on a worker thread with a `recv_timeout` (a hung input leaks its thread until the test binary exits: acceptable, and said so in a comment); returned sizes are bounded by the input (`preview_jpeg(d).len() <= d.len()`, `boxes(..).len() <= d.len() / 8`).
- The failing seed and iteration are printed, so a red CI run names the input. About 20,000 iterations inside two seconds.
- TDD order matters: write the fuzzer, watch it find the hang, then land the clamp.

## 2 · A harness for the keymap, and the three defects reading it found

`src/app/useCullKeymap.ts` (860 lines, 63 props) has no test. Harness: `renderHook` under jsdom with a typed props factory — no production change, all three listeners exercised as shipped. Ruling: not a key→action table extraction; the bugs live in control flow (modal precedence, `e.repeat`, zoom gates), which a table would refactor away. Mechanics that make such tests lie if missed: `KeyboardEvent`s must be `cancelable: true`; Escape's `defaultPrevented` is always true (a capture listener) and proves nothing; spies typed; ordering via `mock.invocationCallOrder`.

About 36 tests, the scout's list: modal gates (table-driven: 5 overlays × rating keys never rate), help sheet, Ctrl combos, grid size, page keys (one step per press; rest while zoomed; filter-relative Home/End; unbound in compare; Shift extends), filters `1`–`5` (asserted through `cycleFilter`, so a `Filter` rename breaks the test), ratings in loupe and compare, Esc semantics, holds and keyup (incl. the `e.code` fallback), zoom.

Defects found by reading, fixed test-first inside this work:
- **A held rating key rates at the OS repeat rate in the loupe** (compare already guards `e.repeat`). Holding Enter keeps frame after frame. Ruling: loupe Enter / Backspace / `f` / `u` and the digits `1`–`5` ignore `e.repeat`. Cost if wrong: nobody can hold a key to mass-rate — which was never a designed feature.
- **Ctrl combos outrank the help sheet**: with Tab held, Ctrl+Z undoes and Ctrl+E opens the finish dialog under the sheet. Ruling: while the help sheet is visible, every key except Tab's own release is swallowed — the help swallow moves above the Ctrl handlers. Cost if wrong: none; the sheet says "any other key dismisses".
- **A held scrub survives Settings and the quit guard** (they return before the scrub interrupt; the other two overlays return after it). Ruling: the scrub interrupt runs before every modal return.
- Minor, same pass: compare's `k` / `f` call `preventDefault` like their neighbours; Ctrl+Tab does not open the help sheet.

## 3 · One App-level smoke test

Nothing mounts `<App/>`. Blocker: `WindowControls.tsx` calls `getCurrentWindow()` in its render body into an unused local — delete it (the effect already calls it). Then one shared `src/test/tauriMocks.ts` (core `invoke` router by command name, event, window, dialog, a `ResizeObserver` stub) and ONE test: start → staged → culling with fake `scan_folder` / `analyze_folder`, press Enter, assert `invoke("write_xmp_rating", { path, rating: "keep" })`. It proves the 63 props are wired to the right callbacks — the one thing the hook harness cannot. Ruling: exactly one path; `waitFor`, never sleeps; if it proves flaky in three consecutive local runs it is cut rather than nursed. The eight test files that each re-declare the same `vi.mock("@tauri-apps/api/core")` migrate onto the shared kit only where that is mechanical.

## 4 · CI

- `frontend`: add `pnpm build` (3.5 s; the command the release workflow depends on, never run in CI) and `pnpm audit --prod` (clean today; dev-only advisories stay out).
- New job `backend-macos` on `macos-latest` (free: the repo is public): `cargo check --all-targets` with the same cache. It compiles what CI has never compiled — a 234-line macOS memory-pressure FFI module with five `unsafe` blocks, the macOS menu that routes ⌘Q through the quit guard, the CoreML provider under a release-candidate `ort` pin. Not `cargo test` (platform-neutral, already run on Windows), not `tauri build`.
- `.github/dependabot.yml`: cargo + npm + github-actions, monthly, grouped, at most three open PRs.
- A weekly scheduled `cargo audit` workflow (not on PRs).
- Branch protection on `main`, applied after the new job has run once: require `frontend`, `backend`, `backend-macos`; `strict: false`; no required reviews (one human — GitHub would deadlock an author-only repo); no force-push, no deletion; `enforce_admins: false` as the escape hatch; merge commits stay allowed.

## 5 · Test hygiene

- `imageStore.test.ts`: the suite-level teardown hard-resets every store, and `hardReset` silences timers by generation rather than cancelling them — so it cannot detect a leaked timer. Add one `describe("timer hygiene")` on fake timers, one store per timer-owning path (reset fallback, grid pending-retry, mid reprobe, tier retry, the meta batcher), asserting `vi.getTimerCount() === 0` after `hardReset()`. Where that fails, the store learns to cancel (keep the handle, `clearTimeout` in `hardReset`). Not a global fake-timer conversion (50–60 of 86 tests would need rewriting).
- The three `.not.toThrow()`-only tests get real assertions (one's title claims a concurrency change it never reads); the 50 ms sleep-and-hope becomes a deterministic wait.
- Decide tests: comments cite production symbols by name; make the citations executable (import the symbol) so a rename is followed by the compiler. `withChanges(ratings, changes)` is introduced in PRODUCTION only — the tests keep their hand-built literals, so a bug in the helper cannot pass on both sides.
- Coverage plumbing: `@vitest/coverage-v8`, a `test:coverage` script, `coverage/` ignored; report the numbers in the plan note. No threshold in CI this phase — measure first; if gated later, per-directory floors (`src/utils`, `src/smart`, `src/image`, `src/app`), never a global 80 % that `App.tsx` would sink.

## Out of scope

An injected scheduler for every store timer (the right end state; 41 call sites — Phase 5 or later). A fuzz seam for the file-reading grow loops. Rust coverage. A CHANGELOG. Signed installers and the updater (Phase 5). CR3 only.
