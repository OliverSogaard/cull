# Phase 0 — Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every silent-failure and data-safety finding of the 2026-09-13 audit so CULL can never report "saved" for a sidecar that did not land, never orphan a sidecar in a folder a photo has left, never hide a file-operation, listing, sidecar-read or full-res failure, and never panic on a degenerate preview — shipped as one PR on branch `phase-0-safety`.

**Architecture:** Backend refuses sidecar writes for a CR3 that is not there and counts every sidecar move/trash result; the finish flow tells the frontend which sources are gone and the frontend prunes those frames from the live session (images, ratings, cursor, history, image store) without a generation bump. Listing and sidecar-read failures come back on `AnalyzeResult` and surface as a status-bar chip; the zoom tier's error state reaches the pane as a retry chip. Every fix is a pure function or a `spawn_blocking`-free helper with its own unit test; no new dependencies.

**Tech Stack:** Rust 1.98 (Tauri 2, serde, std fs), React 19 + TypeScript 5.8 strict, Vitest 4 (node environment, no DOM), pnpm 10. Windows + macOS only.

**Spec:** `docs/superpowers/audits/2026-09-13-full-app-audit/audit.md` — §5.1 Robustness, §5.7 Tests/CI/release (hygiene items), §5.8 Rust backend (af_crop), §6 "Phase 0 — Safety", §8 Decisions. Reviewer detail in `reports/silent-failures.md` and `reports/rust-backend.md` next to it.

## Global Constraints

- Nothing is pushed or merged without Oliver's say-so; the branch `phase-0-safety` and its PR are what Phase 0 delivers. His git attribution is disabled (no `Co-Authored-By`).
- CR3 files are never modified; the only writes are `{basename}.xmp` sidecars (ARCHITECTURE.md invariant). The new rule: **no CR3 at the path, no sidecar write.**
- Never drive the running app against Oliver's real photo folders (`C:\Canon Media\...`) with rating keys or file operations. Live checks use a scratch copy under `%TEMP%` only.
- Every task ends with the suites green: `pnpm test`, `pnpm typecheck && pnpm typecheck:tests`, `pnpm lint && pnpm lint:css`, `cargo test`, `cargo clippy --all-targets -- -D warnings`, `cargo fmt --check` (run from `src-tauri/`, with `export PATH="$HOME/.cargo/bin:$PATH"` in Git Bash).
- Commit messages: `<type>: <description>` (feat, fix, refactor, docs, test, chore, perf, ci), one commit per task, prettier-formatted TS (`pnpm format` is allowed on touched files only — do not reformat untouched files).
- Timing-sensitive paths (imageStore lanes, presenter, zoom choreography) get the narrowest possible change and a unit test in the existing harness; no restructuring.
- Windows + macOS only; never add Linux handling. Tests that touch the filesystem use `std::env::temp_dir()` + `std::process::id()` like the existing suites.

---

## File Structure

| File | Responsibility in this plan |
| --- | --- |
| `docs/superpowers/audits/2026-09-13-full-app-audit/` | The audit (spec) + 8 reviewer reports, committed first. |
| `.gitignore`, `.gitattributes` | Hygiene: `.dev-logs/`, `src-tauri/Cargo.toml text eol=lf`. |
| `package.json`, `pnpm-lock.yaml` | Vite 7.3.6 (GHSA-fx2h-pf6j-xcff). |
| `src-tauri/src/xmp.rs` | `MISSING_SOURCE` + `require_source()` guard on both write commands; `read_ratings` returns `Result`. |
| `src/utils/writeFailure.ts` (new) | `isPermanentWriteError()` — the frontend half of the guard. |
| `src/app/useRatingPersistence.ts` | No retries for a permanent failure. |
| `src-tauri/src/file_ops.rs` | `SourceFate`, `note_error()`, sidecar failures counted, `gone` list. |
| `src/types/ipc.ts` | `FileOpResult.gone`, `AnalyzeResult` warning fields. |
| `src/image/imageStore.ts` | `forget(gone)` + `dropPath()`; `debugStats().cursor`. |
| `src/utils/pruneSession.ts` (new) | Pure `pruneGone`, `remapIndex`, `omitIds`, `pruneHistory`. |
| `src/app/useSessionLifecycle.ts` | `pruneMoved()`, analyze warnings, `writeLocalStorage`. |
| `src/App.tsx` | `doMoveRejects` prunes; `analyzeWarning` chip; `gone: []` literals. |
| `src-tauri/src/jpeg_rgb.rs`, `src-tauri/src/analyze.rs` | `validate_dims()` rejects 0×0; `af_crop` total on empty buffers. |
| `src-tauri/src/scan.rs` | `list_parents()`, `restore_ratings()` extracted with progress callbacks; failures accounted on `AnalyzeResult`. |
| `src/utils/analyzeWarnings.ts` (new) | `summarizeAnalyzeWarnings()` → chip label + detail. |
| `src/image/stage.ts` | `Resolved.fullError`. |
| `src/components/pane/PhotoPane.tsx` | "full-res failed · retry" chip replaces the endless zoom ring. |
| `src/utils/storage.ts` (new) | `writeLocalStorage()` never throws. |
| `ARCHITECTURE.md`, `README.md` | Rating-write rule, prune-after-move, warning chips. |

---

### Task 1: Audit document + this plan (first commit)

**Files:**
- Create: `docs/superpowers/audits/2026-09-13-full-app-audit/audit.md` (copied from `~/.claude/plans/cull-audit-2026-09-13/audit.md`)
- Create: `docs/superpowers/audits/2026-09-13-full-app-audit/reports/*.md` (8 files, copied)
- Create: `docs/superpowers/plans/2026-09-14-phase-0-safety.md` (this file)

- [ ] **Step 1: Branch**

```bash
cd /c/Users/OSA/Developer/cull && git switch -c phase-0-safety
```

- [ ] **Step 2: Copy the audit + reports** (screenshots stay out: 1.3 MB of captures, still at `~/.claude/plans/cull-audit-2026-09-13/shots/` on the Windows PC)

```bash
mkdir -p docs/superpowers/audits/2026-09-13-full-app-audit/reports
cp ~/.claude/plans/cull-audit-2026-09-13/audit.md docs/superpowers/audits/2026-09-13-full-app-audit/
cp ~/.claude/plans/cull-audit-2026-09-13/reports/*.md docs/superpowers/audits/2026-09-13-full-app-audit/reports/
```

Prepend one line under the title of the copied `audit.md`: `> Screenshots referenced as \`shots/\` are not in the repo (1.3 MB); they live with the original at \`~/.claude/plans/cull-audit-2026-09-13/\` on the Windows PC.`

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/audits docs/superpowers/plans/2026-09-14-phase-0-safety.md
git commit -m "docs: full app audit (2026-09-13) + Phase 0 safety plan"
```

---

### Task 2: Repo hygiene — `.dev-logs/` and LF `Cargo.toml`

**Files:**
- Modify: `.gitignore`
- Modify: `.gitattributes`

Why: `pnpm tauri dev/build` rewrites `src-tauri/Cargo.toml` with LF, so on Windows (`* text=auto` + `core.autocrlf=true`) `git status` shows it modified after every run, and reverting it restarts the dev app. `.dev-logs/` is currently ignored only via the untracked `.git/info/exclude`.

- [ ] **Step 1: Edit `.gitignore`** — after the `# Logs` block add:

```gitignore
# Dev-server logs from `pnpm tauri dev` redirects (see TESTING.md)
.dev-logs/
```

- [ ] **Step 2: Edit `.gitattributes`** — after the `*.sh text eol=lf` line add:

```gitattributes
# The Tauri CLI rewrites this file with LF on every dev/build run; pinning
# LF keeps `git status` clean on Windows and stops the revert → watcher →
# app-restart loop.
src-tauri/Cargo.toml text eol=lf
```

- [ ] **Step 3: Re-checkout `Cargo.toml` under the new attribute and drop the local exclude line**

```bash
rm src-tauri/Cargo.toml && git checkout -- src-tauri/Cargo.toml
git ls-files --eol src-tauri/Cargo.toml     # expect: i/lf    w/lf    attr/text eol=lf
sed -i '/^\.dev-logs\/$/d' .git/info/exclude
git status --short                          # expect: only .gitattributes and .gitignore modified
```

- [ ] **Step 4: Commit**

```bash
git add .gitignore .gitattributes
git commit -m "chore: ignore .dev-logs/, keep src-tauri/Cargo.toml LF on Windows"
```

---

### Task 3: Vite 7.3.6

**Files:**
- Modify: `package.json`, `pnpm-lock.yaml`

- [ ] **Step 1: Update in range** (`^7.0.4` → 7.3.6 is the latest 7.x; 8.x is out of range and out of scope)

```bash
pnpm update vite
grep -n '"vite"' package.json         # expect ^7.3.6 (or unchanged range if pnpm keeps ^7.0.4 — both fine)
pnpm audit 2>&1 | grep -c "│ vite " # expect 0
```

- [ ] **Step 2: Verify the frontend still builds and tests**

```bash
pnpm test && pnpm build
```

Expected: all suites pass; `dist/` builds.

