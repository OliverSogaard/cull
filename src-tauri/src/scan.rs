//! Folder scan + capture-time analysis.
//!
//! Two commands feed the staged/analyze phases:
//!
//! - [`scan_folder`] recursively lists CR3 files.
//! - [`analyze_folder`] orders them chronologically (EXIF capture time when the
//!   frontend asks for it, otherwise each file's mtime) and restores any
//!   existing CULL ratings from their `.xmp` sidecars.
//!
//! Both invariants: read-only, no CR3 mutation.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::Instant;

use tauri::Emitter;
use walkdir::WalkDir;

use crate::tier_cache::{CacheTier, TierCache};
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

/// One frame's sort key. EXIF capture time when the frame has one, else the
/// file's own mtime (written in shoot order for an in-camera write), else
/// `None` — which `order_by_capture` sinks to the end, in path order.
///
/// `offset_ms` is that FOLDER's clock correction and rides whichever source
/// won: the offset describes a body's clock, so applying it only to the EXIF
/// frames would split one folder across two clock spaces the moment a single
/// frame lost its `DateTimeOriginal`. Saturating, so a pathological offset
/// cannot wrap a sort key into the past.
fn capture_epoch(exif_ms: Option<i64>, mtime_ms: Option<i64>, offset_ms: i64) -> Option<i64> {
    exif_ms.or(mtime_ms).map(|t| t.saturating_add(offset_ms))
}

/// Re-express a true UTC epoch at `offset`, then read that wall clock AS IF it
/// were UTC. Split out from [`mtime_in_capture_frame`] so the conversion can be
/// pinned at explicit offsets in a test — on a UTC machine (CI) the local-clock
/// version is the identity and would prove nothing.
fn wall_clock_ms_at(ms: i64, offset: chrono::FixedOffset) -> Option<i64> {
    Some(
        chrono::DateTime::from_timestamp_millis(ms)?
            .with_timezone(&offset)
            .naive_local()
            .and_utc()
            .timestamp_millis(),
    )
}

/// A file's mtime (a true UTC epoch) moved into the frame EXIF capture times
/// live in — the camera's naive wall clock read as if it were UTC, which is
/// what `analyze::captured_at_ms` builds out of a timezone-less
/// `DateTimeOriginal` via `.and_utc()`.
///
/// The two frames are only interchangeable at UTC+00. Mixing them raw would
/// put every mtime fallback the machine's offset away from its true
/// neighbours — seven hours, in Los Angeles — so one unreadable head in the
/// middle of a burst would sort at the far end of the shoot. Only the
/// `by_capture_time` path needs this: with the flag off every key is an mtime,
/// one frame throughout, and the raw values are already consistent.
///
/// The offset is the one in force AT THAT INSTANT, not today's, so frames shot
/// either side of a DST boundary each convert with the offset the camera's
/// clock was actually showing. A timestamp outside chrono's range keeps its raw
/// value: a slightly-misplaced frame still beats a frame with no key at all.
fn mtime_in_capture_frame(ms: i64) -> i64 {
    let Some(utc) = chrono::DateTime::from_timestamp_millis(ms) else {
        return ms;
    };
    wall_clock_ms_at(ms, *utc.with_timezone(&chrono::Local).offset()).unwrap_or(ms)
}

/// The two capture fields of a CACHED thumb-tier header (`bundle::ThumbHeader`),
/// combined into an epoch. Minimal-struct parse in the house style of
/// `bundle::OrientationOnly`: only the fields this pass needs, every one
/// `serde(default)`, so a v1 header (`meta: null`), a header written before a
/// field existed, or one written after a field is added all parse instead of
/// erroring. `None` means "the cache cannot answer" — never "this frame has no
/// time" — so the caller falls through to the source file.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedCapture {
    #[serde(default)]
    captured_at: Option<String>,
    #[serde(default)]
    sub_sec_ms: Option<u16>,
}

#[derive(serde::Deserialize)]
struct CachedThumbHeader {
    #[serde(default)]
    meta: Option<CachedCapture>,
}

