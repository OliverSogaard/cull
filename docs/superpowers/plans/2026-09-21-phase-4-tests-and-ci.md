# Phase 4 — Tests & CI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the one real bug the audit's fourth phase found — a file-supplied TIFF count that makes the CR3 parser spin for seconds on every image — and then build the mechanical checks that would have caught it, and that will catch the next one: a mutation fuzzer over the whole parser, a `renderHook` harness for the 860-line keymap nobody has ever tested (which pins five defects found by reading), one smoke test that proves `<App/>`'s 63 keymap props are wired to the right callbacks, a CI leg that compiles the macOS-only code and runs the release build's own command, and a timer-hygiene suite for a store whose teardown is architecturally incapable of seeing a leak.

**Architecture:** Five independent slices. **A** is Rust: a hand-rolled deterministic fuzzer as a plain `#[test]` inside `cr3.rs`'s existing test module (zero new crates, no corpus), written FIRST so it goes red, then one clamp in `Tiff::find_entry` that bounds every caller at once, plus two walker hardenings the fuzzer reaches. **B** is the keymap: a typed props factory derived from the hook's real props type, `renderHook` under jsdom, ~36 assertions, and five production edits to the dispatch order that the tests demand first. **C** is `src/test/tauriMocks.ts` — the first shared test kit in the repo — plus one `<App/>` smoke test that walks start → staged → culling and presses one key. **D** is CI: `pnpm build` + `pnpm audit --prod --audit-level=high` in the existing `frontend` job, a new `backend-macos` job, dependabot, and a weekly `cargo audit`. **E** is hygiene: the store learns to CANCEL its timers instead of silencing them, three assert-nothing tests get real assertions, a 50 ms sleep becomes a fake-timer advance, the decide tests' symbol citations become type-checked, and coverage is plumbed in (measured, not gated).

**Tech Stack:** Tauri 2, Rust 1.98 stable (pure-Rust CR3 pipeline; `[dev-dependencies]` is exactly `image` + `zenjpeg`), React 19, TypeScript 5.8 strict, plain CSS, Vitest 4.1.7 (node env by default, jsdom per file via a first-line docblock, **no `@types/node`**), @testing-library/react 16.3.3, jsdom 30, pnpm 10, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-21-phase-4-tests-and-ci-design.md` (binding — every ruling in it is a decision already taken). Background: `~/.claude/plans/cull-audit-2026-09-13/phase-4-scout.txt`. The scout is a POINTER, not truth — where this plan and the scout disagree, this plan says so explicitly and the code is what was read.

## Global Constraints

- Branch `phase-4-tests-and-ci`, cut from `main` @ `7b4df25` (plus `d6f6d19`, the spec commit). Every file:line in this plan was read at that tip; if a symbol moved, the **name** wins over the line number, and report the drift.
- **CR3 only.** No other RAW format, no JPEG ingest, no format branching.
- **Scope is the spec.** No drive-by refactors, no new dependencies (JS or Rust) beyond the ONE this plan names (`@vitest/coverage-v8`, Task 4), no renames outside a task's own Files list. If the code contradicts the plan, the code wins — report it rather than "fixing" the surroundings.
- **Tests never import `node:*`.** `@types/node` is not installed, so `node:fs` / `node:path` fail both `pnpm typecheck:tests` and the type-aware lint. Read source files with
  `const files = import.meta.glob<string>(pattern, { query: "?raw", eager: true, import: "default" });`
  (always pass the `<string>` type argument). `vite.config.ts`'s `test.css.include` is already scoped to `/\.css\?.*\braw\b/`, so `?raw` CSS reads return real text while ordinary CSS imports stay stubbed. Every such test must first assert the glob returned readable text (`Object.keys(files).length` > 0 and a known substring), or the suite passes on empty strings.
- **Test files are linted type-aware.** Type every `vi.fn` callback (`vi.fn((_x: T) => {})`), and hoist anything a `vi.mock` factory closes over with `vi.hoisted`. Unused bindings need a `_` prefix.
- **A `vi.mock` factory may not reference a module-scope import.** Vitest hoists the factory above every import, so a factory that names an imported binding throws at collection. Use `vi.hoisted(() => …)` for a value, or an **async factory that imports the shared kit itself**: `vi.mock("@tauri-apps/api/window", async () => (await import("./test/tauriMocks")).windowMock());`
- **jsdom only via a first-line docblock**: `// @vitest-environment jsdom` as line 1 of the file. Default env is node.
- **jsdom 30 implements neither `window.matchMedia` nor `ResizeObserver`.** Verified by probe, and the `matchMedia` half **contradicts the scout** (`phase-4-scout.txt:100`, "matchMedia is NOT a blocker (jsdom implements it)" — it is a blocker: `useImageStoreWiring.ts:97` calls it in an unconditional mount effect). It **does** implement `URL.createObjectURL` / `revokeObjectURL` under Vitest's jsdom environment, which installs a Node-backed compat `URL` (`vitest/dist/chunks/index.DC7d2Pf8.js:556-570`) — a bare `new JSDOM()` in plain Node does not, so probe inside Vitest or you will measure the wrong thing. A test replaces that pair with spies only to COUNT blob churn, never because it is missing. `src/components/strip/PhotoStrip.metrics.test.tsx:19-58` is the repo's complete `MediaQueryList` fake and `src/components/GridCell.layers.test.tsx:22-29` its `ResizeObserver` stub.
- **KeyboardEvents in tests are created `cancelable: true`** — without it `preventDefault()` is a silent no-op and **every `defaultPrevented` assertion passes vacuously** — and `bubbles: true`.
- **Escape's `defaultPrevented` proves nothing.** `useCullKeymap.ts:839-845` registers a capture-phase listener that preventDefaults every Escape in every phase, so `defaultPrevented === true` for Escape is true no matter what the rest of the keymap does. Only the test that deliberately pins that listener may assert it.
- **Tests never sleep.** No `await new Promise(r => setTimeout(r, n))` and no "give it a moment" — use `waitFor` / `findBy*` / `vi.waitUntil` for a positive outcome, and fake timers (`vi.advanceTimersByTimeAsync`) when the thing being proven is that a *window elapsed*. A negative assertion needs a provably-elapsed clock, not a guess.
- **A fuzz / property test prints its seed and its iteration on failure**, and the printed pair must reproduce that single input on its own without replaying the run.
- **Nothing in CI installs a tool on every run without caching** unless it is a scheduled job. A weekly `cargo install` is fine; a per-PR one is not.
- **A test that can only run with the `CULL_TEST_CR3_DIR` corpus is not CI coverage.** CI has no CR3 files. Every Rust behaviour added here needs an ungated test of its pure part; a corpus-gated test may only be an *extra*.
- **Immutable updates** (spread, never mutate a settings object or a profile in place). **No `console.log`** (`no-console` allows `error` / `warn` only).
- **TDD**: write the failing test first, watch it fail **for the right reason**, then implement. A task that reports "the test failed" without saying *how* has not done this.
- **Commits** are conventional (`feat:`, `fix:`, `refactor:`, `style:`, `perf:`, `docs:`, `test:`, `ci:`, `chore:`), always in pathspec form — `git commit -m "<type>: <desc>" -- <files>` — with **no attribution trailers**. Never `git add -A`, never a bare `git commit`.
  A pathspec commit takes a file's **whole working-tree content**, not a hunk: never plan two commits that split different hunks of one file. One file, one commit, per task.
  The prettier hook reformats after a commit: content leftovers go in a follow-up `style:` pathspec commit; line-ending-only noise is `git add <file>`.
- **Implementers never run `git stash` / `git checkout` / `git restore` / `git reset`.** To watch a test fail, temporarily edit the one line under test and edit it back.
- **Never run the app**, never open a real photo folder, never touch `C:\Canon Media`. A vite dev server may be listening on port 1420 — leave it alone.
- **Gate for every task** (run from the repo root): `pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm lint:css && pnpm test`.
  **Rust tasks additionally** run, from `src-tauri/`: `cargo fmt` FIRST — the Rust in this plan is hand-written, not rustfmt output, so transcribing it verbatim can fail the check gate on nothing but a chain wrap — then, exactly as `.github/workflows/ci.yml` does, `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test`.
  The docs task adds `pnpm build` and `pnpm audit --prod --audit-level=high`, so its gate matches CI's `frontend` job exactly.
