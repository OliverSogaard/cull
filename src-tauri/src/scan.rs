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

/// True for CULL's own crash-orphaned atomic-write temp shape,
/// `"<base>.xmp.<seq>.tmp"` (seq = one or more ASCII digits). Deliberately
/// strict — magic suffix + a numeric sequence + an `.xmp` head — so another
/// tool's `*.tmp` (or a user file that merely ends `.tmp`) is never swept.
fn is_orphan_xmp_temp(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".tmp") else {
        return false;
    };
    let Some((head, seq)) = stem.rsplit_once('.') else {
        return false;
    };
    head.ends_with(".xmp") && !seq.is_empty() && seq.bytes().all(|b| b.is_ascii_digit())
}

/// Order indices by capture time (`epoch` ms); a missing time sorts LAST, and
/// equal times (or two missing times) tiebreak on path. Pure so the ordering
/// contract is unit-testable without touching the filesystem. `epoch` and
/// `paths` are parallel, one entry per input index.
fn order_by_capture(epoch: &[Option<i64>], paths: &[String]) -> Vec<usize> {
    let mut order: Vec<usize> = (0..epoch.len()).collect();
    order.sort_by(|&a, &b| match (epoch[a], epoch[b]) {
        (Some(ea), Some(eb)) => ea.cmp(&eb).then_with(|| paths[a].cmp(&paths[b])),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => paths[a].cmp(&paths[b]),
    });
    order
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
    // Spawn-blocking: the recursive walk is sync fs I/O (potentially thousands
    // of NAS round-trips) and must not stall the async runtime — same pattern
    // as the file_ops commands.
    tauri::async_runtime::spawn_blocking(move || scan_folder_sync(&path, ignore_subdir))
        .await
        .map_err(|e| format!("scan task failed: {e}"))?
}

fn scan_folder_sync(path: &str, ignore_subdir: Option<String>) -> Result<ScanResult, String> {
    let start = Instant::now();
    let root = Path::new(path);

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
    /// Parent directories the analyze pass could not list, `"<dir>: <error>"`.
    /// Every frame in one lost its mtime (sorts last) and its sidecar was
    /// never discovered (reads back unrated) — the UI surfaces this instead of
    /// presenting a silently degraded order as if it were complete.
    unreadable_dirs: Vec<String>,
    /// Sidecars that exist but could not be read, `"<path>: <error>"`. Capped
    /// at [`RESTORE_ERROR_CAP`] entries so a folder-wide permissions failure
    /// can't blow up the IPC payload.
    restore_errors: Vec<String>,
    /// Exact number of failed sidecar reads, uncapped — `restore_errors` may
    /// list fewer.
    restore_error_count: u32,
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
/// image during culling via [`crate::bundle::read_preview`].
/// When the frontend passes `concurrent_restore = true` (storage mode = local),
/// sidecar reads run on this many threads. 4 is enough to saturate a local
/// SSD's queue depth without thrashing; the NAS path stays sequential.
const RESTORE_WORKERS: usize = 4;

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
            let path = entry.path();
            // Sweep crash-orphaned atomic-write temps left behind if the process
            // died between temp-create and rename (see [`is_orphan_xmp_temp`]).
            // Best-effort.
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                if is_orphan_xmp_temp(name) {
                    let _ = std::fs::remove_file(&path);
                    continue;
                }
            }
            if path
                .extension()
                .is_some_and(|e| e.eq_ignore_ascii_case("xmp"))
            {
                out.xmp_stems
                    .insert(path.with_extension("").to_string_lossy().to_lowercase());
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
                    out.mtime.insert(pstr.to_string(), since.as_millis() as i64);
                    // Size rides along for free (Phase 7): the tier cache's
                    // second validator, from the metadata already in hand.
                    out.sizes.insert(pstr.to_string(), md.len());
                }
            }
            done += 1;
            on_progress(done);
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
    // Spawn-blocking: directory listings + sequential sidecar restore are sync
    // fs I/O sized in NAS round-trips — off the async runtime, like scan_folder.
    // The State borrow can't cross into the 'static closure; the Arc can.
    let session = session.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        analyze_folder_sync(window, paths, concurrent_restore, &session)
    })
    .await
    .map_err(|e| format!("analyze task failed: {e}"))?
}

