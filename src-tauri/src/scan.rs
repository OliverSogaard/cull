//! Folder scan + capture-time analysis.
//!
//! Two commands feed the staged/analyze phases:
//!
//! - [`scan_folder`] recursively lists CR3 files.
//! - [`analyze_folder`] orders them chronologically (from each file's mtime —
//!   the camera's write time, which on the NAS this app targets matches shot
//!   order) and restores any existing CULL ratings from their `.xmp` sidecars.
//!
//! Both invariants: read-only, no CR3 mutation.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::Instant;

use tauri::Emitter;
use walkdir::WalkDir;

use crate::xmp::read_xmp_rating;

/// Scan a folder recursively for `.CR3` files, sorted lexicographically.
#[tauri::command]
pub(crate) async fn scan_folder(path: String) -> Result<Vec<String>, String> {
    let start = Instant::now();
    let root = Path::new(&path);
    if !root.is_dir() {
        return Err(format!("not a directory: {path}"));
    }

    let mut paths: Vec<String> = WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .filter_map(|e| {
            let p = e.path();
            let ext = p.extension()?.to_str()?;
            if ext.eq_ignore_ascii_case("cr3") {
                p.to_str().map(|s| s.to_string())
            } else {
                None
            }
        })
        .collect();

    paths.sort();

    eprintln!(
        "[cull] scan_folder({}): {} CR3 files in {:?}",
        path,
        paths.len(),
        start.elapsed()
    );
    Ok(paths)
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AnalyzeProgress {
    done: usize,
    total: usize,
    phase: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AnalyzeResult {
    /// Input indices sorted by capture time (then path as tiebreak).
    order: Vec<usize>,
    /// Per input index: restored CULL rating from the `.xmp` sidecar, or null.
    ratings: Vec<Option<String>>,
}

/// Order a staged set chronologically and restore ratings.
///
/// ## Fast path (network / removable storage)
///
/// Capture order comes from each file's mtime, gathered from each parent
/// directory's listing. On Windows `DirEntry::metadata()` is served from the
/// directory scan (no extra round-trip per file), so we pay for a few listings
/// instead of `n` opens. On a NAS where every open is a round-trip (~37 ms in
/// the benchmark), this collapses ~10 min of metadata reads into seconds.
///
/// Exact EXIF (precise time, lens, GPS, AF point) is still read lazily per
/// image during culling via [`crate::bundle::read_bundle`].
/// When the frontend passes `concurrent_restore = true` (storage mode = local),
/// sidecar reads run on this many threads. 4 is enough to saturate a local
/// SSD's queue depth without thrashing; the NAS path stays sequential.
const RESTORE_WORKERS: usize = 4;

/// `concurrent_restore` is a storage hint forwarded from frontend settings.
/// `Some(true)` parallelises sidecar reads (fine on local SSD); defaults to
/// sequential — safe on a NAS that punishes concurrent opens.
#[tauri::command]
pub(crate) async fn analyze_folder(
    window: tauri::Window,
    paths: Vec<String>,
    concurrent_restore: Option<bool>,
) -> Result<AnalyzeResult, String> {
    let concurrent_restore = concurrent_restore.unwrap_or(false);
    let n = paths.len();
    if n == 0 {
        return Ok(AnalyzeResult { order: vec![], ratings: vec![] });
    }
    let start = Instant::now();

    // Enumerate each distinct parent dir ONCE. We also note which .xmp sidecars
    // exist, to avoid probe-opening absent ones (a fresh import has none).
    let want: HashSet<&str> = paths.iter().map(String::as_str).collect();
    let parents: HashSet<&Path> = paths.iter().filter_map(|p| Path::new(p).parent()).collect();

    let mut mtime: HashMap<String, i64> = HashMap::new();
    let mut xmp_stems: HashSet<String> = HashSet::new(); // lowercased path, no ext
    let step = (n / 100).max(1); // ≤ ~100 progress events
    let mut done = 0usize;

    for dir in parents {
        let Ok(entries) = std::fs::read_dir(dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().is_some_and(|e| e.eq_ignore_ascii_case("xmp")) {
                xmp_stems.insert(path.with_extension("").to_string_lossy().to_lowercase());
                continue;
            }
            let Some(pstr) = path.to_str() else { continue };
            if !want.contains(pstr) {
                continue;
            }
            if let Ok(modified) = entry.metadata().and_then(|m| m.modified()) {
                if let Ok(since) = modified.duration_since(std::time::UNIX_EPOCH) {
                    mtime.insert(pstr.to_string(), since.as_secs() as i64);
                }
            }
            done += 1;
            if done.is_multiple_of(step) || done == n {
                let _ = window.emit(
                    "analyze-progress",
                    AnalyzeProgress { done, total: n, phase: "reading".into() },
                );
            }
        }
    }

    let epoch: Vec<Option<i64>> = paths.iter().map(|p| mtime.get(p).copied()).collect();

    // Restore ratings from the sidecars we KNOW exist. Two paths:
    //
    // - NAS (default): sequential. Each sidecar is a tiny open, but the
    //   benchmarked NAS punishes concurrent opens hard (parallelism here once
    //   took minutes), so one-at-a-time is actually fastest.
    // - Local (`concurrent_restore`): RESTORE_WORKERS threads in a scoped
    //   pool. On local SSD this cuts a 10k-sidecar restore from ~5s to ~1s.
    //
    // Both paths emit "restoring" progress so the bar advances instead of
    // sitting full while we work.
    let to_read: Vec<usize> = (0..n)
        .filter(|&i| {
            let stem = Path::new(&paths[i]).with_extension("").to_string_lossy().to_lowercase();
            xmp_stems.contains(&stem)
        })
        .collect();
    let total_xmp = to_read.len();
    let step = (total_xmp / 100).max(1); // ≤ ~100 progress events
    let mut ratings: Vec<Option<String>> = vec![None; n];

    if concurrent_restore && to_read.len() > RESTORE_WORKERS {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let done_counter = AtomicUsize::new(0);
        let chunk_size = to_read.len().div_ceil(RESTORE_WORKERS);
        let paths_ref = &paths;
        let window_ref = &window;
        let done_ref = &done_counter;

        let parts: Vec<Vec<(usize, Option<String>)>> = std::thread::scope(|s| {
            let mut handles = Vec::with_capacity(RESTORE_WORKERS);
            for chunk in to_read.chunks(chunk_size) {
                handles.push(s.spawn(move || {
                    let mut out = Vec::with_capacity(chunk.len());
                    for &i in chunk {
                        let rating = read_xmp_rating(&paths_ref[i]);
                        out.push((i, rating));
                        let d = done_ref.fetch_add(1, Ordering::Relaxed) + 1;
                        if d % step == 0 || d == total_xmp {
                            let _ = window_ref.emit(
                                "analyze-progress",
                                AnalyzeProgress { done: d, total: total_xmp, phase: "restoring".into() },
                            );
                        }
                    }
                    out
                }));
            }
            handles.into_iter().map(|h| h.join().unwrap()).collect()
        });

        for part in parts {
            for (i, r) in part {
                ratings[i] = r;
            }
        }
    } else {
        for (done, &i) in to_read.iter().enumerate() {
            ratings[i] = read_xmp_rating(&paths[i]);
            if done % step == 0 || done + 1 == total_xmp {
                let _ = window.emit(
                    "analyze-progress",
                    AnalyzeProgress { done: done + 1, total: total_xmp, phase: "restoring".into() },
                );
            }
        }
    }

    // Sort by capture time (mtime); missing times sort last, tiebreak on path.
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by(|&a, &b| match (epoch[a], epoch[b]) {
        (Some(ea), Some(eb)) => ea.cmp(&eb).then_with(|| paths[a].cmp(&paths[b])),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => paths[a].cmp(&paths[b]),
    });

    let _ = window.emit(
        "analyze-progress",
        AnalyzeProgress { done: n, total: n, phase: "done".into() },
    );
    eprintln!(
        "[cull] analyze_folder: {} images in {:?} (mtime fast path)",
        n,
        start.elapsed()
    );
    Ok(AnalyzeResult { order, ratings })
}