- **`tsconfig.json` excludes only `src/**/*.test.ts(x)`.** A non-`.test` helper under `src/` (Task 9's `src/test/tauriMocks.ts`) is therefore type-checked by `pnpm typecheck` AND by `pnpm build`'s `tsc`, and linted by the **strict** block of `eslint.config.js` — the `src/**/*.test.{ts,tsx}` relaxations (`unbound-method`, `require-await`, …) do **not** apply to it. Write it clean rather than widening either config. It is never bundled: `vite build` follows the import graph from `index.html`, and no app module imports it.
- **The `[profile.dev]` in `src-tauri/Cargo.toml` sets only `opt-level`** (lines 68-69) and never overrides `overflow-checks`, so `cargo test` panics on integer overflow. The fuzzer gets release-wrap detection for free — do not add a profile override.
- `design-board/` is git-excluded. Nothing in Phase 4 uses it.

---

### Task 1: [RUST] The fuzzer, the count clamp it finds, and two walker hardenings

**Files:** Modify `src-tauri/src/cr3.rs` (the ONLY file this task touches).

**Interfaces — Produces** (all private to `cr3.rs`; the module is `mod cr3;`, private in `lib.rs`, so nothing new is `pub`):

```rust
/// Clamp a file-supplied IFD count to the components the buffer can hold.
fn clamp_count(buf_len: usize, voff: usize, typ: u16, cnt: u32) -> u32;
```

**Consumes:** the existing `type_size` (`cr3.rs:139-147`), `Tiff::{u16,u32,ifd0,find_entry,urational_at,srational_at}`, and the test module's `synth_cr3_head` / `synth_cr3_head_padded` / `sample_jpeg` / `tmp_cr3`.

**Ruling (the reader already has a type table — do not write a second one).** The spec's clamp sketch enumerates "1: BYTE 1, 2: ASCII 1, 3: SHORT 2, 4: LONG 4, 5: RATIONAL 8, 7: UNDEFINED 1, 9: SLONG 4, 10: SRATIONAL 8". `cr3.rs:139-147` already has exactly this function, and it is **wider** than the spec's list — it also handles 6 (SBYTE, 1), 8 (SSHORT, 2), 11 (FLOAT, 4) and 12 (DOUBLE, 8), and returns 0 for anything else. `find_entry` already calls it at `:206` to decide inline-vs-offset. The clamp reuses `type_size`; the plan adds no new size table.

**Ruling (unknown type → 0, not pass-through).** `clamp_count` returns 0 when `type_size` is 0. Every existing caller type-checks *before* reading the count — `ascii` requires type 2 (`:221`), `rational` and `rationals` require 5/10 (`:247`, `:259`), `uint` requires 3/4 (`:280`), `canon_drive_mode` requires 3 (`:977`), `af_display` requires 3 (`:1051`) — so this is observably identical today. It is chosen over pass-through because it makes `find_entry`'s contract unconditional: *the returned count is a number of components you can actually read.* A future caller that forgets to type-check then gets 0 instead of 4 billion.

**Ruling (inline values need no special case — but the clamp is not quite a no-op there).** `find_entry` picks `voff = entry + 8` exactly when `type_size(typ) * cnt <= 4`, so an inline entry's count is already at most 4 by construction and no well-formed file is ever touched. The one case the clamp *does* bite inline is an entry truncated at the buffer's tail (`entry + 8 <= len < entry + 8 + cnt * size`), where `ascii` now returns the characters that exist instead of `None`. Bounded, and in the same direction as the rest of this change — but the plan says so rather than claiming a blanket no-op, because the fuzzer's `else` branch leans on the distinction.

**Ruling (do BOTH the clamp and `map_while` — the second is free and provably behaviour-identical).** `rationals`' `filter_map` (`:263`) SKIPS an unreadable component and keeps going; `map_while` stops. For a RATIONAL array the components are contiguous and `urational_at` / `srational_at` return `None` **only** when a bounds-checked read fails, so out-of-range is monotone in `k`: once `voff + 8*k + 8 > d.len()`, every larger `k` fails too. The two combinators therefore produce the **same `Vec`** for every input, and `map_while` additionally bounds the loop. One-word change, zero behaviour delta, and it survives a future regression in `find_entry`.

**Ruling (harden `boxes`, not `full_jpeg_location`).** The scout (`:182-183`) and the spec both say `full_jpeg_location` is `pub` with an undocumented `moov_end <= d.len()` precondition "that panics in `boxes()` if violated". The panic is real — `boxes` reads `d[i+4]…d[i+7]` directly at `:75` while its loop condition only guarantees `i + 8 <= end`, and `be_u32(d, i)` succeeding only guarantees `i + 4 <= d.len()`, so a buffer that ends between `i+4` and `i+7` with `end > d.len()` indexes off the slice. The fix goes in `boxes` (`let end = end.min(d.len());`), not at the one public caller: it makes `i + 8 <= end <= d.len()` an invariant that proves the four direct indices safe for **every** caller, present and future, and it is a no-op for all six existing callers (every one already passes `end <= d.len()`). `full_jpeg_location` then needs only a doc line saying its range is no longer a precondition.

**Ruling (`top_box_content_start` hands back no out-of-range offset — the scout is wrong; fix the inconsistency instead).** The scout (`:180-181`) says it "returns `Some(i + hdr)` BEFORE validating `size >= hdr`, so it can hand back an offset past the buffer". It cannot: `hdr` is 8 only under the loop condition `i + 8 <= d.len()`, and `hdr` is 16 only after `be_u64(d, i + 8)?` succeeded, which requires `i + 16 <= d.len()`. The returned offset is therefore **always** `<= d.len()`. What the late check *does* mean is that a box declaring `size < hdr` — which `boxes` rejects at `:72` — is reported as found here. Ruled: move the `size < hdr` check above the fourcc match so the two walkers agree. This is a consistency fix, not a memory-safety one, and the plan says so rather than repeating the scout's claim.

**Ruling (the seeds need a GPS builder — there is none).** `synth_cr3_head_padded` (`:1406`) builds ftyp + moov > uuid > **CMT2** only, with two hard-coded ASCII tags. The hang lives in a **CMT4 GPS** RATIONAL array, so mutation alone would have to invent one. This task adds `synth_tiff` / `tiff_entry` / `synth_gps_tiff` / `synth_cr3_head_with_cmt`, and lifts `synth_cr3_head_padded`'s inner `boxed` closure (`:1407-1413`) to a free function so both builders share it.

**Ruling (a structure-aware mutator, not luck).** A count field is **not 4-byte aligned** in the file (IFD0 at 8, entry `e` at `8 + 2 + 12e`, its count at `+4` → offsets 14, 26, 38 …), so the spec's "overwrite an aligned 4-byte window" mutator can never land on one. Two consequences, both applied: the u32 splat writes at an **arbitrary** offset in both endiannesses, and the mutator set gains `inflate_an_ifd_count`, which finds a little-endian TIFF header, picks one of its IFD0 entries and writes a hostile value into that entry's count field. With random splats alone the expected time-to-red was ~7,500 iterations with a ~7 % chance of missing 20,000 entirely; with the structure-aware mutator it is tens of iterations and the miss probability is nil. Structure-aware mutation is what real fuzzers do with a dictionary; this is the same idea, 15 lines.

**Ruling (batch-per-worker with a per-input ack, not one thread per input).** 20,000 threads is ~1 s of pure spawning. Instead one worker runs a batch of 250 and **acks every input it finishes** over an `mpsc` channel. The main thread's `recv_timeout` then names the culprit exactly — `last ack + 1` — for a **hang** (`Timeout`) *and* for a **panic** (`Disconnected`, because the sender drops with the thread). No re-run pass is needed. A genuinely hung input leaks its worker until the test binary exits; that is stated in the code comment and accepted (the process is about to fail anyway).

- [ ] **Step 1: the fuzzer's fixtures.** In `cr3.rs`'s `mod tests`, immediately after `tmp_cr3` (`:1387-1391`), add the box/TIFF builders. First **lift the existing closure**: in `synth_cr3_head_padded`, delete lines `:1407-1413` (the `let boxed = |fourcc, payload| { … };` closure) and leave its **five** call sites (`boxed(b"CMT2", &t)`, `boxed(b"free", …)`, `boxed(b"uuid", …)`, `boxed(b"ftyp", …)`, `boxed(b"moov", …)` — `cr3.rs:1456-1460`) untouched: they now resolve to the free function below, and both argument kinds still coerce (`b"crx isom"` unsizes, `&vec![0u8; pad]` derefs). Then add:

```rust
    /// `size + fourcc + payload` — the ISO-BMFF box header. Lifted out of
    /// `synth_cr3_head_padded`'s inner closure so the GPS fixture and the
    /// fuzzer's seeds can build boxes too.
    fn boxed(fourcc: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let mut b = Vec::with_capacity(8 + payload.len());
        b.extend_from_slice(&((8 + payload.len()) as u32).to_be_bytes());
        b.extend_from_slice(fourcc);
        b.extend_from_slice(payload);
        b
    }

    /// One little-endian IFD entry: tag, type, count, value-or-offset.
    fn tiff_entry(tag: u16, typ: u16, cnt: u32, voff: u32) -> [u8; 12] {
        let mut e = [0u8; 12];
        e[0..2].copy_from_slice(&tag.to_le_bytes());
        e[2..4].copy_from_slice(&typ.to_le_bytes());
        e[4..8].copy_from_slice(&cnt.to_le_bytes());
        e[8..12].copy_from_slice(&voff.to_le_bytes());
        e
    }

    /// Assemble a little-endian TIFF blob: "II" + magic 42 + IFD0 at offset 8,
    /// then `entries`, a zero next-IFD pointer, and `tail` — the out-of-line
    /// value area the entries' offsets point into. The knob
    /// `synth_cr3_head_padded` does not give: an ARBITRARY entry, so a test
    /// can build the GPS IFD the unbounded-count hang lived in.
    fn synth_tiff(entries: &[[u8; 12]], tail: &[u8]) -> Vec<u8> {
        let mut t = Vec::new();
        t.extend_from_slice(b"II");
        t.extend_from_slice(&42u16.to_le_bytes());
        t.extend_from_slice(&8u32.to_le_bytes());
        t.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        for e in entries {
            t.extend_from_slice(e);
        }
        t.extend_from_slice(&0u32.to_le_bytes());
        assert_eq!(t.len(), value_area_of(entries.len()), "value area offset");
        t.extend_from_slice(tail);
        t
    }

    /// Where `synth_tiff`'s value area begins: IFD0 at 8, its 2-byte entry
    /// count, 12 bytes per entry, then the 4-byte next-IFD pointer.
    fn value_area_of(entries: usize) -> usize {
        8 + 2 + 12 * entries + 4
    }

    /// A CMT4-shaped GPS IFD: `GPSLatitudeRef` (ASCII "N", inline) and
    /// `GPSLatitude` (three RATIONALs at the value area) — with the latitude's
    /// COUNT under the caller's control. 51° 30' 0" N, give or take.
    fn synth_gps_tiff(lat_count: u32) -> Vec<u8> {
        let lat_off = value_area_of(2) as u32;
        let mut lat_ref = tiff_entry(0x0001, 2, 2, 0); // ASCII, 2 bytes -> inline
        lat_ref[8] = b'N';
        let mut tail = Vec::new();
        for (n, d) in [(51u32, 1u32), (30, 1), (0, 1)] {
            tail.extend_from_slice(&n.to_le_bytes());
            tail.extend_from_slice(&d.to_le_bytes());
        }
        synth_tiff(&[lat_ref, tiff_entry(0x0002, 5, lat_count, lat_off)], &tail)
    }

    /// A CR3 head whose Canon uuid carries ONE CMT box holding `tiff`.
    /// `cmt_in_uuid_range` never inspects the uuid's value, so 16 zero bytes
    /// stand in for Canon's 85c0b687….
    fn synth_cr3_head_with_cmt(cmt: &[u8; 4], tiff: &[u8]) -> Vec<u8> {
        let mut uuid_payload = vec![0u8; 16];
        uuid_payload.extend_from_slice(&boxed(cmt, tiff));
        let mut out = boxed(b"ftyp", b"crx isom");
        out.extend_from_slice(&boxed(b"moov", &boxed(b"uuid", &uuid_payload)));
        out
    }
```

Gate: `cargo fmt && cargo clippy --all-targets -- -D warnings && cargo test`. The four existing `read_capture_time` tests are this step's regression net for the closure lift — they must still pass unchanged.

- [ ] **Step 2: the fuzzer — write it, run it, and WATCH IT GO RED.** Append to `mod tests`, after the fixtures. The whole block, verbatim:

```rust
    // ── Mutation fuzzer ──────────────────────────────────────────────────
    //
    // A deterministic, dependency-free fuzzer over every `&[u8]` parse entry
    // point in this file, as an ordinary `#[test]`, so it rides the existing
    // `cargo test` step on BOTH CI runners and needs no CR3 corpus.
    //
    // Why hand-rolled: `cargo fuzz` needs nightly + libFuzzer and a separate
    // crate that would link tauri and ort; `proptest` is ten crates plus a
    // generator re-implementing the synthetic heads above. This is ~180 lines,
    // runs on stable, and — because [profile.dev] sets only opt-level and
    // never overrides overflow-checks (Cargo.toml:68-69) — gets
    // arithmetic-overflow panic detection for free.
    //
    // Honest limitations, so nobody over-reads a green run:
    //  (i) A hang cannot be detected from the thread that is hanging. Each
    //      BATCH runs on a worker that acks every input it finishes; the main
    //      thread's recv_timeout names the culprit (last ack + 1) for a hang
    //      (Timeout) and for a panic (Disconnected — the sender drops with the
    //      thread). A genuinely hung input LEAKS its worker until the test
    //      binary exits. Accepted: the process is about to fail anyway, and
    //      the alternative is 20,000 thread spawns.
    //  (ii) Allocation cannot be observed without a custom allocator, so the
    //      inputs are capped instead and the assertions are on RETURNED sizes.
    //  (iii) This is a robustness net, not a correctness oracle: it proves no
    //      input panics, hangs, or returns a nonsense size — never that a
    //      well-formed CR3 parses correctly. The tests above do that.

    const FUZZ_MAX_INPUT: usize = 256 << 10;
    const FUZZ_ITERS: u64 = 20_000;
    const FUZZ_BATCH: u64 = 250;
    /// Per-INPUT budget. A healthy input over a small buffer is microseconds;
    /// the unbounded-count spin this fuzzer was written to find is 1.6–1.9 s
    /// per file (spec, "The one real bug"). 1 s sits four orders of magnitude
    /// above a healthy input and still below a single-tag spin, so neither CI
    /// scheduling noise on a shared runner nor a slow machine can move it
    /// across either line.
    const FUZZ_INPUT_BUDGET: std::time::Duration = std::time::Duration::from_millis(1000);
    const FUZZ_SEED: u64 = 0xC0FF_EE15_0FEE_D000;

    /// xorshift64* — eight lines, no dependency, good enough to shuffle bytes.
    struct Rng(u64);
    impl Rng {
        fn next_u64(&mut self) -> u64 {
            let mut x = self.0;
            x ^= x >> 12;
            x ^= x << 25;
            x ^= x >> 27;
            self.0 = x;
            x.wrapping_mul(0x2545_F491_4F6C_DD1D)
        }
        /// An index in `0..n`; `n == 0` yields 0 (never a modulo by zero).
        fn below(&mut self, n: usize) -> usize {
            if n == 0 {
                0
            } else {
                (self.next_u64() % n as u64) as usize
            }
        }
    }

    fn fuzz_env(name: &str, default: u64) -> u64 {
        std::env::var(name)
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(default)
    }

    /// The inputs the mutators start from. Every one is a shape the parser is
    /// MEANT to walk, so a mutation lands inside real structure instead of on
    /// random noise.
    fn fuzz_seeds() -> Vec<Vec<u8>> {
        vec![
            synth_cr3_head(Some("2026:09:21 11:00:00"), Some("47")),
            synth_cr3_head_padded(Some("2026:09:21 11:00:00"), Some("47"), 64),
            // The GPS head: the tag family the hang lived in.
            synth_cr3_head_with_cmt(b"CMT4", &synth_gps_tiff(3)),
            // A bare TIFF blob, so Tiff::new is reached without a box walk.
            synth_gps_tiff(3),
            sample_jpeg(),
            Vec::new(),
        ]
    }

    /// First little-endian TIFF header ("II", magic 42) in the buffer.
    /// `saturating_sub(3)`, not 4: a 4-byte window at `i` needs `i + 4 <= len`,
    /// so the last legal start is `len - 4` and the range must run to `len - 3`.
    fn find_le_tiff(d: &[u8]) -> Option<usize> {
        (0..d.len().saturating_sub(3)).find(|&i| &d[i..i + 4] == b"II\x2A\x00")
    }

    fn read_le_u16(d: &[u8], i: usize) -> Option<u16> {
        d.get(i..i + 2).map(|b| u16::from_le_bytes([b[0], b[1]]))
    }
    fn read_le_u32(d: &[u8], i: usize) -> Option<u32> {
        d.get(i..i + 4)
            .map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }

    /// STRUCTURE-AWARE mutation: find a little-endian TIFF, pick one of its
    /// IFD0 entries, and overwrite that entry's 4-byte COUNT field with a
    /// hostile value. This is the shape that hung the parser, and random byte
    /// edits reach it only by accident — the count field is never 4-byte
    /// aligned in the file, so an aligned splat can NEVER land on one.
    fn inflate_an_ifd_count(rng: &mut Rng, buf: &mut [u8]) {
        let Some(t0) = find_le_tiff(buf) else { return };
        let Some(ifd) = read_le_u32(buf, t0 + 4).map(|v| v as usize) else {
            return;
        };
        let Some(n) = read_le_u16(buf, t0 + ifd).map(|v| v as usize) else {
            return;
        };
        if n == 0 {
            return;
        }
        let at = t0 + ifd + 2 + rng.below(n) * 12 + 4;
        if at + 4 > buf.len() {
            return;
        }
        let v = [0xFFFF_FFFFu32, 0x7FFF_FFFF, 0x00FF_FFFF, 8][rng.below(4)];
        buf[at..at + 4].copy_from_slice(&v.to_le_bytes());
    }

    fn mutate(rng: &mut Rng, buf: &mut Vec<u8>) {
        match rng.below(8) {
            0 => {
                if buf.is_empty() {
                    return;
                }
                let i = rng.below(buf.len());
                buf[i] ^= 1u8 << rng.below(8);
            }
            1 => {
                if buf.is_empty() {
                    return;
                }
                let i = rng.below(buf.len());
                buf[i] = [0u8, 0xFF, 1, 8][rng.below(4)];
            }
            2 => {
                let keep = rng.below(buf.len() + 1);
                buf.truncate(keep);
            }
            // An ARBITRARY offset, both endiannesses: TIFF counts are little-
            // endian and unaligned, box sizes are big-endian and aligned.
            3 | 4 => {
                if buf.len() < 4 {
                    return;
                }
                let v = [0xFFFF_FFFFu32, 0x7FFF_FFFF, 0x8000_0000, 1, 0, 8][rng.below(6)];
                let bytes = if rng.below(2) == 0 {
                    v.to_be_bytes()
                } else {
                    v.to_le_bytes()
                };
                let i = rng.below(buf.len() - 3);
                buf[i..i + 4].copy_from_slice(&bytes);
            }
            5 => {
                const FOURCCS: [&[u8; 4]; 7] =
                    [b"moov", b"uuid", b"mdat", b"ftyp", b"CMT2", b"CMT4", b"PRVW"];
                if buf.len() < 4 {
                    return;
                }
                let i = rng.below(buf.len() - 3);
                buf[i..i + 4].copy_from_slice(FOURCCS[rng.below(FOURCCS.len())]);
            }
            6 => {
                if buf.len() >= FUZZ_MAX_INPUT {
                    return;
                }
                let at = rng.below(buf.len() + 1);
                let n = 1 + rng.below(64);
                let b = (rng.next_u64() & 0xFF) as u8;
                buf.splice(at..at, std::iter::repeat_n(b, n));
            }
            _ => inflate_an_ifd_count(rng, buf),
        }
        buf.truncate(FUZZ_MAX_INPUT);
    }

    /// The input for `(seed, iteration)` — DERIVED, never replayed. A red run
    /// prints both, and the pair reproduces that one input on its own.
    fn fuzz_input(seeds: &[Vec<u8>], seed: u64, iter: u64) -> Vec<u8> {
        let mut rng = Rng((seed ^ iter.wrapping_mul(0x9E37_79B9_7F4A_7C15)) | 1);
        let mut buf = seeds[rng.below(seeds.len())].clone();
        for _ in 0..(1 + rng.below(6)) {
            mutate(&mut rng, &mut buf);
        }
        buf
    }

    /// The buffer itself plus every CMT blob the box walk can reach, so a
    /// mutation that only damages a CMT's TIFF still gets that TIFF read.
    fn tiff_candidates(d: &[u8]) -> Vec<&[u8]> {
        let mut out = vec![d];
        if let Some((ms, me)) = moov_range(d) {
            for cmt in [b"CMT1", b"CMT2", b"CMT3", b"CMT4"] {
                if let Some(blob) = cmt_in_uuid_range(d, ms, me, cmt) {
                    out.push(blob);
                }
            }
        }
        out
    }

    /// Tags across every reader arm: GPS rationals, orientation, the ASCII
    /// times, the exposure rationals, the SHORT/LONG uints, and the two Canon
    /// MakerNote arrays.
    const FUZZ_TAGS: [u16; 10] = [
        0x0002, 0x0004, 0x0112, 0x9003, 0x9291, 0x829D, 0x8827, 0xA002, 0x0001, 0x0026,
    ];

    /// Every `&[u8]` parse entry point, on one input, with the size
    /// invariants asserted inline. The harness needs only two verdicts from a
    /// worker: "finished" and "panicked".
    fn fuzz_one(d: &[u8]) {
        let n = d.len();

        let all = boxes(d, 0, n);
        assert!(
            all.len() <= n / 8,
            "boxes returned {} boxes for {n} bytes — each consumes >= 8",
            all.len()
        );
        for &(_, cs, ce) in &all {
            assert!(cs <= ce && ce <= n, "box range {cs}..{ce} outside 0..{n}");
        }
        // Deliberately UNVALIDATED ranges: boxes clamps `end` itself, and
        // full_jpeg_location is pub with no precondition left.
        let _ = boxes(d, 0, usize::MAX);
        let _ = boxes(d, n.saturating_add(1024), usize::MAX);
        let _ = top_box_content_start(d, b"mdat");
        let _ = child_box(d, 0, n, b"trak");
        let _ = full_jpeg_location(d, 0, usize::MAX);
        if let Some((ms, me)) = moov_range(d) {
            assert!(ms <= me && me <= n, "moov range {ms}..{me} outside 0..{n}");
            let _ = full_jpeg_location(d, ms, me);
        }

        let _ = find_soi(d, 0, n);
        if let Some(j) = jpeg_in_box(d, 0, n, b"PRVW") {
            assert!(j.len() <= n, "jpeg_in_box returned {} of {n}", j.len());
        }
        if let Some(p) = preview_jpeg(d) {
            assert!(p.len() <= n, "preview_jpeg returned {} of {n}", p.len());
        }
        if let Some(t) = thumbnail_from_prefix(d) {
            assert!(t.len() <= n, "thumbnail_from_prefix returned {} of {n}", t.len());
        }
        for soi in [0usize, 1, n / 2] {
            if soi < n {
                if let Some(end) = jpeg_extent(d, soi) {
                    assert!(end <= n, "jpeg_extent returned {end} past {n}");
                }
            }
        }
        let oriented = with_exif_orientation(d.to_vec(), 6);
        assert!(
            oriented.len() <= n + 36,
            "orientation splice grew {n} to {} — one APP1 is 36 bytes",
            oriented.len()
        );

        for blob in tiff_candidates(d) {
            let Some(t) = Tiff::new(blob) else { continue };
            let Some(ifd) = t.ifd0() else { continue };
            for tag in FUZZ_TAGS {
                if let Some((typ, cnt, voff)) = t.find_entry(ifd, tag) {
                    // THE invariant this phase bought: a file-supplied count
                    // can never make a reader iterate past its own buffer.
                    let sz = type_size(typ);
                    let bytes = (cnt as usize).saturating_mul(sz);
                    if sz > 0 && voff <= blob.len() {
                        assert!(
                            bytes <= 4 || bytes <= blob.len() - voff,
                            "find_entry({tag:#06x}) kept an unreadable count {cnt} \
                             (type {typ}, offset {voff}, buffer {})",
                            blob.len()
                        );
                    } else {
                        assert_eq!(cnt, 0, "unknown type / offset past the end must clamp to 0");
                    }
                }
                let r = t.rationals(ifd, tag);
                assert!(
                    r.len() * 8 <= blob.len(),
                    "rationals returned {} components — {} bytes do not fit",
                    r.len(),
                    blob.len()
                );
                let _ = t.ascii(ifd, tag);
                let _ = t.rational(ifd, tag);
                let _ = t.uint(ifd, tag);
                let _ = t.short_tag(ifd, tag);
            }
            let _ = af_display(&t, 6);
            let _ = canon_drive_mode(&t);
        }
        let _ = orientation_from_cmt1(Some(d));
        let _ = metadata_from_prefix(d);
    }

    /// The whole parser, on mutated input, bounded in time and in output size.
    /// UNGATED on purpose: no corpus, no env var, no feature — it runs in CI.
    #[test]
    fn mutation_fuzz_never_panics_hangs_or_returns_an_oversized_result() {
        use std::sync::mpsc;

        let seed = fuzz_env("CULL_FUZZ_SEED", FUZZ_SEED);
        let iters = fuzz_env("CULL_FUZZ_ITERS", FUZZ_ITERS);
        let from = fuzz_env("CULL_FUZZ_FROM", 0);
        let seeds = fuzz_seeds();
        let started = std::time::Instant::now();

        let mut i = from;
        while i < from + iters {
            let hi = (i + FUZZ_BATCH).min(from + iters);
            let batch: Vec<Vec<u8>> = (i..hi).map(|k| fuzz_input(&seeds, seed, k)).collect();
            let sizes: Vec<usize> = batch.iter().map(Vec::len).collect();
            let (tx, rx) = mpsc::channel::<()>();
            // Detached on purpose — see limitation (i) above.
            let _worker = std::thread::spawn(move || {
                for input in &batch {
                    fuzz_one(input);
                    if tx.send(()).is_err() {
                        return; // the main thread has already given up
                    }
                }
            });
            for k in i..hi {
                let how = match rx.recv_timeout(FUZZ_INPUT_BUDGET) {
                    Ok(()) => continue,
                    Err(mpsc::RecvTimeoutError::Timeout) => "HANG",
                    Err(mpsc::RecvTimeoutError::Disconnected) => "PANIC (message above)",
                };
                panic!(
                    "{how} on iteration {k} of seed {seed:#x} ({} byte input). Reproduce \
                     exactly this one input with:\n  CULL_FUZZ_SEED={seed} CULL_FUZZ_FROM={k} \
                     CULL_FUZZ_ITERS=1 cargo test mutation_fuzz -- --nocapture",
                    sizes[(k - i) as usize]
                );
            }
            i = hi;
        }
        eprintln!(
            "fuzz: {iters} inputs from seed {seed:#x} in {:?}",
            started.elapsed()
        );
    }
```

  Then **run it and record the red**: `cargo test mutation_fuzz -- --nocapture` from `src-tauri/`.
  - It **must** fail. The first red will be one of **three** expected faces of this phase's work, and which one comes first depends on the seed:
    1. a **PANIC** on the `find_entry` count invariant (what Step 3's clamp makes true);
    2. a **HANG** against the 1 s budget — `rationals` iterating a declared 4-billion count (what Step 3 and Step 4 together make impossible);
    3. an **index-out-of-bounds or arithmetic-overflow PANIC inside `boxes`**, from the deliberately-unvalidated `boxes(d, 0, usize::MAX)` call in `fuzz_one` — `boxes` pushes `d[i+4]…d[i+7]` (`cr3.rs:75`) while its loop only guarantees `i + 8 <= end`, so a buffer ending mid-header walks off the slice. That is fixed by Step 5's `let end = end.min(d.len());`, not by Step 3.
  - **Paste the exact line the run printed — the `how`, the iteration and the `seed:#x` — into the task report.** A report that does not quote it has not watched the test fail.
  - If the run reports a defect that is none of those three (an overflow panic in a grow loop, a `jpeg_extent` size violation, anything else), **STOP and report it**. Do not invent a fix: the controller decides whether it belongs in this phase.

- [ ] **Step 3: the clamp.** In `src-tauri/src/cr3.rs`, directly after `type_size` (`:139-147`), add:

```rust
/// Clamp a file-supplied IFD `count` to the components the buffer can hold.
///
/// An IFD entry's count is a raw `u32` — up to 4,294,967,295 — and nothing in
/// the file guarantees the bytes behind it exist. Before this clamp,
/// `Tiff::rationals` iterated the DECLARED count with `filter_map`, which
/// SKIPS an out-of-bounds read instead of stopping: a CR3 whose CMT4 GPS IFD
/// declared `type 5 (RATIONAL), count 0xFFFF_FFFF` spun about a second per
/// tag, twice per file (lat + lon), on every read path — for GPS the UI never
/// displays (`metadata_from_prefix` -> `gps_coord` -> `rationals`).
///
/// Clamping HERE, in `find_entry`, bounds every caller at once instead of
/// four times at the call sites, and makes the returned count a promise:
/// *this many components are readable from `voff`.*
///
/// - An unknown type (`type_size` == 0) reads back 0. Every caller checks the
///   type before using the count, so this is observably identical today — but
///   it keeps the promise true for a future caller, which passing the raw
///   count through would not.
/// - A `voff` past the end of the buffer also reads back 0.
/// - An INLINE value (`type_size * count <= 4`, stored at `entry + 8`) carries
///   at most 4 components by construction, so the clamp is a no-op for every
///   well-formed file. The one case it does bite is an entry truncated at the
///   buffer's tail, where it yields the components that actually exist instead
///   of None — bounded, and in the same direction as the rest of this change.
fn clamp_count(buf_len: usize, voff: usize, typ: u16, cnt: u32) -> u32 {
    let size = type_size(typ);
    if size == 0 {
        return 0;
    }
    let Some(room) = buf_len.checked_sub(voff) else {
        return 0;
    };
    u32::try_from(room / size).unwrap_or(u32::MAX).min(cnt)
}
```

  Then change `find_entry`'s doc line and its `return`. Before (`:197-198`, `:212`):

```rust
    /// Find an IFD entry by tag → (type, count, absolute value offset). Values
    /// ≤ 4 bytes are inline at entry+8; larger ones live at the u32 offset there.
```
```rust
                return Some((typ, cnt, voff));
```

  After:

```rust
    /// Find an IFD entry by tag → (type, CLAMPED count, absolute value
    /// offset). Values ≤ 4 bytes are inline at entry+8; larger ones live at
    /// the u32 offset there. The count is file-supplied and unvalidated, so it
    /// passes through `clamp_count` before any caller can loop on it.
```
```rust
                return Some((typ, clamp_count(self.d.len(), voff, typ, cnt), voff));
```

- [ ] **Step 4: the belt — bound `rationals` too.** Replace `filter_map` with `map_while` (`:263`) and extend the doc (`:254`):

```rust
    /// All RATIONAL/SRATIONAL components (e.g. GPS deg/min/sec).
    ///
    /// `map_while`, not `filter_map`: the components are CONTIGUOUS, so the
    /// first unreadable one ends the array — `filter_map` skipped it and kept
    /// going, which is what turned a hostile count into a multi-second spin.
    /// Provably the same output: `urational_at` / `srational_at` return None
    /// ONLY on a failed bounds-checked read, and that is monotone in `k`, so
    /// no reachable input has a readable component after an unreadable one.
    /// Belt to `find_entry`'s clamp (the braces): the clamp bounds every
    /// caller, this bounds the loop even if a future change hands back an
    /// unclamped count.
    fn rationals(&self, ifd_off: usize, tag: u16) -> Vec<f64> {
        let Some((typ, cnt, voff)) = self.find_entry(ifd_off, tag) else {
            return Vec::new();
        };
        if typ != 5 && typ != 10 {
            return Vec::new();
        }
        (0..cnt as usize)
            .map_while(|k| {
                let o = voff + 8 * k;
                if typ == 10 {
                    self.srational_at(o)
                } else {
                    self.urational_at(o)
                }
            })
            .collect()
    }
```

- [ ] **Step 5: the two walker hardenings.** In `boxes` (`:49-51`), insert the clamp as the first statement and extend the doc:

```rust
/// Top-level / sibling boxes in [start, end) → (fourcc, content_start, box_end).
///
/// `end` is caller-supplied and `full_jpeg_location` is `pub`, so it can
/// exceed the buffer. Clamping it here makes `i + 8 <= end <= d.len()` an
/// invariant, which is what proves the four DIRECT indices at the push below
/// safe — previously they rested on a promise every caller happened to keep.
fn boxes(d: &[u8], start: usize, end: usize) -> Vec<([u8; 4], usize, usize)> {
    let end = end.min(d.len());
    let mut out = Vec::new();
```

  In `top_box_content_start` (`:400-406`), move the malformed-box check above the fourcc match. Before:

```rust
        if &fourcc == want {
            return Some(i + hdr);
        }
        if size < hdr {
            break;
        }
        i = i.checked_add(size)?;
```

  After:

```rust
        // A box declaring a size smaller than its own header is malformed and
        // ends the walk — the same rule `boxes` applies at its `size < hdr`
        // check. Checked BEFORE the fourcc match so the two walkers agree:
        // this one used to report such a box as found. (The returned offset
        // was never out of range: hdr is 8 only under `i + 8 <= d.len()`, and
        // 16 only after `be_u64(d, i + 8)?` proved `i + 16 <= d.len()`.)
        if size < hdr {
            break;
        }
        if &fourcc == want {
            return Some(i + hdr);
        }
        i = i.checked_add(size)?;
```

  And add one line to `full_jpeg_location`'s doc (after `:439`, the last line of the existing block):

```rust
/// `moov_start` / `moov_end` are NOT a precondition: `boxes` clamps its `end`
/// to the buffer, so any range is safe (an out-of-range one simply yields no
/// boxes and therefore `None`).
```

- [ ] **Step 6: re-run the fuzzer — it must now be GREEN**, and report the printed line (`fuzz: 20000 inputs from seed 0x… in …`). If the wall clock exceeds **5 s** on the dev profile, lower `FUZZ_ITERS` until it is under 3 s and say so in the report with both numbers. Then run the full `cargo test` and confirm 154 + the new tests pass.

- [ ] **Step 7: the targeted unit tests.** Append to `mod tests` (these are the deterministic proofs; the fuzzer is the standing net):

```rust
    /// THE bug this phase exists for, in its exact hostile shape: a CMT4 GPS
    /// IFD declaring `GPSLatitude (0x0002), type 5 RATIONAL, count
    /// 0xFFFF_FFFF` over a buffer that holds three rationals.
    #[test]
    fn a_hostile_ifd_count_is_clamped_to_the_bytes_that_exist() {
        const HOSTILE: u32 = 0xFFFF_FFFF;
        let blob = synth_gps_tiff(HOSTILE);
        let lat_off = value_area_of(2);
        assert_eq!(blob.len(), lat_off + 24, "three RATIONALs in the value area");

        let t = Tiff::new(&blob).expect("II header");
        let ifd = t.ifd0().expect("IFD0 offset");

        // 1. The clamp itself — deterministic, no clock involved.
        let (typ, cnt, voff) = t.find_entry(ifd, 0x0002).expect("the GPS latitude entry");
        assert_eq!(typ, 5);
        assert_eq!(voff, lat_off);
        assert_eq!(cnt, 3, "clamped to (len - voff) / 8, not the declared {HOSTILE}");

        // 2. The consequence: the three real components, returned AT ONCE.
        //    The budget is ~1000x a healthy parse and ~4x under the measured
        //    pre-clamp spin, so this cannot pass merely by being fast.
        let t0 = std::time::Instant::now();
        let parts = t.rationals(ifd, 0x0002);
        let elapsed = t0.elapsed();
        assert_eq!(parts, vec![51.0, 30.0, 0.0]);
        assert!(
            elapsed < std::time::Duration::from_millis(200),
            "rationals took {elapsed:?} — an unbounded IFD count is back"
        );

        // 3. The PRODUCTION route the bug actually lived on, end to end:
        //    metadata_from_prefix -> gps_coord -> rationals, on a whole CR3
        //    head. Asserting only on `rationals` would leave the path every
        //    real image takes untested.
        let head = synth_cr3_head_with_cmt(b"CMT4", &blob);
        let t1 = std::time::Instant::now();
        let m = metadata_from_prefix(&head);
        assert!(
            t1.elapsed() < std::time::Duration::from_millis(200),
            "metadata_from_prefix took {:?}",
            t1.elapsed()
        );
        assert_eq!(m.gps_lat, Some(51.5), "51 deg 30 min 0 sec, N");
    }

    /// The clamp's other arms. No production caller can reach them today
    /// (every one checks the type first), which is exactly why they need a
    /// test: they are what keeps `find_entry`'s contract true for the next one.
    #[test]
    fn an_unknown_type_and_an_out_of_range_offset_clamp_to_zero() {
        assert_eq!(type_size(0), 0, "0 is not a TIFF field type");
        assert_eq!(type_size(13), 0, "13 is past the TIFF 6.0 table");
        assert_eq!(clamp_count(100, 10, 13, 9), 0, "unknown type");
        assert_eq!(clamp_count(100, 200, 5, 9), 0, "value offset past the end");
        assert_eq!(clamp_count(100, 92, 5, 9), 1, "(100 - 92) / 8 = 1");
        assert_eq!(clamp_count(100, 10, 5, 2), 2, "a well-formed count is untouched");
    }

    /// `boxes` indexes `d[i + 4 ..= i + 7]` directly while the loop condition
    /// only bounds `i + 8` against `end`. `full_jpeg_location` is pub and took
    /// `moov_end` unvalidated, so a five-byte buffer with a larger `end`
    /// walked off the slice.
    #[test]
    fn boxes_clamps_a_caller_end_past_the_buffer() {
        let d = [0u8, 0, 0, 8, b'f']; // a size-8 header, truncated mid-fourcc
        assert!(boxes(&d, 0, 8).is_empty(), "no complete box in five bytes");
        assert!(boxes(&d, 0, usize::MAX).is_empty());
        assert_eq!(full_jpeg_location(&d, 0, usize::MAX), None);
    }

    /// A box whose declared size is smaller than its own header is malformed.
    /// `boxes` has always ended the walk there; `top_box_content_start`
    /// checked after the fourcc match and reported it as found.
    #[test]
    fn top_box_content_start_rejects_a_box_shorter_than_its_header() {
        let mut d = Vec::new();
        d.extend_from_slice(&4u32.to_be_bytes()); // size 4 < the 8-byte header
        d.extend_from_slice(b"mdat");
        d.extend_from_slice(&[0u8; 8]);
        assert_eq!(top_box_content_start(&d, b"mdat"), None);
        assert!(boxes(&d, 0, d.len()).is_empty(), "boxes already rejected it");
    }
```

  Each of the four is red before its Step-3/4/5 edit and green after — verify that by temporarily reverting the one line under test (never `git restore`), then putting it back.

- [ ] **Step 8:** Rust gate green (`cargo fmt`, then `cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test`). Commit: `fix(cr3): clamp a file-supplied IFD count, and a mutation fuzzer that finds it` — `git commit -m "fix(cr3): clamp a file-supplied IFD count, and a mutation fuzzer that finds it" -- src-tauri/src/cr3.rs`

### Task 2: CI — the release build's own command, a prod audit, and a macOS leg

**Files:** Modify `.github/workflows/ci.yml` (the ONLY file this task touches, and the only task that touches it).

**Interfaces — Produces:** a third GitHub check named exactly **`backend-macos`**, alongside the existing `frontend` and `backend`. The controller's branch-protection step consumes that name.

**Ruling (one task, not two).** The scout split these into T1 and T2 and then noted they share a file. One owner, one commit.

**Ruling (actions stay on the majors already in the file).** `actions/checkout@v7`, `dtolnay/rust-toolchain@stable`, `swatinem/rust-cache@v2` — copied from the `backend` job verbatim. No new action is introduced by this task.

**Ruling (no cache key by hand).** `swatinem/rust-cache@v2` already keys on the runner OS, the job name and the lockfile, so `backend-macos` cannot collide with `backend`'s Windows cache. `workspaces: src-tauri` is the only input it needs, exactly as `backend` has it.

**Ruling (`cargo check --all-targets`, not `cargo test`, and default features stay on).** The point of the leg is to COMPILE what CI has never compiled: `memory_pressure.rs`'s `#[cfg(target_os = "macos")] mod platform` (five `unsafe` blocks, `#[repr(C)]` libdispatch FFI), `lib.rs`'s macOS menu block that routes ⌘Q through the quit guard, and `ml_models.rs`'s `ort::ep::CoreML` under an exactly-pinned release candidate (`Cargo.toml:87`). Tests are platform-neutral and already run on Windows; running them again would double a five-minute job for nothing. Default features stay on because `smart-ml` — and therefore `ort` with `coreml` — is the whole reason the leg exists.

- [ ] **Step 1: the two `frontend` steps.** In `.github/workflows/ci.yml`, replace line 17 (`      - run: pnpm test`) with:

```yaml
      - run: pnpm test
      # The exact command release.yml's tauri-action runs (`beforeBuildCommand`),
      # which CI has never once executed: 3.5 s here against finding out at a
      # tag. Type errors already fail `typecheck`; this catches the rest of the
      # bundle (a bad import path, a missing asset, a Rollup resolution error).
      - run: pnpm build
      # RUNTIME advisories only, and only the ones worth stopping a merge for.
      # Plain `pnpm audit` reports 21 findings today, every one of them
      # dev-only (eslint/vite/stylelint transitives) — gating on those would
      # make a red CI the normal state and teach everyone to ignore it.
      # `--audit-level=high` is the second half of the same argument: a
      # MODERATE advisory in a runtime dependency of a single-owner desktop app
      # is a thing to read on Monday, not a thing that blocks every PR;
      # high and critical are not. Both dials can be reopened by editing this
      # one line. `--prod` alone is clean today.
      #
      # This step talks to the registry, so a registry outage reds it with a
      # network error rather than a finding. The remedy is to re-run the job,
      # never to delete the step.
      - run: pnpm audit --prod --audit-level=high
```

- [ ] **Step 2: the macOS job.** Append to the end of `.github/workflows/ci.yml`, after the `backend` job's last step (line 33):

```yaml
  backend-macos:
    runs-on: macos-latest # free: the repo is public
    defaults: { run: { working-directory: src-tauri } }
    steps:
      - uses: actions/checkout@v7
      # No `components:` here, unlike `backend` — this job runs neither fmt
      # nor clippy, so installing them would be a cold download for nothing.
      - uses: dtolnay/rust-toolchain@stable
      - uses: swatinem/rust-cache@v2
        with: { workspaces: src-tauri }
      # COMPILE ONLY, and with default features on. This is the only job that
      # ever builds the macOS-only code: memory_pressure.rs's
      # `#[cfg(target_os = "macos")] mod platform` (libdispatch FFI, five
      # unsafe blocks), lib.rs's macOS menu that routes Cmd+Q through the quit
      # guard, and ml_models.rs's `ort::ep::CoreML` behind an exact rc pin —
      # all of which are invisible until a release tag today. Not `cargo test`
      # (platform-neutral, already run on windows-latest); not `tauri build`
      # (slow, and it wants signing).
      - run: cargo check --all-targets
```

- [ ] **Step 2b: this job cannot be run locally, and a first-run failure is not yours to fix.** The implementer is on Windows; `backend-macos` compiles a `#[cfg(target_os = "macos")]` module, a macOS menu API surface and a CoreML execution provider that CI has **never** compiled, so a red on its first real run is plausible and is exactly the finding the job exists to produce. Its first real run is on the pull request. If it fails to compile, **report the exact `rustc` error and STOP** — do not patch `memory_pressure.rs`, `lib.rs` or `ml_models.rs` from inside this task. The controller decides whether the fix belongs in Phase 4 or in its own change, and branch protection must not be applied until the job has reported green once.
- [ ] **Step 3: verify the file parses and the check names are what branch protection will require.** There is no yaml linter in this repo, so read the whole file back and confirm: three top-level keys under `jobs:` (`frontend`, `backend`, `backend-macos`), two-space indentation throughout, and that `backend-macos`'s `defaults:` / `steps:` sit at the same column as `backend`'s. Record the three job names verbatim in the task report — the controller's final step needs them.
- [ ] **Step 4:** repo gate green (this task changes no source, so `pnpm test` should be unchanged; run it anyway). Commit: `ci: run the release build and a prod audit, and compile the macOS backend` — `git commit -m "ci: run the release build and a prod audit, and compile the macOS backend" -- .github/workflows/ci.yml`

### Task 3: Dependabot, and a weekly cargo audit

**Files:** Create `.github/dependabot.yml`, create `.github/workflows/cargo-audit.yml`.

**Interfaces — Produces:** nothing the other tasks consume. **Consumes:** nothing. Fully disjoint.

**Ruling (`cargo install cargo-audit --locked` in a scheduled job, not a third-party action).** `rustsec/audit-check` would be faster, but it adds a third-party action to the supply chain of a repo whose backend is deliberately pure-Rust with exactly one vendored native dependency — and the thing being watched here IS a supply-chain risk (`ort = "=2.0.0-rc.12"` ships a downloaded native binary). A weekly job can afford the two-to-three-minute compile, and the Global Constraint permits an uncached install precisely because it is scheduled. `workflow_dispatch` is included so it can be run on demand without waiting for Monday.

**Ruling (monthly, grouped, three open PRs).** Per the spec. Grouping means one PR per ecosystem per month rather than thirty; the limit of three stops a stale week from burying the branch list.

- [ ] **Step 1: `.github/dependabot.yml`**, new file, verbatim:

```yaml
# Monthly, grouped, at most three open PRs per ecosystem. The reason this
# exists is `ort = "=2.0.0-rc.12"` (src-tauri/Cargo.toml): an EXACT pin on a
# release candidate that ships a downloaded native binary, which nothing else
# in this repo would ever notice going stale. npm and github-actions ride
# along for the same money.
version: 2
updates:
  - package-ecosystem: cargo
    directory: /src-tauri
    schedule: { interval: monthly }
    open-pull-requests-limit: 3
    groups:
      cargo: { patterns: ["*"] }
  - package-ecosystem: npm
    directory: /
    schedule: { interval: monthly }
    open-pull-requests-limit: 3
    groups:
      npm: { patterns: ["*"] }
  - package-ecosystem: github-actions
    directory: /
    schedule: { interval: monthly }
    open-pull-requests-limit: 3
    groups:
      actions: { patterns: ["*"] }
```

- [ ] **Step 2: `.github/workflows/cargo-audit.yml`**, new file, verbatim:

```yaml
# RustSec advisories against Cargo.lock. Weekly and on demand — NOT on pull
# requests: a new advisory published on a Tuesday is not a reason to block a
# Tuesday afternoon's merge, and `cargo install` costs two to three minutes
# that a PR should not pay. The npm side of this runs per-PR instead, as
# `pnpm audit --prod --audit-level=high` in ci.yml, because that one is a
# download rather than a build. This job has no severity floor: a weekly
# report should say everything it knows.
#
# GitHub disables a scheduled workflow after 60 days without repository
# activity and emails the owner; `workflow_dispatch` is the manual escape
# hatch, and pushing anything re-arms the schedule.
name: cargo audit
on:
  schedule:
    - cron: "0 6 * * 1" # Mondays, 06:00 UTC
  workflow_dispatch:
# Explicit beats inherited: this job reads the lockfile and nothing else.
permissions:
  contents: read
jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: dtolnay/rust-toolchain@stable
      # --locked so the audit tool's own dependency tree cannot drift and turn
      # a green week red for reasons that have nothing to do with this repo.
      - run: cargo install cargo-audit --locked
      - run: cargo audit --file src-tauri/Cargo.lock
```

- [ ] **Step 3: confirm the lockfile path.** `cargo audit --file src-tauri/Cargo.lock` is only correct if `src-tauri/Cargo.lock` exists (it does — `.gitattributes:15` marks `Cargo.lock` as generated). Verify it with a read; if the lockfile lives elsewhere, use its real path and report the correction.
- [ ] **Step 4:** repo gate green. Two separate pathspec commits (two files, two concerns): `chore: monthly grouped dependabot for cargo, npm and actions` — `git commit -m "chore: monthly grouped dependabot for cargo, npm and actions" -- .github/dependabot.yml`; then `ci: weekly cargo audit` — `git commit -m "ci: weekly cargo audit" -- .github/workflows/cargo-audit.yml`

### Task 4: Coverage, measured and reported — not gated

**Files:** Modify `package.json`, `pnpm-lock.yaml`, `vite.config.ts`, `.gitignore`.

**Interfaces — Produces:** a `pnpm test:coverage` script. **Consumes:** nothing.

**Ruling (one owner for all four files, because `pnpm add -D` rewrites the lockfile).** This is the only task in the phase that runs a package manager install, so it is the only one that may touch `pnpm-lock.yaml`. No other task adds a dependency.

**Ruling (no threshold this phase).** Per the spec: measure first. A global 80 % in CI would be sunk by `App.tsx` (~2,000 lines) and the presentational components and would block every PR for reasons unrelated to it. Per-directory floors on `src/utils`, `src/smart`, `src/image`, `src/app` are the shape to propose once numbers exist — Phase 5's call, with this phase's numbers in front of it.

**Ruling (`^4`, to match vitest's major).** `node_modules/vitest/package.json` reads `4.1.7`; `@vitest/coverage-v8` is a peer of vitest and must share its major (the lockfile already carries it as an OPTIONAL peer of vitest at 4.1.7 — `pnpm-lock.yaml:1793-1794` — which is metadata about vitest, not an install).

- [ ] **Step 1: install.** From the repo root: `pnpm add -D @vitest/coverage-v8@^4`. Report the exact resolved version from `package.json` afterwards.
- [ ] **Step 2: the config block.** In `vite.config.ts`, extend the `test` key (`:33-45`) — keep the existing `css.include` and its comment untouched, and add below it:

```ts
    // Coverage is MEASURED, not gated (Phase 4): there is no threshold here
    // and none in CI. A global floor would be sunk by App.tsx and the
    // presentational components, and would then be ignored. Per-directory
    // floors are the shape to add once the numbers exist.
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      // Only the code a test could meaningfully cover: the entry point, the
      // type barrels and the test scaffolding itself are noise in the number.
      // A user `exclude` REPLACES Vitest's defaults, which is why the test
      // files and the fixtures have to be named here explicitly.
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.test.{ts,tsx}",
        "src/**/__fixtures__/**", // e.g. src/image/__fixtures__/metaBatching
        "src/test/**",
        "src/types/**",
        "src/main.tsx",
        "src/vite-env.d.ts",
      ],
    },
```

- [ ] **Step 3: the script.** In `package.json`'s `scripts`, add directly after `"test:watch"` (`:15`):

```json
    "test:coverage": "vitest run --coverage",
```

- [ ] **Step 4: `.gitignore`.** Append after the `# Node / Vite` block's `*.local` (`:18`):

```
# Coverage output (pnpm test:coverage) — generated, never committed.
coverage
```

- [ ] **Step 5: measure and report.** Run `pnpm test:coverage`. In the task report, record the **total** line/branch/function percentages and the per-directory figures for `src/utils`, `src/smart`, `src/image`, `src/app`, `src/components` — those five are what Phase 5 will set floors from. Note any file at 0 % that surprises you.
- [ ] **Step 6:** gate green (`pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm lint:css && pnpm test`), and confirm `git status` shows `coverage/` as ignored rather than untracked. One pathspec commit over all four files: `chore: v8 coverage plumbing, measured and not gated` — `git commit -m "chore: v8 coverage plumbing, measured and not gated" -- package.json pnpm-lock.yaml vite.config.ts .gitignore`

### Task 5: The keymap harness, and the five defects it pins

**Files:** Create `src/app/useCullKeymap.test.tsx`. Modify `src/app/useCullKeymap.ts`.

**Interfaces — Produces** (all local to the new test file; Task 6 consumes them verbatim):

```tsx
type KeymapProps = Parameters<typeof useCullKeymap>[0];
function props(over?: Partial<KeymapProps>): KeymapProps;
function renderKeymap(initial: KeymapProps): RenderHookResult<void, KeymapProps>;
function press(key: string, init?: KeyboardEventInit): KeyboardEvent;
function release(key: string, init?: KeyboardEventInit): KeyboardEvent;
function ref<T>(current: T): RefObject<T>;
```

**Consumes:** `useCullKeymap` (`src/app/useCullKeymap.ts`), `DEFAULT_SETTINGS` (`src/types/settings.ts:125`), `Img` / `Rating` / `Filter` / `NavSite` (`src/types`).

**Ruling (63 props, counted from the code).** The destructuring at `useCullKeymap.ts:22-84` has exactly 63 entries — 15 state/value, 3 refs, 45 callbacks/setters. Two of them (`pageStep`, `cycleChallenger`) arrived in Phase 3C, so the scout's count is current. The factory does not hand-maintain that list as a type: it is `Parameters<typeof useCullKeymap>[0]`, so a 64th prop is a compile error in this file on the day it lands.

**Ruling (`renderHook`, not a key→action table).** Per the spec. All five defects this task fixes live in *control flow* — which listener sees a key first, whether a modal returns before or after the scrub interrupt, whether `e.repeat` is consulted. A table extraction would refactor away the thing under test and still need a harness for the rest.

**Ruling (`afterEach(cleanup)` is mandatory and load-bearing).** Vitest runs without `globals: true` (`vite.config.ts` has no `globals` key), so `@testing-library/react`'s auto-cleanup never registers — it looks for a global `afterEach` and finds none. Without an explicit `afterEach(cleanup)` every `renderHook` leaves its `window` keydown/keyup listeners attached (`useCullKeymap.ts:850-859` registers once per mount and removes on unmount), so the second test's single `press()` runs through the first test's handler too and its spies fire. `src/app/useDecideCallbacks.test.tsx:142` already does this; copy it.

**Ruling (the chrome listener is out of scope and stays that way).** `Ctrl+,` and `Ctrl+O` live in a SEPARATE `window` keydown listener (`useCullKeymap.ts:160-208`), registered by the first effect, and neither listener calls `stopPropagation`. Moving the help swallow therefore cannot reach them: with the help sheet up, `Ctrl+,` still opens Settings. That is harmless — Settings is itself a modal that then owns the keyboard — and a test below pins it so a later reader knows it was considered rather than missed.

**Ruling (the five production edits ship as ONE coherent reordering).** Three of them change the order of `onKey`'s branches; splitting them across tasks would leave the file in an order no test describes. Task 5 makes every production edit in this file; Task 6 adds tests only.

#### The production edits, in the order the tests demand them

- **Fix A — `e.repeat` on the loupe's rating keys and the filter digits** (`handleSingleModeKey`). Compare already guards all four of its decide keys (`:288`, `:292`, `:297`, `:302`); the loupe's `Enter` / `Backspace` / `f` / `u` (`:399-414`) and the digits `1`–`5` (`:603-627`) do not, so a held `Enter` rates frame after frame at the OS repeat rate and a held `3` spins the keeps sub-mode cycle. The guard cannot break the FIRST press: `e.repeat` is false on the keydown that begins a physical press, by definition. Verified against `applyRating`'s body (`useDecideCallbacks.ts:81-198`): every branch is idempotent-per-press, and the rate-while-zoomed carry (`advanceTo`, `:141-160`) is driven by `isZoomingRef`, never by the key event — the macOS phantom-repeat quirk documented at `useCullKeymap.ts:728-732` is about the still-held **Space**, not the rating key. Cost if the ruling is wrong: nobody can hold a key to mass-rate, which was never a designed feature.
- **Fix B — the help swallow moves above the Ctrl handlers.** Today the order is `handleModalKeys` → Ctrl+Z/Y (`:652`, `:658`) → Ctrl+E (`:665`) → Ctrl+A (`:673`) → Ctrl+0 (`:682`) → Tab (`:692`) → the help swallow (`:700`), so with the sheet up `Ctrl+Z` undoes and `Ctrl+E` opens the act-on-cull dialog *underneath* it — contradicting the `:701` comment, "Any other key dismisses AND is swallowed". The **Tab** branch moves with it and stays above it: Tab must still open the sheet, and a held Tab must not dismiss the sheet it just opened.
- **Fix C — the scrub interrupt runs before every modal return.** `handleModalKeys` returns `true` for `settingsOpen` (`:223`) and `quitGuard` (`:232`) BEFORE the interrupt at `:245-250`, while `confirmHome` (`:262`) and `actionsOpen` (`:272`) return after it — so a held scrub keeps advancing behind two of the four overlays and not the other two. The bare-modifier no-op (`:238-239`) must stay ABOVE the interrupt or tapping Shift mid-scrub would abort the hold, which `:236-237` deliberately prevents.
- **Fix D — compare's `k` / `K` and `f` / `F` call `preventDefault`,** like `Enter` and `Backspace` beside them (`:294-303`).
- **Fix E — `Ctrl+Tab` does not open the help sheet.** Tab is handled above the Ctrl drop (`:722`), and its branch never checks the modifiers.

- [ ] **Step 1: the harness.** Create `src/app/useCullKeymap.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { cleanup, renderHook } from "@testing-library/react";
import type { Filter, Img, NavSite, Rating } from "../types";
import { DEFAULT_SETTINGS } from "../types/settings";
import { useCullKeymap } from "./useCullKeymap";

/**
 * The cull keymap, exercised as shipped: all three of its `window` listeners
 * (the phase-agnostic chrome effect, the big cull keymap behind `cullKeyRef`,
 * and the capture-phase Escape swallow) under `renderHook`, with a typed
 * props factory derived from the hook's OWN props type.
 *
 * Three mechanics that make such tests lie if you get them wrong:
 *  1. A KeyboardEvent must be `cancelable: true`, or `preventDefault()` is a
 *     silent no-op and EVERY `defaultPrevented` assertion passes vacuously.
 *  2. Escape's `defaultPrevented` is ALWAYS true — a capture-phase listener
 *     (useCullKeymap.ts:839-845) preventDefaults it in every phase — so it
 *     proves nothing except in the one test that pins that listener.
 *  3. `afterEach(cleanup)` is load-bearing. Vitest runs without `globals`,
 *     so RTL's auto-cleanup never registers; an un-unmounted hook leaves its
 *     window listeners attached and the NEXT test's keypress fires this
 *     test's spies too.
 */

/** The hook's real props object — a 64th prop, or a rename, breaks this file
 *  at compile time instead of leaving it testing yesterday's shape. */
type KeymapProps = Parameters<typeof useCullKeymap>[0];

/** A `Dispatch<SetStateAction<T>>` spy. Typed explicitly because test files
 *  are linted type-aware and a bare `vi.fn()` is an implicit any here. */
function setter<T>(): Dispatch<SetStateAction<T>> {
  return vi.fn((_v: SetStateAction<T>) => {});
}

/** A ref stand-in: the hook only ever reads `.current`. */
function ref<T>(current: T): RefObject<T> {
  return { current };
}

const IMAGES: Img[] = [0, 1, 2].map((id) => ({
  id,
  path: `/s/${id}.cr3`,
  filename: `${id}.cr3`,
  srcFolder: "/s",
}));

function props(over: Partial<KeymapProps> = {}): KeymapProps {
  return {
    phase: "culling",
    images: IMAGES,
    settings: DEFAULT_SETTINGS,
    settingsOpen: false,
    setSettingsOpen: setter<boolean>(),
    pickFolder: vi.fn(() => Promise.resolve()),
    beginCulling: vi.fn(() => Promise.resolve()),
    resetSession: vi.fn(() => {}),
    quitGuard: false,
    setQuitGuard: setter<boolean>(),
    confirmHome: false,
    setConfirmHome: setter<boolean>(),
    leaveToHome: vi.fn(() => {}),
    actionsOpen: false,
    setActionsOpen: setter<boolean>(),
    openActions: vi.fn(() => {}),
    helpVisible: false,
    setHelpVisible: setter<boolean>(),
    setHelpIntro: setter<boolean>(),
    undo: vi.fn(() => {}),
    redo: vi.fn(() => {}),
    gridVisible: false,
    gridCols: 6,
    stepGridSizeBy: vi.fn((_dir: 1 | -1) => {}),
    resetGridSize: vi.fn(() => {}),
    advance: vi.fn((_dir: 1 | -1, _step?: number) => true),
    pageStep: vi.fn(() => 24),
    selectAllInGrid: vi.fn(() => {}),
    growGridSelection: vi.fn((_deltaCells: number) => {}),
    clearMultiSelection: vi.fn(() => {}),
    hasGridSelection: false,
    heldDirRef: ref<0 | 1 | -1>(0),
    startHold: vi.fn((_dir: 1 | -1) => {}),
    stopHold: vi.fn(() => {}),
    heldGridVertDirRef: ref<0 | 1 | -1>(0),
    startGridVertHold: vi.fn((_dir: 1 | -1) => {}),
    stopGridVertHold: vi.fn(() => {}),
    isZooming: false,
    isZoomingRef: ref(false),
    setIsZooming: setter<boolean>(),
    setZoomLevel: setter<1 | 2>(),
    setPanOffset: setter<{ x: number; y: number }>(),
    mouseZooming: false,
    resetZoom: vi.fn(() => {}),
    pan: vi.fn((_dx: number, _dy: number) => {}),
    compareMode: false,
    championIndex: 0,
    goToSite: vi.fn((_target: NavSite) => {}),
    goBack: vi.fn((_landIndex?: number) => {}),
    cycleChallenger: vi.fn((_dir: 1 | -1, _step?: number) => true),
    challengerWins: vi.fn(() => {}),
    challengerLoses: vi.fn(() => {}),
    challengerKeptBoth: vi.fn((_asFavorite: boolean) => {}),
    applyRating: vi.fn((_rating: Rating) => {}),
    unrateCurrent: vi.fn(() => {}),
    setFilter: setter<Filter>(),
    chipsTooltip: { pulse: vi.fn(() => {}) },
    startAnalysis: vi.fn(() => {}),
    setExifVisible: setter<boolean>(),
    setClippingVisible: setter<boolean>(),
    setPeakingVisible: setter<boolean>(),
    setThumbsVisible: setter<boolean>(),
    setCompositionVisible: setter<boolean>(),
    ...over,
  };
}

/** `rerender(next)` flips a state prop mid-test the way App's re-render does. */
function renderKeymap(initial: KeymapProps) {
  return renderHook(
    (p: KeymapProps) => {
      useCullKeymap(p);
    },
    { initialProps: initial },
  );
}

/** Dispatch a keydown on `window` — where all three listeners live — and hand
 *  back the event so a test can read `defaultPrevented`. */
function press(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  window.dispatchEvent(e);
  return e;
}

function release(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true, ...init });
  window.dispatchEvent(e);
  return e;
}

afterEach(cleanup);
```

  Add one scaffolding self-test, so a broken harness fails loudly rather than making every later assertion vacuous:

```tsx
describe("the harness itself", () => {
  it("dispatches cancelable events, so defaultPrevented means something", () => {
    renderKeymap(props());
    // Tab preventDefaults unconditionally (useCullKeymap.ts:693).
    expect(press("Tab").defaultPrevented).toBe(true);
    // Ctrl+S deliberately does NOT (the Ctrl drop at :722 returns without
    // preventDefault) — so a `true` here would mean the events are not
    // cancelable, and both being `false` would mean nothing is listening.
    expect(press("s", { ctrlKey: true }).defaultPrevented).toBe(false);
  });

  it("unmounts between tests, so one keypress reaches exactly one hook", () => {
    const first = props();
    const { unmount } = renderKeymap(first);
    unmount();
    const second = props();
    renderKeymap(second);
    press("Enter");
    expect(first.applyRating).not.toHaveBeenCalled();
    expect(second.applyRating).toHaveBeenCalledTimes(1);
  });
});
```

  Run it. Both must pass before anything else is written — if the second fails, `afterEach(cleanup)` is not doing its job and every later test is unreliable.

- [ ] **Step 2: the modal gates.** Append:

```tsx
describe("modal gates", () => {
  it("the settings modal owns the keyboard: Escape closes it, nothing else acts", () => {
    const p = props({ settingsOpen: true });
    renderKeymap(p);
    press("Enter");
    press("f");
    expect(p.applyRating).not.toHaveBeenCalled();
    press("Escape");
    expect(p.setSettingsOpen).toHaveBeenCalledWith(false);
  });

  it("the quit guard owns the keyboard: Escape dismisses it, nothing else acts", () => {
    const p = props({ quitGuard: true });
    renderKeymap(p);
    press("Backspace");
    expect(p.applyRating).not.toHaveBeenCalled();
    press("Escape");
    expect(p.setQuitGuard).toHaveBeenCalledWith(false);
  });

  it("the leave confirm takes Enter to leave and Escape to stay", () => {
    const p = props({ confirmHome: true });
    renderKeymap(p);
    press("Enter");
    expect(p.leaveToHome).toHaveBeenCalledTimes(1);
    expect(p.applyRating).not.toHaveBeenCalled();
    press("Escape");
    expect(p.setConfirmHome).toHaveBeenCalledWith(false);
  });

  it("the act-on-cull dialog swallows everything but Escape", () => {
    const p = props({ actionsOpen: true });
    renderKeymap(p);
    press("f");
    expect(p.applyRating).not.toHaveBeenCalled();
    press("Escape");
    expect(p.setActionsOpen).toHaveBeenCalledWith(false);
  });

  it("Enter on the staged screen begins the cull — but not with nothing staged", () => {
    const withImages = props({ phase: "staged" });
    const { unmount } = renderKeymap(withImages);
    expect(press("Enter").defaultPrevented).toBe(true);
    expect(withImages.beginCulling).toHaveBeenCalledTimes(1);
    unmount();

    const empty = props({ phase: "staged", images: [] });
    renderKeymap(empty);
    press("Enter");
    expect(empty.beginCulling).not.toHaveBeenCalled();
  });

  it("Escape on the staged screen discards the staged set", () => {
    const p = props({ phase: "staged" });
    renderKeymap(p);
    press("Escape");
    expect(p.resetSession).toHaveBeenCalledTimes(1);
  });

  // The table the spec asks for: no overlay may ever let a rating through, in
  // either mode. Five overlays x three rating keys = fifteen cases.
  const OVERLAYS = ["settingsOpen", "quitGuard", "confirmHome", "actionsOpen", "helpVisible"] as const;
  for (const overlay of OVERLAYS) {
    for (const key of ["Enter", "Backspace", "f"]) {
      it(`${key} never rates behind ${overlay}`, () => {
        const single = props({ [overlay]: true });
        const { unmount } = renderKeymap(single);
        press(key);
        expect(single.applyRating).not.toHaveBeenCalled();
        expect(single.unrateCurrent).not.toHaveBeenCalled();
        unmount();

        const compare = props({ [overlay]: true, compareMode: true });
        renderKeymap(compare);
        press(key);
        expect(compare.challengerWins).not.toHaveBeenCalled();
        expect(compare.challengerLoses).not.toHaveBeenCalled();
        expect(compare.challengerKeptBoth).not.toHaveBeenCalled();
      });
    }
  }
});
```

  All of these pass today — they are the safety net the reordering in Steps 5 and 6 must not break. Run them before touching production and say so in the report.

- [ ] **Step 3: help, Ctrl, ratings and Escape (also all green today).** Append:

```tsx
describe("the help sheet", () => {
  it("Tab opens it, swallows the key, and clears the intro flag", () => {
    const p = props();
    renderKeymap(p);
    expect(press("Tab").defaultPrevented).toBe(true);
    expect(p.setHelpVisible).toHaveBeenCalledWith(true);
    expect(p.setHelpIntro).toHaveBeenCalledWith(false);
  });

  it("a held Tab opens it once, not once per OS repeat", () => {
    const p = props();
    renderKeymap(p);
    press("Tab");
    press("Tab", { repeat: true });
    press("Tab", { repeat: true });
    expect(p.setHelpVisible).toHaveBeenCalledTimes(1);
  });

  it("any other key dismisses it AND is swallowed", () => {
    const p = props({ helpVisible: true });
    renderKeymap(p);
    const e = press("Enter");
    expect(e.defaultPrevented).toBe(true);
    expect(p.setHelpVisible).toHaveBeenCalledWith(false);
    expect(p.applyRating).not.toHaveBeenCalled();
  });

  it("releasing Tab hides it", () => {
    const p = props({ helpVisible: true });
    renderKeymap(p);
    expect(release("Tab").defaultPrevented).toBe(true);
    expect(p.setHelpVisible).toHaveBeenCalledWith(false);
  });
});

describe("Ctrl combinations", () => {
  it("Ctrl+Z undoes, Ctrl+Shift+Z and Ctrl+Y redo", () => {
    const p = props();
    renderKeymap(p);
    press("z", { ctrlKey: true });
    expect(p.undo).toHaveBeenCalledTimes(1);
    press("z", { ctrlKey: true, shiftKey: true });
    press("y", { ctrlKey: true });
    expect(p.redo).toHaveBeenCalledTimes(2);
  });

  it("Ctrl+E opens the act-on-cull dialog", () => {
    const p = props();
    renderKeymap(p);
    press("e", { ctrlKey: true });
    expect(p.openActions).toHaveBeenCalledTimes(1);
  });

  it("Ctrl+A selects the grid, and is swallowed everywhere so the webview never does", () => {
    const grid = props({ gridVisible: true });
    const { unmount } = renderKeymap(grid);
    expect(press("a", { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(grid.selectAllInGrid).toHaveBeenCalledTimes(1);
    unmount();

    const loupe = props();
    renderKeymap(loupe);
    expect(press("a", { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(loupe.selectAllInGrid).not.toHaveBeenCalled();
  });

  it("Ctrl+0 resets the grid size, from the number row and the numpad", () => {
    const p = props({ gridVisible: true });
    renderKeymap(p);
    press("0", { ctrlKey: true });
    press("Unidentified", { ctrlKey: true, code: "Numpad0" });
    expect(p.resetGridSize).toHaveBeenCalledTimes(2);
  });

  it("an unbound Ctrl or Alt combo does nothing AND is left to the platform", () => {
    const p = props();
    renderKeymap(p);
    // :718-721 deliberately does not preventDefault here, so Ctrl+Home and
    // friends still reach whatever the platform does with them.
    expect(press("s", { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(press("f", { altKey: true }).defaultPrevented).toBe(false);
    expect(p.applyRating).not.toHaveBeenCalled();
  });
});

describe("ratings", () => {
  it("the loupe rates keep / reject / favorite and unrates", () => {
    const p = props();
    renderKeymap(p);
    expect(press("Enter").defaultPrevented).toBe(true);
    expect(press("Backspace").defaultPrevented).toBe(true);
    press("F");
    press("u");
    expect(p.applyRating).toHaveBeenNthCalledWith(1, "keep");
    expect(p.applyRating).toHaveBeenNthCalledWith(2, "reject");
    expect(p.applyRating).toHaveBeenNthCalledWith(3, "favorite");
    expect(p.unrateCurrent).toHaveBeenCalledTimes(1);
  });

  it("compare decides: Enter wins, Backspace loses, k keeps both, f stars the challenger", () => {
    const p = props({ compareMode: true });
    renderKeymap(p);
    press("Enter");
    press("Backspace");
    press("K");
    press("f");
    expect(p.challengerWins).toHaveBeenCalledTimes(1);
    expect(p.challengerLoses).toHaveBeenCalledTimes(1);
    expect(p.challengerKeptBoth).toHaveBeenNthCalledWith(1, false);
    expect(p.challengerKeptBoth).toHaveBeenNthCalledWith(2, true);
    expect(p.applyRating).not.toHaveBeenCalled();
  });
});

describe("Escape", () => {
  it("clears a grid selection first, and only then offers to leave", () => {
    const selected = props({ gridVisible: true, hasGridSelection: true });
    const { unmount } = renderKeymap(selected);
    press("Escape");
    expect(selected.clearMultiSelection).toHaveBeenCalledTimes(1);
    expect(selected.setConfirmHome).not.toHaveBeenCalled();
    unmount();

    const empty = props({ gridVisible: true });
    renderKeymap(empty);
    press("Escape");
    expect(empty.setConfirmHome).toHaveBeenCalledWith(true);
  });

  it("from the loupe it opens the leave confirm rather than stepping back a site", () => {
    const p = props();
    renderKeymap(p);
    press("Escape");
    expect(p.setConfirmHome).toHaveBeenCalledWith(true);
    expect(p.goBack).not.toHaveBeenCalled();
  });

  it("is swallowed in EVERY phase, home included — the macOS fullscreen listener", () => {
    // The one test allowed to assert Escape's defaultPrevented: it is pinning
    // the capture-phase listener at :839-845 that makes it always true.
    const p = props({ phase: "start" });
    renderKeymap(p);
    expect(press("Escape").defaultPrevented).toBe(true);
    expect(p.setConfirmHome).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 4: Fix A, test first.** Append the failing tests:

```tsx
describe("a held key acts once (fix A)", () => {
  it("a held rating key in the loupe rates once, not at the OS repeat rate", () => {
    const p = props();
    renderKeymap(p);
    press("Enter");
    press("Enter", { repeat: true });
    press("Enter", { repeat: true });
    expect(p.applyRating).toHaveBeenCalledTimes(1);
    expect(p.applyRating).toHaveBeenCalledWith("keep");
  });

  it("the same for Backspace, f and u", () => {
    const p = props();
    renderKeymap(p);
    for (const key of ["Backspace", "f", "u"]) {
      press(key);
      press(key, { repeat: true });
    }
    expect(p.applyRating).toHaveBeenCalledTimes(2); // reject, favorite
    expect(p.unrateCurrent).toHaveBeenCalledTimes(1);
  });

  it("a held filter digit cycles its sub-modes once per press", () => {
    const p = props();
    renderKeymap(p);
    press("3");
    press("3", { repeat: true });
    press("3", { repeat: true });
    expect(p.setFilter).toHaveBeenCalledTimes(1);
    expect(p.chipsTooltip.pulse).toHaveBeenCalledTimes(1);
  });

  it("compare's decide keys already guarded it — the two modes now agree", () => {
    const p = props({ compareMode: true });
    renderKeymap(p);
    press("Enter");
    press("Enter", { repeat: true });
    expect(p.challengerWins).toHaveBeenCalledTimes(1);
  });
});
```

  Run: the first three fail (3 calls / 4 + 2 calls / 3 calls), the fourth passes. Then edit `src/app/useCullKeymap.ts`. In `handleSingleModeKey`, replace the rating block (`:394-414`) with:

```ts
        // Rating works WHILE ZOOMED: the advance carries the zoom to the next
        // frame at its own AF anchor (see applyRating's advanceTo). The old
        // block existed to fight the held Space key re-arming zoom — the carry
        // design goes WITH the held key instead, and the arm guard on Space
        // makes the OS's resumed-repeat keydown a no-op.
        //
        // `e.repeat` is dropped on all four (break, not return, so the
        // preventDefaults still run): a held Enter used to rate frame after
        // frame at the OS repeat rate, which was never a designed feature —
        // compare has guarded its own four decide keys since it was written,
        // and the asymmetry was the accident. The FIRST press is unaffected by
        // definition: `repeat` is false on the keydown that begins a press.
        case "Enter":
          e.preventDefault();
          if (e.repeat) break;
          applyRating("keep");
          break;
        case "Backspace":
          e.preventDefault();
          if (e.repeat) break;
          applyRating("reject");
          break;
        case "f":
        case "F":
          if (e.repeat) break;
          applyRating("favorite");
          break;
        case "u":
        case "U":
          if (e.repeat) break;
          unrateCurrent(); // clear rating, stay on frame (zoom unaffected)
          break;
```

  and add `if (e.repeat) break;` as the first statement of each of the five digit cases (`:603-627`), with the reason on the first one:

```ts
        case "1":
          // Same one-per-press rule as the rating keys above: a held digit
          // used to spin its sub-mode cycle at the OS repeat rate.
          if (e.repeat) break;
          setFilter((f) => cycleFilter(f, "all"));
          break;
```

  Re-run: all four green.

- [ ] **Step 5: Fix B and Fix E, test first.** Append:

```tsx
describe("nothing acts behind the help sheet (fix B)", () => {
  it("Ctrl+Z does not undo under the sheet", () => {
    const p = props({ helpVisible: true });
    renderKeymap(p);
    const e = press("z", { ctrlKey: true });
    expect(p.undo).not.toHaveBeenCalled();
    expect(p.setHelpVisible).toHaveBeenCalledWith(false);
    expect(e.defaultPrevented).toBe(true);
  });

  it("Ctrl+E does not open the finish dialog under the sheet", () => {
    const p = props({ helpVisible: true });
    renderKeymap(p);
    press("e", { ctrlKey: true });
    expect(p.openActions).not.toHaveBeenCalled();
    expect(p.setHelpVisible).toHaveBeenCalledWith(false);
  });

  it("Ctrl+A and Ctrl+0 are dismissals too, not grid commands", () => {
    const p = props({ helpVisible: true, gridVisible: true });
    renderKeymap(p);
    press("a", { ctrlKey: true });
    press("0", { ctrlKey: true });
    expect(p.selectAllInGrid).not.toHaveBeenCalled();
    expect(p.resetGridSize).not.toHaveBeenCalled();
  });

  it("a held Tab does not dismiss the sheet it is holding open", () => {
    // The regression guard for the move: Tab must stay ABOVE the swallow.
    const p = props({ helpVisible: true });
    renderKeymap(p);
    press("Tab", { repeat: true });
    expect(p.setHelpVisible).not.toHaveBeenCalledWith(false);
  });

  it("Ctrl+, still opens Settings — that is a different listener, by design", () => {
    // The chrome effect (useCullKeymap.ts:160-208) is its own window listener
    // and neither handler stops propagation, so the help swallow cannot reach
    // it. Settings is itself a modal that then owns the keyboard, so this is
    // harmless — pinned so it reads as considered rather than missed.
    const p = props({ helpVisible: true });
    renderKeymap(p);
    press(",", { ctrlKey: true, code: "Comma" });
    expect(p.setSettingsOpen).toHaveBeenCalledWith(true);
  });

  it("Ctrl+Tab does not open the help sheet (fix E)", () => {
    const p = props();
    renderKeymap(p);
    const e = press("Tab", { ctrlKey: true });
    expect(p.setHelpVisible).not.toHaveBeenCalled();
    // Falls through to the Ctrl drop, which deliberately does not swallow.
    expect(e.defaultPrevented).toBe(false);
  });
});
```

  Run: the first three and the last fail; the two regression guards pass. Note which assertion inside each failure is the discriminating one — in the Ctrl+Z test, `expect(p.undo).not.toHaveBeenCalled()` is what goes red, while `expect(e.defaultPrevented).toBe(true)` passes **before** the fix too (the Ctrl+Z branch at `:652-653` already preventDefaults). Do not read that as a half-red test: the `undo` and `setHelpVisible` assertions beside it are the proof. Then edit `onKey` (`useCullKeymap.ts:647-756`). **Move the Tab block and the help-swallow block** (`:691-710`) so they sit immediately after `if (handleModalKeys(e)) return;` (`:648`), before the Ctrl+Z check, and guard Tab against the modifiers:

```ts
    const onKey = (e: KeyboardEvent) => {
      if (handleModalKeys(e)) return;

      // Tab (hold) → keyboard help. Available in both single and compare.
      // ABOVE the help swallow below, so a held Tab cannot dismiss the sheet
      // it is holding open. NOT for Ctrl/Meta/Alt+Tab: those belong to the
      // window manager, and Tab sits above the Ctrl drop further down, so
      // without this guard Ctrl+Tab opened the sheet. Shift+Tab still does,
      // like every other Shift+key (see the Ctrl drop's comment).
      if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        if (!e.repeat) {
          setHelpVisible(true);
          setHelpIntro(false);
        }
        return;
      }
      if (helpVisible) {
        // Any other key dismisses AND is swallowed — one press closes the
        // auto-shown intro without also rating a frame. (During a held-Tab
        // showing this just closes early; Tab-release would have anyway.)
        // preventDefault too: the dismissing key must not fall through to a
        // platform default (ESC exiting macOS fullscreen was the live bug).
        //
        // ABOVE the Ctrl combos below, not beneath them: with the sheet up,
        // Ctrl+Z used to undo and Ctrl+E used to open the act-on-cull dialog
        // UNDERNEATH it, which this comment already claimed could not happen.
        // (Ctrl+, and Ctrl+O are a different listener — :160-208 — and still
        // work; Settings is a modal that then owns the keyboard anyway.)
        e.preventDefault();
        setHelpVisible(false);
        setHelpIntro(false);
        return;
      }

      // Undo / redo, works in both single and compare. …
```

  …with the original `if (e.key === "Tab") { … }` and `if (helpVisible) { … }` blocks deleted from their old position at `:691-710`. Re-run the whole file: everything green, including Step 3's four help tests and Step 2's fifteen-case table (`helpVisible` is one of its five overlays).

- [ ] **Step 6: Fix C and Fix D, test first.** Append:

```tsx
describe("a held scrub is interrupted behind every overlay (fix C)", () => {
  for (const overlay of ["settingsOpen", "quitGuard", "confirmHome", "actionsOpen"] as const) {
    it(`a non-arrow key stops the horizontal scrub behind ${overlay}`, () => {
      const p = props({ [overlay]: true, heldDirRef: ref<0 | 1 | -1>(1) });
      renderKeymap(p);
      press("f");
      expect(p.stopHold).toHaveBeenCalledTimes(1);
    });

    it(`a non-arrow key stops the grid row-jump behind ${overlay}`, () => {
      const p = props({
        [overlay]: true,
        gridVisible: true,
        heldGridVertDirRef: ref<0 | 1 | -1>(1),
      });
      renderKeymap(p);
      press("Escape");
      expect(p.stopGridVertHold).toHaveBeenCalledTimes(1);
    });
  }

  it("a bare modifier still never interrupts a hold", () => {
    // The regression guard for the reorder: :236-237 exists so tapping Shift
    // mid-scrub does not abort the flow.
    const p = props({ heldDirRef: ref<0 | 1 | -1>(1) });
    renderKeymap(p);
    press("Shift");
    press("Control");
    press("Alt");
    press("Meta");
    expect(p.stopHold).not.toHaveBeenCalled();
  });

  it("the held arrow itself still sustains the scrub", () => {
    const p = props({ heldDirRef: ref<0 | 1 | -1>(1) });
    renderKeymap(p);
    press("ArrowRight");
    expect(p.stopHold).not.toHaveBeenCalled();
  });
});

describe("compare swallows its decide keys (fix D)", () => {
  it("k and f preventDefault like Enter and Backspace beside them", () => {
    const p = props({ compareMode: true });
    renderKeymap(p);
    expect(press("k").defaultPrevented).toBe(true);
    expect(press("F").defaultPrevented).toBe(true);
  });
});
```

  Run: the `settingsOpen` and `quitGuard` cases fail (4 of the 8), the `confirmHome` / `actionsOpen` cases and both regression guards pass, and fix D's test fails. Then edit `handleModalKeys` (`:219-276`): hoist the bare-modifier no-op and the scrub interrupt above the `settingsOpen` check, so the block reads, in order:

```ts
    const handleModalKeys = (e: KeyboardEvent): boolean => {
      // Bare modifier presses (Ctrl/Shift/Alt/Meta alone) carry no cull action —
      // make them a no-op so e.g. tapping Shift mid-scrub doesn't abort the hold.
      // FIRST, so it stays above the interrupt below.
      if (e.key === "Control" || e.key === "Shift" || e.key === "Alt" || e.key === "Meta")
        return true;

      // A held scrub is sustained ONLY by its own arrow key. Any OTHER key (zoom,
      // rating, help, esc, compare, digits…) interrupts it, so nothing keeps
      // scrubbing behind a modal. The opposite arrow is handled in the arrow cases
      // below — it's ignored entirely (can't redirect or stop the flow).
      //
      // ABOVE every modal return below, which is the point: settingsOpen and
      // quitGuard used to return BEFORE this ran, so a held scrub kept
      // advancing currentIndex behind those two overlays and not behind the
      // other two. All four are the same rule now.
      const isNavArrow = e.key === "ArrowLeft" || e.key === "ArrowRight";
      if (heldDirRef.current !== 0 && !isNavArrow) stopHold();
      // Same rule for the grid's vertical hold — sustained only by its own
      // arrow, interrupted by anything else (rating, esc, mode switch…).
      const isVertNavArrow = e.key === "ArrowUp" || e.key === "ArrowDown";
      if (heldGridVertDirRef.current !== 0 && !isVertNavArrow) stopGridVertHold();

      // Chrome shortcuts (settings, open folder, begin culling) are handled by
      // the phase-agnostic effect above. While the settings modal is open,
      // swallow all cull keys here so nothing slips through behind it.
      if (settingsOpen) return true;
      if (quitGuard) { … body and comment unchanged … }
      if (phase !== "culling") return true; // chrome screens are button-driven
      if (confirmHome) { … body and comment unchanged … }
      if (actionsOpen) { … body and comment unchanged … }
      return false;
    };
```

  (The two hoisted blocks are deleted from their old position at `:236-250`; the `quitGuard`, `confirmHome` and `actionsOpen` blocks keep their bodies and comments verbatim.) Then, for fix D, add `e.preventDefault();` as the first statement of compare's `k`/`K` and `f`/`F` cases (`:294-303`), above the existing `if (!e.repeat)` line, matching `Enter` and `Backspace` above them.

- [ ] **Step 7: re-read the whole dispatch path once more and record the confirmation in the task report.** After all five edits, confirm by reading `onKey` and `handleModalKeys` end to end:
  1. the order is now `handleModalKeys` → Tab → help swallow → Ctrl+Z/Y → Ctrl+E → Ctrl+A → Ctrl+0 → the Ctrl/Meta/Alt drop → Space → Escape → `handleCompareKey` / `handleSingleModeKey`;
  2. `onKeyUp` (`:757-783`) was NOT touched, so Tab's release still hides the sheet and the `e.code` fallback that fixed the forever-scrub is intact;
  3. `phase !== "culling"` still returns `true` before any mode handler, so the staged and home screens stay button-driven;
  4. nothing in the moved blocks reads a value computed later — the Tab and help blocks read only `e` and the three help props; the hoisted interrupt reads only `e`, the two refs and the two stop callbacks, none of which is assigned inside `handleModalKeys`;
  5. the dependency array (`:789-831`) needs no change: every identifier the moved code reads was already a dep (`helpVisible`, `stopHold`, `stopGridVertHold`), and `setHelpVisible` / `setHelpIntro` are `Dispatch`es the array deliberately omits along with the others.
- [ ] **Step 8:** gate green. Report the new Vitest totals (801 tests in 80 files before). Two pathspec commits, one per file: `git commit -m "fix(keys): one action per press, nothing behind the help sheet, one scrub rule" -- src/app/useCullKeymap.ts`; then `git commit -m "test(keys): a renderHook harness for the cull keymap" -- src/app/useCullKeymap.test.tsx`

### Task 6: The keymap harness, part 2 — navigation, filters, holds and zoom

**Files:** Modify `src/app/useCullKeymap.test.tsx`. **This task makes NO production change.** If a test here fails against the shipped behaviour, STOP and report it — do not edit `useCullKeymap.ts`, which Task 5 owns.

**Interfaces — Consumes:** `props` / `renderKeymap` / `press` / `release` / `ref` / `IMAGES` from Task 5, plus `cycleFilter` from `../utils/filterModes` (a new import this task adds).

**Ruling (the filter tests assert THROUGH `cycleFilter`, never against a literal).** `setFilter` is called with an UPDATER (`(f) => cycleFilter(f, "all")`), so the test captures the updater, applies it to a known `Filter`, and compares the result with `cycleFilter(known, top)`. That is what makes a `Filter`-union rename or a `CYCLES` reorder (`utils/filterModes.ts:13-19`) break this test; a hard-coded `"keepsFavs"` would not.

**Ruling (`vi.mocked(...).mock.invocationCallOrder` for every ordering claim).** Three assertions in this task are about ORDER, not about calls — clear-then-advance, stop-then-rate, stop-then-grow. A test that only asserted both were called would pass on the reversed code.

- [ ] **Step 1: page keys.** Add `import { cycleFilter } from "../utils/filterModes";` to the file's imports, then append:

```tsx
describe("page keys", () => {
  it("Home and End cross the whole filter; PgUp and PgDn move one screenful", () => {
    const p = props();
    renderKeymap(p);
    press("End");
    press("Home");
    press("PageDown");
    press("PageUp");
    expect(p.advance).toHaveBeenNthCalledWith(1, 1, IMAGES.length);
    expect(p.advance).toHaveBeenNthCalledWith(2, -1, IMAGES.length);
    expect(p.advance).toHaveBeenNthCalledWith(3, 1, 24); // props().pageStep() === 24
    expect(p.advance).toHaveBeenNthCalledWith(4, -1, 24);
  });

  it("all four are swallowed — an unhandled PageDown would scroll the grid", () => {
    renderKeymap(props({ gridVisible: true }));
    for (const key of ["Home", "End", "PageUp", "PageDown"]) {
      expect(press(key).defaultPrevented).toBe(true);
    }
  });

  it("they act once per press and rest while zoomed", () => {
    const held = props();
    const { unmount } = renderKeymap(held);
    press("End");
    press("End", { repeat: true });
    expect(held.advance).toHaveBeenCalledTimes(1);
    unmount();

    const zoomed = props({ isZooming: true });
    renderKeymap(zoomed);
    press("PageDown");
    press("End");
    expect(zoomed.advance).not.toHaveBeenCalled();
  });

  it("in the grid a plain page key clears the selection BEFORE it moves", () => {
    const p = props({ gridVisible: true });
    renderKeymap(p);
    press("End");
    expect(p.clearMultiSelection).toHaveBeenCalledTimes(1);
    expect(vi.mocked(p.clearMultiSelection).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(p.advance).mock.invocationCallOrder[0],
    );
  });

  it("in the grid Shift extends the selection instead of moving the cursor", () => {
    const p = props({ gridVisible: true });
    renderKeymap(p);
    press("End", { shiftKey: true });
    press("PageDown", { shiftKey: true });
    expect(p.growGridSelection).toHaveBeenNthCalledWith(1, IMAGES.length);
    expect(p.growGridSelection).toHaveBeenNthCalledWith(2, 24);
    expect(p.advance).not.toHaveBeenCalled();
    expect(p.clearMultiSelection).not.toHaveBeenCalled();
  });

  it("compare gets the page keys only — Home and End are swallowed there, not bound", () => {
    const p = props({ compareMode: true });
    renderKeymap(p);
    expect(press("Home").defaultPrevented).toBe(true);
    expect(press("End").defaultPrevented).toBe(true);
    expect(p.cycleChallenger).not.toHaveBeenCalled();
    press("PageDown");
    expect(p.cycleChallenger).toHaveBeenCalledWith(1, 24);
  });

  it("compare's page keys also act once per press and rest while zoomed", () => {
    const held = props({ compareMode: true });
    const { unmount } = renderKeymap(held);
    press("PageDown");
    press("PageDown", { repeat: true });
    expect(held.cycleChallenger).toHaveBeenCalledTimes(1);
    unmount();

    const zoomed = props({ compareMode: true, isZooming: true });
    renderKeymap(zoomed);
    press("PageDown");
    expect(zoomed.cycleChallenger).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: grid size.** Append:

```tsx
describe("grid size", () => {
  it("+ / = grow and − shrinks, grid only", () => {
    const p = props({ gridVisible: true });
    renderKeymap(p);
    press("+");
    press("=");
    press("-");
    expect(p.stepGridSizeBy).toHaveBeenNthCalledWith(1, 1);
    expect(p.stepGridSizeBy).toHaveBeenNthCalledWith(2, 1);
    expect(p.stepGridSizeBy).toHaveBeenNthCalledWith(3, -1);
  });

  it("a held + steps once, but is still swallowed", () => {
    const p = props({ gridVisible: true });
    renderKeymap(p);
    press("+");
    expect(press("+", { repeat: true }).defaultPrevented).toBe(true);
    expect(p.stepGridSizeBy).toHaveBeenCalledTimes(1);
  });

  it("outside the grid it is neither bound nor swallowed", () => {
    const p = props();
    renderKeymap(p);
    expect(press("+").defaultPrevented).toBe(false);
    expect(p.stepGridSizeBy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: filters.** Append:

```tsx
describe("filter digits", () => {
  /** `setFilter` takes an UPDATER, so read it back and apply it. */
  function applyUpdater(setFilter: KeymapProps["setFilter"], from: Filter): Filter {
    const calls = vi.mocked(setFilter).mock.calls;
    expect(calls).toHaveLength(1);
    const updater = calls[0][0];
    if (typeof updater !== "function") throw new Error("setFilter was called with a value");
    return updater(from);
  }

  // Asserted THROUGH cycleFilter, so renaming a Filter value or reordering a
  // CYCLES entry (utils/filterModes.ts:13-19) breaks this test. A hard-coded
  // "keepsFavs" would sail straight past both.
  const CASES: [string, Parameters<typeof cycleFilter>[1]][] = [
    ["1", "all"],
    ["2", "unrated"],
    ["3", "keeps"],
    ["4", "suggested"],
    ["5", "rejects"],
  ];
  for (const [key, top] of CASES) {
    it(`${key} selects the ${top} tab, and re-pressing it cycles the sub-modes`, () => {
      const p = props();
      renderKeymap(p);
      press(key);
      expect(applyUpdater(p.setFilter, "all")).toBe(cycleFilter("all", top));
      expect(applyUpdater(p.setFilter, "keepsFavs")).toBe(cycleFilter("keepsFavs", top));
    });
  }

  it("only the two tabs with sub-modes pulse the chip tooltip", () => {
    for (const key of ["1", "2", "5"]) {
      const p = props();
      const { unmount } = renderKeymap(p);
      press(key);
      expect(p.chipsTooltip.pulse).not.toHaveBeenCalled();
      unmount();
    }
    for (const key of ["3", "4"]) {
      const p = props();
      const { unmount } = renderKeymap(p);
      press(key);
      expect(p.chipsTooltip.pulse).toHaveBeenCalledTimes(1);
      unmount();
    }
  });

  it("4 kicks off analysis only when smart culling is on", () => {
    const on = props();
    const { unmount } = renderKeymap(on);
    press("4");
    expect(on.startAnalysis).toHaveBeenCalledTimes(1);
    unmount();

    const off = props({ settings: { ...DEFAULT_SETTINGS, smartCulling: false } });
    renderKeymap(off);
    press("4");
    expect(off.startAnalysis).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 4: holds and keyup.** Append:

```tsx
describe("holds", () => {
  it("an arrow starts a scrub; its OS repeat does not restart it", () => {
    const p = props();
    renderKeymap(p);
    press("ArrowRight");
    press("ArrowRight", { repeat: true });
    expect(p.startHold).toHaveBeenCalledTimes(1);
    expect(p.startHold).toHaveBeenCalledWith(1);
  });

  it("the OPPOSITE arrow mid-scrub is ignored entirely", () => {
    const p = props({ heldDirRef: ref<0 | 1 | -1>(1) });
    renderKeymap(p);
    press("ArrowLeft");
    expect(p.startHold).not.toHaveBeenCalled();
    expect(p.stopHold).not.toHaveBeenCalled();
  });

  it("a rating key mid-scrub stops the hold BEFORE it rates", () => {
    const p = props({ heldDirRef: ref<0 | 1 | -1>(1) });
    renderKeymap(p);
    press("f");
    expect(p.stopHold).toHaveBeenCalledTimes(1);
    expect(vi.mocked(p.stopHold).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(p.applyRating).mock.invocationCallOrder[0],
    );
  });

  it("only the HELD arrow's release stops the scrub", () => {
    const p = props({ heldDirRef: ref<0 | 1 | -1>(1) });
    renderKeymap(p);
    release("ArrowLeft");
    expect(p.stopHold).not.toHaveBeenCalled();
    release("ArrowRight");
    expect(p.stopHold).toHaveBeenCalledTimes(1);
  });

  it("a mangled key on release still stops it, via e.code", () => {
    // The fallback that fixed the forever-scrub: a modifier still held at
    // release can blank e.key (useCullKeymap.ts:764-770).
    const p = props({ heldDirRef: ref<0 | 1 | -1>(1) });
    renderKeymap(p);
    release("", { code: "ArrowRight" });
    expect(p.stopHold).toHaveBeenCalledTimes(1);
  });

  it("the grid's row-jump starts on a bare down-arrow and drops the selection", () => {
    const p = props({ gridVisible: true });
    renderKeymap(p);
    press("ArrowDown");
    expect(p.clearMultiSelection).toHaveBeenCalledTimes(1);
    expect(p.startGridVertHold).toHaveBeenCalledWith(1);
  });

  it("Shift added mid row-jump kills the loop before it grows the selection", () => {
    const p = props({ gridVisible: true, heldGridVertDirRef: ref<0 | 1 | -1>(1) });
    renderKeymap(p);
    press("ArrowDown", { shiftKey: true });
    expect(p.stopGridVertHold).toHaveBeenCalledTimes(1);
    expect(p.growGridSelection).toHaveBeenCalledWith(6); // props().gridCols
    expect(vi.mocked(p.stopGridVertHold).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(p.growGridSelection).mock.invocationCallOrder[0],
    );
  });
});
```

- [ ] **Step 5: zoom.** Append:

```tsx
describe("zoom", () => {
  it("Space arms 1:1, Shift+Space 2:1, and both re-centre the pan", () => {
    const plain = props();
    const { unmount } = renderKeymap(plain);
    expect(press(" ", { code: "Space" }).defaultPrevented).toBe(true);
    expect(plain.setIsZooming).toHaveBeenCalledWith(true);
    expect(plain.setZoomLevel).toHaveBeenCalledWith(1);
    expect(plain.setPanOffset).toHaveBeenCalledWith({ x: 0, y: 0 });
    unmount();

    const shifted = props();
    renderKeymap(shifted);
    press(" ", { code: "Space", shiftKey: true });
    expect(shifted.setZoomLevel).toHaveBeenCalledWith(2);
  });

  it("an already-zoomed Space changes nothing — the macOS phantom-repeat pin", () => {
    // 7bf33e8: after a rating keypress macOS resumes the still-held Space's
    // auto-repeat as a NON-repeat keydown. With zoom carried, it must be inert.
    const p = props({ isZoomingRef: ref(true) });
    renderKeymap(p);
    press(" ", { code: "Space" });
    expect(p.setIsZooming).not.toHaveBeenCalled();
  });

  it("Space in the grid is swallowed but does nothing", () => {
    const p = props({ gridVisible: true });
    renderKeymap(p);
    expect(press(" ", { code: "Space" }).defaultPrevented).toBe(true);
    expect(p.setIsZooming).not.toHaveBeenCalled();
  });

  it("releasing Space exits zoom — unless the MOUSE owns it", () => {
    const keyboard = props();
    const { unmount } = renderKeymap(keyboard);
    release(" ", { code: "Space" });
    expect(keyboard.resetZoom).toHaveBeenCalledTimes(1);
    unmount();

    const mouse = props({ mouseZooming: true });
    renderKeymap(mouse);
    release(" ", { code: "Space" });
    expect(mouse.resetZoom).not.toHaveBeenCalled();
  });

  it("arrows pan while zoomed instead of moving the cursor", () => {
    const p = props({ isZooming: true });
    renderKeymap(p);
    press("ArrowRight");
    press("ArrowDown");
    expect(p.pan).toHaveBeenNthCalledWith(1, 2, 0); // PAN_STEP
    expect(p.pan).toHaveBeenNthCalledWith(2, 0, 2);
    expect(p.advance).not.toHaveBeenCalled();
    expect(p.startHold).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 6: one `rerender` test**, because a state flip mid-session is the one thing a fresh mount cannot cover:

```tsx
describe("a state flip between renders", () => {
  it("opening the help sheet mid-session starts swallowing immediately", () => {
    const p = props();
    const { rerender } = renderKeymap(p);
    press("Enter");
    expect(p.applyRating).toHaveBeenCalledTimes(1);
    // Same spy, new props object: the effect rebuilds cullKeyRef's closures.
    rerender(props({ helpVisible: true, applyRating: p.applyRating }));
    press("Enter");
    expect(p.applyRating).toHaveBeenCalledTimes(1); // still one
  });
});
```

- [ ] **Step 7:** gate green. Report the total `it()` count added across Tasks 5 and 6, and the new Vitest file/test totals. Commit: `git commit -m "test(keys): navigation, filters, holds and zoom" -- src/app/useCullKeymap.test.tsx`

### Task 7: The store cancels its timers, and three tests start asserting something

**Files:** Modify `src/image/imageStore.ts`, `src/image/midSweep.ts`, `src/image/imageStore.test.ts`.

**Interfaces — Produces** (both private to `ImageStore`):

```ts
private later(fn: () => void, ms: number): void;   // setTimeout, tracked
private clearTimers(): void;                        // cancel every tracked timer
```

plus a module-private `const BG_FILL_FALLBACK_MS = 2000;` and, in `MidSweep`, a `private timer` field replacing `private timerArmed` (`midSweep.ts:67`).

**Consumes:** `MID_SWEEP_QUIET_MS` (`src/image/midSweep.ts:18`, exported), `PERFORMANCE_PROFILES` (`src/types/settings.ts`, already imported by the test file at `:19`).

**Ruling (the teardown cannot see a leak, which is the whole point).** `imageStore.test.ts:65-70` hard-resets every tracked store after each test, and `hardReset()` (`imageStore.ts:857-906`) bumps `this.generation` so every pending callback's `if (this.generation === gen)` guard bails. That **silences** timers; it does not **cancel** them. The handles stay armed, fire into a no-op, and a leaked or un-guarded timer is invisible. `vi.getTimerCount() === 0` after `hardReset()` is the assertion that can actually see one.

**Ruling (a tracked-handle set, not five ad-hoc fields).** `armGridThumbPendingRetry` (`:1874-1883`) keeps its own named handle because it also needs identity for its dedupe check (`if (this.gridThumbPendingRetry !== undefined) return;`) and `clearGridThumbPendingRetry` (`:1918-1922`) already cancels it from `reset()` (`:682`), `hardReset()` (`:884`) and `clearGridRange()` (`:966`). It is the model, and it stays exactly as it is. The other four sites — `reset()`'s background-fill fallback (`:726`), `fetchThumbInto`'s backoff retry (`:1397`), `scheduleFullRetry` (`:1657`) and `scheduleMidReprobe` (`:1932`) — have no handle at all, and a per-site field for each would be four more things to remember. One self-removing `Set` plus one `clearTimers()` covers all four and every future one.

**Ruling (`MidSweep` gets the same treatment in four lines).** `midSweep.ts:117-125` arms a `MID_SWEEP_QUIET_MS` timer deduped by a boolean, and `reset()` (`:85-88`) — called by both `reset()` and `hardReset()` — clears `done` and `inFlight` but leaves the timer armed. The handle replaces the boolean: it is already a perfect dedupe flag.

**Ruling (no global fake-timer conversion).** Only 12 of 86 tests use fake timers and 37 depend on `vi.waitUntil` / `waitFor`; a global `beforeEach(vi.useFakeTimers)` plus an `afterEach` count assertion would need 50-60 of them rewritten. One `describe` on fake timers, arming one path at a time, buys the signal for six tests and zero rewrites.

**Ruling (three of the five paths are armed for real; two are covered by construction plus a source guard).** `reset()`'s fallback, the thumb backoff and the full-retry are each armable with three public calls. `scheduleMidReprobe` needs a zoom read in flight plus a mid miss, and `MidSweep`'s quiet window needs `canSweep()` true with an on-demand lane busy — both are more fixture than the bug class is worth. They get the identical production change, and a **source guard** test asserts that every `setTimeout` in either file is tracked, so a future timer cannot slip in untracked even where no runtime test reaches it.

**Ruling (`setGridRange`'s half of the assert-nothing test is DELETED, not rewritten).** `:370-375` asserts that `setCursor` and `setGridRange` do not throw. `setCursor` has a direct observable (`debugStats().cursor`, `:2170`) and a real second behaviour (the `scrubbing` argument suppresses `prefetchFullsAround`, `:929-931`) — it gets a real test. `setGridRange` requests nothing at all unless `setGridCellW` has been called and every path has a `registerDisplay` ref (`:1038`), and the grid `describe` already covers exactly that with its `armed()` / `askedFor()` helpers. Duplicating it here would be a worse test in a worse place.

**Ruling (`unregisterWantFull` keeps no assertion of its own).** Its only observable is the eviction protection it releases, which needs the profile's keep-window arithmetic to demonstrate. `:362-368` is rewritten to pin `registerWantFull` properly — one nav read per path, none for a repeat registration — and a comment says plainly what the other half is not covering and why. A test that claimed to cover it would be the same lie in a new coat.

- [ ] **Step 1: the timer-hygiene describe, test first.** Append to `src/image/imageStore.test.ts` (it already imports `PERFORMANCE_PROFILES` at `:19`; add `import { MID_SWEEP_QUIET_MS } from "./midSweep";`):

```ts
describe("timer hygiene", () => {
  // hardReset SILENCES timers by bumping the generation — every callback
  // re-checks `this.generation === gen` and bails. That is not CANCELLING
  // them: the handles stay armed, so the suite teardown at :66-70 is
  // architecturally incapable of seeing a leak. These tests assert the
  // stronger property, one armed path at a time.
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reset arms the background-fill fallback, and hardReset cancels it", async () => {
    vi.useFakeTimers();
    const Store = await getStoreClass();
    const store = new Store();
    store.reset(["/p/a.cr3"]);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    store.hardReset();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a failed thumb read arms a backoff retry, and hardReset cancels it", async () => {
    vi.useFakeTimers();
    vi.mocked(invoke).mockRejectedValue(new Error("nope"));
    const Store = await getStoreClass();
    const store = new Store();
    store.reset(["/p/a.cr3"]);
    store.requestThumbFor("/p/a.cr3");
    // Flush the rejection's promise chain without advancing the clock, so
    // the catch block gets to arm its backoff.
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    store.hardReset();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a failed nav read's scheduled retry is cancelled by hardReset", async () => {
    vi.useFakeTimers();
    vi.mocked(invoke).mockRejectedValue(new Error("nope"));
    const Store = await getStoreClass();
    const store = new Store();
    store.reset(["/p/a.cr3"]);
    store.registerWantFull("/p/a.cr3");
    await vi.advanceTimersByTimeAsync(0); // the read fails, the error is recorded
    // The SECOND registration is what hits `inCooldown` and schedules the
    // retry (imageStore.ts:1106-1110).
    store.registerWantFull("/p/a.cr3");
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    store.hardReset();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("no store timer survives hardReset after a session that armed several", async () => {
    vi.useFakeTimers();
    vi.mocked(invoke).mockRejectedValue(new Error("nope"));
    const Store = await getStoreClass();
    const store = new Store();
    store.reset(["/p/a.cr3", "/p/b.cr3"]);
    store.requestThumbFor("/p/a.cr3");
    store.registerWantFull("/p/b.cr3");
    await vi.advanceTimersByTimeAsync(0);
    store.registerWantFull("/p/b.cr3");
    expect(vi.getTimerCount()).toBeGreaterThan(1);
    store.hardReset();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reset() for a NEW folder also cancels the outgoing session's timers", async () => {
    vi.useFakeTimers();
    const Store = await getStoreClass();
    const store = new Store();
    store.reset(["/p/a.cr3"]);
    const first = vi.getTimerCount();
    store.reset(["/q/a.cr3"]);
    // One fallback armed by the new reset, not two — the old one is gone.
    expect(vi.getTimerCount()).toBe(first);
    store.hardReset();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("every timer in the store and the sweep is tracked, so hardReset can reach it", () => {
    const src = import.meta.glob<string>("./{imageStore,midSweep}.ts", {
      query: "?raw",
      eager: true,
      import: "default",
    });
    const store = src["./imageStore.ts"] ?? "";
    const sweep = src["./midSweep.ts"] ?? "";
    // The glob must have returned real text, or every assertion below is
    // satisfied by the empty string.
    expect(store).toContain("private later(");
    expect(sweep).toContain(`const MID_SWEEP_QUIET_MS`);

    // A bare call, not a `ReturnType<typeof setTimeout>` annotation and not
    // `window.setTimeout`. Keep the literal `setTimeout(` out of comments in
    // both files, or this counts them.
    const bare = (s: string) => [...s.matchAll(/(?<![.\w])setTimeout\(/g)].length;
    expect(bare(store)).toBe(2); // one inside `later`, one for the grid retry
    expect(store).toContain("this.gridThumbPendingRetry = setTimeout(");
    expect(store).toContain("private clearTimers(");
    expect(bare(sweep)).toBe(1);
    expect(sweep).toContain("this.timer = setTimeout(");
  });
});
```

  Run: the first five fail on the `toBe(0)` (the fallback and the retries stay armed), the sixth fails on `private later(`. If the `?raw` glob returns nothing for a `.ts` file, fall back to a direct `import storeSrc from "./imageStore.ts?raw";` and report the substitution — the assertion content does not change.

- [ ] **Step 2: the store tracks and cancels.** In `src/image/imageStore.ts`, add the named constant beside the other timing constants (after `MID_REPROBE_MS`, `:96`):

```ts
/** How long `reset()` waits before starting the background thumb sweep on its
 *  own, for a session that never asks for a full (grid-first entry). Long
 *  enough that a normal loupe entry's first full always wins the race, and a
 *  wall clock rather than an animation frame: the display is 240 Hz and this
 *  is a deadline, not a paint. Was an unnamed literal until Phase 4. */
const BG_FILL_FALLBACK_MS = 2000;
```

  Add the field beside `gridThumbPendingRetry` (`:223-228`):

```ts
  /** Every OTHER wall-clock timer this store owns, so reset()/hardReset() can
   *  CANCEL them rather than merely silence them. hardReset bumps the
   *  generation and each callback re-checks it — but a silenced timer is
   *  still armed, so a leaked one (or a future one without a generation
   *  guard) used to be invisible. The grid tier's pending-retry above keeps
   *  its own named handle because it needs identity for its dedupe check. */
  private timers = new Set<ReturnType<typeof setTimeout>>();
```

  Add the two methods next to `clearGridThumbPendingRetry` (`:1914-1922`):

```ts
  /** Schedule, tracked. Self-removing, so the set never outgrows the timers
   *  actually pending. The ONLY sanctioned way to schedule in this class
   *  apart from the grid retry above — imageStore.test.ts's "timer hygiene"
   *  describe reads this file and asserts it. */
  private later(fn: () => void, ms: number): void {
    // `h` is read inside its own initialiser's callback — legal and correct
    // (the callback runs long after the binding is initialised), TS-strict
    // clean, and no `no-use-before-define` rule is in this repo's eslint
    // chain. Do not "fix" it into a `let h: … | undefined`.
    const h = setTimeout(() => {
      this.timers.delete(h);
      fn();
    }, ms);
    this.timers.add(h);
  }

  /** Cancel every tracked timer. Called from reset() and hardReset(). */
  private clearTimers(): void {
    for (const h of this.timers) clearTimeout(h);
    this.timers.clear();
  }
```

  Convert the four untracked sites — `:726` (`}, 2000);` becomes `}, BG_FILL_FALLBACK_MS);`), `:1397`, `:1657`, `:1932` — from `setTimeout(` to `this.later(`, leaving every callback body and comment untouched. `scheduleFullRetry`'s two-argument form (`:1657-1667`) keeps its trailing-comma wrap; run `prettier` on the file afterwards rather than hand-formatting. Finally add `this.clearTimers();` immediately after the existing `this.clearGridThumbPendingRetry();` call in **both** `reset()` (`:682`) and `hardReset()` (`:884`).

- [ ] **Step 3: the sweep keeps its handle.** In `src/image/midSweep.ts`, replace `private timerArmed = false;` (`:67`) with:

```ts
  /** The armed quiet-window timer — the handle IS the dedupe flag, and it is
   *  what lets `reset()` cancel the timer instead of leaving it to fire into
   *  a dead generation. */
  private timer: ReturnType<typeof setTimeout> | undefined;
```

  Rewrite `armTimer` (`:116-125`):

```ts
  /** One-shot quiet-window re-pump (gen-scoped; at most one armed timer). */
  private armTimer(): void {
    if (this.timer !== undefined) return;
    const gen = this.deps.generation();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.deps.generation() === gen) this.pump();
    }, MID_SWEEP_QUIET_MS);
  }
```

  and extend `reset` (`:85-88`):

```ts
  reset(): void {
    this.done.clear();
    this.inFlight = 0;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
```

  Re-run Step 1: all six green. Then run the WHOLE file — the 12 existing fake-timer tests (`:728`, `:1654`, `:1785`, `:1816`, `:1852`, `:1883`, `:1910`, `:1942`, `:1961`, `:2335`, `:2355`, `:2389`) and their `advanceTimersByTimeAsync` calls are the regression net for the conversion, and every one must still pass.

- [ ] **Step 4: the three assert-nothing tests.** Replace `:323-330` with:

```ts
  it("setProfile swaps the lanes' concurrency caps", async () => {
    const store = await getStore();
    store.hardReset();
    store.setMemoryPressure("normal"); // pressure clamps the caps otherwise
    const bg = () => store.debugStats().lanes.bg;
    store.setProfile(PERFORMANCE_PROFILES.network);
    const net = bg();
    store.setProfile(PERFORMANCE_PROFILES.local);
    const loc = bg();
    // The profiles must actually differ here, or the assertions below would
    // hold on a setProfile whose body had been emptied — which is exactly the
    // hole the old `.not.toThrow()` version left (its title claimed to check
    // backgroundFillConcurrency and its body never read it).
    expect(PERFORMANCE_PROFILES.network.backgroundFillConcurrency).not.toBe(
      PERFORMANCE_PROFILES.local.backgroundFillConcurrency,
    );
    expect(net).toBe(`0/${PERFORMANCE_PROFILES.network.backgroundFillConcurrency} q0`);
    expect(loc).toBe(`0/${PERFORMANCE_PROFILES.local.backgroundFillConcurrency} q0`);
  });
```

  (Verify `setMemoryPressure`'s exact name and its "no pressure" argument in `imageStore.ts` before writing it; if the store has no such method, drop that line and say so.) Replace `:362-368` with:

```ts
  it("registerWantFull queues exactly one nav read per path", async () => {
    // unregisterWantFull is NOT asserted here: its only observable is the
    // eviction protection it releases, which needs the profile's keep-window
    // arithmetic to demonstrate. Better to cover half honestly than to keep a
    // `.not.toThrow()` that covers neither.
    vi.mocked(invoke).mockResolvedValue(makePreviewBuf());
    const Store = await getStoreClass();
    const store = new Store();
    const path = "/p/wf.cr3";
    store.reset([path]);
    store.registerWantFull(path);
    await vi.waitUntil(() => store.debugStats().counts.navLoads === 1, { timeout: 2000 });
    expect(vi.mocked(invoke)).toHaveBeenCalledWith(
      "read_preview",
      expect.objectContaining({ path }),
    );
    const reads = vi.mocked(invoke).mock.calls.filter((c) => c[0] === "read_preview").length;
    store.registerWantFull(path); // already resolved — must not re-read
    expect(
      vi.mocked(invoke).mock.calls.filter((c) => c[0] === "read_preview"),
    ).toHaveLength(reads);
    store.unregisterWantFull(path);
  });
```

  Replace `:370-375` with:

```ts
  it("setCursor moves the reported cursor, and scrubbing suppresses the prefetch", async () => {
    // setGridRange's half of the old `.not.toThrow()` test is gone: it
    // requests nothing without setGridCellW plus a registerDisplay per path,
    // and the grid describe below already covers exactly that (see `armed`).
    vi.mocked(invoke).mockResolvedValue(makePreviewBuf());
    const Store = await getStoreClass();
    const store = new Store();
    store.reset(["/p/0.cr3", "/p/1.cr3", "/p/2.cr3", "/p/3.cr3", "/p/4.cr3"]);
    store.setCursor(2, true); // scrubbing: no prefetchFullsAround
    expect(store.debugStats().cursor).toBe(2);
    const whileScrubbing = vi.mocked(invoke).mock.calls.length;
    store.setCursor(3); // parked: the prefetch runs
    expect(store.debugStats().cursor).toBe(3);
    expect(vi.mocked(invoke).mock.calls.length).toBeGreaterThan(whileScrubbing);
  });
```

- [ ] **Step 5: the 50 ms sleep.** Replace the body of `:1306-1320` so the negative assertion rests on a provably-elapsed clock instead of a guess:

```ts
  it("the sweep never runs on the network profile, even after its quiet window", async () => {
    const { PERFORMANCE_PROFILES } = await import("../types/settings");
    const calls = routeMidInvoke();
    const Store = await getStoreClass();
    const store = new Store();

    // Fake timers BEFORE reset(): reset arms a 2 s background-fill fallback
    // (imageStore.ts:726), and arming it on the real clock is precisely the
    // cross-test bleed imageStore.test.ts:54-64 documents — it would also
    // leave the `mid` assertion below depending on a promise chain the fake
    // clock never drives.
    vi.useFakeTimers();
    try {
      store.setProfile(PERFORMANCE_PROFILES.network);
      store.reset(["/p/a.cr3", "/p/b.cr3"]);
      store.setNeedPxProvider(() => 1860);
      store.registerWantFull("/p/a.cr3");
      store.reevaluateMid();
      // Was `await new Promise(r => setTimeout(r, 50))` — "give a wrong sweep
      // time to fire", which a sweep with >50 ms of latency would have
      // strolled straight past. advanceTimersByTimeAsync flushes the read's
      // promise chain AND runs the idle sweep's whole quiet window to its end,
      // so "it never fired" now means the deadline provably passed.
      await vi.advanceTimersByTimeAsync(MID_SWEEP_QUIET_MS + 1);
      expect(store.snapshot("/p/a.cr3").mid).toBeDefined();
      expect(genCalls(calls)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
```

- [ ] **Step 6:** gate green, and run `pnpm test` twice in a row to confirm the converted test is not order-dependent. Report the new test count. Three pathspec commits, one per file: `git commit -m "fix(store): cancel timers on reset instead of silencing them" -- src/image/imageStore.ts`; `git commit -m "fix(store): the idle sweep cancels its quiet-window timer" -- src/image/midSweep.ts`; `git commit -m "test(store): timer hygiene, and three tests that now assert something" -- src/image/imageStore.test.ts`

### Task 8: `withChanges` in production, and citations a compiler follows

**Files:** Create `src/utils/withChanges.ts`, `src/utils/withChanges.test.ts`. Modify `src/app/useDecideCallbacks.ts`, `src/app/useDecideCallbacks.test.tsx`.

**Interfaces — Produces:**

```ts
// src/utils/withChanges.ts
export type RatingChange = { imgId: number; after: Rating | undefined };
export function withChanges(
  ratings: Readonly<Record<number, Rating>>,
  changes: readonly RatingChange[],
): Record<number, Rating>;
```

**Consumes:** `Rating` (`src/types/rating.ts`).

**Ruling (PRODUCTION only — the decide tests keep their hand-built literals).** `useDecideCallbacks.test.tsx` asserts `setRatings` was called with a literal map (`:178`, `:276`, `:307`, `:362`). Sharing `withChanges` with the tests would let a bug in the helper pass on both sides — strictly weaker than today. The literals are untouched; only production learns the helper, and the helper gets its own unit test that hand-builds *its* expectations.

**Ruling (four call sites, not seven).** Read from `useDecideCallbacks.ts`, the shape "derive a next-ratings map from a ratings map plus a changes array" appears at `:106-110` (`applyRating`'s grid-selection branch), `:221-225` and `:239-243` (`unrateCurrent`'s two branches) and `:280-281` (`resolveCompareDecide`). The three compare BUILDERS (`:374`, `:394`, `:414-416`) build a `next` map *in parallel with* the `changes` array they pass — the same derivation expressed twice, thirty lines apart, in each of three functions — so they become `withChanges(ratings, changes)` over a `changes` array hoisted to a `const`. That is where the duplication actually hurts, and it is the reason `resolveCompareDecide` then derives the SAME map a third time at `:280`.

**Ruling (`after: undefined` deletes the key).** `unrateCurrent` records `after: undefined as Rating | undefined` (`:217`, `:237`) and its updaters `delete next[c.imgId]` (`:223`, `:241`). `withChanges` must do the same, or an unrated frame would come back as an explicit `undefined` value and `passesFilter(ratings[id], …)` would still see the key. The helper's own test pins it with `Object.hasOwn`.

**Ruling (two of the three citation classes are ALREADY compiler-followed; only the private one needs rewording).** The scout says ~38 comments cite production symbols as free text. Read against the file: `makeProps` ends with `return props satisfies Parameters<typeof useDecideCallbacks>[0];` (`useDecideCallbacks.test.tsx:127`), so **every prop name** — `nearestUnrated`, `flashFeedback`, `persistRating`, `recordAction` — already breaks the build on a rename. And the three decide names are called as `result.current.challengerLoses()` / `.challengerKeptBoth()` / `.challengerWins()`, so those break too. What is genuinely unfollowed is **`resolveCompareDecide`** (a `useCallback` local inside the hook, `:275`) and **`DecideSpec`** (a module-private type, `:18`) — cited by name in about a dozen comments. Per the standing rule, they are NOT exported to satisfy a comment: the comments are reworded to cite the behaviour instead, and one compile-time pin is added so the public names are referenced by TYPE as well as by call.

- [ ] **Step 1: the helper, test first.** Create `src/utils/withChanges.test.ts` (node env — no docblock):

```ts
import { describe, expect, it } from "vitest";
import { withChanges } from "./withChanges";

describe("withChanges", () => {
  it("applies each change to a COPY, leaving the input untouched", () => {
    const before = { 0: "keep", 1: "reject" } as const;
    const after = withChanges(before, [{ imgId: 1, after: "favorite" }]);
    expect(after).toEqual({ 0: "keep", 1: "favorite" });
    expect(before).toEqual({ 0: "keep", 1: "reject" });
    expect(after).not.toBe(before);
  });

  it("DELETES the key when a change clears a rating", () => {
    // Not `{ 1: undefined }`: the key must be gone, or every
    // `id in ratings` / Object.keys consumer still counts the frame as rated.
    const after = withChanges({ 0: "keep", 1: "reject" }, [{ imgId: 1, after: undefined }]);
    expect(Object.hasOwn(after, "1")).toBe(false);
    expect(after).toEqual({ 0: "keep" });
  });

  it("applies changes in order, so a later one wins", () => {
    const after = withChanges({}, [
      { imgId: 7, after: "keep" },
      { imgId: 7, after: "reject" },
    ]);
    expect(after).toEqual({ 7: "reject" });
  });

  it("an empty changes array still returns a fresh copy", () => {
    const before = { 3: "keep" } as const;
    const after = withChanges(before, []);
    expect(after).toEqual(before);
    expect(after).not.toBe(before);
  });
});
```

  Then create `src/utils/withChanges.ts`:

```ts
import type { Rating } from "../types/rating";

/** The fields of an undo `changes` entry this helper needs. The real entries
 *  (see `UndoAction`) also carry `path` and `before`, which only the persist
 *  and revert paths read — a structural subset keeps the helper usable by
 *  both the two-field compare builders and the four-field grid ones. */
export type RatingChange = { imgId: number; after: Rating | undefined };

/**
 * The ratings map AFTER a set of changes — one derivation, used everywhere a
 * decide needs the post-change map.
 *
 * The duplication this removes was real and asymmetric: each compare builder
 * derived `next` by hand to ask `nearestUnrated` what was left, THEN handed
 * `resolveCompareDecide` a `changes` array describing the same edits, which
 * derived the map a third time. Three expressions of one rule, thirty lines
 * apart.
 *
 * `after: undefined` DELETES the key rather than storing `undefined` — an
 * unrated frame must not remain a key, or `Object.keys(ratings).length` and
 * every `id in ratings` check would still count it.
 *
 * Deliberately NOT shared with the decide tests: they hand-build their
 * expected maps as literals, so a bug in here cannot pass on both sides.
 */
export function withChanges(
  ratings: Readonly<Record<number, Rating>>,
  changes: readonly RatingChange[],
): Record<number, Rating> {
  const next: Record<number, Rating> = { ...ratings };
  for (const c of changes) {
    if (c.after === undefined) delete next[c.imgId];
    else next[c.imgId] = c.after;
  }
  return next;
}
```

- [ ] **Step 2: production adopts it.** In `src/app/useDecideCallbacks.ts`, add `import { withChanges } from "../utils/withChanges";` beside the existing imports (`:1-3`), then make five edits, each replacing a hand-rolled derivation and NOTHING else:
  1. `applyRating`'s grid branch (`:106-110`): `setRatings((prev) => withChanges(prev, changes));`
  2. `unrateCurrent`'s grid branch (`:221-225`): `setRatings((prev) => withChanges(prev, changes));`
  3. `unrateCurrent`'s single branch (`:236-243`): hoist the one-element array the `recordAction` call already builds into a `const changes = [{ imgId: cur.id, path: cur.path, before: ratings[cur.id], after: undefined }];`, pass it to `recordAction({ changes })`, and use `setRatings((prev) => withChanges(prev, changes));`
  4. `resolveCompareDecide` (`:278-281`): keep the two comment lines, replace the two derivation lines (`:280-281`) with `const next = withChanges(ratings, changes);`
  5. the three builders (`challengerLoses` `:372-383`, `challengerKeptBoth` `:391-403`, `challengerWins` `:410-426`): hoist each one's `changes` array into a `const changes = [...]` **above** the `next` derivation, then `const next = withChanges(ratings, changes);`, then pass `changes` into `resolveCompareDecide({ changes, … })`. `challengerWins`' array is two entries, dethroned champion first — that order is load-bearing (it is the persist order, `:311-313`) and must not change.

  The decide suite (12 tests) is the regression net: it asserts the exact `setRatings` argument and the exact `recordAction` shape for all three decides, so any drift in the derivation fails it. Run it after each of the five edits.

- [ ] **Step 3: the citations.** In `src/app/useDecideCallbacks.test.tsx`, add one compile-time pin directly under the imports:

```tsx
/**
 * Compile-time pins for the names the comments below cite. `makeProps` ends
 * with `satisfies Parameters<typeof useDecideCallbacks>[0]`, which already
 * follows every PROP rename; this follows the RETURNED ones even in the tests
 * that only mention them in prose.
 *
 * `resolveCompareDecide` and `DecideSpec` are deliberately absent: both are
 * module-private (a `useCallback` local and a local type), and exporting them
 * to satisfy a comment would widen the module's surface for documentation.
 * The comments that used to name them cite the BEHAVIOUR instead.
 */
type Decides = ReturnType<typeof useDecideCallbacks>;
const _PINNED: Record<keyof Decides, true> = {
  applyRating: true,
  unrateCurrent: true,
  challengerLoses: true,
  challengerKeptBoth: true,
  challengerWins: true,
};
void _PINNED;
```

  (A missing key is an error, an extra one is an error, so a rename in either direction fails `typecheck:tests`.) Then reword every comment that names `resolveCompareDecide` — `:164`, `:174`, `:176`, `:177`, `:179`, `:208`, `:228`, `:263`, `:273`, `:275`, `:276`, `:321`, `:347`, `:359`, `:363`, `:364`, `:382`, `:390`, `:397`, `:429`, `:439`, `:473`, `:496` — to name the behaviour instead. Two worked examples; apply the same transformation to the rest:

```tsx
    expect(props.flashFeedback).toHaveBeenCalledWith("reject", 1); // the shared decide's flash, keyed to the judged frame
```
```tsx
    // The shared decide's setRatings call: the whole next map, BY VALUE (not
    // an updater function) — the caller already derived it to ask
    // nearestUnrated what was left.
```

  Leave every comment naming `challengerLoses` / `challengerKeptBoth` / `challengerWins` / `nearestUnrated` **exactly as it is** — those names are already followed by the compiler (the `satisfies` line and the `result.current.<name>()` calls), and rewording them would lose real information for nothing. Say so in the task report rather than "fixing" them.

- [ ] **Step 4:** gate green. Confirm the decide suite's 12 tests pass **unchanged in substance** — if any assertion had to move, the refactor changed behaviour and must be reverted rather than the test adjusted. Four pathspec commits: `git commit -m "refactor(decide): one derivation for the post-change ratings map" -- src/utils/withChanges.ts src/utils/withChanges.test.ts`; `git commit -m "refactor(decide): the decides derive next through withChanges" -- src/app/useDecideCallbacks.ts`; `git commit -m "test(decide): cite behaviour where the symbol is private, and pin the public names" -- src/app/useDecideCallbacks.test.tsx`

### Task 9: A shared Tauri mock kit, a dead local, and one App smoke test

**Files:** Create `src/test/tauriMocks.ts`, `src/App.smoke.test.tsx`, `src/components/WindowControls.test.tsx`. Modify `src/components/WindowControls.tsx`.

**Interfaces — Produces:**

```ts
// src/test/tauriMocks.ts
export type InvokeRouter = (cmd: string, args?: Record<string, unknown>) => unknown;
export const invoke: Mock<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>;
export function setInvokeRouter(router: InvokeRouter): void;
export function coreMock(): { invoke: typeof invoke };
export function eventMock(): { listen: (...a: unknown[]) => Promise<() => void> };
export function windowMock(): { getCurrentWindow: () => FakeWindow };
export function dialogMock(): { open: Mock<(...a: unknown[]) => Promise<unknown>> };
export function installDomStubs(): void;   // matchMedia, ResizeObserver, object URLs
export function frame(header: object, payloadLen: number): ArrayBuffer;
```

**Consumes:** nothing from the app.

**Ruling (the seven duplicate `vi.mock` factories are NOT migrated).** The spec says to migrate them "only where that is mechanical". There are **seven**, not eight (the scout counted the eight `vi.mock("@tauri-apps/…")` LINES, one file declaring two): `useDecideCallbacks.test.tsx:27`, `useRatingPersistence.test.tsx:26`, `FinishDialog.test.tsx:23`, `StagedFolders.test.tsx:9`, `imageStore.test.ts:23`, `analysisDriver.test.ts:7`, `useSmartCulling.test.tsx:22`. Two of them are owned by other Phase 4 tasks (Task 7 owns `imageStore.test.ts`, Task 8 owns `useDecideCallbacks.test.tsx`), so migrating would either serialise the phase or hand three tasks the same files — and the thing gained is the deletion of a seven-times-repeated **one-liner**. Ruled: the kit is introduced for the smoke test and for future DOM tests; the seven stay. Recorded in "Not in this plan" with the conditions under which a later pass should do it in one go.

**Ruling (the kit lives at `src/test/tauriMocks.ts` and no config changes).** `tsconfig.json` excludes only `src/**/*.test.ts(x)`, so this file is type-checked by `pnpm typecheck` and by `pnpm build`'s `tsc`, and linted by the **strict** eslint block. That is a feature — a broken kit fails the normal gate — and it costs nothing, because `vite build` follows imports from `index.html` and no app module imports it. Do not widen `tsconfig.json`'s `exclude` or eslint's test-relaxation glob to accommodate it; write it clean.

**Ruling (real binary frames, not rejections).** `read_preview` / `extract_thumbnail` / `read_grid_thumb` return a `u32 LE` header length, that many bytes of JSON, then the payload (`src/utils/bundle.ts:22-29`, `:51-68`). A mock returning `undefined` throws inside `new DataView(buf)` and the store records a tier error — survivable, but it fills the run with error noise and leaves the smoke test asserting against a half-failed app. The kit's `frame()` builds a real one (the same construction `imageStore.test.ts:77-104` uses), and the router hands `meta: null` so the 100 ms `MetaBatcher` window is never armed and nothing can fire after the test ends.

**Ruling (the test seeds `cull:helpSeen`).** `App.tsx:174-184` auto-shows the help overlay on the **first cull ever** and sets `helpVisible`, which would swallow the smoke test's `Enter` and dismiss the sheet instead of rating. The test clears `localStorage` for determinism (the launch auto-open at `useSessionLifecycle.ts:372-388` reads `cull:lastDir`, though `DEFAULT_SETTINGS.openLastFolderOnLaunch` is `false`) and then sets `cull:helpSeen` to `"1"`. Without that line the test fails in a way that looks like a keymap bug.

**Ruling (exactly one path, and it is cut rather than nursed).** Per the spec. If it proves flaky in three consecutive local runs, delete the file, keep the kit and the `WindowControls` fix, and say so.

- [ ] **Step 1: the dead local, test first.** Create `src/components/WindowControls.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { WindowControls } from "./WindowControls";

/**
 * WindowControls is the reason nothing has ever mounted <App/>. It called
 * `getCurrentWindow()` in its RENDER BODY into a local the render never used
 * (the effect below calls it again), so the component threw without
 * `__TAURI_INTERNALS__`. Deleting that local is NOT enough: the effect's own
 * `const w = getCurrentWindow()` sits OUTSIDE its try/catch, and under jsdom
 * `isMac` is false, so the effect runs and its throw propagates out of
 * render() all the same. Both calls have to go.
 *
 * Deliberately NO Tauri mock in this file: mocking it would prove nothing.
 */
afterEach(cleanup);

describe("WindowControls", () => {
  it("renders every caption button without the Tauri global, and without throwing", () => {
    // jsdom's UA is win32, so `isMac` is false and all four render: the
    // settings gear plus minimize / maximize / close.
    const { container } = render(<WindowControls onSettings={() => {}} />);
    expect(container.querySelector(".cull-wincontrols")).not.toBeNull();
    expect(container.querySelectorAll("button")).toHaveLength(4);
  });

  it("omits the settings gear when no handler is supplied", () => {
    const { container } = render(<WindowControls />);
    expect(container.querySelectorAll("button")).toHaveLength(3);
  });
});
```

  Run it: both tests throw (`getCurrentWindow` reads `window.__TAURI_INTERNALS__.metadata`, which is `undefined` — `node_modules/@tauri-apps/api/window.js:85`). Then make **two** edits to `src/components/WindowControls.tsx`:
  1. Delete `:21` — `const win = getCurrentWindow();` — and replace the three uses of `win` in the button handlers (`:75` `void win.minimize();`, `:86` `void win.toggleMaximize();`, `:102` `void win.close();`) with `void getCurrentWindow().minimize();` and so on, so each call happens on click rather than on render.
  2. Guard the effect's own call. Replace `:28` — `const w = getCurrentWindow();` — with:

```tsx
      let w: ReturnType<typeof getCurrentWindow>;
      try {
        w = getCurrentWindow();
      } catch {
        return undefined; // window API unavailable (plain-browser dev / jsdom) — keep the default
      }
```

  (The existing `try` at `:32-37` wraps only `await w.isMaximized()`, which is why the construction above it needed its own guard. The `catch` at `:35-37` and its comment stay as they are.) Re-run: green.
  Neither test clicks a caption button, so no Tauri call ever fires; `isMac` is a UA sniff (`src/utils/platform.ts`) and the two counts above pin both branches of it explicitly rather than depending on which one the runner takes.

- [ ] **Step 2: the shared kit.** Create `src/test/tauriMocks.ts`:

```ts
import { vi } from "vitest";

/**
 * The repo's first shared test kit: one place that knows what a mounted CULL
 * tree asks of Tauri and of the DOM.
 *
 * HOISTING: a `vi.mock` factory may not reference a module-scope import, so a
 * consumer writes the ASYNC form, which imports this file from inside the
 * factory:
 *
 *   vi.mock("@tauri-apps/api/window", async () =>
 *     (await import("./test/tauriMocks")).windowMock());
 *
 * This file is NOT excluded from `tsconfig.json` (which excludes only
 * `*.test.ts*`), so `pnpm typecheck` and `pnpm build` check it and the strict
 * eslint block lints it. Keep it clean rather than widening either config.
 */

export type InvokeRouter = (cmd: string, args?: Record<string, unknown>) => unknown;

let router: InvokeRouter = () => undefined;

/** Point `invoke` at a table for this test. Call it in `beforeEach`. */
export function setInvokeRouter(next: InvokeRouter): void {
  router = next;
}

/** The shared `invoke` spy. One per test FILE (Vitest gives each file its own
 *  module registry), so `mockClear` between tests is the caller's job. */
export const invoke = vi.fn((cmd: string, args?: Record<string, unknown>) =>
  Promise.resolve(router(cmd, args)),
);

export function coreMock() {
  return { invoke };
}

/** `listen` must return a PROMISE that resolves to an unlisten function:
 *  App.tsx:427-429 does `un.then((f) => f())` and
 *  useSessionLifecycle.ts:506 calls the resolved value unguarded. */
export function eventMock() {
  return { listen: () => Promise.resolve(() => {}) };
}

/** Every window method the mounted tree touches. The three `on…` registrars
 *  are THENABLE (useQuitGuard.ts:31-41, useDragAndDrop.ts:35-70 and
 *  WindowControls' effect all chain `.then`), and `isMaximized` resolves. */
export function windowMock() {
  return {
    getCurrentWindow: () => ({
      isMaximized: () => Promise.resolve(false),
      isFullscreen: () => Promise.resolve(false),
      onResized: () => Promise.resolve(() => {}),
      onCloseRequested: () => Promise.resolve(() => {}),
      onDragDropEvent: () => Promise.resolve(() => {}),
      minimize: () => Promise.resolve(),
      toggleMaximize: () => Promise.resolve(),
      close: () => Promise.resolve(),
      destroy: () => Promise.resolve(),
    }),
  };
}

export const dialogOpen = vi.fn((..._args: unknown[]) => Promise.resolve<unknown>(null));

export function dialogMock() {
  return { open: dialogOpen };
}

/**
 * A binary read frame: `u32` LE header length, that many bytes of JSON, then
 * `payloadLen` bytes standing in for a JPEG (SOI + a filler byte). The wire
 * format is documented at src/utils/bundle.ts:22-29 and parsed at :51-68;
 * handing `invoke` anything else throws inside `new DataView(buf)`.
 */
export function frame(header: object, payloadLen: number): ArrayBuffer {
  const bytes = new TextEncoder().encode(JSON.stringify(header));
  const buf = new ArrayBuffer(4 + bytes.length + payloadLen);
  new DataView(buf).setUint32(0, bytes.length, true);
  new Uint8Array(buf, 4, bytes.length).set(bytes);
  new Uint8Array(buf, 4 + bytes.length).fill(0xff);
  return buf;
}

/**
 * The browser APIs a mounted CULL tree reaches that need help under jsdom.
 *  - `matchMedia`: NOT implemented by jsdom 30 (contradicting the Phase 4
 *    scout, which said it was). useImageStoreWiring.ts:88-102 arms one on
 *    mount and calls addEventListener/removeEventListener on the result, so
 *    without this stub App throws on render.
 *  - `ResizeObserver`: also not implemented. The grid and the loupe stage
 *    observe (App.tsx:454, useImageStoreWiring.ts:78) — both phase-gated, so
 *    the start screen never reaches them; stubbed anyway.
 *  - `URL.createObjectURL` / `revokeObjectURL`: these DO exist under Vitest's
 *    jsdom environment (it installs a Node-backed compat URL). They are
 *    replaced with spies so a test can count blob churn — not because they
 *    are missing.
 * Call from `beforeEach`; `vi.unstubAllGlobals()` in `afterEach` undoes the
 * first two, and the URL pair is restored by the caller.
 */
export function installDomStubs(): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  let n = 0;
  globalThis.URL.createObjectURL = vi.fn(() => `blob:mock-${++n}`);
  globalThis.URL.revokeObjectURL = vi.fn(() => {});
}
```

  `vi.stubGlobal("matchMedia", …)` puts it on `globalThis`, and in Vitest 4's jsdom environment `globalThis === window` is `true` — verified, so `window.matchMedia` is a function after the call and the direct-assignment form (`PhotoStrip.metrics.test.tsx:50-58`) is not needed here.

- [ ] **Step 3: the smoke test.** Create `src/App.smoke.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import App from "./App";
import { imageStore } from "./image/imageStore";
import { dialogOpen, frame, installDomStubs, invoke, setInvokeRouter } from "./test/tauriMocks";

/**
 * ONE path: start -> staged -> culling -> Enter -> the sidecar write.
 *
 * What only this test can prove: that the 63 props App hands `useCullKeymap`
 * are wired to the right callbacks. The hook harness
 * (useCullKeymap.test.tsx) proves the keymap's behaviour against a props
 * object the TEST builds; nothing else checks that App's object matches.
 *
 * Deliberately not a suite. Everything beyond this path duplicates the hook
 * harness at several times the flakiness — and if this one proves flaky in
 * three consecutive local runs, it is deleted rather than nursed (spec §3).
 *
 * De-flaking rules, all of them load-bearing:
 *  - `findBy*` / `waitFor` only. No sleeps, no fake timers: the phase
 *    transitions are promise chains, not clocks.
 *  - Every read frame is REAL, so no tier error is logged and no retry timer
 *    is armed. `meta: null` keeps the 100 ms MetaBatcher window unarmed, so
 *    nothing can update state after the test ends.
 *  - `cull:helpSeen` is seeded: the first cull ever auto-shows the help
 *    overlay (App.tsx:174-184), which would swallow the Enter.
 */

vi.mock("@tauri-apps/api/core", async () => (await import("./test/tauriMocks")).coreMock());
vi.mock("@tauri-apps/api/event", async () => (await import("./test/tauriMocks")).eventMock());
vi.mock("@tauri-apps/api/window", async () => (await import("./test/tauriMocks")).windowMock());
vi.mock("@tauri-apps/plugin-dialog", async () => (await import("./test/tauriMocks")).dialogMock());

const FOLDER = "/shoot";
const PATHS = [`${FOLDER}/a.CR3`, `${FOLDER}/b.CR3`];

const origCreate = globalThis.URL.createObjectURL;
const origRevoke = globalThis.URL.revokeObjectURL;

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("cull:helpSeen", "1");
  installDomStubs();
  invoke.mockClear();
  dialogOpen.mockClear();
  dialogOpen.mockResolvedValue([FOLDER]);
  setInvokeRouter((cmd) => {
    switch (cmd) {
      case "scan_folder":
        return { paths: PATHS, ignored: 0 };
      case "analyze_folder":
        return {
          order: [0, 1],
          ratings: [null, null],
          lrcRatings: [null, null],
          unreadableDirs: [],
          restoreErrors: [],
          restoreErrorCount: 0,
        };
      case "extract_thumbnail":
        return frame({ width: 60, height: 40, jpegLen: 2, meta: null }, 2);
      case "read_preview":
        return frame({ meta: null, previewLen: 2 }, 2);
      case "read_grid_thumb":
        return frame({ gridLen: 2, width: 60, height: 40 }, 2);
      case "read_mid":
        return frame({ midLen: 2, width: 60, height: 40 }, 2);
      case "read_fullres":
        return frame({ fullLen: 2 }, 2);
      case "analyze_quality":
        // NOT `undefined`. DEFAULT_SETTINGS has smartCulling AND
        // smartCullingOnOpen true, so reaching "culling" auto-starts the
        // analysis driver, whose chunk call is typed Promise<ImageScore[]>;
        // an undefined chunk fails and the driver re-arms a REAL 120 ms idle
        // retry (analysisDriver.ts) that would fire after the test ends.
        return [];
      default:
        // begin_session and set_io_profile (imageStore.ts:589 — pushBackend
        // sends them through a variable, and its `typeof window === "undefined"`
        // guard does NOT skip under jsdom), write_xmp_rating,
        // clear_xmp_rating, read_capture_times, generate_mid, path_exists…
        return undefined;
    }
  });
});

afterEach(() => {
  cleanup();
  imageStore.hardReset();
  vi.unstubAllGlobals();
  globalThis.URL.createObjectURL = origCreate;
  globalThis.URL.revokeObjectURL = origRevoke;
});

describe("App, end to end on one path", () => {
  it("stages a folder, begins the cull, and Enter writes a keep sidecar", async () => {
    render(<App />);

    // Start screen. The button's accessible name includes its KeyCombo caps
    // ("Open foldersCtrlO"), so match loosely.
    fireEvent.click(await screen.findByRole("button", { name: /Open folders/ }));
    await waitFor(() => expect(dialogOpen).toHaveBeenCalledTimes(1));

    // Staged screen.
    const begin = await screen.findByRole("button", { name: "Begin culling →" });
    expect(invoke).toHaveBeenCalledWith("scan_folder", expect.objectContaining({ path: FOLDER }));
    fireEvent.click(begin);

    // Culling. The Rejects filter tab lives in the footer StatusBar, which
    // renders only past App.tsx:1517's `phase !== "culling"` return.
    await screen.findByRole("button", { name: "Rejects" });

    fireEvent.keyDown(window, { key: "Enter", bubbles: true, cancelable: true });
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("write_xmp_rating", {
        path: PATHS[0],
        rating: "keep",
      }),
    );
  });
});
```

- [ ] **Step 4: de-flake, then decide.** Run the file **five times in a row** (`pnpm test src/App.smoke.test.tsx`, five invocations). Record every failure verbatim.
  - A failure inside the render is a missing stub — fix it in the KIT, not in the test, and note what was missing.
  - A failure at `findByRole("button", { name: "Rejects" })` means the phase never reached culling: read the console for the `analyze_folder failed` path (`useSessionLifecycle.ts:503`) and fix the router's shape.
  - A timing failure in `waitFor` is the flakiness the spec pre-authorised cutting for. If three of the five runs are red for reasons that are not a missing stub, **delete `src/App.smoke.test.tsx`**, keep the kit and the `WindowControls` fix, and report the decision with the failure output.
- [ ] **Step 5:** gate green. Report the five-run result and the new Vitest totals. Pathspec commits: `git commit -m "fix(chrome): drop the render-body getCurrentWindow that made App unmountable" -- src/components/WindowControls.tsx src/components/WindowControls.test.tsx`; then `git commit -m "test(app): a shared Tauri mock kit and one start-to-rating smoke test" -- src/test/tauriMocks.ts src/App.smoke.test.tsx`

### Task 10: The docs, and the final gate

**Files:** Modify `TESTING.md`, `ARCHITECTURE.md`, `README.md`, and this plan file.

**Interfaces — Consumes:** everything. This is the one task that owns the three root docs, so no file has two owners.

**Ruling (ARCHITECTURE.md only where BEHAVIOUR changed).** Three things changed how the app behaves: the keymap's dispatch order and its one-action-per-press rule (Task 5), the CR3 reader's count clamp (Task 1), and the store cancelling rather than silencing its timers (Task 7). Everything else in this phase is test and CI scaffolding, which belongs in TESTING.md. Do not narrate the fuzzer or the harness in ARCHITECTURE.md.

**Ruling (README only for the visible key change).** The one user-visible behaviour change is that a held rating key or filter digit now acts once instead of at the OS repeat rate. The cheat sheet (`README.md:201-228`) does not list per-key repeat behaviour, so this is one line under the table, not a table edit. Nothing else in Phase 4 is visible to a user.

- [ ] **Step 1: `TESTING.md`.** Add a new `## The keymap harness` section after **Reading source files in tests** (`:27-47`) and before **Stylesheet guards** (`:49`), covering, in prose the length of the neighbouring sections: `src/app/useCullKeymap.test.tsx` drives the hook under `renderHook` with a props factory typed as `Parameters<typeof useCullKeymap>[0]` (so a new prop is a compile error, not a silent gap); the three mechanics that make such a test lie if missed — `cancelable: true`, Escape's always-true `defaultPrevented` because of the capture listener, and the mandatory `afterEach(cleanup)` because Vitest runs without `globals` so RTL's auto-cleanup never registers; and that ordering claims are asserted with `mock.invocationCallOrder`, never by "both were called".
- [ ] **Step 2: `TESTING.md` — the fuzzer.** Add `## The CR3 mutation fuzzer` after the new keymap section: a plain `#[test]` in `cr3.rs`'s own test module, zero dependencies, ungated so it runs in CI with no corpus; deterministic from a constant seed; what it asserts (never panics, never hangs, returned sizes bounded by the input); and — the part a future reader actually needs — **how to reproduce a red run**, verbatim:

```bash
CULL_FUZZ_SEED=<seed> CULL_FUZZ_FROM=<iteration> CULL_FUZZ_ITERS=1 \
  cargo test mutation_fuzz -- --nocapture
```

  with the note that the input is DERIVED from `(seed, iteration)` rather than replayed, so one iteration reproduces on its own. Add the three env vars to the **Env-var-gated corpus tests** table (`:98-102`) — they are the opposite of corpus gates (they narrow a test that always runs) so say so in the row.
- [ ] **Step 3: `TESTING.md` — the kit, the timer rule, coverage.** Three more short additions:
  - `src/test/tauriMocks.ts` is the shared Tauri + DOM kit: what it provides, the async-factory hoisting form a consumer must use, the fact that jsdom 30 implements neither `matchMedia` nor `ResizeObserver` (it **does** implement `URL.createObjectURL` under Vitest's jsdom environment — the kit replaces that pair with spies to count blob churn, not because it is missing), and that the seven pre-existing inline `vi.mock("@tauri-apps/api/core")` declarations were deliberately left alone (see "Not in this plan").
  - **The timer rule**: every wall-clock timer inside `ImageStore` goes through `this.later(...)` so `reset()` / `hardReset()` can cancel it, `MidSweep` keeps its one handle, and `imageStore.test.ts`'s `timer hygiene` describe reads both files raw and fails on an untracked `setTimeout(`. Say explicitly WHY: `hardReset` silences by generation, which cannot detect a leak.
  - `pnpm test:coverage` (v8 provider, text + html), `coverage/` is git-ignored, and there is **no threshold** — the numbers from Task 4 are recorded in this plan's implementation note, and per-directory floors are Phase 5's call.
- [ ] **Step 4: `ARCHITECTURE.md`.** Three edits, no new sections:
  1. In the **Read pipeline** section (`:78`), one paragraph: every IFD entry's count is file-supplied and clamped in `Tiff::find_entry` to the components the buffer holds, so no reader can be made to iterate past its own buffer; before that clamp a CR3 declaring a 4-billion-component GPS RATIONAL array spun about a second per tag on every read path, for a value the UI does not display.
  2. In the **Design language** section's modifier-key neighbourhood (`:534-719`), one paragraph on the keymap's dispatch order — modal gates (with the scrub interrupt ahead of every one of them), then Tab and the help swallow, then the Ctrl combos, then Space, Escape and the mode handlers — plus the rule that a rating key, a filter digit and a page key act **once per press** while the arrows are the one deliberate hold-to-repeat gesture.
  3. In the **Modules** section (`:720`), add `src/utils/withChanges.ts` to whatever inventory that section keeps, one line.
- [ ] **Step 5: `README.md`.** One line directly under the cheat-sheet table (after `:230`'s `Ctrl` + wheel note):

```
Rating keys, the filter digits and the page keys act **once per press** — only
the arrows repeat while held (that is the scrub).
```

- [ ] **Step 6: the implementation note.** Append an `## Implementation note (2026-09-21)` section to THIS plan file, in the shape Phase 3C's has: what shipped · where the spec or the plan was wrong and what was ruled instead · verification · Oliver's walk · left for later. It must include: the fuzzer's printed red line from Task 1 (seed + iteration + hang-or-panic) and its green wall clock; Task 4's coverage numbers; whether the App smoke test survived its five runs; and the final gate figures (Vitest files/tests, Rust test count). **Oliver's walk** must be: hold `Enter` on a frame and confirm it rates once; hold `Tab` and press `Ctrl+Z` and confirm nothing undoes behind the sheet; start a scrub, let the quit guard or Settings open, press a key and confirm the scrub stops; and open the newest PR to see three green checks rather than two.
- [ ] **Step 7: the final gate** — from the repo root: `pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm lint:css && pnpm test && pnpm build && pnpm audit --prod --audit-level=high`, plus, from `src-tauri/`: `cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test`. That JS list is exactly what Task 2 put in CI's `frontend` job, in the same order — the audit is last because it is the one step that talks to the registry, so a network failure there cannot mask a real one above it (re-run rather than delete). Report every number.
- [ ] **Step 8:** commit: `git commit -m "docs: Phase 4 — the keymap harness, the CR3 fuzzer, timer hygiene and CI" -- TESTING.md ARCHITECTURE.md README.md docs/superpowers/plans/2026-09-21-phase-4-tests-and-ci.md`

---

## Pre-flight corrections (2026-09-21)

Two fresh checkers fact-checked this plan against the code before any of it was executed — one of them compiled Task 5's props factory verbatim and ran all five RED claims through the real hook. Every finding below was applied here, so an implementer reads only corrected text. Recorded so the record survives even if the session is interrupted; Task 10 moves this section into the implementation note.

- **BLOCKER — Task 7 Step 5 armed a real 2 s timer before faking the clock.** `vi.useFakeTimers()` sat *after* `store.reset([...])`, so `reset()`'s background-fill fallback (`imageStore.ts:726`) was armed on the real clock and survived the test — exactly the cross-test bleed `imageStore.test.ts:54-64` documents — and the `mid` assertion depended on a promise chain the fake clock never drove. The call moved to immediately after `new Store()`, with `setProfile` / `reset` / `setNeedPxProvider` inside the `try`.
- **BLOCKER — deleting `WindowControls.tsx:21` does not make the component mountable.** The effect's own `const w = getCurrentWindow()` (`:28`) sits OUTSIDE its `try`, and under jsdom `isMac` is false so the effect runs; a checker's probe confirmed the throw propagates out of `render()`. Task 9 Step 1 now makes **two** edits, the second wrapping that construction in its own `try`/`catch` returning `undefined`. The test asserts four buttons render (three without `onSettings`) with no Tauri global and no throw.
- **The fuzzer has a THIRD expected red, and the plan's own STOP rule would have stalled on it.** `boxes(d, 0, usize::MAX)` in `fuzz_one` panics before Step 5's clamp lands — the same defect the `boxes` hardening fixes, seen from the fuzzer instead of from the unit test. Named explicitly in the Step 2 red list.
- **`find_le_tiff` was off by one** (`saturating_sub(4)` can never see a TIFF header ending at the last byte). Now `saturating_sub(3)`, with the arithmetic in the doc comment.
- **The "inline values are a no-op" ruling was too strong.** For an entry truncated at the buffer's tail the clamp does reduce an inline count, turning `ascii`'s `None` into a truncated string. Stated in both the ruling and the `clamp_count` doc, since the fuzzer's `else` branch leans on the distinction.
- **The hostile-count test never exercised the production route.** It called `Tiff::rationals` directly; it now also runs `metadata_from_prefix` over a whole synthetic CR3 head and asserts `gps_lat == Some(51.5)` — the path every real image takes.
- **`jsdom` does implement `URL.createObjectURL`.** The plan said it did not, from a probe run against bare `new JSDOM()` in plain Node; under **Vitest's** jsdom environment a Node-backed compat `URL` is installed (`vitest/dist/chunks/index.DC7d2Pf8.js:556-570`). `matchMedia` and `ResizeObserver` really are missing. Corrected in the Global Constraints, the kit's doc comment and Task 10's TESTING.md brief, with the "probe inside Vitest" warning attached.
- **The smoke test's router returned `undefined` for `analyze_quality`.** `DEFAULT_SETTINGS` has both `smartCulling` and `smartCullingOnOpen` true, so reaching "culling" auto-starts the analysis driver, whose chunk call is typed `Promise<ImageScore[]>`; an undefined chunk fails and re-arms a real 120 ms idle retry that would fire after the test ends — in the one test whose entire budget is de-flaking. Now returns `[]`.
- **Task 2's macOS job cannot be run by its implementer.** A Step 2b says so: the first real run is on the PR, and a compile failure there is a finding for the controller, not a fix inside Task 2. The job's deliberate omission of `components:` is now stated so nobody copies it from `backend`.
- **The branch-protection precondition had the wrong reason.** GitHub accepts an unknown context and shows it as *Expected — waiting for status* forever, silently blocking every merge — it does not reject the call. The precondition stands; the sentence was rewritten.
- **Task 4 cannot run beside any task that runs `pnpm test`** (controller's ruling). `pnpm add` rewrites `node_modules` under a running vitest. The map now has a wave 0 in which Task 4 runs alone apart from the Rust and CI tasks, and wave 1 follows it.
- **`pnpm audit --prod` gates on every severity including `low`** (controller's ruling). Now `pnpm audit --prod --audit-level=high`, in CI and in Task 10's final gate, with the reasoning and the registry-outage remedy (re-run the job, never delete the step) written next to it.
- **The fuzzer's per-input deadline was too tight for a shared runner** (controller's ruling). 250 ms → **1000 ms**, still four orders of magnitude above a healthy input and below the 1.6–1.9 s spin it hunts.
- **Smaller:** the closure lift names **five** call sites, not three; `coverage.exclude` gains `src/**/__fixtures__/**` (a user `exclude` replaces Vitest's defaults); the weekly audit workflow gains `permissions: { contents: read }` and a note that GitHub disables a schedule after 60 idle days; `later`'s `const h` self-capture is annotated so nobody "fixes" it; Task 7's heading and commit say **three** rewritten tests plus one deletion, not four; `required_conversation_resolution` gained its sentence in the controller step; `resolveCompareDecide`'s derivation is **two** lines (`:280-281`), not three; Task 5 Step 5 now says which assertion inside the Ctrl+Z test is the discriminating one (its `defaultPrevented` passes before the fix too); and the settled `vi.stubGlobal` question (`globalThis === window` under Vitest's jsdom) was dropped from Task 9's steps rather than left for the implementer to re-discover.
- **Two checker findings REJECTED, verified against the code:** (1) that `begin_session` and `set_io_profile` "do not exist anywhere in the repo" — they do, at `imageStore.ts:589`, `:523`, `:644`, `:863`, invoked through a variable in `pushBackend`, whose `typeof window === "undefined"` guard does **not** skip under jsdom; the smoke test's default case comment was extended with the other real commands instead of replaced. (2) that `new ResizeObserver` is at `App.tsx:455` — it is at `:454`, as the plan already said.

---

## Controller step (NOT an implementer task): branch protection

Run by the controller **after Task 2 has merged and `backend-macos` has reported at least once on a pull request**. GitHub does **not** reject a context it has never seen — it accepts it and then shows it as *Expected — waiting for status* forever, silently blocking every merge. So the precondition is not about the API refusing the call; it is about knowing the check actually arrives.

The endpoint is a `PUT` and rejects a partial body with 422: all four of `required_status_checks`, `enforce_admins`, `required_pull_request_reviews` and `restrictions` must be present even when null.

```bash
gh api -X PUT repos/OliverSogaard/cull/branches/main/protection \
  -H "Accept: application/vnd.github+json" --input - <<'JSON'
{ "required_status_checks": { "strict": false,
    "contexts": ["frontend", "backend", "backend-macos"] },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_linear_history": false,
  "required_conversation_resolution": true }
JSON
```

Why each field is what it is: **`strict: false`** — `true` forces a rebase and a five-minute Rust re-run before every merge, and with one human on serial phase branches the stale-merge risk it buys is about zero. **`required_pull_request_reviews: null`** — GitHub will not let an author approve their own PR, so requiring a review deadlocks a one-human repo entirely. **`enforce_admins: false`** — the deliberate escape hatch for a broken runner. **`allow_force_pushes` / `allow_deletions` false** — the actual protection being bought. **`required_linear_history: false`** — the history uses merge commits. **`required_conversation_resolution: true`** — the one thing a single-owner repo genuinely loses without it: a review comment left open on a PR you merge yourself is a comment nobody ever sees again. Verify afterwards with `gh api repos/OliverSogaard/cull/branches/main/protection` and confirm all three contexts are listed.

---

## Not in this plan

- **Migrating the seven inline `vi.mock("@tauri-apps/api/core")` declarations onto the shared kit.** Seven files (not eight — the scout counted eight LINES; `FinishDialog.test.tsx` declares two), two of them owned by other Phase 4 tasks, and the thing deleted is a seven-times-repeated one-liner. A later phase that owns none of those files can do it in one mechanical pass; doing it here would either serialise the phase or give three tasks the same files.
- **A coverage threshold, in CI or in config.** Measure first (Task 4 reports the numbers). A global 80 % would be sunk by `App.tsx` and the presentational components and would block every PR for reasons unrelated to it. Per-directory floors on `src/utils`, `src/smart`, `src/image`, `src/app` are the shape to propose with real numbers in hand.
- **An injected scheduler for every store timer.** The right end state (`flushScheduler` already proves the pattern), but 41 construction sites and five new options. Task 7 buys the cancellation property at 1 % of the cost; Phase 5 or later can buy the injection.
- **A fuzz seam for the file-reading grow loops.** `read_head` / `grow` / `read_preview_bundle` / `read_fullres_at` / `locate_fullres` / `read_fullres_scan` / `read_thumbnail` / `read_capture_time` take `&str` and do I/O, but 100 % of their PARSING delegates to the entry points the fuzzer already calls. Only the grow-loop control flow is uncovered, and inventing a seam for it now would add production surface to serve a test.
- **Rust coverage.** `cargo llvm-cov` is not installed and would be a second toolchain to keep alive for a number nobody is yet acting on.
- **`cargo deny`, renovate, a CHANGELOG.** `cargo audit` covers the advisory half, dependabot the freshness half, and a changelog waits until the installers are signed (Phase 5).
- **`tauri build` in CI.** Slow, and it wants signing. `backend-macos` compiles the code; `release.yml` builds the bundles at a tag.
- **Fixing `useCullKeymap.ts`'s size or `imageStore.test.ts`'s.** 860 and 2,494 lines respectively, both past the 800-line guidance. Splitting either while writing this phase's tests would make every assertion's file:line a guess. Report them; leave them.
- **`role="tab"` / `aria-selected` on the filter tabs.** A pre-existing gap recorded in Phase 3C; unrelated to testing.
- **Any behaviour change the fuzzer finds that this plan does not name.** Task 1 Step 2 says to stop and report it. A parser fix nobody planned is a decision, not an implementation detail.

## Parallelism map

The controller runs implementers in parallel **only** on disjoint file sets, up to six at once. Wave = everything in the row may run concurrently.

**Disjoint edited files are not sufficient here.** Every JS task's gate ends in `pnpm test`, and Task 4's Step 1 runs `pnpm add -D @vitest/coverage-v8`, which rewrites `node_modules` and `pnpm-lock.yaml` **underneath a concurrently running vitest**. So Task 4 goes first and alone among JS tasks. The two tasks that touch no JS dependency graph — Task 1 (Rust only) and Task 2 (a YAML file) — may run beside it; nothing they do reads `node_modules`.

| Wave | Task | Files it owns | May run with | Must follow |
| --- | --- | --- | --- | --- |
| 0 | **4** Coverage plumbing (runs `pnpm add`) | `package.json`, `pnpm-lock.yaml`, `vite.config.ts`, `.gitignore` | 1, 2 only | — |
| 0 | **1** CR3 fuzzer + clamp | `src-tauri/src/cr3.rs` | 4, 2 | — |
| 0 | **2** CI build/audit/macOS | `.github/workflows/ci.yml` | 4, 1 | — |
| 1 | **5** Keymap harness pt 1 + the five fixes | `src/app/useCullKeymap.ts`, `src/app/useCullKeymap.test.tsx` | 7, 8, 9, 3 | **4** |
| 1 | **7** Store timer hygiene | `src/image/imageStore.ts`, `src/image/midSweep.ts`, `src/image/imageStore.test.ts` | 5, 8, 9, 3 | **4** |
| 1 | **8** `withChanges` + citations | `src/app/useDecideCallbacks.ts`, `src/app/useDecideCallbacks.test.tsx`, `src/utils/withChanges.ts`(new)+test | 5, 7, 9, 3 | **4** |
| 1 | **9** Mock kit + App smoke | `src/test/tauriMocks.ts`(new), `src/App.smoke.test.tsx`(new), `src/components/WindowControls.tsx`, `src/components/WindowControls.test.tsx`(new) | 5, 7, 8, 3 | **4** |
| 1 | **3** Dependabot + weekly audit | `.github/dependabot.yml`(new), `.github/workflows/cargo-audit.yml`(new) | 5, 7, 8, 9 | **2** (single writer under `.github/`) |
| 2 | **6** Keymap harness pt 2 | `src/app/useCullKeymap.test.tsx` | — | **5** (same file) |
| 3 | **10** Docs + final gate | `TESTING.md`, `ARCHITECTURE.md`, `README.md`, this plan | — | everything |
| — | *controller* | branch protection | — | **2** merged AND `backend-macos` reported green once |

**Serial chains to respect:** 4 → {5, 7, 8, 9}; 2 → 3; 5 → 6 (shared `src/app/useCullKeymap.test.tsx`); everything → 10; Task 2 merged and green → the controller's branch-protection call.

**Never parallel:**
- **4 and any task that runs `pnpm test`** — i.e. 5, 6, 7, 8, 9, 10. `pnpm add` rewrites `node_modules` under a running vitest, and the failure mode is a torn module resolution that looks like a test bug. Task 4 runs alone (beside 1 and 2 only) and finishes before wave 1 starts. It is also the only owner of `pnpm-lock.yaml` and the only task permitted to install anything.
- **5, 6** — both own `src/app/useCullKeymap.test.tsx`, and 6's tests are written against the order 5 establishes.
- **2, 3** — different files, but both write under `.github/`; keeping one writer there at a time makes a bad merge impossible and costs nothing, since 3 has no dependants.
- **10 and anything** — it documents the finished branch and runs the final gate, including `pnpm build` and the registry audit.

Task 7 is the only owner of `src/image/**`; Task 8 the only owner of `src/app/useDecideCallbacks*`; Task 9 the only owner of `src/components/WindowControls*`, `src/test/**` and `src/App.smoke.test.tsx`; Task 1 the only owner of anything under `src-tauri/`. No source file has two owners in this phase.

**Cross-task sanity, not a file conflict:** Task 7 changes `imageStore.ts` while Task 9's smoke test mounts a tree that uses it, and Task 5 changes the keymap the same smoke test presses a key into. Both changes are behaviour-preserving for that path (a tracked timer is still a timer; `Enter` with `repeat: false` still rates), and each task's own gate runs the whole suite — so a real interaction fails loudly at whichever lands second.

---

## Implementation note (2026-09-21)

Executed with subagent-driven development under Oliver's standing instruction of 2026-09-20 to make the calls and keep moving; every choice is a ruling. Before any code, two fresh checkers fact-checked this plan against the repository (2 blockers, 12 should-fixes — see "Pre-flight corrections"). Then a fresh implementer and a fresh reviewer per task, up to six in parallel on disjoint files; fix rounds on Tasks 1, 5, 6, 7 and 9; a scoped re-review of the Rust fix round; a whole-branch review on the strongest model split in two (Rust + CI + docs; everything under `src/`); ONE fix wave by five implementers; ONE scoped re-review. Gates at the tip, run by the controller: 931 tests in 84 files (801 in 80 before), lint, lint:css, typecheck, typecheck:tests, build, `pnpm audit --prod --audit-level=high`; `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, 166 Rust tests (154 before).

### What shipped

- **The one real bug.** A CR3 whose GPS IFD declared a huge RATIONAL count spun for seconds per file on every read path. `Tiff::find_entry` now clamps every file-supplied count to what the buffer can hold, and `rationals` stops at the first out-of-bounds read — either alone ends the hang.
- **A mutation fuzzer for the CR3 parser** — an ordinary `#[test]`, no new dependency, deterministic from a constant seed, 20,000 inputs in about 30 ms. It found the clamp's assertion form at iteration 0 and an overflow in `boxes` at iteration 3; run at 2,000,000 iterations it found a second overflow near `usize::MAX`, and a sweep of the same pattern fixed five sites (two of which panicked in release builds too). Ten seeds reach every parser path — preview, thumbnail, the sample tables, AF data, big-endian TIFF — and a test asserts that reach, so it cannot silently rot. `CULL_FUZZ_SEED` / `_FROM` / `_ITERS` take decimal or hex and panic on garbage; the failure line pastes back unchanged. 12 million inputs across six seeds: no further parser defect.
- **The Exif strip runs in one pass.** The old draining loop was quadratic (2.69 s on 200,000 tiny segments — the same class as the hang, and something random corruption cannot construct). Byte-identical to the old code, which is kept in the tests as an oracle.
- **A harness for the keymap** — `renderHook` under jsdom, a props factory typed against the hook's own parameter type (a new or renamed prop is a compile error) — and 112 tests. Five defects fixed test-first: a held rating key or filter digit acted at the OS repeat rate (now once per press; holding an arrow still flies); Ctrl combos acted underneath the Tab help sheet; a held scrub survived the quit guard and Settings; compare's `k` / `f` lacked `preventDefault`; Ctrl+Tab opened the help sheet.
- **One App-level smoke test** — start → staged → culling → Enter → `write_xmp_rating` with `keep` — on a shared Tauri + DOM mock kit whose default router throws on an unrouted command. 10 of 10 consecutive passes; it stays.
- **Store timers are cancelled on reset, not silenced**, through one `later()` helper; the idle sweep keeps its timer handle. Side effect: an old 1.5 s window after a folder switch in which the sweep could not arm is gone.
- **CI**: `pnpm build` and a production audit on every PR; a `backend-macos` job that compiles the macOS-only code CI had never compiled (green on its first run); monthly grouped Dependabot with majors on their own PRs; a weekly `cargo audit`.
- **Coverage plumbing**, measured and not gated.

### Coverage

| Scope | Before (stmts / branches / funcs / lines) | At the tip |
|---|---|---|
| Total | 74.9 / 61.5 / 67.9 / 77.3 | 73.7 / 60.0 / 69.4 / 76.1 |
| `src/utils` | 93 / 86 / 89 / 93 | 94 / 86 / 91 / 94 |
| `src/smart` | 93 / 89 / 86 / 96 | 93 / 89 / 86 / 96 |
| `src/image` | 87 / 79 / 84 / 91 | 92 / 83 / 94 / 95 |
| `src/app` | 60 / 54 / 54 / 63 | 67 / 60 / 67 / 70 |
| `src/hooks` | 55 / 55 / 64 / 58 | 72 / 64 / 80 / 77 |
| `src/components` | 56 / 36 / 47 / 57 | 49 / 35 / 37 / 50 |
| `src` (`App.tsx`) | never loaded | 45 / 31 / 45 / 48 |

The total FELL 1.2 points while every directory that gained tests rose: the smoke test loads `App.tsx` and the components it mounts for the first time, so their lines now count in the denominator. That is the measurement getting more honest, and it is why no threshold is gated — if one is added later, per-directory floors, never a global figure.

### Where the spec or the plan was wrong, and what was ruled instead

- `top_box_content_start` could not return out of bounds as the scout claimed; the real panics were in `boxes`' direct indices and, later, its loop bound. Found by the planner, confirmed by the fuzzer.
- The plan's timer-hygiene list silently dropped the grid pending-retry the spec names; the whole-branch review caught it, and both resets' cancel is now pinned.
- None of the seven duplicated `vi.mock` factories migrated onto the kit: the kit's default router throws while theirs resolve `undefined`, and `imageStore.test.ts` sends `begin_session` through `invoke` on every reset, so a swap changes behaviour per file.
- `pnpm audit --prod --audit-level=high`, not a bare `--prod`.
- The quadratic Exif strip was fixed rather than listed as a fuzzer limit: same class as the bug this phase exists for.
- Vitest went 4.1.7 → 4.1.11 to match its coverage provider's exact peer (lockfile-level; the caret already allowed it).

### What review caught

Tests that could not fail, in four of the ten tasks — each now watched red under a named production mutation: the scrub half of a store test; two hygiene tests satisfied by the reset fallback alone (one hid a second confound); a source guard blind to `window.setTimeout` and `setInterval`; a rerender test that minted fresh spies, so the dependency array it existed for was never exercised; no positive test for `ArrowLeft`; zoom tests that never separated `e.code` from `e.key`; the digit repeat guard pinned only for `3`; the L / G / C mode keys, grid Shift+Arrow and the overlay toggles asserted nowhere; three of five `withChanges` call sites invisible to any test; the idle sweep's cancel unpinned. Also: a "contract" docblock in the keymap that still described the pre-fix order and would have told the next developer to restore two of the bugs; a fuzzer that called every entry point while its seeds reached about half the parser; a fuzz seed variable that silently ignored hex — so every "reproduction" was a fresh run; and doc claims that were false on the day they were written.

### Verification

Tests and static gates; the parser on the 12 scratch CR3 copies (never the real folders): 2.65 million exhaustive old-versus-new comparisons and 4,275 truncation points per file, zero mismatches. No live run this phase — the one visible change (one action per press) is pinned by the harness. Not seen live: real WebView key-repeat behaviour. The weekly `cargo audit` has never run — trigger it once after the merge.

### Left for later

- A Tab keydown carrying `repeat` AND a modifier slips the Ctrl+Tab guard and closes a held sheet — unreachable in practice.
- The reach test proves reach, not depth; real Rust coverage needs `cargo llvm-cov`. The fuzz seeds embed a JPEG from the `image` crate, so a (seed, iteration) pair reproduces only at a given commit.
- An injected scheduler for the store timers; a fuzz seam for the file-reading grow loops.
- `useCullKeymap.ts` and `imageStore.test.ts` are past the 800-line guidance.
- Carried from 3C, unchanged: the strip's one-cell burst "fence"; no Cancel during "analyzing"; the stepper's far `−`; `C` from Rejects is a silent no-op; filter tabs lack `role="tab"`.
