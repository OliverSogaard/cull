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

use crate::xmp::read_ratings;

/// What a folder scan found: the staged CR3 paths plus a count of everything
/// the walk saw and skipped. The count keeps a folder of JPEGs (or a second
/// body's other-brand RAWs) from reading as "broken" when it stages 0 — the
/// staged screen says "N non-CR3 files ignored" instead of staying silent.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScanResult {
    paths: Vec<String>,
    /// Non-CR3 files skipped. Excludes `.xmp` sidecars (CULL's own data, not a
    /// surprise to the user) and dotfiles (`.DS_Store`, `Thumbs.db`-style noise
    /// stays out of a count meant to explain missing *photos*).
    ignored: u32,
}

/// Pure walk shared by the command and its tests: recursively list `.CR3`
/// files (sorted lexicographically) and count the ignored rest.
fn walk_folder(root: &Path, ignore: Option<&str>) -> ScanResult {
    let mut paths: Vec<String> = Vec::new();
    let mut ignored: u32 = 0;
    let entries = WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            // Keep the root itself; prune only descendant dirs whose name matches
            // the ignored subfolder (case-insensitively — Windows paths).
            e.depth() == 0
                || !(e.file_type().is_dir()
                    && ignore.is_some_and(|name| {
                        e.file_name()
                            .to_str()
                            .is_some_and(|n| n.eq_ignore_ascii_case(name))
                    }))
        })
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file());
    for e in entries {
        let p = e.path();
        let ext = p.extension().and_then(|x| x.to_str());
        if ext.is_some_and(|x| x.eq_ignore_ascii_case("cr3")) {
            if let Some(s) = p.to_str() {
                paths.push(s.to_string());
            }
            continue;
        }
        let is_sidecar = ext.is_some_and(|x| x.eq_ignore_ascii_case("xmp"));
        let is_dotfile = e.file_name().to_str().is_some_and(|n| n.starts_with('.'));
        if !is_sidecar && !is_dotfile {
            ignored += 1;
        }
    }
    paths.sort();
    ScanResult { paths, ignored }
}