fn analyze_folder_sync(
    window: tauri::Window,
    paths: Vec<String>,
    concurrent_restore: Option<bool>,
    session: &crate::io_gate::SessionGate,
) -> Result<AnalyzeResult, String> {
    let concurrent_restore = concurrent_restore.unwrap_or(false);
    let n = paths.len();
    if n == 0 {
        return Ok(AnalyzeResult {
            order: vec![],
            ratings: vec![],
            lrc_ratings: vec![],
            unreadable_dirs: vec![],
            restore_errors: vec![],
            restore_error_count: 0,
        });
    }
    let start = Instant::now();

    // Enumerate each distinct parent dir ONCE. We also note which .xmp sidecars
    // exist, to avoid probe-opening absent ones (a fresh import has none).
    let step = (n / 100).max(1); // ≤ ~100 progress events
    let listing = list_parents(&paths, &mut |done| {
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
    });

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
    session.note_mtimes(&listing.mtime);
    session.note_sizes(&listing.sizes);

    let epoch: Vec<Option<i64>> = paths
        .iter()
        .map(|p| listing.mtime.get(p).copied())
        .collect();

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
            listing.xmp_stems.contains(&stem)
        })
        .collect();
    let total_xmp = to_read.len();
    let step_xmp = (total_xmp / 100).max(1); // ≤ ~100 progress events

    // One emit rule for both restore paths (multiples of `step_xmp`, plus the
    // final tick) so the bar advances identically regardless of storage mode.
    let restore = restore_ratings(&paths, &to_read, concurrent_restore, &|done| {
        if done.is_multiple_of(step_xmp) || done == total_xmp {
            let _ = window.emit(
                "analyze-progress",
                AnalyzeProgress {
                    done,
                    total: total_xmp,
                    phase: "restoring".into(),
                },
            );
        }
    });

    // Sort by capture time (mtime); missing times sort last, tiebreak on path.
    let order = order_by_capture(&epoch, &paths);

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
        ratings: restore.ratings,
        lrc_ratings: restore.lrc_ratings,
        unreadable_dirs: listing.unreadable,
        restore_errors: restore.errors,
        restore_error_count: restore.error_count,
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

    /// order_by_capture: earlier mtime first, exact-tie breaks on path, and any
    /// missing time sinks to the end (two missing ones tiebreak on path too).
    #[test]
    fn order_by_capture_sorts_by_mtime_then_path_missing_last() {
        // Indices:      0        1        2       3       4
        let paths: Vec<String> = ["d", "b", "a", "c", "e"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let epoch = vec![Some(200), Some(100), None, Some(100), None];
        // Expected: mtime 100 group first (idx 1 "b" before idx 3 "c"), then
        // mtime 200 (idx 0), then the missing-time group by path (idx 2 "a"
        // before idx 4 "e").
        assert_eq!(order_by_capture(&epoch, &paths), vec![1, 3, 0, 2, 4]);
    }

    /// order_by_capture: an all-missing set degrades to a pure path sort.
    #[test]
    fn order_by_capture_all_missing_is_path_order() {
        let paths: Vec<String> = ["z", "m", "a"].iter().map(|s| s.to_string()).collect();
        let epoch = vec![None, None, None];
        assert_eq!(order_by_capture(&epoch, &paths), vec![2, 1, 0]);
    }

    /// is_orphan_xmp_temp: only CULL's exact "<base>.xmp.<seq>.tmp" shape is
    /// swept — decoys (other tools' temps, non-numeric seq, no .xmp head, a
    /// user's genuine .tmp) are all left alone.
    #[test]
    fn orphan_temp_matches_only_cull_shape() {
        assert!(is_orphan_xmp_temp("IMG_0001.xmp.0.tmp"));
        assert!(is_orphan_xmp_temp("IMG_0001.xmp.42.tmp"));
        // Decoys:
        assert!(!is_orphan_xmp_temp("IMG_0001.xmp.tmp")); // no numeric seq segment
        assert!(!is_orphan_xmp_temp("IMG_0001.xmp.a.tmp")); // non-numeric seq
        assert!(!is_orphan_xmp_temp("IMG_0001.xmp.7.bak")); // wrong suffix
        assert!(!is_orphan_xmp_temp("IMG_0001.cr3.7.tmp")); // head not .xmp
        assert!(!is_orphan_xmp_temp("notes.tmp")); // a user's own temp
        assert!(!is_orphan_xmp_temp("IMG_0001.xmp")); // the real sidecar
        assert!(!is_orphan_xmp_temp("IMG_0001.xmp..tmp")); // empty seq
    }

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
            let work = tmp_dir(if concurrent {
                "restore-conc"
            } else {
                "restore-seq"
            });
            let a = work.join("a.cr3");
            let b = work.join("b.cr3");
            fs::write(&a, b"cr3").unwrap();
            fs::write(&b, b"cr3").unwrap();
            fs::create_dir_all(a.with_extension("xmp")).unwrap();
            fs::write(
                b.with_extension("xmp"),
                b"xmpDM:pick=\"1\" xmpDM:good=\"true\"",
            )
            .unwrap();
            // Pad with more sidecars so the concurrent branch actually splits.
            let mut paths = vec![
                a.to_string_lossy().to_string(),
                b.to_string_lossy().to_string(),
            ];
            for i in 0..6 {
                let p = work.join(format!("p{i}.cr3"));
                fs::write(&p, b"cr3").unwrap();
                fs::write(
                    p.with_extension("xmp"),
                    b"xmpDM:pick=\"-1\" xmpDM:good=\"false\"",
                )
                .unwrap();
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
}