- [ ] **Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore(deps): vite 7.3.6 (GHSA-fx2h-pf6j-xcff)"
```

---

### Task 4: Backend refuses sidecar writes when the CR3 is gone

**Files:**
- Modify: `src-tauri/src/xmp.rs` (write/clear commands at lines ~84–170, tests module at ~561)
- Modify: `ARCHITECTURE.md` "Rating writes (XMP sidecars)" section (~line 128)

**Interfaces:**
- Produces: `pub(crate) const MISSING_SOURCE: &str = "source missing"` — the error prefix Task 5 matches on. Error shape: `"source missing: <path>"`.

- [ ] **Step 1: Write the failing tests** (append inside `mod tests` in `xmp.rs`)

```rust
    /// Rating a CR3 that is no longer at its path (moved by "Move rejects",
    /// deleted outside CULL) must refuse — never write an orphan sidecar into
    /// the old folder and report "saved".
    #[test]
    fn write_refuses_when_cr3_is_missing() {
        let work = std::env::temp_dir().join(format!("cull-xmp-nosrc-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&work);
        std::fs::create_dir_all(&work).unwrap();
        let cr3 = work.join("moved.cr3"); // never created

        let err = write_xmp_rating_sync(&cr3.to_string_lossy(), "keep").unwrap_err();
        assert!(err.starts_with(MISSING_SOURCE), "{err}");
        assert!(!cr3.with_extension("xmp").exists(), "no orphan sidecar written");

        let _ = std::fs::remove_dir_all(&work);
    }

    /// Unrating a missing CR3 refuses too, and leaves whatever sidecar is
    /// there untouched — ownership can't be verified without the photo.
    #[test]
    fn clear_refuses_when_cr3_is_missing_and_leaves_sidecar() {
        let work = std::env::temp_dir().join(format!("cull-xmp-noclr-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&work);
        std::fs::create_dir_all(&work).unwrap();
        let cr3 = work.join("gone.cr3");
        let xmp = cr3.with_extension("xmp");
        std::fs::write(&xmp, b"<orphan/>").unwrap();

        let err = clear_xmp_rating_sync(&cr3.to_string_lossy()).unwrap_err();
        assert!(err.starts_with(MISSING_SOURCE), "{err}");
        assert_eq!(std::fs::read(&xmp).unwrap(), b"<orphan/>", "sidecar untouched");

        let _ = std::fs::remove_dir_all(&work);
    }
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd src-tauri && cargo test xmp::tests::write_refuses_when_cr3_is_missing xmp::tests::clear_refuses
```

Expected: compile error `cannot find value MISSING_SOURCE` (or, once the const exists, `unwrap_err` panics on `Ok`).

- [ ] **Step 3: Implement** — above `write_xmp_rating` add:

```rust
/// Refusal prefix for a sidecar write whose CR3 is no longer at its path. The
/// frontend matches on it (`utils/writeFailure.ts`) to skip its retry
/// schedule: nothing short of putting the photo back can make the write land.
pub(crate) const MISSING_SOURCE: &str = "source missing";

/// A sidecar is only ever written next to a CR3 that is actually there.
///
/// After "Move rejects" the frontend prunes the moved frames, but a stale
/// cell, an undo replay or a file deleted outside CULL could still ask — and
/// used to get a real, orphaned `.xmp` in the old folder plus a "saved"
/// report (audit 2026-09-13, CRITICAL). A transient stat failure (NAS blip) is
/// reported as such so the frontend's normal retry schedule still applies.
fn require_source(cr3: &Path) -> Result<(), String> {
    match std::fs::metadata(cr3) {
        Ok(md) if md.is_file() => Ok(()),
        Ok(_) => Err(format!("{MISSING_SOURCE}: {} is not a file", cr3.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            Err(format!("{MISSING_SOURCE}: {}", cr3.display()))
        }
        Err(e) => Err(format!("stat source {}: {e}", cr3.display())),
    }
}
```

Then, in both `write_xmp_rating_sync` and `clear_xmp_rating_sync`, immediately after `let cr3 = Path::new(path);` insert `require_source(cr3)?;`.

- [ ] **Step 4: Run the whole xmp suite**

```bash
cargo test xmp::
```

Expected: all pass, including `command_wrappers_round_trip_on_disk` (it creates its CR3).

- [ ] **Step 5: Document** — in `ARCHITECTURE.md` "Rating writes (XMP sidecars)", after the retry paragraph add:

```markdown
A write is refused outright when the CR3 is no longer at its path
(`xmp::require_source`, error prefix `source missing:`) — after "Move rejects"
the moved frames are pruned from the session (see "Finishing a cull" below),
so this only fires for a file deleted outside CULL. The frontend recognises
the prefix and records the failure without retrying (`utils/writeFailure.ts`).
```

- [ ] **Step 6: fmt, clippy, commit**

```bash
cargo fmt && cargo clippy --all-targets -- -D warnings && cd ..
git add src-tauri/src/xmp.rs ARCHITECTURE.md
git commit -m "fix: refuse sidecar writes when the CR3 is no longer at its path"
```

---

### Task 5: Frontend does not retry a permanent write failure

**Files:**
- Create: `src/utils/writeFailure.ts`
- Create: `src/utils/writeFailure.test.ts`
- Modify: `src/app/useRatingPersistence.ts` (`tryWrite`, ~line 79)

**Interfaces:**
- Consumes: the `"source missing: …"` error string from Task 4.
- Produces: `isPermanentWriteError(e: unknown): boolean`.

- [ ] **Step 1: Failing test** — `src/utils/writeFailure.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { isPermanentWriteError, MISSING_SOURCE_PREFIX } from "./writeFailure";

describe("isPermanentWriteError", () => {
  it("recognises the backend's missing-source refusal (string or Error)", () => {
    expect(isPermanentWriteError(`${MISSING_SOURCE_PREFIX} C:\\shoot\\_rejected\\a.cr3`)).toBe(true);
    expect(isPermanentWriteError(new Error("source missing: /v/a.cr3 is not a file"))).toBe(true);
  });

  it("treats every other failure as transient (retry schedule applies)", () => {
    expect(isPermanentWriteError("rename xmp: EACCES")).toBe(false);
    expect(isPermanentWriteError("stat source /v/a.cr3: EIO")).toBe(false);
    expect(isPermanentWriteError(undefined)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm vitest run src/utils/writeFailure.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `src/utils/writeFailure.ts`

```ts
/**
 * The backend refuses a sidecar write when the CR3 is no longer at its path
 * (`xmp.rs` `MISSING_SOURCE`). Retrying cannot help — only putting the photo
 * back can — so the write is recorded as failed at once instead of after the
 * 400/1500/4000 ms schedule.
 */
export const MISSING_SOURCE_PREFIX = "source missing:";

export function isPermanentWriteError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  return msg.startsWith(MISSING_SOURCE_PREFIX);
}
```

- [ ] **Step 4: Wire it** — in `useRatingPersistence.ts` import `isPermanentWriteError` and change `tryWrite`:

```ts
    const tryWrite = (n: number): Promise<unknown> =>
      invoke(cmd, args).catch((e) => {
        // A missing-source refusal is permanent: retrying only delays the
        // honest "didn't save" by six seconds.
        if (n < WRITE_RETRY_DELAYS.length && !isPermanentWriteError(e)) {
          return new Promise((resolve, reject) =>
            window.setTimeout(() => tryWrite(n + 1).then(resolve, reject), WRITE_RETRY_DELAYS[n]),
          );
        }
        throw e;
      });
```

- [ ] **Step 5: Verify**

```bash
pnpm vitest run src/utils/writeFailure.test.ts && pnpm typecheck && pnpm lint
```

- [ ] **Step 6: Commit**

```bash
git add src/utils/writeFailure.ts src/utils/writeFailure.test.ts src/app/useRatingPersistence.ts
git commit -m "fix: record a missing-source sidecar refusal without retrying"
```

---

### Task 6: Sidecar accounting + the `gone` list in file operations

**Files:**
- Modify: `src-tauri/src/file_ops.rs` (whole module; tests at ~232)

**Interfaces:**
- Produces on the wire (camelCase): `FileOpResult { completed, skipped, errors, errorCount, gone: string[] }`. `gone` = source paths no longer at their original location after a move/trash (completed + already-missing on entry); always empty for copy.
- Internal: `enum SourceFate { Consumed, Retained }`, `fn note_error(result: &mut FileOpResult, msg: String)`.

- [ ] **Step 1: Failing tests** — append inside `mod tests`:

```rust
    /// A sidecar that fails to follow its CR3 is an error the user sees —
    /// the CR3 still counts as completed (it did move), but the batch can no
    /// longer report 100 % success with a rating left behind.
    #[test]
    fn batch_counts_sidecar_failure() {
        let work = tmp_dir("batch-xmp-fail");
        let src = work.join("k.cr3");
        fs::write(&src, b"cr3").unwrap();
        fs::write(work.join("k.xmp"), b"<xmp/>").unwrap();
        let dest = work.join("out");
        fs::create_dir_all(&dest).unwrap();

        let r = batch_files(
            &[src.to_string_lossy().to_string()],
            &dest,
            |s, d| {
                if s.extension().is_some_and(|e| e == "xmp") {
                    Err(std::io::Error::other("xmp boom"))
                } else {
                    fs::rename(s, d)
                }
            },
            SourceFate::Consumed,
        );
        assert_eq!(r.completed, 1, "the CR3 itself moved");
        assert_eq!(r.error_count, 1, "the sidecar failure is counted");
        assert!(r.errors[0].contains("sidecar"), "{}", r.errors[0]);
        let _ = fs::remove_dir_all(&work);
    }

    /// Move: completed sources and sources already missing on entry are
    /// `gone`; a destination collision leaves the source in place (not gone).
    #[test]
    fn batch_move_lists_gone_sources() {
        let work = tmp_dir("batch-gone");
        let moved = work.join("m.cr3");
        let missing = work.join("missing.cr3"); // never created
        let collides = work.join("c.cr3");
        fs::write(&moved, b"cr3").unwrap();
        fs::write(&collides, b"cr3").unwrap();
        let dest = work.join("_rejected");
        fs::create_dir_all(&dest).unwrap();
        fs::write(dest.join("c.cr3"), b"already").unwrap();

        let paths: Vec<String> = [&moved, &missing, &collides]
            .iter()
            .map(|p| p.to_string_lossy().to_string())
            .collect();
        let r = batch_files(&paths, &dest, |s, d| fs::rename(s, d), SourceFate::Consumed);
        assert_eq!((r.completed, r.skipped, r.error_count), (1, 2, 0));
        assert_eq!(r.gone, vec![paths[0].clone(), paths[1].clone()]);
        assert!(collides.exists(), "collision skip leaves the source where it was");
        let _ = fs::remove_dir_all(&work);
    }

    /// Copy never consumes its source, so nothing is ever `gone`.
    #[test]
    fn batch_copy_lists_nothing_gone() {
        let work = tmp_dir("batch-copy-gone");
        let src = work.join("a.cr3");
        fs::write(&src, b"cr3").unwrap();
        let dest = work.join("out");
        fs::create_dir_all(&dest).unwrap();

        let r = batch_files(
            &[src.to_string_lossy().to_string()],
            &dest,
            |s, d| fs::copy(s, d).map(|_| ()),
            SourceFate::Retained,
        );
        assert_eq!(r.completed, 1);
        assert!(r.gone.is_empty());
        assert!(src.exists());
        let _ = fs::remove_dir_all(&work);
    }

    /// An input with no filename is an error in the COUNT as well as the list
    /// (the UI shows `errorCount`; the list alone used to read as 0 errors).
    #[test]
    fn no_filename_input_counts_as_error() {
        let work = tmp_dir("batch-nofilename");
        let dest = work.join("out");
        fs::create_dir_all(&dest).unwrap();
        let r = batch_files(
            &["/dev/null-0/".to_string()],
            &dest,
            |s, d| fs::copy(s, d).map(|_| ()),
            SourceFate::Retained,
        );
        assert_eq!(r.error_count, 1);
        assert_eq!(r.errors.len(), 1);
        let _ = fs::remove_dir_all(&work);
    }

    /// trash_batch: trashed and already-missing sources are `gone`; a sidecar
    /// that fails to follow is counted.
    #[test]
    fn trash_batch_lists_gone_and_counts_sidecar_failure() {
        let work = tmp_dir("trash-gone");
        let a = work.join("a.cr3");
        fs::write(&a, b"cr3").unwrap();
        fs::write(work.join("a.xmp"), b"<xmp/>").unwrap();
        let gone_already = work.join("gone.cr3");
        let paths = vec![
            a.to_string_lossy().to_string(),
            gone_already.to_string_lossy().to_string(),
        ];

        let r = trash_batch(&paths, |p| {
            if p.extension().is_some_and(|e| e == "xmp") {
                Err("xmp boom".to_string())
            } else {
                fs::remove_file(p).map_err(|e| e.to_string())
            }
        });
        assert_eq!((r.completed, r.skipped, r.error_count), (1, 1, 1));
        assert_eq!(r.gone, paths);
        assert!(r.errors[0].contains("sidecar"));
        let _ = fs::remove_dir_all(&work);
    }
```

Also update the existing tests for the new parameter: every `batch_files(&paths, &dest, |s, d| fs::rename(s, d))` call gains `, SourceFate::Consumed` and every `fs::copy(...)` variant gains `, SourceFate::Retained`. In `batch_error_cap` add `assert_eq!(r.error_count as usize, FILE_OP_ERROR_CAP + 10);`.

- [ ] **Step 2: Run to verify they fail**

```bash
cd src-tauri && cargo test file_ops::
```

Expected: compile errors (`SourceFate`, `gone` unknown).

- [ ] **Step 3: Implement**

Add to `FileOpResult`:

```rust
    /// Source paths no longer at their original location once the batch is
    /// done: completed moves plus sources already missing on entry. Empty for
    /// copies. The frontend prunes these frames from the live session so a
    /// stale cell can never write a sidecar into the folder the photo left.
    gone: Vec<String>,
```

Add after `FILE_OP_ERROR_CAP`:

```rust
/// Whether a batch op takes the source away (move / trash) or leaves it in
/// place (copy). Decides what lands in [`FileOpResult::gone`].
#[derive(Clone, Copy, PartialEq, Eq)]
enum SourceFate {
    Consumed,
    Retained,
}

/// Count an error in full and store its message only while the list is under
/// the cap — the one place the cap rule lives.
fn note_error(result: &mut FileOpResult, msg: String) {
    result.error_count += 1;
    if result.errors.len() < FILE_OP_ERROR_CAP {
        result.errors.push(msg);
    }
}
```

Rewrite `batch_files`:

```rust
/// Batch-apply an op to a list of CR3 paths, taking each path's `.xmp` sidecar
/// along for the ride. Skips files whose destination already exists OR whose
/// source no longer exists (idempotent re-runs). A sidecar that fails to
/// follow is counted as an error (the CR3 still counts as completed — it did
/// move). Caps the stored error list so a folder full of failures can't
/// balloon the response.
fn batch_files(
    paths: &[String],
    dest_dir: &Path,
    op: impl Fn(&Path, &Path) -> std::io::Result<()>,
    fate: SourceFate,
) -> FileOpResult {
    let mut result = FileOpResult::default();
    for path in paths {
        let src = Path::new(path);
        let Some(name) = src.file_name() else {
            note_error(&mut result, format!("no filename: {path}"));
            continue;
        };
        // Idempotency: a source already moved on a prior pass is a skip, not an
        // error — and it is `gone` for a consuming op.
        if !src.exists() {
            result.skipped += 1;
            if fate == SourceFate::Consumed {
                result.gone.push(path.clone());
            }
            continue;
        }
        let dest = dest_dir.join(name);
        // Never overwrite: a destination collision leaves the source in place.
        if dest.exists() {
            result.skipped += 1;
            continue;
        }
        match op_one(src, &dest, &op) {
            Ok(()) => {
                result.completed += 1;
                if fate == SourceFate::Consumed {
                    result.gone.push(path.clone());
                }
                follow_sidecar(src, dest_dir, &op, &mut result);
            }
            Err(e) => note_error(&mut result, format!("{}: {e}", src.display())),
        }
    }
    result
}

/// The `.xmp` sidecar follows its CR3. A sidecar already present at the
/// destination is never overwritten (a lone existing .xmp could carry the
/// user's edits); a sidecar that fails to move is an error the batch reports.
fn follow_sidecar(
    src: &Path,
    dest_dir: &Path,
    op: &impl Fn(&Path, &Path) -> std::io::Result<()>,
    result: &mut FileOpResult,
) {
    let src_xmp = src.with_extension("xmp");
    if !src_xmp.exists() {
        return;
    }
    let Some(xmp_name) = src_xmp.file_name() else {
        return;
    };
    let dest_xmp = dest_dir.join(xmp_name);
    if dest_xmp.exists() {
        return;
    }
    if let Err(e) = op_one(&src_xmp, &dest_xmp, op) {
        note_error(
            result,
            format!("{}: sidecar did not follow: {e}", src.display()),
        );
    }
}
```

Update callers: `move_rejects_to_subfolder` → `batch_files(&paths, &dest, |s, d| std::fs::rename(s, d), SourceFate::Consumed)`; `copy_keeps_to_export` → `batch_files(&paths, &dest_dir, atomic_copy, SourceFate::Retained)`.

Rewrite `trash_batch`'s loop body:

```rust
        let src = Path::new(path);
        if !src.exists() {
            result.skipped += 1;
            result.gone.push(path.clone());
            continue;
        }
        match trash_op(src) {
            Ok(()) => {
                result.completed += 1;
                result.gone.push(path.clone());
                let src_xmp = src.with_extension("xmp");
                if src_xmp.exists() {
                    if let Err(e) = trash_op(&src_xmp) {
                        note_error(
                            &mut result,
                            format!("{}: sidecar did not follow: {e}", src.display()),
                        );
                    }
                }
            }
            Err(e) => note_error(&mut result, format!("{}: {e}", src.display())),
        }
```

Update the module doc comment: replace "(best effort)" phrasing with "a sidecar that fails to follow is counted in the result".

- [ ] **Step 4: Verify**

```bash
cargo test file_ops:: && cargo clippy --all-targets -- -D warnings && cargo fmt --check && cd ..
```

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/file_ops.rs
git commit -m "fix: count sidecar move/trash failures and report which sources are gone"
```

---

### Task 7: `imageStore.forget(gone)` — drop paths without a generation bump

**Files:**
- Modify: `src/image/imageStore.ts` (add `forget` + `dropPath` next to `reset` at ~525; add `cursor` to `debugStats()` at ~1548)
- Test: `src/image/imageStore.test.ts`

Why not `reset(survivors)`: reset bumps the generation, revokes every nav preview and clears `wantFull`, so the mounted loupe/compare consumers (whose paths did not change) would never re-register and would sit on a blurred thumb until the next navigation. `forget` keeps survivors' tiers, pins, subscriptions and the user's place.

**Interfaces:**
- Produces: `forget(gone: ReadonlySet<string>): void`; `debugStats().cursor: number`.

- [ ] **Step 1: Failing test** — add a `describe("forget", …)` block to `imageStore.test.ts` using the file's existing helpers (`getStoreClass`, `makeThumbnailBuf`, `makeBundleBuf`, `liveUrls`):

```ts
describe("forget (frames that left the session after Move rejects)", () => {
  it("drops gone paths, revokes their blobs, keeps survivors reference-stable and the cursor on its frame", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockImplementation((cmd: unknown) =>
      cmd === "extract_thumbnail"
        ? Promise.resolve(makeThumbnailBuf(800, 600))
        : Promise.resolve(makeBundleBuf()),
    );
    const Store = await getStoreClass();
    const store = new Store();
    const [a, b, c] = ["/f/a.cr3", "/f/b.cr3", "/f/c.cr3"];
    store.reset([a, b, c]);
    for (const p of [a, b, c]) store.requestThumbFor(p);
    await vi.waitUntil(() => [a, b, c].every((p) => store.snapshot(p).thumbUrl !== undefined), {
      timeout: 2000,
    });
    const bUrl = store.snapshot(b).thumbUrl!;
    const aSnap = store.snapshot(a);
    store.setCursor(2); // parked on c

    store.forget(new Set([b]));

    expect(store.snapshot(a)).toBe(aSnap); // survivor untouched
    expect(liveUrls.has(bUrl)).toBe(false); // gone blob revoked
    expect(store.snapshot(b).thumbUrl).toBeUndefined();
    expect(store.debugStats().caches.thumbs).toBe(2);
    expect(store.debugStats().cursor).toBe(1); // still on c, now index 1
  });

  it("clamps the cursor when its own frame is gone and ignores unknown paths", async () => {
    const Store = await getStoreClass();
    const store = new Store();
    const [a, b, c] = ["/g/a.cr3", "/g/b.cr3", "/g/c.cr3"];
    store.reset([a, b, c]);
    store.setCursor(2);
    store.forget(new Set([c, "/g/not-in-session.cr3"]));
    expect(store.debugStats().cursor).toBe(1);
    store.forget(new Set<string>()); // no-op
    expect(store.debugStats().cursor).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm vitest run src/image/imageStore.test.ts -t forget
```

Expected: FAIL — `store.forget is not a function`.

- [ ] **Step 3: Implement** — after `reset()` in `imageStore.ts`:

```ts
  /**
   * Drop paths that left the session (a finished cull moved them to the
   * rejects subfolder or the Trash) WITHOUT a generation bump: survivors keep
   * every tier, pin and subscription, and the user's place is preserved by
   * path (`reset()` would revoke every nav preview and clear `wantFull`, and
   * the mounted loupe/compare consumers — whose paths did not change — would
   * never re-register). Gone paths have their blobs revoked and every
   * per-path record removed. A read still in flight for a gone path lands as
   * a stray entry that the next cursor-driven eviction sweeps.
   */
  forget(gone: ReadonlySet<string>): void {
    if (gone.size === 0) return;
    const cursorPath = this.paths[this.cursor];
    this.paths = this.paths.filter((p) => !gone.has(p));
    this.rebuildPathIndex();
    for (const lane of [this.thumbLane, this.bgLane, this.navLane, this.zoomLane, this.midLane]) {
      lane.queue = lane.queue.filter((p) => !gone.has(p));
    }
    for (const p of gone) this.dropPath(p);
    this.gridStart = -1;
    this.gridEnd = -1;
    const at = cursorPath === undefined ? -1 : this.indexOf(cursorPath);
    const next = at !== -1 ? at : Math.min(this.cursor, Math.max(0, this.paths.length - 1));
    this.cursor = next; // set first so setCursor's direction bookkeeping sees no move
    this.setCursor(next); // re-centres the keep-windows, prefetch and the decode pool
  }

  /** Remove every per-path record for `p` and revoke its blobs. Consumer-owned
   *  refcounts (wantFull / displayRefs / pinnedFulls) are left alone: the cell
   *  that displayed a gone path unmounts and decrements on its own. */
  private dropPath(p: string): void {
    const t = this.thumbs.get(p);
    if (t) URL.revokeObjectURL(t.url);
    this.thumbs.delete(p);
    const f = this.fulls.get(p);
    if (f?.status === "ready") URL.revokeObjectURL(f.url);
    this.fulls.delete(p);
    const z = this.zoomFulls.get(p);
    if (z?.status === "ready") URL.revokeObjectURL(z.url);
    this.zoomFulls.delete(p);
    const m = this.mids.get(p);
    if (m?.status === "ready") URL.revokeObjectURL(m.url);
    this.mids.delete(p);
    this.states.delete(p);
    this.snaps.delete(p);
    for (const set of [
      this.requestedThumb,
      this.requestedFull,
      this.requestedZoom,
      this.requestedMid,
      this.pendingZoom,
      this.pendingMid,
      this.midUncached,
      this.midReprobed,
    ]) {
      set.delete(p);
    }
    for (const map of [this.thumbErrors, this.fullErrors, this.zoomErrors, this.midErrors]) {
      map.delete(p);
    }
    this.fullHints.delete(p);
    this.nativeDims.delete(p);
    this.pathDims.delete(p);
    this.trouble.clearPath(p);
  }
```

If `TierLane.queue` is declared `readonly`, change it to a plain public field (`queue: string[] = []` — it already is at `tierLane.ts:60`; confirm). Add `cursor: this.cursor,` to the object `debugStats()` returns and `cursor: number;` to its return type. If the executor finds a per-path `Map`/`Set` on the class not listed above (grep `new Map<string` / `new Set<string>` in the class body), add it to `dropPath` too.

- [ ] **Step 4: Verify the whole store suite and types**

```bash
pnpm vitest run src/image && pnpm typecheck && pnpm typecheck:tests && pnpm lint
```

- [ ] **Step 5: Commit**

```bash
git add src/image/imageStore.ts src/image/imageStore.test.ts
git commit -m "feat(imageStore): forget() drops moved frames without a generation bump"
```

---

### Task 8: Pure session-prune helpers

**Files:**
- Create: `src/utils/pruneSession.ts`
- Create: `src/utils/pruneSession.test.ts`

**Interfaces (Task 9 consumes exactly these):**

```ts
export type SessionCursor = { currentIndex: number; championIndex: number; challengerIndex: number };
export type PruneInput = { images: readonly Img[]; navStack: readonly NavEntry[] } & SessionCursor;
export type PruneOutput = { images: Img[]; navStack: NavEntry[]; goneIds: Set<number> } & SessionCursor;
export function pruneGone(input: PruneInput, gone: readonly string[]): PruneOutput | null;
export function remapIndex(before: readonly Img[], after: readonly Img[], index: number): number;
export function omitIds<T>(map: Readonly<Record<number, T>>, ids: ReadonlySet<number>): Record<number, T>;
export function pruneHistory(stack: readonly UndoAction[], goneIds: ReadonlySet<number>): UndoAction[];
```

- [ ] **Step 1: Failing tests** — `src/utils/pruneSession.test.ts`

```ts
import { describe, expect, it } from "vitest";
import type { Img, NavEntry, UndoAction } from "../types";
import { omitIds, pruneGone, pruneHistory, remapIndex } from "./pruneSession";

const img = (id: number): Img => ({ id, path: `/s/${id}.cr3`, filename: `${id}.cr3`, srcFolder: "/s" });
const five = [0, 1, 2, 3, 4].map(img);

describe("remapIndex", () => {
  it("follows the same frame when it survives", () => {
    const after = five.filter((im) => im.id !== 1);
    expect(remapIndex(five, after, 3)).toBe(2);
  });
  it("lands on the next survivor when the frame itself is gone, clamped at the end", () => {
    const after = five.filter((im) => im.id !== 2 && im.id !== 4);
    expect(remapIndex(five, after, 2)).toBe(2); // → id 3
    expect(remapIndex(five, after, 4)).toBe(2); // last survivor
  });
  it("is 0 for an empty result or an out-of-range index", () => {
    expect(remapIndex(five, [], 3)).toBe(0);
    expect(remapIndex(five, five, 99)).toBe(0);
  });
});

describe("pruneGone", () => {
  it("returns null when no listed path is in the session", () => {
    expect(
      pruneGone(
        { images: five, navStack: [], currentIndex: 0, championIndex: 0, challengerIndex: 0 },
        ["/elsewhere/x.cr3"],
      ),
    ).toBeNull();
  });
  it("removes gone frames, remaps every cursor by frame and rewrites compare nav entries", () => {
    const nav: NavEntry[] = [{ site: "grid" }, { site: "compare", champ: 3, chall: 4 }];
    const out = pruneGone(
      { images: five, navStack: nav, currentIndex: 3, championIndex: 3, challengerIndex: 4 },
      ["/s/1.cr3", "/s/4.cr3"],
    );
    expect(out).not.toBeNull();
    expect(out!.images.map((im) => im.id)).toEqual([0, 2, 3]);
    expect(out!.goneIds).toEqual(new Set([1, 4]));
    expect(out!.currentIndex).toBe(2); // id 3
    expect(out!.championIndex).toBe(2);
    expect(out!.challengerIndex).toBe(2); // id 4 gone → clamped to the last survivor
    expect(out!.navStack).toEqual([{ site: "grid" }, { site: "compare", champ: 2, chall: 2 }]);
  });
  it("never mutates its input", () => {
    const nav: NavEntry[] = [{ site: "loupe" }];
    const input = { images: five, navStack: nav, currentIndex: 0, championIndex: 0, challengerIndex: 0 };
    pruneGone(input, ["/s/0.cr3"]);
    expect(input.images).toHaveLength(5);
    expect(nav).toEqual([{ site: "loupe" }]);
  });
});

describe("omitIds", () => {
  it("drops the listed ids and leaves the rest", () => {
    expect(omitIds({ 1: "keep", 2: "reject", 3: "favorite" }, new Set([2]))).toEqual({
      1: "keep",
      3: "favorite",
    });
  });
});

describe("pruneHistory", () => {
  const change = (imgId: number) => ({ imgId, path: `/s/${imgId}.cr3`, before: undefined, after: "keep" as const });
  it("drops changes for gone frames, drops emptied actions and strips stale cursor snapshots", () => {
    const stack: UndoAction[] = [
      { changes: [change(1)] },
      {
        changes: [change(2), change(3)],
        cursorBefore: { compareMode: true, championIndex: 2, challengerIndex: 3, currentIndex: 2 },
        cursorAfter: { compareMode: true, championIndex: 3, challengerIndex: 4, currentIndex: 3 },
      },
    ];
    const out = pruneHistory(stack, new Set([1, 2]));
    expect(out).toEqual([{ changes: [change(3)] }]);
    expect(stack[1].cursorBefore).toBeDefined(); // input untouched
  });
  it("returns the same array when nothing is affected", () => {
    const stack: UndoAction[] = [{ changes: [change(7)] }];
    expect(pruneHistory(stack, new Set([1]))).toBe(stack);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm vitest run src/utils/pruneSession.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `src/utils/pruneSession.ts`

```ts
import type { Img, NavEntry, UndoAction } from "../types";

/**
 * Pure helpers for taking frames OUT of a live session after "Move rejects"
 * (subfolder or Trash). The backend reports which sources are gone
 * (`FileOpResult.gone`); everything index-based follows the FRAME, not the
 * slot, so the user keeps their place and the undo history stays sound.
 */

export type SessionCursor = {
  currentIndex: number;
  championIndex: number;
  challengerIndex: number;
};

export type PruneInput = { images: readonly Img[]; navStack: readonly NavEntry[] } & SessionCursor;
export type PruneOutput = { images: Img[]; navStack: NavEntry[]; goneIds: Set<number> } & SessionCursor;

/** The index in `after` of the frame at `index` in `before`; when that frame
 *  is gone, the first survivor at or after its old position (clamped to the
 *  last survivor); 0 when nothing survives or the index was out of range. */
export function remapIndex(before: readonly Img[], after: readonly Img[], index: number): number {
  if (after.length === 0) return 0;
  const target = before[index];
  if (!target) return 0;
  const same = after.findIndex((im) => im.id === target.id);
  if (same !== -1) return same;
  const survivors = new Set(after.map((im) => im.id));
  let ahead = 0;
  for (let i = 0; i < index; i++) if (survivors.has(before[i].id)) ahead++;
  return Math.min(ahead, after.length - 1);
}

/** Remove the frames whose files left the session. `null` when no listed
 *  path is in the set (nothing to do — a copy, or every reject was skipped). */
export function pruneGone(input: PruneInput, gone: readonly string[]): PruneOutput | null {
  const gonePaths = new Set(gone);
  const goneIds = new Set(input.images.filter((im) => gonePaths.has(im.path)).map((im) => im.id));
  if (goneIds.size === 0) return null;
  const images = input.images.filter((im) => !goneIds.has(im.id));
  const remap = (i: number) => remapIndex(input.images, images, i);
  const navStack = input.navStack.map((e) =>
    e.site === "compare" ? { ...e, champ: remap(e.champ), chall: remap(e.chall) } : e,
  );
  return {
    images,
    navStack,
    goneIds,
    currentIndex: remap(input.currentIndex),
    championIndex: remap(input.championIndex),
    challengerIndex: remap(input.challengerIndex),
  };
}

/** A copy of `map` without the listed ids (rating map keyed by frame id). */
export function omitIds<T>(map: Readonly<Record<number, T>>, ids: ReadonlySet<number>): Record<number, T> {
  const out: Record<number, T> = {};
  for (const [k, v] of Object.entries(map)) {
    const id = Number(k);
    if (!ids.has(id)) out[id] = v;
  }
  return out;
}

/** Undo/redo entries after a prune: changes for gone frames are dropped (their
 *  files are not in the folder any more — replaying would ask the backend to
 *  write a sidecar it now refuses), actions left empty are dropped, and the
 *  compare-cursor snapshots are stripped because their indices are stale —
 *  undo/redo then land by frame id (`useUndoRedo`'s existing fallback).
 *  Returns the same array when nothing is affected. */
export function pruneHistory(stack: readonly UndoAction[], goneIds: ReadonlySet<number>): UndoAction[] {
  const touched = stack.some(
    (a) => a.cursorBefore || a.cursorAfter || a.changes.some((c) => goneIds.has(c.imgId)),
  );
  if (!touched) return stack as UndoAction[];
  const out: UndoAction[] = [];
  for (const action of stack) {
    const changes = action.changes.filter((c) => !goneIds.has(c.imgId));
    if (changes.length > 0) out.push({ changes });
  }
  return out;
}
```

- [ ] **Step 4: Verify**

```bash
pnpm vitest run src/utils/pruneSession.test.ts && pnpm typecheck:tests && pnpm lint
```

- [ ] **Step 5: Commit**

```bash
git add src/utils/pruneSession.ts src/utils/pruneSession.test.ts
git commit -m "feat: pure helpers to prune moved frames from a live session"
```

---

### Task 9: Wire the prune — `FileOpResult.gone` → `pruneMoved()` → `doMoveRejects`

**Files:**
- Modify: `src/types/ipc.ts` (`FileOpResult`)
- Modify: `src/app/useSessionLifecycle.ts` (new params, `pruneMoved`, return it)
- Modify: `src/App.tsx` (`useSessionLifecycle` call ~583, `doMoveRejects` ~676–731, `FileOpResult` literals at ~691, ~703, ~745, ~766)

**Interfaces:**
- Consumes: `imageStore.forget` (Task 7), `pruneGone`/`omitIds`/`pruneHistory` (Task 8), backend `gone` (Task 6).
- Produces: `pruneMoved(gone: readonly string[]): void` returned by `useSessionLifecycle`.

- [ ] **Step 1: Type** — in `src/types/ipc.ts` add to `FileOpResult`:

```ts
  /**
   * Source paths no longer at their original location once the batch is done
   * (completed moves + sources already missing on entry). Always empty for a
   * copy. `doMoveRejects` prunes these frames from the live session.
   */
  gone: string[];
```

- [ ] **Step 2: Run typecheck to see every site that must change**

```bash
pnpm typecheck
```

Expected: errors at the four `FileOpResult` literals in `App.tsx` (missing `gone`).

- [ ] **Step 3: `useSessionLifecycle`** — add params (both the destructure and the type):

```ts
  currentIndex,
  championIndex,
  challengerIndex,
  navStack,
  setChampionIndex,
  setChallengerIndex,
```

```ts
  currentIndex: number;
  championIndex: number;
  challengerIndex: number;
  navStack: NavEntry[];
  setChampionIndex: Dispatch<SetStateAction<number>>;
  setChallengerIndex: Dispatch<SetStateAction<number>>;
```

Import `omitIds, pruneGone, pruneHistory` from `../utils/pruneSession`. Add before `resetSession`:

```ts
  // After "Move rejects" (subfolder or Trash): take the moved frames out of
  // the live session in place. Everything index-based follows the frame, the
  // undo/redo history loses the moved frames' changes, and the image store
  // forgets them WITHOUT a generation bump (survivors keep their tiers and
  // the mounted panes keep their registrations). A stale cell for a moved
  // photo used to write a real, orphaned sidecar into the old folder.
  const pruneMoved = useCallback(
    (gone: readonly string[]) => {
      const next = pruneGone(
        { images: imagesRef.current, navStack, currentIndex, championIndex, challengerIndex },
        gone,
      );
      if (!next) return;
      imagesRef.current = next.images;
      setImages(next.images);
      setRatings((prev) => omitIds(prev, next.goneIds));
      setMetadata((prev) => {
        const out = { ...prev };
        for (const p of gone) delete out[p];
        return out;
      });
      setCurrentIndex(next.currentIndex);
      setChampionIndex(next.championIndex);
      setChallengerIndex(next.challengerIndex);
      setNavStack(next.navStack);
      setSelectedIndices(new Set());
      setSelectionAnchor(null);
      undoStack.current = pruneHistory(undoStack.current, next.goneIds);
      redoStack.current = pruneHistory(redoStack.current, next.goneIds);
      imageStore.forget(new Set(gone));
      writeSessionRecent(next.images, omitIds(ratings, next.goneIds));
    },
    [
      imagesRef,
      navStack,
      currentIndex,
      championIndex,
      challengerIndex,
      ratings,
      undoStack,
      redoStack,
      writeSessionRecent,
      setImages,
      setRatings,
      setMetadata,
      setCurrentIndex,
      setChampionIndex,
      setChallengerIndex,
      setNavStack,
      setSelectedIndices,
      setSelectionAnchor,
    ],
  );
```

Return it: `return { openFoldersByPaths, pickFolder, beginCulling, resetSession, leaveToHome, pruneMoved };`

- [ ] **Step 4: `App.tsx`** — destructure `pruneMoved` at the `useSessionLifecycle` call and pass the six new values (`currentIndex, championIndex, challengerIndex, navStack, setChampionIndex, setChallengerIndex` — all declared above line 583). Then in `doMoveRejects`:

  - trash branch: `const res = await invoke<FileOpResult>("move_rejects_to_trash", { paths: rejectedPaths }); setMoveResult(res); pruneMoved(res.gone);`
  - merged literal: `{ completed: 0, skipped: 0, errors: [], errorCount: 0, gone: [] }`; inside the loop add `merged.gone.push(...res.gone);`; after `setMoveResult(merged)` add `pruneMoved(merged.gone);`
  - the three error literals gain `gone: []`.
  - add `pruneMoved` to `doMoveRejects`'s dependency array.

Update the comment above `doMoveRejects` with one sentence: "Moved frames are then pruned from the session (`pruneMoved`)."

- [ ] **Step 5: Verify**

```bash
pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test
```

- [ ] **Step 6: Commit**

```bash
git add src/types/ipc.ts src/app/useSessionLifecycle.ts src/App.tsx
git commit -m "fix: prune moved rejects from the live session after Move rejects"
```

---

### Task 10: No panic on a 0×0 decoded preview

**Files:**
- Modify: `src-tauri/src/jpeg_rgb.rs` (`decode_rgb`, tests)
- Modify: `src-tauri/src/analyze.rs` (`af_crop` ~line 319, tests ~885)

- [ ] **Step 1: Failing tests**

`jpeg_rgb.rs` tests:

```rust
    #[test]
    fn validate_dims_rejects_empty_and_mismatched_buffers() {
        assert!(validate_dims(0, 0, 0).unwrap_err().contains("empty"));
        assert!(validate_dims(0, 4, 0).unwrap_err().contains("empty"));
        assert!(validate_dims(11, 2, 2).unwrap_err().contains("unexpected buffer"));
        assert_eq!(validate_dims(12, 2, 2), Ok(()));
    }
```

`analyze.rs` tests (next to `af_crop_clamps_to_buffer_at_edges`):

```rust
    /// A degenerate decode (0×0) must not panic in the clamp — the crop is
    /// empty and flagged invalid, and score_one never sees one anyway
    /// (jpeg_rgb::validate_dims rejects it upstream).
    #[test]
    fn af_crop_zero_sized_buffer_does_not_panic() {
        for (w, h) in [(0, 0), (0, 600), (1000, 0)] {
            let (rect, valid) = af_crop(1, Some(50.0), Some(50.0), w, h);
            assert_eq!((rect.x0, rect.y0, rect.x1, rect.y1), (0, 0, 0, 0));
            assert!(!valid);
        }
    }
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd src-tauri && cargo test validate_dims af_crop_zero
```

Expected: `validate_dims` not found; `af_crop_zero` panics (`clamp` with `min > max`).

- [ ] **Step 3: Implement**

`jpeg_rgb.rs` — add above `decode_rgb` and use it:

```rust
/// The decoded buffer must be exactly `w*h*3` bytes AND describe at least one
/// pixel: a 0×0 header passes the length check with an empty buffer and would
/// panic the AF-crop clamp downstream (audit 2026-09-13, analyze.rs:326).
fn validate_dims(len: usize, w: usize, h: usize) -> Result<(), String> {
    if w == 0 || h == 0 {
        return Err(format!("decode: empty image ({w}x{h})"));
    }
    if len != w * h * 3 {
        return Err(format!("decode: unexpected buffer ({len} bytes for {w}x{h} RGB)"));
    }
    Ok(())
}
```

and in `decode_rgb` replace the `if rgb.len() != w * h * 3 { … }` block with `validate_dims(rgb.len(), w, h)?;`.

`analyze.rs` — first lines of `af_crop`:

```rust
    if w == 0 || h == 0 {
        return (Rect { x0: 0, y0: 0, x1: 0, y1: 0 }, false);
    }
```

- [ ] **Step 4: Verify**

```bash
cargo test jpeg_rgb:: analyze::tests::af_crop && cargo clippy --all-targets -- -D warnings && cargo fmt --check && cd ..
```

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/jpeg_rgb.rs src-tauri/src/analyze.rs
git commit -m "fix: reject 0x0 decodes and make af_crop total"
```

---

### Task 11: Listing and sidecar-read failures are reported, not swallowed

**Files:**
- Modify: `src-tauri/src/xmp.rs` (`read_ratings` ~line 187)
- Modify: `src-tauri/src/scan.rs` (`AnalyzeResult` ~161, `analyze_folder_sync` 215–445, tests)
- Modify: `src-tauri/src/analyze.rs:1153` (calibration harness caller)

**Interfaces:**
- Produces on the wire (camelCase): `AnalyzeResult { order, ratings, lrcRatings, unreadableDirs: string[], restoreErrors: string[], restoreErrorCount: number }`.
- Internal: `read_ratings(&str) -> Result<(Option<String>, Option<u8>), String>` (absent sidecar → `Ok((None, None))`); `list_parents(&[String], &mut dyn FnMut(usize)) -> Listing`; `restore_ratings(&[String], &[usize], bool, &(dyn Fn(usize) + Sync)) -> Restore`.

- [ ] **Step 1: Failing tests**

`xmp.rs`:

```rust
    /// An absent sidecar is "unrated", not an error; a sidecar that exists but
    /// can't be read (here: a directory wearing the name) is an error the
    /// analyze pass reports instead of folding into "no rating".
    #[test]
    fn read_ratings_distinguishes_absent_from_unreadable() {
        let work = std::env::temp_dir().join(format!("cull-xmp-read-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&work);
        std::fs::create_dir_all(&work).unwrap();
        let absent = work.join("absent.cr3");
        assert_eq!(read_ratings(&absent.to_string_lossy()), Ok((None, None)));

        let blocked = work.join("blocked.cr3");
        std::fs::create_dir_all(blocked.with_extension("xmp")).unwrap();
        let err = read_ratings(&blocked.to_string_lossy()).unwrap_err();
        assert!(err.contains("blocked.xmp"), "{err}");
        let _ = std::fs::remove_dir_all(&work);
    }
```

`scan.rs` (inside `mod tests`):

```rust
    /// A parent directory that can't be listed is reported; the other
    /// parents still list normally.
    #[test]
    fn list_parents_reports_unreadable_parent() {
        let work = tmp_dir("list-unreadable");
        let real = work.join("real");
        fs::create_dir_all(&real).unwrap();
        let b = real.join("b.cr3");
        fs::write(&b, b"cr3").unwrap();
        let ghost = work.join("missing-dir").join("a.cr3");
        let paths = vec![
            ghost.to_string_lossy().to_string(),
            b.to_string_lossy().to_string(),
        ];
        let mut ticks = 0usize;
        let listing = list_parents(&paths, &mut |_| ticks += 1);
        assert_eq!(listing.unreadable.len(), 1, "{:?}", listing.unreadable);
        assert!(listing.unreadable[0].contains("missing-dir"));
        assert!(listing.mtime.contains_key(&paths[1]));
        assert_eq!(ticks, 1);
        let _ = fs::remove_dir_all(&work);
    }

    /// Restore: a readable sidecar restores; an unreadable one (a directory
    /// wearing the sidecar name) is counted and reported, and the frame reads
    /// back unrated. Same outcome on both restore paths.
    #[test]
    fn restore_reports_unreadable_sidecar_not_absent() {
        for concurrent in [false, true] {
            let work = tmp_dir(if concurrent { "restore-conc" } else { "restore-seq" });
            let a = work.join("a.cr3");
            let b = work.join("b.cr3");
            fs::write(&a, b"cr3").unwrap();
            fs::write(&b, b"cr3").unwrap();
            fs::create_dir_all(a.with_extension("xmp")).unwrap();
            fs::write(b.with_extension("xmp"), b"xmpDM:pick=\"1\" xmpDM:good=\"true\"").unwrap();
            // Pad with more sidecars so the concurrent branch actually splits.
            let mut paths = vec![a.to_string_lossy().to_string(), b.to_string_lossy().to_string()];
            for i in 0..6 {
                let p = work.join(format!("p{i}.cr3"));
                fs::write(&p, b"cr3").unwrap();
                fs::write(p.with_extension("xmp"), b"xmpDM:pick=\"-1\" xmpDM:good=\"false\"").unwrap();
                paths.push(p.to_string_lossy().to_string());
            }
            let to_read: Vec<usize> = (0..paths.len()).collect();
            let r = restore_ratings(&paths, &to_read, concurrent, &|_| {});
            assert_eq!(r.ratings[0], None, "concurrent={concurrent}");
            assert_eq!(r.ratings[1].as_deref(), Some("keep"));
            assert_eq!(r.ratings[2].as_deref(), Some("reject"));
            assert_eq!(r.error_count, 1);
            assert!(r.errors[0].contains("a.xmp"), "{}", r.errors[0]);
            let _ = fs::remove_dir_all(&work);
        }
    }
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd src-tauri && cargo test read_ratings_distinguishes list_parents_reports restore_reports
```

Expected: compile errors (`list_parents`, `restore_ratings` missing; `read_ratings` result shape).

- [ ] **Step 3: `xmp.rs`** — change `read_ratings`:

```rust
/// … (keep the existing doc) …
/// Absent sidecar → `Ok((None, None))` (unrated). Any other read failure is
/// an `Err` the analyze pass counts and reports — a sidecar that IS there but
/// can't be read must not silently become "no rating".
pub(crate) fn read_ratings(cr3_path: &str) -> Result<(Option<String>, Option<u8>), String> {
    let xmp = Path::new(cr3_path).with_extension("xmp");
    match std::fs::read_to_string(&xmp) {
        Ok(content) => Ok((classify_xmp(&content), parse_lrc_rating(&content))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok((None, None)),
        Err(e) => Err(format!("{}: {e}", xmp.display())),
    }
}
```

Fix the existing caller in `xmp.rs`'s `command_wrappers_round_trip_on_disk`: `read_ratings(&p).unwrap().0`. In `analyze.rs:1153`: `let (user, _lrc) = crate::xmp::read_ratings(p).unwrap_or((None, None));`.

- [ ] **Step 4: `scan.rs`** — split `analyze_folder_sync` into the two pure passes it orchestrates. Add after `RESTORE_WORKERS`:

```rust
/// Stored restore-error messages are capped (IPC size); the count is exact.
const RESTORE_ERROR_CAP: usize = 20;

/// What one pass over the distinct parent directories found.
struct Listing {
    mtime: HashMap<String, i64>,
    sizes: HashMap<String, u64>,
    /// Lowercased `path-without-extension` of every `.xmp` seen.
    xmp_stems: HashSet<String>,
    /// Parent directories that could not be listed, as `"<dir>: <error>"`.
    /// Their frames have no mtime (sort last) and no discovered sidecar (read
    /// back unrated) — the UI shows a warning chip instead of staying silent.
    unreadable: Vec<String>,
}

/// Enumerate each distinct parent dir ONCE (see the fast-path note on
/// `analyze_folder`). `on_progress(done)` fires once per staged file matched.
fn list_parents(paths: &[String], on_progress: &mut dyn FnMut(usize)) -> Listing {
    let want: HashSet<&str> = paths.iter().map(String::as_str).collect();
    let parents: HashSet<&Path> = paths.iter().filter_map(|p| Path::new(p).parent()).collect();
    let mut out = Listing {
        mtime: HashMap::new(),
        sizes: HashMap::new(),
        xmp_stems: HashSet::new(),
        unreadable: Vec::new(),
    };
    let mut done = 0usize;
    for dir in parents {
        let entries = match std::fs::read_dir(dir) {
            Ok(entries) => entries,
            Err(e) => {
                out.unreadable.push(format!("{}: {e}", dir.display()));
                continue;
            }
        };
        for entry in entries.flatten() {
            // … the existing loop body, verbatim, writing into `out.*` …
            // replace `done += 1; if done.is_multiple_of(step) || done == n { window.emit(…) }`
            // with:   done += 1; on_progress(done);
        }
    }
    out
}

/// Ratings restored from the sidecars in `to_read`.
struct Restore {
    ratings: Vec<Option<String>>,
    lrc_ratings: Vec<Option<u8>>,
    /// Sidecars that exist but could not be read, `"<path>: <error>"`, capped.
    errors: Vec<String>,
    error_count: u32,
}

fn note_restore_error(r: &mut Restore, msg: String) {
    r.error_count += 1;
    if r.errors.len() < RESTORE_ERROR_CAP {
        r.errors.push(msg);
    }
}

/// Read the sidecars we KNOW exist — sequentially (NAS default) or on
/// `RESTORE_WORKERS` threads (`concurrent`, local SSD). `on_progress(done)`
/// fires after each sidecar (from worker threads on the concurrent path).
fn restore_ratings(
    paths: &[String],
    to_read: &[usize],
    concurrent: bool,
    on_progress: &(dyn Fn(usize) + Sync),
) -> Restore {
    let n = paths.len();
    let mut out = Restore {
        ratings: vec![None; n],
        lrc_ratings: vec![None; n],
        errors: Vec::new(),
        error_count: 0,
    };
    type Read = (usize, Result<(Option<String>, Option<u8>), String>);
    let reads: Vec<Read> = if concurrent && to_read.len() > RESTORE_WORKERS {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let done_counter = AtomicUsize::new(0);
        let chunk_size = to_read.len().div_ceil(RESTORE_WORKERS);
        let done_ref = &done_counter;
        std::thread::scope(|s| {
            let mut handles = Vec::with_capacity(RESTORE_WORKERS);
            for chunk in to_read.chunks(chunk_size) {
                handles.push(s.spawn(move || {
                    let mut part: Vec<Read> = Vec::with_capacity(chunk.len());
                    for &i in chunk {
                        part.push((i, read_ratings(&paths[i])));
                        on_progress(done_ref.fetch_add(1, Ordering::Relaxed) + 1);
                    }
                    part
                }));
            }
            let mut all: Vec<Read> = Vec::with_capacity(to_read.len());
            for h in handles {
                match h.join() {
                    Ok(part) => all.extend(part),
                    // A panicked restore worker must not poison the whole
                    // analyze: its chunk reads back as unrated — and, unlike
                    // before, the UI is told (one counted error).
                    Err(_) => {
                        dlog!("[cull] analyze_folder: restore worker panicked; its chunk restores as unrated");
                        // The index is never read on the Err arm of the fold below.
                        all.push((
                            usize::MAX,
                            Err("restore worker panicked; its frames read back unrated".to_string()),
                        ));
                    }
                }
            }
            all
        })
    } else {
        to_read
            .iter()
            .enumerate()
            .map(|(idx, &i)| {
                let r = read_ratings(&paths[i]);
                on_progress(idx + 1);
                (i, r)
            })
            .collect()
    };
    for (i, r) in reads {
        match r {
            Ok((rating, lrc)) => {
                out.ratings[i] = rating;
                out.lrc_ratings[i] = lrc;
            }
            Err(e) => note_restore_error(&mut out, e),
        }
    }
    out
}
```

Keep the panicked-worker handling (a panicked chunk yields an empty part; also `note_restore_error(&mut out, "restore worker panicked; its chunk reads back unrated".into())` so it is no longer invisible). `analyze_folder_sync` becomes the orchestration: compute `step`, call `list_parents(&paths, &mut |done| { if done.is_multiple_of(step) || done == n { emit "reading" } })`, emit the terminal tick, `session.note_mtimes/sizes`, build `epoch` and `to_read` from the listing, call `restore_ratings(&paths, &to_read, concurrent_restore, &|done| { if done.is_multiple_of(step_xmp) || done == total_xmp { emit "restoring" } })`, `order_by_capture`, emit "done", and return:

```rust
    Ok(AnalyzeResult {
        order,
        ratings: restore.ratings,
        lrc_ratings: restore.lrc_ratings,
        unreadable_dirs: listing.unreadable,
        restore_errors: restore.errors,
        restore_error_count: restore.error_count,
    })
```

`AnalyzeResult` gains (with doc comments) `unreadable_dirs: Vec<String>`, `restore_errors: Vec<String>`, `restore_error_count: u32`; the `n == 0` early return fills them with empty values. `tauri::Window` is `Send + Sync`, so the emit closures satisfy `Fn(usize) + Sync`.

- [ ] **Step 5: Verify**

```bash
cargo test scan:: xmp:: analyze:: && cargo clippy --all-targets -- -D warnings && cargo fmt --check && cd ..
```

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/scan.rs src-tauri/src/xmp.rs src-tauri/src/analyze.rs
git commit -m "fix: report unreadable folders and sidecars from the analyze pass"
```

---

### Task 12: Analyze warnings reach the status bar

**Files:**
- Modify: `src/types/ipc.ts` (`AnalyzeResult`)
- Create: `src/utils/analyzeWarnings.ts`, `src/utils/analyzeWarnings.test.ts`
- Modify: `src/app/useSessionLifecycle.ts` (`beginCulling`, `resetSession`, new param)
- Modify: `src/App.tsx` (state, hook param, chip next to the folder-trouble chip ~line 1985)

**Interfaces:**
- Consumes: the three new `AnalyzeResult` fields (Task 11).
- Produces: `summarizeAnalyzeWarnings(r): AnalyzeWarning | null` with `AnalyzeWarning = { label: string; detail: string }`.

- [ ] **Step 1: Type** — add to `AnalyzeResult` in `ipc.ts`:

```ts
  /** Parent folders the analyze pass could not list (`"<dir>: <error>"`):
   *  their frames sort last and read back unrated. */
  unreadableDirs: string[];
  /** Sidecars that exist but could not be read (`"<path>: <error>"`), capped
   *  at 20 — `restoreErrorCount` is the true total. */
  restoreErrors: string[];
  restoreErrorCount: number;
```

- [ ] **Step 2: Failing test** — `src/utils/analyzeWarnings.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { summarizeAnalyzeWarnings } from "./analyzeWarnings";

describe("summarizeAnalyzeWarnings", () => {
  it("is null when nothing went wrong", () => {
    expect(summarizeAnalyzeWarnings({ unreadableDirs: [], restoreErrors: [], restoreErrorCount: 0 })).toBeNull();
  });
  it("labels folders and ratings with correct plurals and lists the detail", () => {
    const w = summarizeAnalyzeWarnings({
      unreadableDirs: ["D:\\shoot\\b: access denied"],
      restoreErrors: ["D:\\shoot\\a.xmp: EIO"],
      restoreErrorCount: 3,
    });
    expect(w?.label).toBe("1 folder not listed · 3 ratings not restored");
    expect(w?.detail).toContain("D:\\shoot\\b: access denied");
    expect(w?.detail).toContain("…and 2 more");
    expect(w?.detail).toContain("click to dismiss");
  });
  it("omits the part that is clean", () => {
    expect(
      summarizeAnalyzeWarnings({ unreadableDirs: [], restoreErrors: ["x: y"], restoreErrorCount: 1 })?.label,
    ).toBe("1 rating not restored");
  });
});
```

- [ ] **Step 3: Implement** — `src/utils/analyzeWarnings.ts`

```ts
import type { AnalyzeResult } from "../types";

/** Status-bar chip text for the analyze pass's non-fatal failures. */
export type AnalyzeWarning = { label: string; detail: string };

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/**
 * Turn the analyze pass's failure lists into one chip: a short label
 * ("1 folder not listed · 3 ratings not restored") and a multi-line detail
 * for the tooltip. `null` when the pass was clean.
 */
export function summarizeAnalyzeWarnings(
  r: Pick<AnalyzeResult, "unreadableDirs" | "restoreErrors" | "restoreErrorCount">,
): AnalyzeWarning | null {
  const dirs = r.unreadableDirs ?? [];
  const errs = r.restoreErrors ?? [];
  const errCount = r.restoreErrorCount ?? errs.length;
  if (dirs.length === 0 && errCount === 0) return null;
  const parts: string[] = [];
  const lines: string[] = [];
  if (dirs.length > 0) {
    parts.push(`${count(dirs.length, "folder")} not listed`);
    lines.push("Folders that couldn't be listed (their frames sort last, ratings not restored):", ...dirs);
  }
  if (errCount > 0) {
    parts.push(`${count(errCount, "rating")} not restored`);
    lines.push("Sidecars that couldn't be read:", ...errs);
    if (errCount > errs.length) lines.push(`…and ${errCount - errs.length} more`);
  }
  lines.push("click to dismiss");
  return { label: parts.join(" · "), detail: lines.join("\n") };
}
```

- [ ] **Step 4: Wire** — `useSessionLifecycle` gets `setAnalyzeWarning: Dispatch<SetStateAction<AnalyzeWarning | null>>`; `beginCulling` calls `setAnalyzeWarning(null)` next to `setAnalyzeError(null)` and, right after `setRatings(restoredRatings)`, `setAnalyzeWarning(summarizeAnalyzeWarnings(result));` `resetSession` sets it to `null`. `App.tsx`: `const [analyzeWarning, setAnalyzeWarning] = useState<AnalyzeWarning | null>(null);` passed into the hook; render right after the folder-trouble chip's closing `)}`:

```tsx
          {analyzeWarning && (
            <button
              type="button"
              className="cull-trouble-chip"
              title={analyzeWarning.detail}
              onClick={() => setAnalyzeWarning(null)}
            >
              ⚠ {analyzeWarning.label}
            </button>
          )}
```

- [ ] **Step 5: Verify**

```bash
pnpm vitest run src/utils/analyzeWarnings.test.ts && pnpm typecheck && pnpm typecheck:tests && pnpm lint
```

- [ ] **Step 6: Commit**

```bash
git add src/types/ipc.ts src/utils/analyzeWarnings.ts src/utils/analyzeWarnings.test.ts src/app/useSessionLifecycle.ts src/App.tsx
git commit -m "feat: status-bar chip for folders and sidecars the analyze pass could not read"
```

---

### Task 13: A failed full-res read is visible while zooming

**Files:**
- Modify: `src/image/stage.ts` (`Resolved`, `resolveStage`)
- Modify: `src/image/stage.test.ts`
- Modify: `src/components/pane/PhotoPane.tsx` (zoom loading ring block ~line 421)

**Interfaces:**
- Produces: `Resolved.fullError: string | undefined` (the zoom tier's error while it is in the error state).

- [ ] **Step 1: Failing test** — append to `stage.test.ts`:

```ts
  it("exposes the zoom tier's error as fullError, cleared once it is ready", () => {
    const thumb = { url: "t", dims: { w: 6, h: 4 } };
    const errored = resolveStage({ thumb, full: { status: "ready", url: "f", dims: { w: 6, h: 4 } }, zoomFull: { status: "error", error: "range read failed" } });
    expect(errored.fullError).toBe("range read failed");
    expect(errored.full).toBeUndefined();
    const ready = resolveStage({ thumb, full: { status: "ready", url: "f", dims: { w: 6, h: 4 } }, zoomFull: { status: "ready", url: "z", dims: undefined } });
    expect(ready.fullError).toBeUndefined();
    expect(resolveStage(base).fullError).toBeUndefined();
  });
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm vitest run src/image/stage.test.ts
```

Expected: FAIL — `fullError` undefined on the errored case.

- [ ] **Step 3: Implement** — in `stage.ts` add to `Resolved`:

```ts
  /** The zoom tier's error while it is in the error state — the pane shows a
   *  "full-res failed · retry" chip instead of an endless loading ring. */
  fullError: string | undefined;
```

In `resolveStage` compute `const fullError = s.zoomFull?.status === "error" ? s.zoomFull.error : undefined;` and add `fullError` to all three returned objects. Fix any literal `Resolved` objects that `pnpm typecheck:tests` flags.

- [ ] **Step 4: PhotoPane** — replace the zoom loading ring block:

```tsx
      {/* Zoom loading ring: zoomed but the sharp raster isn't in place yet
          (fetching or decoding) — tells the user when the pixels are real.
          The 150ms CSS reveal delay keeps cached zooms ring-free. */}
      {isZooming && !hiResReady && !img.fullError && (
        <div className="cull-photo-frame__spinner-wrap" aria-hidden>
          <div className="cull-loading__spinner" />
        </div>
      )}
      {/* The 32 MP read failed while the user is judging sharpness: say so
          instead of spinning forever (the store's auto-retry backs off up to
          MAX_TIER_ATTEMPTS; this chip is the manual way through). retry()
          clears the error state; the explicit request re-queues the read —
          the zoom effects key on path/zoom, which did not change. */}
      {isZooming && !hiResReady && img.fullError && (
        <div className="cull-error-chip" title={img.fullError}>
          <span>full-res failed</span>
          <button
            type="button"
            onClick={() => {
              imageStore.retry(path);
              imageStore.requestZoomFull(path);
            }}
          >
            retry
          </button>
        </div>
      )}
```

- [ ] **Step 5: Verify**

```bash
pnpm vitest run src/image && pnpm typecheck && pnpm typecheck:tests && pnpm lint
```

- [ ] **Step 6: Commit**

```bash
git add src/image/stage.ts src/image/stage.test.ts src/components/pane/PhotoPane.tsx
git commit -m "fix: show a retry chip when the zoom-tier read fails instead of spinning forever"
```

---

### Task 14: A storage write can never fail a scan

**Files:**
- Create: `src/utils/storage.ts`, `src/utils/storage.test.ts`
- Modify: `src/app/useSessionLifecycle.ts:249`, `src/App.tsx:155` and `:755` (the three unguarded `localStorage.setItem` calls)

- [ ] **Step 1: Failing test** — `src/utils/storage.test.ts`

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeLocalStorage } from "./storage";

afterEach(() => vi.unstubAllGlobals());

describe("writeLocalStorage", () => {
  it("writes and reports true", () => {
    const setItem = vi.fn();
    vi.stubGlobal("localStorage", { setItem });
    expect(writeLocalStorage("cull:lastDir", "D:\\shoot")).toBe(true);
    expect(setItem).toHaveBeenCalledWith("cull:lastDir", "D:\\shoot");
  });
  it("swallows a quota / private-mode failure and reports false", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("localStorage", {
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    });
    expect(writeLocalStorage("cull:lastDir", "x")).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
  it("reports false where localStorage does not exist (vitest default env)", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(writeLocalStorage("k", "v")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm vitest run src/utils/storage.test.ts
```

- [ ] **Step 3: Implement** — `src/utils/storage.ts`

```ts
/**
 * localStorage write that never throws. Quota errors and private-mode
 * refusals are a warning, not a failure of whatever the caller was doing —
 * the `cull:lastDir` write used to sit inside the scan's try/catch, so a full
 * storage was reported as "couldn't open folder" and the folder never staged.
 */
export function writeLocalStorage(key: string, value: string): boolean {
  try {
    if (typeof localStorage === "undefined") return false;
    localStorage.setItem(key, value);
    return true;
  } catch (e) {
    console.warn(`[cull] localStorage write failed for ${key}`, e);
    return false;
  }
}
```

Replace the three call sites with `writeLocalStorage(...)` (keep each call where it is; the `cull:lastDir` write stays after the successful scan — it just can no longer throw into the scan's catch). Update the comment at `useSessionLifecycle.ts:247-248` accordingly.

- [ ] **Step 4: Verify**

```bash
pnpm vitest run src/utils/storage.test.ts && pnpm typecheck && pnpm lint
```

- [ ] **Step 5: Commit**

```bash
git add src/utils/storage.ts src/utils/storage.test.ts src/app/useSessionLifecycle.ts src/App.tsx
git commit -m "fix: a localStorage failure can no longer be reported as a scan failure"
```

---

### Task 15: Docs, full gates, PR

**Files:**
- Modify: `ARCHITECTURE.md` (new subsection "Finishing a cull" after "Rating writes"), `README.md` (file_ops line ~274), this plan (implementation note at the end)

- [ ] **Step 1: ARCHITECTURE.md** — add after the "Rating writes" section:

```markdown
## Finishing a cull (move / copy / trash)

`file_ops.rs` batches are idempotent and never overwrite. Every result carries
`completed`, `skipped`, an error list capped at 20 with the exact `errorCount`,
and `gone` — the sources no longer at their original location (completed moves
plus sources already missing; empty for a copy). A sidecar that fails to
follow its CR3 is an error in that count, so "N moved · 0 errors" means the
ratings travelled too.

After a move, `pruneMoved` (`useSessionLifecycle`) takes the `gone` frames out
of the live session: `images`, ratings and metadata drop them, every
index-based cursor follows its frame (`utils/pruneSession.ts`), the undo/redo
history loses their changes, and `imageStore.forget()` revokes their blobs
without a generation bump so the mounted panes keep their registrations. The
staged-set identity changes, so smart-culling scores restart for the remaining
unrated frames.

The analyze pass reports what it could not read — parent folders that failed
to list, sidecars that exist but failed to read — on `AnalyzeResult`; the
status bar shows a dismissible chip (`utils/analyzeWarnings.ts`) instead of
silently sorting those frames last and unrated.
```

- [ ] **Step 2: README.md** — change the `file_ops.rs` tree line to `# move / copy / trash after the cull (sidecar failures counted, gone list)`.

- [ ] **Step 3: Full gates**

```bash
pnpm lint && pnpm lint:css && pnpm typecheck && pnpm typecheck:tests && pnpm test && pnpm build
cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test && cd ..
git status --short   # expect clean
```

- [ ] **Step 4: Implementation note** — append to this plan:

```markdown
## Implementation note (2026-09-14)

Executed on the Windows PC as branch `phase-0-safety`, N commits, suites green
(`pnpm test` <count>, `cargo test` <count>). Fresh-context reviews per task
(spec compliance + code quality); findings fixed in place. Live check on a
scratch copy of 12 CR3s: Move rejects → files + sidecars in `_rejected`, grid
and counts pruned, undo no longer touches the moved frames, no sidecar written
into the old folder. Left for later phases: the smart-culling "N frames could
not be scored" notice and the settings/recents storage-failure notice (§5.1
MEDIUM, last bullet).
```

- [ ] **Step 5: Commit, push the branch, open the PR** (pushing the branch and opening the PR is the agreed deliverable; merging is Oliver's)

```bash
git add ARCHITECTURE.md README.md docs/superpowers/plans/2026-09-14-phase-0-safety.md
git commit -m "docs: Phase 0 safety — finishing a cull, prune-after-move, analyze warnings"
git push -u origin phase-0-safety
gh pr create --title "Phase 0 — Safety" --body-file <(cat <<'EOF'
Closes the safety findings of the 2026-09-13 audit (`docs/superpowers/audits/2026-09-13-full-app-audit/`).

- Sidecar writes refuse when the CR3 is gone (`source missing:`); the frontend records the failure without retrying.
- Sidecar move/trash failures are counted; results carry the `gone` sources and the session prunes those frames (images, ratings, cursors, history, image store — no generation bump).
- Unreadable folders and sidecars from the analyze pass surface as a status-bar chip.
- Zoom-tier read failures show a retry chip instead of an endless ring.
- 0×0 decodes are rejected; `af_crop` is total.
- `cull:lastDir` storage write can no longer fail a scan.
- Hygiene: `.dev-logs/` ignored, `src-tauri/Cargo.toml` pinned LF, Vite 7.3.6.

## Test plan
- [ ] `pnpm test`, `pnpm typecheck && pnpm typecheck:tests`, `pnpm lint && pnpm lint:css`, `pnpm build`
- [ ] `cargo test`, `cargo clippy --all-targets -- -D warnings`, `cargo fmt --check`
- [ ] Scratch-copy live check: Move rejects prunes the session, no orphan sidecar in the old folder
EOF
)
```

---

### Task 16: Live check on a scratch copy (never Oliver's folders)

- [ ] **Step 1:** Copy 12 CR3s from `C:\Canon Media\2026\<a date>` to `%TEMP%\cull-phase0\shoot\` (files only — no sidecars exist there; verify `ls *.xmp` is empty in the source first and copy nothing but `.CR3`).
- [ ] **Step 2:** `pnpm tauri dev` (logs to `.dev-logs/`), open the scratch folder via the GUI-driving recipe (SetProcessDPIAware, AppActivate, Alt+D in the picker), begin culling.
- [ ] **Step 3:** Reject frames 1–3 with `x`, keep frame 4 with `k`, press Ctrl+E, click "Move rejects", confirm.
- [ ] **Step 4:** Verify on disk: `shoot\_rejected\` holds 3 CR3 + 3 XMP; `shoot\` holds 9 CR3 + 1 XMP (the keep); dialog reads "moved 3 · skipped 0".
- [ ] **Step 5:** Close the dialog; grid shows 9 cells; press Ctrl+Z three times — no new `.xmp` appears in `shoot\` for the moved names; footer counts are 1 keep / 0 rejects.
- [ ] **Step 6:** Quit; delete `%TEMP%\cull-phase0`. Record the outcome in the implementation note (Task 15 Step 4).

---

## Implementation note (2026-09-14)

Executed on the Windows PC as branch `phase-0-safety`, 21 commits, suites
green (`pnpm test` 509 tests across 48 files, `cargo test` 121 tests). Every
task got a fresh-context spec+quality review; Tasks 2, 8 and 9 each took one
fix round (a wrong doc cross-reference; a `pruneHistory` empty-set guard; an
empty-session compare exit plus live-cursor functional remap) — all findings
fixed in place. Live check (Task 16) deferred: the PC was in use during the
session; the driver `phase0-live.ps1` and a 12-frame scratch copy are
prepared and the PR's test plan keeps that box unticked. Extra on
the way: clippy's two pending `as_chunks` lints (analyze.rs, phash.rs) were
applied so the CI clippy gate is green; `cargo test` rejects multi-filter
invocations on cargo 1.98, so per-module gates were run one filter at a time.

Left for later phases:

- The smart-culling "N frames could not be scored" notice.
- The settings/recents storage-failure notice (§5.1 MEDIUM, last bullet).
- Phase 3 — a distinct chip text/title for `source missing:` write failures
  ("photo no longer at its path") instead of a retry that cannot succeed.
- Phase 2 — an `overlayService.forget(paths)` next to `imageStore.forget`
  (overlay rasters for moved frames stay cached until session end).
- Phase 2 — key smart-culling's session on a stable path set rather than
  `images` array identity so a mid-cull prune does not wipe scores and
  re-run inference.
- Phase 2 — guard the two tier-landing sites in `imageStore` against a path
  no longer in `pathIndex` (a read in flight for a moved frame lands as a
  stray entry until the eviction window passes).

Final whole-branch review (2026-09-14): ready to merge with fixes; the no-op
unrate and the empty-session pool clear landed as the fix wave.