fn capture_from_thumb_header(header_json: &[u8]) -> Option<i64> {
    let h: CachedThumbHeader = serde_json::from_slice(header_json).ok()?;
    let m = h.meta?;
    crate::analyze::captured_at_ms(m.captured_at.as_deref(), m.sub_sec_ms)
}

/// EXIF capture time for one frame, cheapest source first: the thumb tier's
/// stored header (validated by the listing's own mtime + size, so a hit costs
/// ZERO source-file round-trips and re-opening a shoot is free), then a
/// `moov`-head read of the CR3 itself. Any read failure is `None` — a frame
/// that cannot be opened here still sorts, on its mtime.
fn exif_ms_for(cache: &TierCache, path: &str, stat: Option<(i64, u64)>) -> Option<i64> {
    if let Some((ms, size)) = stat {
        if let Some((header, _payload)) = cache.get(CacheTier::Thumb, path, ms, size) {
            if let Some(t) = capture_from_thumb_header(&header) {
                return Some(t);
            }
        }
    }
    let (captured_at, sub_sec) = crate::cr3::read_capture_time(path).ok()?;
    crate::analyze::captured_at_ms(captured_at.as_deref(), sub_sec)
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
    /// Input indices in session order. The key is each file's EXIF
    /// `DateTimeOriginal` + `SubSecTimeOriginal` when `by_capture_time` is on
    /// (falling back per frame to that file's mtime), otherwise the mtime
    /// alone; path is the tiebreak either way, and a frame with neither sorts
    /// last.
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
/// BY DEFAULT capture order comes from each file's mtime, gathered from each
/// parent directory's listing. On Windows `DirEntry::metadata()` is served from
/// the directory scan (no extra round-trip per file), so we pay for a few
/// listings instead of `n` opens. On a NAS where every open is a round-trip
/// (~37 ms in the benchmark), this collapses ~10 min of metadata reads into
/// seconds.
///
/// `by_capture_time` spends that saving deliberately: it reads each frame's
/// EXIF `DateTimeOriginal` ([`exif_ms_for`] — the thumb-cache header first, so
/// a re-opened shoot is still free), which is the only key that interleaves two
/// bodies correctly. The rest of EXIF (lens, GPS, AF point) is read lazily per
/// image during culling via [`crate::bundle::read_preview`] on either path.
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

/// Read every frame's EXIF capture time, on `RESTORE_WORKERS` threads when the
/// storage hint says local (same rule and same pool shape as `restore_ratings`
/// — the benchmarked NAS punishes concurrent opens hard). `on_progress(done)`
/// fires once per frame, from worker threads on the concurrent path.
///
/// `cancelled` is polled before EVERY file, in every worker: a superseded
/// analyze stops within one read instead of opening the other 4,000 frames.
/// What it never reached keeps `None` and falls back to that frame's mtime in
/// the sort — the same graceful degradation a panicked chunk gets, so the
/// analyze still returns a usable order rather than an error.
fn read_capture_epochs(
    cache: &TierCache,
    paths: &[String],
    stats: &[Option<(i64, u64)>],
    concurrent: bool,
    cancelled: &(dyn Fn() -> bool + Sync),
    on_progress: &(dyn Fn(usize) + Sync),
) -> Vec<Option<i64>> {
    let n = paths.len();
    let mut out: Vec<Option<i64>> = vec![None; n];
    if concurrent && n > RESTORE_WORKERS {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let done_counter = AtomicUsize::new(0);
        let chunk_size = n.div_ceil(RESTORE_WORKERS);
        let done_ref = &done_counter;
        let all: Vec<usize> = (0..n).collect();
        let parts: Vec<Vec<(usize, Option<i64>)>> = std::thread::scope(|s| {
            let mut handles = Vec::with_capacity(RESTORE_WORKERS);
            for chunk in all.chunks(chunk_size) {
                handles.push(s.spawn(move || {
                    let mut part = Vec::with_capacity(chunk.len());
                    for &i in chunk {
                        if cancelled() {
                            break;
                        }
                        part.push((i, exif_ms_for(cache, &paths[i], stats[i])));
                        on_progress(done_ref.fetch_add(1, Ordering::Relaxed) + 1);
                    }
                    part
                }));
            }
            handles
                .into_iter()
                .map(|h| {
                    h.join().unwrap_or_else(|_| {
                        // A panicked worker must not poison the whole analyze:
                        // its chunk reads back with no EXIF and sorts on mtime.
                        dlog!("[cull] analyze_folder: capture worker panicked; its chunk sorts on mtime");
                        Vec::new()
                    })
                })
                .collect()
        });
        for part in parts {
            for (i, t) in part {
                out[i] = t;
            }
        }
    } else {
        for i in 0..n {
            if cancelled() {
                break;
            }
            out[i] = exif_ms_for(cache, &paths[i], stats[i]);
            on_progress(i + 1);
        }
    }
    out
}

/// `concurrent_restore` is a storage hint forwarded from frontend settings.
/// `Some(true)` parallelises sidecar reads AND the capture-time pass (fine
/// on local SSD); defaults to sequential — safe on a NAS that punishes
/// concurrent opens.
///
/// `by_capture_time` (default false) swaps the sort key from each file's
/// mtime to its EXIF `DateTimeOriginal` + `SubSecTimeOriginal`, per frame,
/// falling back to that frame's mtime where the EXIF is absent.
/// `offsets_ms` is a per-INPUT-PATH clock correction in milliseconds (the
/// frontend resolves its own folder → offset map before calling, because
/// the folder a frame belongs to is the folder the USER picked, not the
/// subdirectory the recursive walk found it in). Ignored when
/// `by_capture_time` is off; a short or absent vector reads as 0.
///
/// `gen` is the session generation, the same one `read_preview` / `read_mid` /
/// `analyze_quality` carry: the capture pass polls it per frame and stops when
/// it moves, so a superseded Begin culling stops opening files instead of
/// grinding through the rest of the shoot. `None` never cancels — the mtime
/// path opens nothing anyway, and a caller that doesn't send a generation
/// keeps today's behaviour.
// Eight arguments, over clippy's seven: a Tauri command's parameters ARE its
// wire protocol, so grouping them into a struct would change the invoke shape
// for no gain at the only call site there will ever be.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub(crate) async fn analyze_folder(
    window: tauri::Window,
    paths: Vec<String>,
    concurrent_restore: Option<bool>,
    by_capture_time: Option<bool>,
    offsets_ms: Option<Vec<i64>>,
    gen: Option<u64>,
    session: tauri::State<'_, std::sync::Arc<crate::io_gate::SessionGate>>,
    cache: tauri::State<'_, std::sync::Arc<crate::tier_cache::TierCache>>,
) -> Result<AnalyzeResult, String> {
    // Spawn-blocking: directory listings + sequential sidecar restore are sync
    // fs I/O sized in NAS round-trips — off the async runtime, like scan_folder.
    // The State borrows can't cross into the 'static closure; the Arcs can.
    let session = session.inner().clone();
    let cache = cache.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        analyze_folder_sync(
            window,
            paths,
            concurrent_restore,
            by_capture_time,
            offsets_ms,
            gen,
            &session,
            &cache,
        )
    })
    .await
    .map_err(|e| format!("analyze task failed: {e}"))?
}

