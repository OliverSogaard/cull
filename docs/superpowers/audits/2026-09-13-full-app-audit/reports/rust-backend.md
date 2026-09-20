# CULL Backend Rust Review (src-tauri, 8.6k lines / 19 files)

## Summary verdict

APPROVE: no CRITICAL and no blocking HIGH issues. This is an unusually
disciplined codebase for a hand-rolled binary-format parser: cr3.rs treats
every byte as hostile (bounds-checked accessors, checked_add, scan caps),
error handling is Result-based end-to-end with no stray unwrap/expect
outside test modules (three narrow, justified exceptions noted below), and
concurrency (IoGate/SessionGate/MidGen) is a genuinely well-designed
detach-and-self-heal model for un-abortable blocking I/O. cargo clippy
--all-targets came back clean (2 style-only warnings), and cargo test is
already known-green (109/109). Findings below are mostly MEDIUM (fuzzing,
one real narrow panic path, previously-known sidecar-error swallowing) plus
LOW polish items.

## What is genuinely excellent

- cr3.rs bounds discipline. Every multi-byte read goes through be_u32/
  be_u64/Tiff::u16/u32 helpers built on slice::get, never raw indexing on
  attacker-influenced offsets. boxes() and top_box_content_start() use
  checked_add explicitly to guard the ISO-BMFF size==1 64-bit large-size case
  (cr3.rs:69, cr3.rs:406) -- exactly the integer-overflow class that sinks
  most hand-rolled container parsers, handled correctly with a code comment
  explaining why.
- Read caps everywhere. SCAN_CAP/MOOV_SCAN_CAP/MAX_JPEG (cr3.rs:644, 711,
  774, 823) bound every grow-loop against a malformed file with no moov/no
  mdat SOI, so a hostile or corrupt CR3 cannot force an unbounded read or OOM.
- XMP atomic writes are correct. Temp-sibling + fsync + rename
  (xmp.rs:50-71) with a process-wide sequence number so two overlapping
  writers can never share a temp name (xmp.rs:46) -- the right pattern, and
  it is followed consistently in tier_cache.rs and file_ops.rs atomic_copy.
- Concurrency model for un-abortable I/O. bundle::gated (bundle.rs:68-103)
  is a well-reasoned design: since blocking fs reads cannot be safely
  cancelled on Windows/macOS, the wrapper times out the frontend-visible
  future while letting the orphaned spawn_blocking task keep running and
  self-heal, with a dlog! breadcrumb when it does. This correctly separates
  "the UI must not hang" from "the OS read must not be corrupted by a hard
  abort."
- Tier cache correctness. Versioned binary format with a magic + version
  byte that invalidates all tiers on any header shape change (tier_cache.rs:
  41-48), dual validators (mtime + size) to avoid a hot-path stat, and
  eviction/delete correctly split so file deletes happen outside the mutex
  (tier_cache.rs:323-329) -- materially better than the naive
  delete-under-lock design most caches ship with.
- Test discipline. 27 test modules with real synthetic fixtures, explicit
  edge-case tests for overflow/cancellation/malformed input, and a
  well-labeled corpus-gated test tier (CULL_TEST_CR3_DIR) that degrades to a
  clean skip rather than a CI failure when fixtures are absent.
- ml_models.rs LazySession is a clean, minimal abstraction: OnceLock for
  both the path and the session, Mutex around the ort::Session for !Sync
  inference calls, silent-degrade on init failure logged via dlog! rather
  than surfaced as a user-facing error. Exactly right for an advisory,
  never-blocking ML tier.

## Findings

### MEDIUM

1. No fuzz target for the CR3/JPEG parser (cr3.rs: jpeg_extent/boxes/Tiff).
   The code is defensively written, but it is still a hand-rolled binary
   parser consuming files from SD cards or NAS shares that could be
   corrupted, truncated mid-write, or in principle hostile. There is no
   cargo-fuzz/afl harness anywhere in the repo. Given the quality of the
   existing bounds checks a fuzzer would likely find little today, but it is
   the standard due-diligence step for this exact code shape (integer-driven
   offset arithmetic over untrusted bytes) and is cheap to add: a single
   harness feeding raw bytes into cr3::preview_jpeg, full_jpeg_location, and
   read_preview_bundle (via a temp file) would cover the highest-value
   surface.
   Fix: add fuzz/fuzz_targets/cr3_parse.rs under cargo-fuzz, seeded with
   sample_cr3s/.

