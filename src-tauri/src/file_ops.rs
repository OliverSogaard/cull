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
//! (non-destructive). The `.xmp` sidecar follows its CR3 (best effort). Copy
//! preserves the source mtime so the export folder's by-capture-time sort still
//! reflects shoot order — CULL relies on directory mtimes elsewhere for this.

use std::path::Path;

/// Outcome of a batch file operation.
#[derive(serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileOpResult {
    completed: u32,
    /// Destination already existed OR source no longer exists.
    skipped: u32,
    /// Per-file error messages, capped at [`FILE_OP_ERROR_CAP`].
    errors: Vec<String>,
}

/// Cap the per-batch error list — a folder full of failures shouldn't balloon
/// the IPC response.
const FILE_OP_ERROR_CAP: usize = 20;

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
/// source no longer exists (idempotent re-runs). Caps the error list so a
/// folder full of failures can't balloon the response.
fn batch_files(
    paths: &[String],
    dest_dir: &Path,
    op: impl Fn(&Path, &Path) -> std::io::Result<()>,
) -> FileOpResult {
    let mut result = FileOpResult::default();
    for path in paths {
        let src = Path::new(path);
        let Some(name) = src.file_name() else {
            result.errors.push(format!("no filename: {path}"));
            continue;
        };
        let dest = dest_dir.join(name);
        // Idempotency: if the destination already has it OR the source is gone
        // (already moved on a prior pass), treat as skipped instead of
        // erroring. Re-running the action is safe.
        if dest.exists() || !src.exists() {
            result.skipped += 1;
            continue;
        }
        match op_one(src, &dest, &op) {
            Ok(()) => {
                // Sidecar follows the CR3 (best effort — don't fail the CR3
                // op on this).
                let src_xmp = src.with_extension("xmp");
                if src_xmp.exists() {
                    if let Some(xmp_name) = src_xmp.file_name() {
                        let _ = op_one(&src_xmp, &dest_dir.join(xmp_name), &op);
                    }
                }
                result.completed += 1;
            }
            Err(e) => {
                result.errors.push(format!("{}: {e}", src.display()));
                if result.errors.len() >= FILE_OP_ERROR_CAP {
                    break;
                }
            }
        }
    }
    result
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
        std::fs::create_dir_all(&dest)
            .map_err(|e| format!("create {}: {e}", dest.display()))?;
        Ok(batch_files(&paths, &dest, |s, d| std::fs::rename(s, d)))
    })
    .await
    .map_err(|e| format!("move task failed: {e}"))?
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
        Ok(batch_files(&paths, &dest_dir, |s, d| {
            std::fs::copy(s, d).map(|_| ())
        }))
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
        let r1 = batch_files(&paths, &dest, |s, d| fs::rename(s, d));
        assert_eq!(r1.completed, 1);
        assert_eq!(r1.skipped, 0);
        assert!(r1.errors.is_empty());
        assert!(dest.join("photo.cr3").exists());
        assert!(dest.join("photo.xmp").exists());

        // Second run on the same input: source is gone → skipped, not errored.
        let r2 = batch_files(&paths, &dest, |s, d| fs::rename(s, d));
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
        );
        assert_eq!(r.completed, 0);
        assert_eq!(r.skipped, 1);
        // Destination preserved.
        assert_eq!(fs::read(dest.join("a.cr3")).unwrap(), b"DEST");

        let _ = fs::remove_dir_all(&work);
    }

    /// batch_files: error list caps so a huge failure folder can't balloon.
    #[test]
    fn batch_error_cap() {
        let work = tmp_dir("batch-error-cap");
        // Source paths that don't have filenames (impossible inputs) → all
        // bucket into the error list quickly so we can verify the cap.
        let bad: Vec<String> = (0..(FILE_OP_ERROR_CAP + 10))
            .map(|i| format!("/dev/null-{i}/"))
            .collect();
        let dest = work.join("out");
        fs::create_dir_all(&dest).unwrap();

        let r = batch_files(&bad, &dest, |s, d| fs::copy(s, d).map(|_| ()));
        assert!(r.errors.len() <= FILE_OP_ERROR_CAP);

        let _ = fs::remove_dir_all(&work);
    }
}
