//! Act on the cull: post-cull file operations.
//!
//! Two non-destructive actions the user can run when they're done culling:
//!
//! - [`move_rejects_to_subfolder`] moves rejected CR3s (+ sidecar) into a
//!   subfolder of the current cull folder (default `_rejected/`).
//! - [`copy_keeps_to_export`] copies kept/favorite CR3s (+ sidecar) to a folder
//!   the user picks.
//!
//! Both skip rather than overwrite when the destination already has that file
//! (non-destructive). The `.xmp` sidecar follows its CR3 — a sidecar that
//! fails to follow is counted in the result. Copy preserves the source mtime
//! so the export folder's by-capture-time sort still reflects shoot order —
//! CULL relies on directory mtimes elsewhere for this.

use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

/// Outcome of a batch file operation.
#[derive(serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileOpResult {
    completed: u32,
    /// Destination already existed OR source no longer exists.
    skipped: u32,
    /// Per-file error messages, capped at [`FILE_OP_ERROR_CAP`] for IPC size.
    errors: Vec<String>,
    /// Total errors encountered — may exceed `errors.len()`, which is capped.
    /// The UI shows this so a capped list never reads as "only N failed".
    error_count: u32,
    /// Source paths no longer at their original location once the batch is
    /// done: completed moves plus sources already missing on entry. Empty for
    /// copies. The frontend prunes these frames from the live session so a
    /// stale cell can never write a sidecar into the folder the photo left.
    gone: Vec<String>,
}

/// Unique sequence for atomic-copy temp files (paired with the pid) so two
/// concurrent or retried copies to the same destination never collide.
static COPY_TMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// Copy atomically: write to a unique temp sibling in the destination directory,
/// then rename over the final name. A failed or interrupted copy leaves only the
/// temp (which we remove) — never a truncated file at the destination, and never
/// a half-file that a re-run would then skip as "already there".
fn atomic_copy(src: &Path, dest: &Path) -> std::io::Result<()> {
    let seq = COPY_TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let pid = std::process::id();
    let tmp_name = match dest.file_name().and_then(|n| n.to_str()) {
        Some(n) => format!(".{n}.{pid}.{seq}.culltmp"),
        None => format!(".culltmp.{pid}.{seq}"),
    };
    let tmp = dest.with_file_name(tmp_name);
    std::fs::copy(src, &tmp)?;
    std::fs::rename(&tmp, dest).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

/// Cap the per-batch error list — a folder full of failures shouldn't balloon
/// the IPC response.
const FILE_OP_ERROR_CAP: usize = 20;

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

/// Perform one source→dest operation (rename or copy) and preserve the source's
/// modification time on the destination. mtime preservation is a best-effort
/// no-op if the platform refuses; rename keeps mtime naturally.
fn op_one(
    src: &Path,
    dest: &Path,
    op: &impl Fn(&Path, &Path) -> std::io::Result<()>,
) -> std::io::Result<()> {
    let mtime = std::fs::metadata(src).and_then(|m| m.modified()).ok();
    op(src, dest)?;
    if let Some(mtime) = mtime {
        if let Ok(f) = std::fs::OpenOptions::new().write(true).open(dest) {
            let _ = f.set_times(std::fs::FileTimes::new().set_modified(mtime));
        }
    }
    Ok(())
}

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

/// Cheap existence check the finish dialog uses (pinned mode) to surface the
/// "folder already exists" warning before the user commits the copy. Backend
/// is `Path::exists`, so this matches whatever the filesystem says — a
/// follow-up copy that lands in an existing folder is then a *merge*, not an
/// overwrite (`batch_files` skips destination collisions).
///
/// On a slow NAS we don't want every keystroke to fire a probe, so the
/// frontend debounces calls; the backend itself is plain sync I/O.
#[tauri::command]
pub(crate) async fn path_exists(path: String) -> Result<bool, String> {
    // Spawn-blocking so a slow NAS stat doesn't stall the async runtime.
    tauri::async_runtime::spawn_blocking(move || Ok(Path::new(&path).exists()))
        .await
        .map_err(|e| format!("path_exists task failed: {e}"))?
}

#[tauri::command]
pub(crate) async fn move_rejects_to_subfolder(
    folder: String,
    paths: Vec<String>,
    subfolder: String,
) -> Result<FileOpResult, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<FileOpResult, String> {
        let folder_path = Path::new(&folder);
        if !folder_path.is_dir() {
            return Err(format!("not a directory: {folder}"));
        }
        let dest = folder_path.join(&subfolder);
        std::fs::create_dir_all(&dest).map_err(|e| format!("create {}: {e}", dest.display()))?;
        Ok(batch_files(
            &paths,
            &dest,
            |s, d| std::fs::rename(s, d),
            SourceFate::Consumed,
        ))
    })
    .await
    .map_err(|e| format!("move task failed: {e}"))?
}