/// Scan a folder recursively for `.CR3` files, sorted lexicographically, plus
/// a count of ignored non-CR3 files (see [`ScanResult`]).
///
/// `ignore_subdir` (the configured rejected-subfolder name) is pruned from the
/// walk so re-scanning a shoot after "move rejects" doesn't re-import the frames
/// that were filed away under it. `None`/empty disables pruning.
#[tauri::command]
pub(crate) async fn scan_folder(
    path: String,
    ignore_subdir: Option<String>,
) -> Result<ScanResult, String> {
    let start = Instant::now();
    let root = Path::new(&path);

    // Classify the failure so the UI can tell a genuinely-gone folder (evict it
    // from recents) from a transient NAS/SMB blip (keep it — the user retries).
    // An unreachable share / sleeping drive surfaces as an IO error here, NOT as
    // a successful-but-not-a-dir, so it is correctly treated as transient.
    match std::fs::metadata(root) {
        Ok(m) if m.is_dir() => {}
        Ok(_) => return Err(format!("not a directory: {path}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(format!("folder not found: {path}"));
        }
        Err(e) => return Err(format!("couldn't read folder: {e}")),
    }

    let ignore = ignore_subdir.filter(|s| !s.is_empty());
    let result = walk_folder(root, ignore.as_deref());

    dlog!(
        "[cull] scan_folder({}): {} CR3 files ({} ignored) in {:?}",
        path,
        result.paths.len(),
        result.ignored,
        start.elapsed()
    );
    Ok(result)
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
    /// Input indices sorted by write time (mtime, sub-second), then path as a
    /// tiebreak. mtime ≈ capture order for in-camera writes; precise EXIF
    /// DateTimeOriginal is read lazily per image and is not used for ordering.
    order: Vec<usize>,
    /// Per input index: restored CULL rating from the `.xmp` sidecar, or null.
    ratings: Vec<Option<String>>,
    /// Per input index: the user's LrC 1–5★ rating (if any). Frees the UI
    /// from waiting for the per-image bundle read to show pre-existing LrC
    /// ratings on the grid + EXIF panel. Same sidecar pass as `ratings`, so
    /// it's free to extract here.
    lrc_ratings: Vec<Option<u8>>,
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
    session: tauri::State<'_, std::sync::Arc<crate::io_gate::SessionGate>>,
) -> Result<AnalyzeResult, String> {
    let concurrent_restore = concurrent_restore.unwrap_or(false);
    let n = paths.len();
    if n == 0 {
        return Ok(AnalyzeResult {
            order: vec![],
            ratings: vec![],
            lrc_ratings: vec![],
        });
    }
    let start = Instant::now();

    // Enumerate each distinct parent dir ONCE. We also note which .xmp sidecars
    // exist, to avoid probe-opening absent ones (a fresh import has none).
    let want: HashSet<&str> = paths.iter().map(String::as_str).collect();
    let parents: HashSet<&Path> = paths.iter().filter_map(|p| Path::new(p).parent()).collect();

    let mut mtime: HashMap<String, i64> = HashMap::new();
    let mut sizes: HashMap<String, u64> = HashMap::new();
    let mut xmp_stems: HashSet<String> = HashSet::new(); // lowercased path, no ext
    let step = (n / 100).max(1); // ≤ ~100 progress events
    let mut done = 0usize;

    for dir in parents {
        let Ok(entries) = std::fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            // Sweep crash-orphaned atomic-write temps ("<base>.xmp.<seq>.tmp") left
            // behind if the process died between temp-create and rename. Match only
            // CULL's exact shape so another tool's *.tmp is never touched. Best-effort.
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                if let Some(stem) = name.strip_suffix(".tmp") {
                    if let Some((head, seq)) = stem.rsplit_once('.') {
                        if head.ends_with(".xmp")
                            && !seq.is_empty()
                            && seq.bytes().all(|b| b.is_ascii_digit())
                        {
                            let _ = std::fs::remove_file(&path);
                            continue;
                        }
                    }
                }
            }
            if path
                .extension()
                .is_some_and(|e| e.eq_ignore_ascii_case("xmp"))
            {
                xmp_stems.insert(path.with_extension("").to_string_lossy().to_lowercase());
                continue;
            }
            let Some(pstr) = path.to_str() else { continue };
            if !want.contains(pstr) {
                continue;
            }
            if let Ok(md) = entry.metadata() {
                if let Some(since) = md
                    .modified()
                    .ok()
                    .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
                {
                    // Milliseconds, not whole seconds: Canon burst frames are
                    // written many-per-second, so second-resolution mtime ties
                    // a whole burst and falls back to filename order (which a
                    // 9999→0001 counter wrap reverses). Sub-second mtime keeps
                    // them in actual write order; the path tiebreak below then
                    // only fires on a genuine exact-millisecond tie.
                    mtime.insert(pstr.to_string(), since.as_millis() as i64);
                    // Size rides along for free (Phase 7): the tier cache's
                    // second validator, from the metadata already in hand.
                    sizes.insert(pstr.to_string(), md.len());
                }
            }
            done += 1;
            if done.is_multiple_of(step) || done == n {
                let _ = window.emit(
                    "analyze-progress",
                    AnalyzeProgress {
                        done,
                        total: n,
                        phase: "reading".into(),
                    },
                );
            }
        }
    }

    // Terminal tick: a staged file missing from its parent listing (deleted /
    // moved between scan and analyze) or a parent dir we couldn't read means the
    // per-entry counter above may never reach `n`, freezing the bar short. Emit
    // one final full tick (idempotent in the normal case) so it always completes.
    let _ = window.emit(
        "analyze-progress",
        AnalyzeProgress {
            done: n,
            total: n,
            phase: "reading".into(),
        },
    );

    // Feed the session stat table (Phase 2, sizes added in Phase 7): the tier
    // cache validates its entries against these instead of stat-ing the source
    // per cached hit — zero filesystem round-trips for analyzed files. Sound
    // because CR3s are immutable while culling (the app never writes them).
    session.note_mtimes(&mtime);
    session.note_sizes(&sizes);

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
            let stem = Path::new(&paths[i])
                .with_extension("")
                .to_string_lossy()
                .to_lowercase();
            xmp_stems.contains(&stem)
        })
        .collect();
    let total_xmp = to_read.len();
    let step = (total_xmp / 100).max(1); // ≤ ~100 progress events
    let mut ratings: Vec<Option<String>> = vec![None; n];
    // LrC star ratings: same sidecar pass, no extra I/O. Only the indices in
    // `to_read` have a sidecar to read; the rest stay None.
    let mut lrc_ratings: Vec<Option<u8>> = vec![None; n];

    if concurrent_restore && to_read.len() > RESTORE_WORKERS {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let done_counter = AtomicUsize::new(0);
        let chunk_size = to_read.len().div_ceil(RESTORE_WORKERS);
        let paths_ref = &paths;
        let window_ref = &window;
        let done_ref = &done_counter;

        type RestorePart = Vec<(usize, Option<String>, Option<u8>)>;
        let parts: Vec<RestorePart> = std::thread::scope(|s| {
            let mut handles = Vec::with_capacity(RESTORE_WORKERS);
            for chunk in to_read.chunks(chunk_size) {
                handles.push(s.spawn(move || {
                    let mut out = Vec::with_capacity(chunk.len());
                    for &i in chunk {
                        let (rating, lrc) = read_ratings(&paths_ref[i]);
                        out.push((i, rating, lrc));
                        let d = done_ref.fetch_add(1, Ordering::Relaxed) + 1;
                        if d.is_multiple_of(step) || d == total_xmp {
                            let _ = window_ref.emit(
                                "analyze-progress",
                                AnalyzeProgress {
                                    done: d,
                                    total: total_xmp,
                                    phase: "restoring".into(),
                                },
                            );
                        }
                    }
                    out
                }));
            }
            handles.into_iter().map(|h| h.join().unwrap()).collect()
        });

        for part in parts {
            for (i, r, lrc) in part {
                ratings[i] = r;
                lrc_ratings[i] = lrc;
            }
        }
    } else {
        for (idx, &i) in to_read.iter().enumerate() {
            let (rating, lrc) = read_ratings(&paths[i]);
            ratings[i] = rating;
            lrc_ratings[i] = lrc;
            let done = idx + 1;
            // Same step boundaries as the concurrent path (multiples of `step`,
            // plus the final tick) so the bar advances identically regardless of
            // storage mode.
            if done.is_multiple_of(step) || done == total_xmp {
                let _ = window.emit(
                    "analyze-progress",
                    AnalyzeProgress {
                        done,
                        total: total_xmp,
                        phase: "restoring".into(),
                    },
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
        AnalyzeProgress {
            done: n,
            total: n,
            phase: "done".into(),
        },
    );
    dlog!(
        "[cull] analyze_folder: {} images in {:?} (mtime fast path)",
        n,
        start.elapsed()
    );
    Ok(AnalyzeResult {
        order,
        ratings,
        lrc_ratings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("cull-scan-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// walk_folder: CR3s stage (case-insensitive), other files count as ignored,
    /// sidecars and dotfiles stay out of the count.
    #[test]
    fn walk_stages_cr3_and_counts_ignored() {
        let work = tmp_dir("ignored-count");
        for name in ["a.cr3", "b.CR3"] {
            fs::write(work.join(name), b"cr3").unwrap();
        }
        for name in ["c.jpg", "d.mp4", "e.nef"] {
            fs::write(work.join(name), b"x").unwrap();
        }
        // Not "surprising" files: CULL's own sidecar + OS noise.
        fs::write(work.join("a.xmp"), b"<xmp/>").unwrap();
        fs::write(work.join(".DS_Store"), b"").unwrap();

        let r = walk_folder(&work, None);
        assert_eq!(r.paths.len(), 2);
        assert_eq!(r.ignored, 3);
        let _ = fs::remove_dir_all(&work);
    }

    /// walk_folder: files inside the pruned rejected subfolder count for
    /// neither list — a moved-away reject is not "ignored", it's filed.
    #[test]
    fn walk_prunes_rejected_subfolder_from_both_counts() {
        let work = tmp_dir("prune-subdir");
        fs::write(work.join("keep.cr3"), b"cr3").unwrap();
        let rej = work.join("_rejected");
        fs::create_dir_all(&rej).unwrap();
        fs::write(rej.join("gone.cr3"), b"cr3").unwrap();
        fs::write(rej.join("gone.jpg"), b"x").unwrap();

        let r = walk_folder(&work, Some("_rejected"));
        assert_eq!(r.paths.len(), 1);
        assert_eq!(r.ignored, 0);
        let _ = fs::remove_dir_all(&work);
    }
}