#[allow(clippy::too_many_arguments)] // mirrors the command's parameters
fn analyze_folder_sync(
    window: tauri::Window,
    paths: Vec<String>,
    concurrent_restore: Option<bool>,
    by_capture_time: Option<bool>,
    offsets_ms: Option<Vec<i64>>,
    gen: Option<u64>,
    session: &crate::io_gate::SessionGate,
    cache: &TierCache,
) -> Result<AnalyzeResult, String> {
    let concurrent_restore = concurrent_restore.unwrap_or(false);
    let by_capture_time = by_capture_time.unwrap_or(false);
    let n = paths.len();
    // A wrong-length offsets vector is memory-safe — `.get(i)` just reads 0 past
    // the end — but silently wrong, which is worse: say so instead of shipping a
    // folder whose clock correction quietly stopped applying partway through.
    if let Some(v) = offsets_ms.as_ref() {
        if v.len() != n {
            dlog!(
                "[cull] analyze_folder: {} offsets for {} paths; extras read as 0",
                v.len(),
                n
            );
        }
    }
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

    // The sort key. Default: each file's mtime, from the directory listings
    // above — no file is opened. With `by_capture_time`, each frame's EXIF
    // capture time instead (thumb-cache hit first, else a moov-head read),
    // with that frame's folder offset, falling back to its mtime.
    let epoch: Vec<Option<i64>> = if by_capture_time {
        let stats: Vec<Option<(i64, u64)>> = paths
            .iter()
            .map(|p| match (listing.mtime.get(p), listing.sizes.get(p)) {
                (Some(&ms), Some(&size)) => Some((ms, size)),
                _ => None,
            })
            .collect();
        let step_cap = (n / 100).max(1); // ≤ ~100 progress events

        // The generation moves when the frontend resets its store, which is
        // exactly when this pass's answer stopped mattering.
        let cancelled = || gen.is_some_and(|g| session.is_cancelled(g));
        let exif = read_capture_epochs(
            cache,
            &paths,
            &stats,
            concurrent_restore,
            &cancelled,
            &|done| {
                if done.is_multiple_of(step_cap) || done == n {
                    let _ = window.emit(
                        "analyze-progress",
                        AnalyzeProgress {
                            done,
                            total: n,
                            phase: "capturing".into(),
                        },
                    );
                }
            },
        );
        // One terminal tick, for the same reason the listing pass emits one.
        let _ = window.emit(
            "analyze-progress",
            AnalyzeProgress {
                done: n,
                total: n,
                phase: "capturing".into(),
            },
        );
        (0..n)
            .map(|i| {
                let offset = offsets_ms
                    .as_ref()
                    .and_then(|v| v.get(i).copied())
                    .unwrap_or(0);
                // The fallback is rebased onto the EXIF clock frame (see
                // [`mtime_in_capture_frame`]): on this path the two key kinds
                // sit side by side in one order, so they must share a frame.
                let mtime = listing
                    .mtime
                    .get(&paths[i])
                    .copied()
                    .map(mtime_in_capture_frame);
                capture_epoch(exif[i], mtime, offset)
            })
            .collect()
    } else {
        paths
            .iter()
            .map(|p| listing.mtime.get(p).copied())
            .collect()
    };

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

    // Sort by the epoch built above; missing times sort last, tiebreak on path.
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
        "[cull] analyze_folder: {} images in {:?} ({})",
        n,
        start.elapsed(),
        if by_capture_time {
            "EXIF capture time"
        } else {
            "mtime fast path"
        }
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

/// Capture time (epoch ms, camera local clock) for a handful of paths — the
/// staged screen's per-folder probe, called with the FIRST STAGED (i.e.
/// lexicographically first, `scan.rs`'s `paths.sort()`) frame of each staged
/// folder, so the row can print THAT frame's capture time and the signed
/// difference from the first folder's. Not necessarily the folder's earliest
/// frame — a 9999→0001 counter wrap reverses the two. Deliberately cache-free and
/// sequential: N is the number of staged folders (one or two in practice), so
/// wiring the tier cache in would cost more than the reads it saves.
/// A per-path failure is `None`, never an error: a row with no time just shows
/// a dash.
#[tauri::command]
pub(crate) async fn read_capture_times(paths: Vec<String>) -> Result<Vec<Option<i64>>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        paths
            .iter()
            .map(|p| {
                let (captured_at, sub_sec) = crate::cr3::read_capture_time(p).ok()?;
                crate::analyze::captured_at_ms(captured_at.as_deref(), sub_sec)
            })
            .collect()
    })
    .await
    .map_err(|e| format!("capture-time task failed: {e}"))
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

    /// capture_epoch: EXIF wins, the file's mtime is the fallback, and the
    /// folder's clock offset rides whichever one won — a folder must never be
    /// split across two clock spaces just because one frame lost its EXIF.
    #[test]
    fn capture_epoch_prefers_exif_then_mtime_and_always_offsets() {
        assert_eq!(capture_epoch(Some(1_000), Some(9_000), 0), Some(1_000));
        assert_eq!(capture_epoch(None, Some(9_000), 0), Some(9_000));
        assert_eq!(capture_epoch(None, None, 5_000), None);
        assert_eq!(capture_epoch(Some(1_000), None, 300_000), Some(301_000));
        assert_eq!(capture_epoch(None, Some(9_000), -1_500), Some(7_500));
    }

    /// A pathological offset must not wrap the sort key into the past.
    #[test]
    fn capture_epoch_saturates_instead_of_overflowing() {
        assert_eq!(capture_epoch(Some(i64::MAX), None, 1), Some(i64::MAX));
        assert_eq!(capture_epoch(Some(i64::MIN), None, -1), Some(i64::MIN));
    }

    /// capture_from_thumb_header: the two fields are read out of a stored
    /// ThumbHeader without re-opening the CR3, and every degraded shape
    /// (a v1 `meta: null`, an empty object, a frame with no DateTimeOriginal,
    /// outright garbage) answers None so the caller falls through to the file.
    #[test]
    fn capture_from_thumb_header_reads_a_cached_header_and_tolerates_old_ones() {
        let full = br#"{"width":160,"height":120,"jpegLen":9000,"meta":{"capturedAt":"2026-09-20T14:02:11","subSecMs":470,"camera":"Canon EOS R6m3","iso":400}}"#;
        let ms = capture_from_thumb_header(full).expect("a full header carries the time");
        assert_eq!(
            ms,
            crate::analyze::captured_at_ms(Some("2026-09-20T14:02:11"), Some(470)).unwrap()
        );
        assert_eq!(
            capture_from_thumb_header(br#"{"meta":null}"#),
            None,
            "v1 header"
        );
        assert_eq!(capture_from_thumb_header(b"{}"), None, "no meta key at all");
        assert_eq!(
            capture_from_thumb_header(br#"{"meta":{"subSecMs":470}}"#),
            None,
            "SubSec alone is not a time"
        );
        assert_eq!(capture_from_thumb_header(b"not json"), None);
    }

    /// wall_clock_ms_at: the conversion is pinned at two explicit offsets, so
    /// it is covered on a UTC machine (CI) where the two frames coincide and a
    /// local-timezone assertion alone would prove nothing.
    #[test]
    fn wall_clock_conversion_rebases_a_utc_epoch_onto_the_camera_clock() {
        // One instant, 21:02:11 UTC — 14:02:11 in Los Angeles (−07:00),
        // 23:02:11 in Copenhagen (+02:00).
        let utc_ms = crate::analyze::captured_at_ms(Some("2026-09-20T21:02:11"), None).unwrap();
        let la = chrono::FixedOffset::east_opt(-7 * 3600).unwrap();
        let cph = chrono::FixedOffset::east_opt(2 * 3600).unwrap();
        assert_eq!(
            wall_clock_ms_at(utc_ms, la),
            crate::analyze::captured_at_ms(Some("2026-09-20T14:02:11"), None)
        );
        assert_eq!(
            wall_clock_ms_at(utc_ms, cph),
            crate::analyze::captured_at_ms(Some("2026-09-20T23:02:11"), None)
        );
    }

    /// mtime_in_capture_frame: an mtime lands in exactly the frame
    /// `captured_at_ms` builds, so an EXIF key and an mtime fallback are
    /// comparable. The expectation is computed THROUGH `chrono::Local`, so the
    /// test is correct in any timezone (on a UTC machine it reduces to
    /// identity, which is the right answer there).
    #[test]
    fn mtime_in_capture_frame_matches_that_instants_local_wall_clock() {
        let utc_ms = crate::analyze::captured_at_ms(Some("2026-09-20T21:02:11"), None).unwrap();
        let wall = chrono::DateTime::from_timestamp_millis(utc_ms)
            .unwrap()
            .with_timezone(&chrono::Local)
            .format("%Y-%m-%dT%H:%M:%S")
            .to_string();
        assert_eq!(
            mtime_in_capture_frame(utc_ms),
            crate::analyze::captured_at_ms(Some(&wall), None).unwrap()
        );
        // Outside chrono's range there is nothing to rebase onto: the raw value
        // stands, so the frame keeps a sort key instead of losing its place.
        assert_eq!(mtime_in_capture_frame(i64::MIN), i64::MIN);
    }

    /// Seed `n` thumb-tier entries with a distinct capture time each, for paths
    /// that DO NOT exist on disk — so any time that comes back proves the cache
    /// answered it with zero source reads. Returns (paths, stats, wanted).
    #[allow(clippy::type_complexity)]
    fn seed_thumb_capture_times(
        cache: &TierCache,
        dir: &Path,
        n: usize,
    ) -> (Vec<String>, Vec<Option<(i64, u64)>>, Vec<Option<i64>>) {
        let mut paths = Vec::with_capacity(n);
        let mut stats = Vec::with_capacity(n);
        let mut want = Vec::with_capacity(n);
        for i in 0..n {
            let path = dir
                .join(format!("IMG_{i:04}.CR3"))
                .to_string_lossy()
                .to_string();
            let captured = format!("2026-09-20T14:02:{:02}", i % 60);
            let sub_sec = i as u16;
            let header = format!(
                r#"{{"width":160,"height":120,"jpegLen":0,"meta":{{"capturedAt":"{captured}","subSecMs":{sub_sec}}}}}"#
            );
            let stat = (1_700_000_000_000 + i as i64, 4096 + i as u64);
            cache.put(
                CacheTier::Thumb,
                &path,
                stat.0,
                stat.1,
                header.as_bytes(),
                b"",
            );
            want.push(crate::analyze::captured_at_ms(
                Some(&captured),
                Some(sub_sec),
            ));
            paths.push(path);
            stats.push(Some(stat));
        }
        (paths, stats, want)
    }

    /// read_capture_epochs on the concurrent path: EVERY index gets ITS OWN
    /// cached time back (the chunk → index mapping is the easy thing to get
    /// wrong), and an entry whose (mtime, size) no longer matches the listing
    /// is not used — a stale cache must never decide a frame's place.
    #[test]
    fn read_capture_epochs_maps_every_index_to_its_own_cached_time() {
        let work = tmp_dir("capture-cache");
        let cache = TierCache::new(work.join("tiers"));
        // > 4 × RESTORE_WORKERS, and not a multiple of it, so the last chunk is
        // short and every boundary is exercised.
        let n = 21;
        let (paths, stats, want) = seed_thumb_capture_times(&cache, &work, n);
        assert!(
            !Path::new(&paths[0]).exists(),
            "the seeded paths must not exist, or a hit proves nothing"
        );

        let out = read_capture_epochs(&cache, &paths, &stats, true, &|| false, &|_| {});
        assert_eq!(out, want);

        // Same frame, a listing that no longer agrees with the stored entry:
        // the cache is refused and the (absent) source cannot answer either.
        let mut stale = stats.clone();
        stale[0] = Some((1, 1));
        let out = read_capture_epochs(&cache, &paths, &stale, true, &|| false, &|_| {});
        assert_eq!(out[0], None, "a stale entry must not be used");
        assert_eq!(out[1], want[1], "its neighbours are unaffected");
        let _ = fs::remove_dir_all(&work);
    }

    /// read_capture_epochs: a cancel mid-pass stops the reads there and then.
    /// The frames already read keep their times; the rest come back None and
    /// fall back to their mtime in the sort, exactly like a panicked chunk —
    /// a superseded Begin culling must not keep opening thousands of files.
    #[test]
    fn read_capture_epochs_stops_reading_once_cancelled() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let work = tmp_dir("capture-cancel");
        let cache = TierCache::new(work.join("tiers"));
        let n = 10;
        let (paths, stats, want) = seed_thumb_capture_times(&cache, &work, n);

        // Cancelled from the 4th check on: 3 frames are read, 7 are not.
        let checks = AtomicUsize::new(0);
        let cancelled = || checks.fetch_add(1, Ordering::Relaxed) >= 3;
        let out = read_capture_epochs(&cache, &paths, &stats, false, &cancelled, &|_| {});
        assert_eq!(out[..3], want[..3], "frames read before the cancel");
        assert!(
            out[3..].iter().all(Option::is_none),
            "frames after the cancel stay unread: {:?}",
            &out[3..]
        );
        assert_eq!(checks.load(Ordering::Relaxed), 4, "stopped at the cancel");
        let _ = fs::remove_dir_all(&work);
    }
}