/// Batch-send paths to a trash-like op, the `.xmp` sidecar riding along with
/// its CR3 — a sidecar that fails to follow is counted in the result. Mirrors
/// [`batch_files`]' accounting: a missing source is a skip (idempotent
/// re-runs) and is `gone`, errors are counted in full with the stored list
/// capped. No destination — the op itself owns where files go.
fn trash_batch(paths: &[String], trash_op: impl Fn(&Path) -> Result<(), String>) -> FileOpResult {
    let mut result = FileOpResult::default();
    for path in paths {
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
    }
    result
}

/// Move rejected CR3s (+ sidecars) to the OS Trash / Recycle Bin. Recoverable
/// by design: CULL never permanent-deletes — the Trash is the floor.
#[tauri::command]
pub(crate) async fn move_rejects_to_trash(paths: Vec<String>) -> Result<FileOpResult, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<FileOpResult, String> {
        Ok(trash_batch(&paths, |p| {
            trash::delete(p).map_err(|e| e.to_string())
        }))
    })
    .await
    .map_err(|e| format!("trash task failed: {e}"))?
}

#[tauri::command]
pub(crate) async fn copy_keeps_to_export(
    paths: Vec<String>,
    dest: String,
) -> Result<FileOpResult, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<FileOpResult, String> {
        let dest_dir = Path::new(&dest).to_path_buf();
        std::fs::create_dir_all(&dest_dir)
            .map_err(|e| format!("create {}: {e}", dest_dir.display()))?;
        // atomic_copy (temp + rename) so a cross-device or interrupted copy can
        // never leave a truncated file at the destination.
        Ok(batch_files(
            &paths,
            &dest_dir,
            atomic_copy,
            SourceFate::Retained,
        ))
    })
    .await
    .map_err(|e| format!("copy task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("cull-tests-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// batch_files: re-running on a path that's already moved counts as skipped.
    #[test]
    fn batch_idempotent_when_already_moved() {
        let work = tmp_dir("batch-idempotent");
        let src = work.join("photo.cr3");
        let xmp = work.join("photo.xmp");
        fs::write(&src, b"cr3").unwrap();
        fs::write(&xmp, b"<xmp/>").unwrap();
        let dest = work.join("_rejected");
        fs::create_dir_all(&dest).unwrap();

        let paths = vec![src.to_string_lossy().to_string()];

        // First run: moves the file.
        let r1 = batch_files(&paths, &dest, |s, d| fs::rename(s, d), SourceFate::Consumed);
        assert_eq!(r1.completed, 1);
        assert_eq!(r1.skipped, 0);
        assert!(r1.errors.is_empty());
        assert!(dest.join("photo.cr3").exists());
        assert!(dest.join("photo.xmp").exists());

        // Second run on the same input: source is gone → skipped, not errored.
        let r2 = batch_files(&paths, &dest, |s, d| fs::rename(s, d), SourceFate::Consumed);
        assert_eq!(r2.completed, 0);
        assert_eq!(r2.skipped, 1);
        assert!(r2.errors.is_empty());

        let _ = fs::remove_dir_all(&work);
    }

    /// batch_files: destination collision is a skip, not an overwrite.
    #[test]
    fn batch_does_not_overwrite_existing_destination() {
        let work = tmp_dir("batch-no-overwrite");
        let src = work.join("a.cr3");
        fs::write(&src, b"src").unwrap();
        let dest = work.join("out");
        fs::create_dir_all(&dest).unwrap();
        fs::write(dest.join("a.cr3"), b"DEST").unwrap();

        let r = batch_files(
            &[src.to_string_lossy().to_string()],
            &dest,
            |s, d| fs::copy(s, d).map(|_| ()),
            SourceFate::Retained,
        );
        assert_eq!(r.completed, 0);
        assert_eq!(r.skipped, 1);
        // Destination preserved.
        assert_eq!(fs::read(dest.join("a.cr3")).unwrap(), b"DEST");

        let _ = fs::remove_dir_all(&work);
    }

    /// batch_files: a sidecar already present at the destination is never
    /// overwritten, even when the CR3 itself does copy (the .xmp could hold the
    /// user's edits). Regression for the collision-guard bypass.
    #[test]
    fn batch_does_not_overwrite_existing_sidecar() {
        let work = tmp_dir("batch-no-overwrite-xmp");
        let src = work.join("b.cr3");
        let src_xmp = work.join("b.xmp");
        fs::write(&src, b"cr3").unwrap();
        fs::write(&src_xmp, b"NEW").unwrap();
        let dest = work.join("out");
        fs::create_dir_all(&dest).unwrap();
        // Destination has a lone sidecar (no CR3) carrying user data.
        fs::write(dest.join("b.xmp"), b"USER_EDITS").unwrap();

        let r = batch_files(
            &[src.to_string_lossy().to_string()],
            &dest,
            |s, d| fs::copy(s, d).map(|_| ()),
            SourceFate::Retained,
        );
        assert_eq!(r.completed, 1, "CR3 copied (no CR3 collision)");
        // The pre-existing sidecar is preserved, not clobbered.
        assert_eq!(fs::read(dest.join("b.xmp")).unwrap(), b"USER_EDITS");
        let _ = fs::remove_dir_all(&work);
    }

    /// path_exists: backed by Path::exists. Returns true for an existing dir
    /// (so the finish-dialog "folder already exists" banner fires), false for
    /// a non-existent path. Tested against the same primitive the command
    /// uses; the Tauri wrapper just spawn-blocks it.
    #[test]
    fn path_exists_matches_filesystem() {
        let work = tmp_dir("path-exists");
        let dest = work.join("already_here");
        // Doesn't exist yet.
        assert!(!std::path::Path::new(&dest).exists());
        std::fs::create_dir_all(&dest).unwrap();
        // Now it does.
        assert!(std::path::Path::new(&dest).exists());
        // Non-existent sibling path still false.
        let absent = work.join("not_yet");
        assert!(!std::path::Path::new(&absent).exists());
        let _ = std::fs::remove_dir_all(&work);
    }

    /// batch_files: error list caps so a huge failure folder can't balloon.
    #[test]
    fn batch_error_cap() {
        let work = tmp_dir("batch-error-cap");
        // Source paths that don't have filenames (impossible inputs) → all
        // bucket into the error list quickly so we can verify the cap. (An
        // empty string is the one input `Path::file_name()` reliably reports
        // as having no filename — a trailing slash alone does not: per the
        // stdlib docs, `Path::new("/usr/bin/").file_name()` is `Some("bin")`.)
        let bad: Vec<String> = (0..(FILE_OP_ERROR_CAP + 10))
            .map(|_| String::new())
            .collect();
        let dest = work.join("out");
        fs::create_dir_all(&dest).unwrap();

        let r = batch_files(
            &bad,
            &dest,
            |s, d| fs::copy(s, d).map(|_| ()),
            SourceFate::Retained,
        );
        assert!(r.errors.len() <= FILE_OP_ERROR_CAP);
        assert_eq!(r.error_count as usize, FILE_OP_ERROR_CAP + 10);

        let _ = fs::remove_dir_all(&work);
    }

    /// trash_batch: missing sources skip (idempotent re-runs), present ones
    /// complete, and the sidecar rides along with its CR3.
    #[test]
    fn trash_batch_completes_skips_and_takes_sidecar() {
        let work = tmp_dir("trash-batch");
        let a = work.join("a.cr3");
        let a_xmp = work.join("a.xmp");
        fs::write(&a, b"cr3").unwrap();
        fs::write(&a_xmp, b"<xmp/>").unwrap();
        let gone = work.join("already-gone.cr3");

        let trashed = std::sync::Mutex::new(Vec::<std::path::PathBuf>::new());
        let r = trash_batch(
            &[
                a.to_string_lossy().to_string(),
                gone.to_string_lossy().to_string(),
            ],
            |p| {
                trashed.lock().unwrap().push(p.to_path_buf());
                fs::remove_file(p).map_err(|e| e.to_string())
            },
        );
        assert_eq!(r.completed, 1);
        assert_eq!(r.skipped, 1);
        assert!(r.errors.is_empty());
        let got = trashed.lock().unwrap();
        assert!(got.contains(&a), "CR3 went to the trash op");
        assert!(got.contains(&a_xmp), "sidecar followed its CR3");
        let _ = fs::remove_dir_all(&work);
    }

    /// trash_batch: errors are counted in full but the stored list caps.
    #[test]
    fn trash_batch_error_cap() {
        let work = tmp_dir("trash-errors");
        let paths: Vec<String> = (0..(FILE_OP_ERROR_CAP + 5))
            .map(|i| {
                let f = work.join(format!("f{i}.cr3"));
                fs::write(&f, b"x").unwrap();
                f.to_string_lossy().to_string()
            })
            .collect();
        let r = trash_batch(&paths, |_| Err("nope".to_string()));
        assert_eq!(r.completed, 0);
        assert_eq!(r.error_count as usize, FILE_OP_ERROR_CAP + 5);
        assert!(r.errors.len() <= FILE_OP_ERROR_CAP);
        let _ = fs::remove_dir_all(&work);
    }

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
        assert!(
            collides.exists(),
            "collision skip leaves the source where it was"
        );
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
            &[String::new()],
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
}