2. af_crop panics on a zero-dimension decoded preview (analyze.rs:326):

       let side = ((AF_CROP_FRAC * w.min(h) as f32) as usize).clamp(1, w.min(h));

   usize::clamp(min, max) panics if min > max. If w.min(h) == 0 (a decoded
   PRVW with a 0-pixel dimension -- not rejected by jpeg_rgb::decode_rgb,
   which only checks rgb.len() == w*h*3, a check zero dimensions trivially
   satisfy), this becomes .clamp(1, 0) and panics. This runs inside
   analyze_quality (a spawn_blocking task), so today a panic here is caught
   at the task boundary and surfaces as a generic Err rather than a process
   crash -- but it is a real, if narrow, panic path fed by preview bytes
   extracted from a CR3, worth closing explicitly rather than relying on
   unwind safety.
   Fix: guard in score_one/af_crop -- return early when w == 0 or h == 0, or
   change the clamp to .clamp(1, w.min(h).max(1)).

3. Sidecar move/trash results discarded with let _ = (file_ops.rs:112,
   file_ops.rs:184). Confirmed from the prior review: op_one(&src_xmp,
   &dest_xmp, &op) and trash_op(&src_xmp) results are dropped, so a CR3
   move/copy/trash that succeeds while its sidecar op silently fails leaves
   the user rating orphaned with no error surfaced, no retry, and no log
   line (unlike almost everywhere else in the codebase, which uses dlog!
   liberally for exactly this kind of best-effort failure).
   Fix: at minimum dlog! the sidecar error; consider counting it in
   FileOpResult (a sidecar_errors: u32 field) so the finish dialog can warn
   "N ratings did not travel with their photos."

4. write_xmp_rating does not verify the CR3 still exists (xmp.rs:84-109).
   Confirmed from the prior review: write_xmp_rating_sync operates purely on
   xmp_path derived from path, with no cr3.exists() check. A rating written
   after the source CR3 was deleted or moved out from under the app
   (external move, a race with move_rejects_to_subfolder) creates or updates
   an orphaned .xmp with no CR3 next to it. This is low-frequency but
   silent -- the invariant "only write when a corresponding CR3 exists" is
   implicit everywhere else (sidecars always ride a CR3 op) but not enforced
   here.
   Fix: return an error before the read-modify-write when the CR3 no longer
   exists, so the frontend's existing failed-write UX picks it up instead of
   silently authoring an orphan.

5. tier_cache.rs FNV-1a key has no collision defense (tier_cache.rs:95-102).
   A 64-bit hash of the path string is the sole cache key; two distinct
   paths that collide would silently serve each other cached bytes (wrong
   thumbnail/preview for a frame). FNV-1a's collision rate at 64 bits is
   astronomically low for realistic corpus sizes, so this is not a practical
   risk today, but it is an unvalidated assumption with no comment
   explaining why it is acceptable, unlike the rest of the file's careful
   contract documentation.
   Fix: either a short comment stating the accepted risk (matching the
   file's own documentation style), or store the source path in the entry
   and verify it on get() -- cheap since the read is already happening.

### LOW

6. cargo clippy flags chunks_exact(3) in two hot loops (analyze.rs:283,
   phash.rs:15), suggesting the newer as_chunks::<3>() API. Purely
   stylistic, zero behavior difference, not worth an #[allow] either way --
   safe to apply or ignore.
7. ort is pinned to =2.0.0-rc.12 (Cargo.toml:87,90) -- an exact pin on a
   pre-1.0 release candidate is the right call for stability, but means
   security patches in ort/bundled ONNX Runtime binaries require a manual
   bump; worth a cargo-audit/Dependabot rule specifically on this crate
   given it ships a native binary via download-binaries.
8. memory_pressure.rs's FFI block is well-justified (SAFETY comments present
   at every unsafe site, memory_pressure.rs:108-136, 181) but the leaked
   Box<Ctx> (memory_pressure.rs:102-103) has no cleanup path beyond "lives
   until process exit" -- true and fine for a single long-lived dispatch
   source, and already commented as deliberate; listed here only because a
   fresh reviewer will flag the raw Box::into_raw on first read.

## Clippy summary

cargo clippy --all-targets (default features, i.e. smart-ml on) is clean:
2 warnings, both the same lint (clippy::chunks_exact_to_as_chunks, a
pedantic-adjacent suggestion new to recent clippy versions), zero errors,
zero #[allow]-suppressed lints found anywhere in the source. No -D warnings
failures. This is a very low warning count for 8.6k lines with a native FFI
feature enabled.

## Panic-surface inventory (cr3.rs / xmp.rs / scan.rs)

Production code in all three files contains zero unwrap()/expect() calls.
Every unwrap/expect occurrence in cr3.rs (9), xmp.rs (23), and scan.rs (9)
is inside a #[cfg(test)] mod tests block operating on test-constructed data,
not on untrusted input. Indexing on external bytes is consistently routed
through bounds-checked helpers. Representative audit:

| Site | Pattern | Risk |
|---|---|---|
| cr3.rs:75 fourcc read d[i+4..i+8] | preceded by i + 8 <= end check | safe |
| cr3.rs:100-106 d[p..p+4], d[soi..box_end] | p+8>hi bounds check before slice; find_soi range-bounded | safe |
| cr3.rs:224 ASCII tag raw.split(0) | self.d.get(voff..voff+cnt)? -- ? on None, no panic | safe |
| cr3.rs:963-964 datetime slicing &s[0..4] etc | explicit b.len()>=19 && b[..19].is_ascii() guard against mid-char-boundary panics on non-ASCII | safe, deliberately defended |
| cr3.rs:727 buf[0]/buf[1] SOI check | preceded by buf.len() < 2 check | safe |
| xmp.rs:340-347 set_desc_attr byte slicing | positions from str::find, which always returns char-boundary-aligned offsets | safe |
| xmp.rs:363-372 remove_desc_attr b[start-1] | start > 0 checked in the while condition itself | safe |
| scan.rs: no raw indexing on filesystem-derived strings | uses Path/OsStr APIs and get-free iterator combinators throughout | safe |

The one meaningful gap found by tracing data flow out of these three files
is Finding 2 (af_crop in analyze.rs, fed directly by
cr3::read_preview_bundle's decoded output) -- flagged above since it is the
actual panic-reachable path from CR3-derived bytes.

Two intentional, justified expect() calls exist elsewhere in the crate and
are worth noting for completeness since they are easy to mistake for
carelessness on a quick grep: io_gate.rs:108
(sem.acquire_owned().await.expect("IoGate semaphore closed")) and
midtier.rs:166 (same pattern for MidGen) -- both semaphores are
process-lifetime and never explicitly closed, so this can only fire on a
tokio runtime bug -- and lib.rs:223
(.run(...).expect("error while running tauri application")) is the
top-level main-equivalent boilerplate every Tauri app ships.

## Build hygiene

- Profiles: [profile.release] sets opt-level=3, lto=true, codegen-units=1,
  strip=true with an explicit, correct comment on not using panic=abort (a
  decode panic inside spawn_blocking must unwind so the command returns Err
  instead of taking the app down). [profile.dev] sets opt-level=1 for the
  crate and opt-level=3 for all dependencies -- a good compromise keeping
  hot byte-scan loops from being painfully slow under tauri dev while
  preserving fast incremental rebuilds.
- Dependency count: 244 unique normal-dependency crates (cargo tree -e
  normal), which is heavy in absolute terms but unremarkable for a Tauri 2
  desktop app (webview/menu/dialog/fs plugin chains dominate the count).
  cargo tree -d shows the duplicate-version pairs are all inside Tauri's own
  transitive graph (bitflags, indexmap/hashbrown, getrandom, semver), none
  introduced by CULL's own direct dependencies.
- ort (ONNX Runtime) is the one native/non-pure-Rust dependency, and it is
  correctly gated behind the default-but-optional smart-ml feature
  (Cargo.toml:30), with --no-default-features producing a lean build that
  compiles without it -- exactly the right shape for an optional heavy
  feature.
- Unsafe blocks: 5, all in memory_pressure.rs, all with // SAFETY: comments
  (lines 108, 113-114, 123, 180-181). No unsafe anywhere else in the crate
  (cr3.rs's hand-rolled binary parsing is done entirely in safe Rust via
  bounds-checked slicing -- notably disciplined for this problem domain).
  Every unsafe use is either FFI-call-inherent (GlobalMemoryStatusEx,
  dispatch_*) or a documented unsafe impl Send justified by the actual usage
  pattern.

## Top 10 prioritized recommendations

1. Add a cargo-fuzz harness over cr3::read_preview_bundle /
   full_jpeg_location seeded from sample_cr3s/ (Finding 1).
2. Guard af_crop/score_one against a 0x0 decoded preview to eliminate the
   one real panic path reachable from CR3 bytes (Finding 2).
3. Log (and ideally surface in FileOpResult) sidecar move/trash failures
   instead of let _ = (Finding 3) -- already known, still open.
4. Add a CR3-existence check to write_xmp_rating_sync before writing
   (Finding 4) -- already known, still open.
5. Document or close the FNV-1a collision assumption in tier_cache.rs
   (Finding 5).
6. Add a cargo-audit/Dependabot rule specifically watching the pinned ort
   version given its native binary payload.
7. Apply or dismiss the two as_chunks clippy suggestions for consistency
   with the rest of the very-low-warning baseline.
8. Consider a short fuzz/property test for xmp.rs's string-surgery
   functions (set_desc_attr/remove_desc_attr/insert_after_about) against
   arbitrary third-party XMP (not just LrC's), since they parse foreign
   sidecars that could in principle come from any tool.
9. No action needed, but call out the memory_pressure.rs leaked Box<Ctx> in
   onboarding docs/comments for future contributors (it already has a
   rationale comment; just easy to misflag on a fast pass).
10. Keep the current advisory-ML, silent-degrade, dlog!-logged pattern
    (ml_models.rs) as the template for any future ML tier -- it is the
    correct shape and should not be refactored toward hard failures.
