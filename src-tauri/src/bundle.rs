//! Per-image reads: navigation preview, zoom full-res, and the tiny embedded
//! thumbnail.
//!
//! ## Invariant
//!
//! CR3 files are NEVER modified — every read goes through [`crate::cr3`]'s
//! pure-Rust parser. Orientation is applied by splicing an EXIF tag into the
//! returned JPEG bytes (the webview rotates on display); the file on disk is
//! untouched, and there is no decode/re-encode, so the embedded JPEG's quality
//! is preserved bit-for-bit.
//!
//! ## Gating (Phase 2)
//!
//! Every read command runs through [`gated_read`]: an [`IoGate`] permit
//! (global backstop), the tier's timeout (backend-owned; detach + ignore on
//! expiry), and a `spawn_blocking` so slow NAS reads never stall the async
//! runtime. `read_preview`/`read_fullres` additionally carry the session
//! generation for chunked-read cancellation.

use std::sync::Arc;
use std::time::Instant;
use tauri::ipc::Response;
use tauri::State;

use crate::cr3;
use crate::gridthumb;
use crate::io_gate::{IoGate, SessionGate, Tier};
use crate::meta::ImageMetadata;
use crate::midtier::{self, MidGen};
use crate::tier_cache::{stat_of, CacheTier, TierCache};

/// (mtime ms, file size) for tier-cache validation WITHOUT a hot-path stat:
/// the session table (fed by analyze's dir listings) when known; ONE memoized
/// stat for un-analyzed paths. None (stat failed) → skip the cache entirely.
pub(crate) fn resolve_stat(session: &SessionGate, path: &str) -> Option<(i64, u64)> {
    if let Some(s) = session.file_stat(path) {
        return Some(s);
    }
    let s = stat_of(path);
    if let Some((ms, size)) = s {
        session.note_mtime(path, ms);
        session.note_size(path, size);
    }
    s
}

/// u32 LE header-length + JSON header + raw payload — the one binary frame
/// shape every image read shares (no base64; the frontend slices the
/// `ArrayBuffer` directly).
fn frame(header_json: Vec<u8>, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + header_json.len() + payload.len());
    out.extend_from_slice(&(header_json.len() as u32).to_le_bytes());
    out.extend_from_slice(&header_json);
    out.extend_from_slice(payload);
    out
}

/// Run one blocking operation under the IoGate with the tier's timeout.
///
/// On timeout the invoke REJECTS — the frontend's lane slot frees instantly —
/// while the orphaned blocking task keeps its owned permit and self-heals when
/// the syscall eventually returns (blocking fs reads can't be safely aborted
/// on Windows/macOS, so detach + ignore is the decision; see io_gate.rs). The
/// watcher logs when the orphan lands: the stuck-permit detector.
///
/// Generic over the result so multi-stage commands (`read_mid`'s probe-then-
/// generate) can run each stage gated without re-implementing the machinery;
/// [`gated_read`] is the Response-producing wrapper every one-shot read uses.
pub(crate) async fn gated<T: Send + 'static>(
    gate: &IoGate,
    tier: Tier,
    label: String,
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let dur = gate.read_timeout(tier);
    // Bound the WAIT for a permit too: if every backstop permit is held by
    // hung orphans (NAS gone with many reads in flight), an unbounded acquire
    // would pin frontend lanes after all. Rejecting here keeps the "a hung
    // read never costs a frontend lane" guarantee absolute; the frontend's
    // retry/backoff model treats it like any other failed read.
    let Ok(permit) = tokio::time::timeout(dur, gate.acquire()).await else {
        return Err(format!("{label}: I/O gate saturated (reads hung?)"));
    };
    let started = Instant::now();
    let mut handle = tokio::task::spawn_blocking(move || {
        let _permit = permit; // held for the WHOLE read, surviving a detach
        work()
    });
    match tokio::time::timeout(dur, &mut handle).await {
        Ok(joined) => joined.map_err(|e| format!("read task failed: {e}"))?,
        Err(_) => {
            let msg = format!("{label}: read timed out after {}s", dur.as_secs());
            tauri::async_runtime::spawn(async move {
                let _ = handle.await;
                dlog!(
                    "[cull] {label}: orphaned read returned after {:?} (timeout {:?})",
                    started.elapsed(),
                    dur
                );
            });
            Err(msg)
        }
    }
}

/// One gated blocking read producing a raw-binary IPC frame.
async fn gated_read(
    gate: &IoGate,
    tier: Tier,
    label: String,
    work: impl FnOnce() -> Result<Vec<u8>, String> + Send + 'static,
) -> Result<Response, String> {
    gated(gate, tier, label, work).await.map(Response::new)
}

// ── Navigation tier ─────────────────────────────────────────────────────────

/// Header for [`read_preview`]: full metadata, the orientation (echoed back to
/// `read_fullres` so the zoom tier skips the moov re-parse), and the exact
/// full-res range hint from moov's sample tables.
/// Deserialize exists for one consumer: `fetch_decoded_preview` re-reading a
/// cached entry's stored wire header (the v2 cache stores it verbatim).
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreviewHeader {
    meta: ImageMetadata,
    orientation: u32,
    preview_len: u32,
    full_offset: Option<u64>,
    full_len: Option<u64>,
}

/// Navigation hot path: ONE open, ONE ~2 MiB read → 1620×1080 PRVW + metadata
/// + the zoom tier's range hint. `Err("… no PRVW")` per the edge contract when
/// the body writes none (frontend routes that path's nav tier to full).
///
/// Phase 7: served from the on-disk prvw tier cache when current (validated
/// against the session stat table — a hit costs ZERO source-file round-trips
/// and returns the frame byte-identical to a fresh parse, header included);
/// misses piggyback their result into the cache — never a standalone sweep.
#[tauri::command]
pub(crate) async fn read_preview(
    path: String,
    gen: u64,
    cache: State<'_, Arc<TierCache>>,
    gate: State<'_, Arc<IoGate>>,
    session: State<'_, Arc<SessionGate>>,
) -> Result<Response, String> {
    let cache = Arc::clone(&cache);
    let session = Arc::clone(&session);
    let label = format!("read_preview({path})");
    gated_read(&gate, Tier::Small, label, move || {
        let start = Instant::now();
        let (header_json, jpeg, hit) =
            preview_parts(&path, &session, &cache, &|| session.is_cancelled(gen))?;
        dlog!(
            "[cull] read_preview({}): {} {}B in {:?}",
            path,
            if hit { "prvw cache hit" } else { "cold read" },
            jpeg.len(),
            start.elapsed()
        );
        Ok(frame(header_json, &jpeg))
    })
    .await
}

/// The one prvw acquisition path (shared by [`read_preview`],
/// [`fetch_decoded_preview`] and [`read_grid_thumb`], so cache/read behavior
/// can never drift): validated cache hit returns the stored wire header +
/// payload VERBATIM; a miss is ONE head read.
///
/// `put_on_miss` decides whether that miss is written back to the prvw tier.
/// Navigation says yes — it is the tier's own filler. The GRID says no: it
/// visits frames the loupe never opens, and writing every one of them would
/// push ~2.2 GB through a 2 GiB cap and evict the previews the user is
/// actually navigating (spec: "the grid path must NOT fill the preview
/// cache"). A cache HIT still serves the grid, at zero source I/O.
///
/// Returns `(header_json, preview_jpeg, was_cache_hit)`.
fn preview_parts_opt(
    path: &str,
    session: &SessionGate,
    cache: &TierCache,
    cancelled: &dyn Fn() -> bool,
    put_on_miss: bool,
) -> Result<(Vec<u8>, Vec<u8>, bool), String> {
    let stat = resolve_stat(session, path);
    if let Some((ms, size)) = stat {
        if let Some((header, payload)) = cache.get(CacheTier::Prvw, path, ms, size) {
            return Ok((header, payload, true));
        }
    }
    let b = cr3::read_preview_bundle(path, cancelled).map_err(|e| format!("cr3 preview: {e}"))?;
    let mut meta = ImageMetadata::from(b.meta);
    meta.file_size = Some(b.file_size);
    let header = PreviewHeader {
        meta,
        orientation: b.orientation,
        preview_len: b.preview.len() as u32,
        full_offset: b.full_hint.map(|h| h.0),
        full_len: b.full_hint.map(|h| h.1),
    };
    let header_json = serde_json::to_vec(&header).map_err(|e| format!("preview header: {e}"))?;
    if put_on_miss {
        if let Some((ms, size)) = stat {
            cache.put(CacheTier::Prvw, path, ms, size, &header_json, &b.preview);
        }
    }
    Ok((header_json, b.preview, false))
}

/// The navigation form: a miss piggy-backs into the prvw cache, as it always
/// has. `read_preview` and `fetch_decoded_preview` call this and are unchanged.
fn preview_parts(
    path: &str,
    session: &SessionGate,
    cache: &TierCache,
    cancelled: &dyn Fn() -> bool,
) -> Result<(Vec<u8>, Vec<u8>, bool), String> {
    preview_parts_opt(path, session, cache, cancelled, true)
}

/// Smart culling's per-file fetch (docs/history/SMART_CULLING_PLAN.md Phase 1): the same
/// prvw acquisition as [`read_preview`] — validated cache hit, else ONE head
/// read that piggy-back-fills the cache — then a zune-jpeg RGB decode of the
/// PRVW for the metric pass. Runs inside `analyze_quality`'s gated chunk; the
/// session `gen` threads cancellation into the read itself.
pub(crate) fn fetch_decoded_preview(
    path: &str,
    gen: u64,
    session: &SessionGate,
    cache: &TierCache,
) -> Result<crate::analyze::DecodedInput, String> {
    let (header_json, jpeg, _hit) =
        preview_parts(path, session, cache, &|| session.is_cancelled(gen))?;
    let header: PreviewHeader =
        serde_json::from_slice(&header_json).map_err(|e| format!("prvw header parse: {e}"))?;

    // Decode to RGB8 (see jpeg_rgb). The decoder ignores the spliced EXIF
    // orientation, so pixels come out in the UN-ROTATED sensor frame —
    // exactly what the AF-crop inverse mapping expects.
    let (rgb, w, h) = crate::jpeg_rgb::decode_rgb(&jpeg).map_err(|e| format!("prvw {e}"))?;

    let m = header.meta;
    Ok(crate::analyze::DecodedInput {
        rgb,
        w,
        h,
        orientation: header.orientation,
        af_x_pct: m.af_x_pct,
        af_y_pct: m.af_y_pct,
        // mtime for TS burst grouping; resolve_stat memoized this above. 0
        // (stat failed mid-session) is harmless: the TS captured_at guard and
        // drive_mode gate keep a 0-delta from fabricating groups.
        mtime_ms: resolve_stat(session, path).map(|(ms, _)| ms).unwrap_or(0),
        drive_mode: m.drive_mode,
        focal_length_mm: m.focal_length_mm,
        shutter_seconds: m.shutter_seconds,
        iso: m.iso,
        sub_sec_ms: m.sub_sec_ms,
        captured_at: m.captured_at,
    })
}

/// Header for [`read_fullres`]: just the JPEG length.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FullresHeader {
    full_len: u32,
}

/// The zoom/mid tiers' shared full-res ladder: exact-range chunked read via
/// the moov hint (SOI/EOI validated), any mismatch → the legacy head+grow
/// mdat scan (with a dlog line — telemetry for future bodies). Returns the
/// raw JPEG plus the authoritative orientation: the echoed one when the
/// caller has it (it arrived with the preview header), else the scan's
/// self-derived value — orientation 1 must NEVER be assumed (a rotated frame
/// would cache unrotated).
fn full_with_orientation(
    label: &str,
    path: &str,
    full_offset: Option<u64>,
    full_len: Option<u64>,
    orientation: Option<u32>,
    cancelled: &dyn Fn() -> bool,
) -> Result<(Vec<u8>, u32), String> {
    match (full_offset, full_len, orientation) {
        // The exact-range path needs the echoed orientation (it never sees
        // moov); without one, scan + self-derive even if a range hint exists.
        (Some(off), Some(len), Some(echoed)) => {
            match cr3::read_fullres_at(path, off, len, cancelled) {
                Ok(jpeg) => Ok((jpeg, echoed)),
                Err(e) if cr3::is_cancelled(&e) => Err("cancelled".into()),
                Err(e) => {
                    dlog!("[cull] {label}: hint mismatch ({e}) — mdat scan fallback");
                    let (jpeg, _) =
                        cr3::read_fullres_scan(path).map_err(|e| format!("cr3 fullres: {e}"))?;
                    // The echo came from this file's own preview header —
                    // still authoritative even when the range hint wasn't.
                    Ok((jpeg, echoed))
                }
            }
        }
        _ => {
            // Hintless (the idle sweep over never-navigated paths; rare zoom
            // races): derive the range + orientation from a ~2 MiB moov head,
            // then ONE exact-range read — the 12 MiB+ grow scan must not
            // become a common path again (review F2; the plan's cut list
            // deleted buf_pool.rs on the premise the scan stays rare). The
            // scan remains the net under any locate/validation failure.
            match cr3::locate_fullres(path, cancelled) {
                Ok((Some((off, len)), derived)) => {
                    match cr3::read_fullres_at(path, off, len, cancelled) {
                        Ok(jpeg) => return Ok((jpeg, orientation.unwrap_or(derived))),
                        Err(e) if cr3::is_cancelled(&e) => return Err("cancelled".into()),
                        Err(e) => {
                            dlog!(
                                "[cull] {label}: derived hint mismatch ({e}) — mdat scan fallback"
                            );
                        }
                    }
                }
                Err(e) if cr3::is_cancelled(&e) => return Err("cancelled".into()),
                _ => {} // no hint derivable / head unreadable → the scan decides
            }
            let (jpeg, scanned) =
                cr3::read_fullres_scan(path).map_err(|e| format!("cr3 fullres: {e}"))?;
            Ok((jpeg, orientation.unwrap_or(scanned)))
        }
    }
}

/// Zoom tier: seek + ONE exact-range chunked read via the moov hint (see
/// [`full_with_orientation`] for the validation/fallback/orientation ladder).
/// Phase 8: a successful read also feeds the OPPORTUNISTIC mid generator —
/// the full's bytes are already in memory, so the ≤2560px tier costs CPU
/// only, zero extra I/O (this is how the mid cache fills on network mode).
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri command: the signature IS the wire contract
pub(crate) async fn read_fullres(
    path: String,
    gen: u64,
    full_offset: Option<u64>,
    full_len: Option<u64>,
    orientation: Option<u32>,
    cache: State<'_, Arc<TierCache>>,
    gate: State<'_, Arc<IoGate>>,
    session: State<'_, Arc<SessionGate>>,
    midgen: State<'_, Arc<MidGen>>,
) -> Result<Response, String> {
    let cache = Arc::clone(&cache);
    let session = Arc::clone(&session);
    let midgen = Arc::clone(&midgen);
    let label = format!("read_fullres({path})");
    gated_read(&gate, Tier::Full, label.clone(), move || {
        let start = Instant::now();
        let (raw, orient) =
            full_with_orientation(&label, &path, full_offset, full_len, orientation, &|| {
                session.is_cancelled(gen)
            })?;
        let jpeg = cr3::with_exif_orientation(raw, orient);
        maybe_generate_mid_opportunistic(&cache, &session, &midgen, gen, &path, orient, &jpeg);
        let header_json = serde_json::to_vec(&FullresHeader {
            full_len: jpeg.len() as u32,
        })
        .map_err(|e| format!("fullres header: {e}"))?;
        dlog!(
            "[cull] read_fullres({}): {}B in {:?}",
            path,
            jpeg.len(),
            start.elapsed()
        );
        Ok(frame(header_json, &jpeg))
    })
    .await
}

// ── Mid tier (Phase 8): the display-adaptive ≤2560px generated tier ─────────

/// Header for [`read_mid`]: JPEG length + the mid's (unrotated) pixel dims.
/// Stored VERBATIM in the tier cache (the bump-VERSION-on-header-change
/// contract applies to this shape from now on).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct MidHeader {
    mid_len: u32,
    width: u32,
    height: u32,
}

/// Error sentinel for "no cached mid and this call may not generate one".
/// The frontend treats it as a quiet miss (stays on preview, re-probes after
/// the opportunistic generator has had a chance) — never as a tier failure.
const MID_UNCACHED: &str = "mid uncached";

/// Generate the mid from in-memory full bytes and publish it to the cache.
/// Returns (header JSON, jpeg) exactly as cached — `read_mid` frames them.
/// Runs on a blocking thread with the caller holding a [`MidGen`] permit.
fn generate_and_cache_mid(
    cache: &TierCache,
    path: &str,
    stat: (i64, u64),
    full_jpeg: &[u8],
    orientation: u32,
    cancelled: &dyn Fn() -> bool,
) -> Result<(Vec<u8>, Vec<u8>), String> {
    let m = midtier::generate_mid_jpeg(full_jpeg, orientation, cancelled)?;
    let header = MidHeader {
        mid_len: m.jpeg.len() as u32,
        width: m.width,
        height: m.height,
    };
    let header_json = serde_json::to_vec(&header).map_err(|e| format!("mid header: {e}"))?;
    cache.put(CacheTier::Mid, path, stat.0, stat.1, &header_json, &m.jpeg);
    Ok((header_json, m.jpeg))
}

/// Opportunistic mid generation (Phase 8): the zoom read already paid for the
/// full's bytes — clone them and generate the mid DETACHED (the zoom response
/// returns immediately; the CPU work runs on the blocking pool under a MidGen
/// permit, generation-cancelled between pipeline stages). Runs on EVERY
/// profile: on network mode this is the ONLY way the mid cache fills, per the
/// hard rule that the NAS profile never fetches a full solely to generate.
/// The pending-set claim dedups against `read_mid`/`generate_mid` racing on
/// the same path; the ~10 MB clone is bounded by that dedup plus the zoom
/// lane's own concurrency (2).
fn maybe_generate_mid_opportunistic(
    cache: &Arc<TierCache>,
    session: &Arc<SessionGate>,
    midgen: &Arc<MidGen>,
    gen: u64,
    path: &str,
    orientation: u32,
    full_jpeg: &[u8],
) {
    let Some(stat) = resolve_stat(session, path) else {
        return;
    };
    if cache.has_current(CacheTier::Mid, path, stat.0, stat.1) {
        return;
    }
    if session.is_cancelled(gen) {
        return;
    }
    if !midgen.try_begin(path) {
        return; // another producer is already generating this path's mid
    }
    let cache = Arc::clone(cache);
    let session = Arc::clone(session);
    let midgen = Arc::clone(midgen);
    let path = path.to_string();
    let full = full_jpeg.to_vec();
    tauri::async_runtime::spawn(async move {
        let permit = midgen.acquire().await;
        let start = Instant::now();
        let (c2, s2, p2) = (Arc::clone(&cache), Arc::clone(&session), path.clone());
        let joined = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            generate_and_cache_mid(&c2, &p2, stat, &full, orientation, &|| s2.is_cancelled(gen))
                .map(|(_, jpeg)| jpeg.len())
        })
        .await;
        midgen.end(&path);
        match joined {
            Ok(Ok(len)) => dlog!(
                "[cull] midgen({path}): opportunistic {len}B in {:?}",
                start.elapsed()
            ),
            Ok(Err(e)) if e == "cancelled" => {}
            Ok(Err(e)) => dlog!("[cull] midgen({path}): {e}"),
            Err(e) => dlog!("[cull] midgen({path}): task failed: {e}"),
        }
    });
}

/// Display-adaptive mid tier (Phase 8). Serves the generated ≤2560px JPEG
/// from the `mid/` disk cache; a hit costs ZERO source-file round-trips and
/// replays the stored wire header verbatim. On a miss:
/// - network profile (or profile unset): `Err("mid uncached …")` — the HARD
///   RULE: the NAS profile never fetches a full SOLELY to generate. The
///   cache fills opportunistically as the user zooms.
/// - local profile: read the full by exact range (scan fallback), decode →
///   resize → q80 encode → splice orientation, cache, return — under a
///   MidGen permit (concurrency 2 local / 1 network).
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri command: the signature IS the wire contract
pub(crate) async fn read_mid(
    path: String,
    gen: u64,
    full_offset: Option<u64>,
    full_len: Option<u64>,
    orientation: Option<u32>,
    cache: State<'_, Arc<TierCache>>,
    gate: State<'_, Arc<IoGate>>,
    session: State<'_, Arc<SessionGate>>,
    midgen: State<'_, Arc<MidGen>>,
) -> Result<Response, String> {
    let cache = Arc::clone(&cache);
    let session = Arc::clone(&session);
    let label = format!("read_mid({path})");
    // Stage 1 — cache probe (app-cache disk, cheap; Small tier).
    let probe = {
        let (cache, session, path) = (Arc::clone(&cache), Arc::clone(&session), path.clone());
        gated(&gate, Tier::Small, label.clone(), move || {
            let start = Instant::now();
            let stat = resolve_stat(&session, &path);
            let hit = stat.and_then(|(ms, size)| cache.get(CacheTier::Mid, &path, ms, size));
            if let Some((_, payload)) = &hit {
                dlog!(
                    "[cull] read_mid({}): mid cache hit {}B in {:?}",
                    path,
                    payload.len(),
                    start.elapsed()
                );
            }
            Ok((hit, stat))
        })
        .await?
    };
    let (hit, stat) = probe;
    if let Some((header, payload)) = hit {
        return Ok(Response::new(frame(header, &payload)));
    }
    // Miss. Generation is a LOCAL-profile privilege (the plan's hard rule).
    if !gate.is_local() {
        return Err(format!("{MID_UNCACHED} (network profile)"));
    }
    let Some(stat) = stat else {
        return Err(format!("{label}: source stat failed"));
    };
    // Claim the path: a pending opportunistic/sweep generation will publish
    // the same mid momentarily — bounce now, the frontend re-probes shortly.
    if !midgen.try_begin(&path) {
        return Err(format!("{MID_UNCACHED} (generation pending)"));
    }
    let permit = midgen.acquire().await;
    let result = {
        let (cache, session, path, label) = (
            Arc::clone(&cache),
            Arc::clone(&session),
            path.clone(),
            label.clone(),
        );
        gated(&gate, Tier::Full, label.clone(), move || {
            let _permit = permit;
            let start = Instant::now();
            let cancelled = || session.is_cancelled(gen);
            let (raw, orient) = full_with_orientation(
                &label,
                &path,
                full_offset,
                full_len,
                orientation,
                &cancelled,
            )?;
            let (header, payload) =
                generate_and_cache_mid(&cache, &path, stat, &raw, orient, &cancelled)?;
            dlog!(
                "[cull] read_mid({}): generated {}B in {:?}",
                path,
                payload.len(),
                start.elapsed()
            );
            Ok(frame(header, &payload))
        })
        .await
    };
    midgen.end(&path);
    result.map(Response::new)
}

/// Idle-sweep generation (Phase 8): generate + cache the mid WITHOUT shipping
/// payload bytes back over IPC. `Ok(true)` = a current mid is cached (fresh
/// or pre-existing); `Ok(false)` = skipped because another producer holds the
/// path's pending claim (the sweep just moves on). Backend-enforced
/// local-only — the frontend's sweep gates on the profile too, but the hard
/// rule must not depend on frontend discipline.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri command: the signature IS the wire contract
pub(crate) async fn generate_mid(
    path: String,
    gen: u64,
    full_offset: Option<u64>,
    full_len: Option<u64>,
    orientation: Option<u32>,
    cache: State<'_, Arc<TierCache>>,
    gate: State<'_, Arc<IoGate>>,
    session: State<'_, Arc<SessionGate>>,
    midgen: State<'_, Arc<MidGen>>,
) -> Result<bool, String> {
    if !gate.is_local() {
        return Err("midgen disabled on the network profile".into());
    }
    let cache = Arc::clone(&cache);
    let session = Arc::clone(&session);
    let label = format!("generate_mid({path})");
    // Currency probe: prelude-only, no LRU bump (sweeping thousands of
    // already-cached paths must not churn recency under the on-demand hits).
    let (current, stat) = {
        let (cache, session, path) = (Arc::clone(&cache), Arc::clone(&session), path.clone());
        gated(&gate, Tier::Small, label.clone(), move || {
            let stat = resolve_stat(&session, &path);
            let current =
                stat.is_some_and(|(ms, size)| cache.has_current(CacheTier::Mid, &path, ms, size));
            Ok((current, stat))
        })
        .await?
    };
    if current {
        return Ok(true);
    }
    let Some(stat) = stat else {
        return Err(format!("{label}: source stat failed"));
    };
    if !midgen.try_begin(&path) {
        return Ok(false);
    }
    let permit = midgen.acquire().await;
    let result = {
        let (cache, session, path, label) = (
            Arc::clone(&cache),
            Arc::clone(&session),
            path.clone(),
            label.clone(),
        );
        gated(&gate, Tier::Full, label.clone(), move || {
            let _permit = permit;
            let start = Instant::now();
            let cancelled = || session.is_cancelled(gen);
            let (raw, orient) = full_with_orientation(
                &label,
                &path,
                full_offset,
                full_len,
                orientation,
                &cancelled,
            )?;
            let (_, payload) =
                generate_and_cache_mid(&cache, &path, stat, &raw, orient, &cancelled)?;
            dlog!(
                "[cull] generate_mid({}): swept {}B in {:?}",
                path,
                payload.len(),
                start.elapsed()
            );
            Ok(())
        })
        .await
    };
    midgen.end(&path);
    result.map(|()| true)
}

// ── Grid tier (Phase 3B): the sharp contact-sheet thumbnail ────────────────

/// Header for [`read_grid_thumb`]: JPEG length + the thumb's (unrotated) pixel
/// dims. Stored VERBATIM in the tier cache (the bump-VERSION-on-header-change
/// contract applies to this shape from now on).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GridThumbHeader {
    grid_len: u32,
    width: u32,
    height: u32,
}

/// PERMANENT: this file will never have a grid thumb (no PRVW, an undecodable
/// one, or one already ≤512px). The frontend latches it per path and leaves
/// the cell on its THMB — never a shimmer, never a retry loop, never an error
/// chip (grid cells have no error state).
const GRID_THUMB_UNAVAILABLE: &str = "grid thumb unavailable";

/// TRANSIENT: another producer holds this path's [`MidGen`] claim. NOT the
/// quiet sentinel — the pending set is SHARED with the opportunistic mid
/// generator and the whole-shoot idle sweep, so this bounce is common, and
/// latching it would strand a cell on the soft THMB for the session.
const GRID_THUMB_PENDING: &str = "grid thumb pending";

/// Map a generation failure onto the wire. Permanent causes become the ONE
/// quiet sentinel the frontend latches; a cancellation stays itself so the
/// frontend drops it silently; anything else is a real error with backoff.
fn grid_thumb_error(e: String) -> String {
    if e == "cancelled" || e.ends_with(": cancelled") {
        e
    } else if e.contains("no PRVW") {
        format!("{GRID_THUMB_UNAVAILABLE} (no preview)")
    } else if e.contains("not larger") || e.starts_with("grid thumb ") {
        format!("{GRID_THUMB_UNAVAILABLE} ({e})")
    } else {
        e
    }
}

/// Generate the grid thumb from an in-memory PRVW and publish it to the cache.
/// Returns (header JSON, jpeg) exactly as cached — `read_grid_thumb` frames them.
fn generate_and_cache_grid_thumb(
    cache: &TierCache,
    path: &str,
    stat: (i64, u64),
    preview_jpeg: &[u8],
    orientation: u32,
    cancelled: &dyn Fn() -> bool,
) -> Result<(Vec<u8>, Vec<u8>), String> {
    let g = gridthumb::generate_grid_thumb_jpeg(preview_jpeg, orientation, cancelled)?;
    let header = GridThumbHeader {
        grid_len: g.jpeg.len() as u32,
        width: g.width,
        height: g.height,
    };
    let header_json = serde_json::to_vec(&header).map_err(|e| format!("grid thumb header: {e}"))?;
    cache.put(CacheTier::Grid, path, stat.0, stat.1, &header_json, &g.jpeg);
    Ok((header_json, g.jpeg))
}

/// The grid's sharp thumbnail (Phase 3B). Serves the generated 512px JPEG from
/// the `grid/` disk cache; a hit costs ZERO source-file round-trips and replays
/// the stored wire header verbatim. On a miss it acquires the PRVW through
/// [`preview_parts_opt`] with `put_on_miss: false` — a prvw cache hit is used,
/// but a miss's head read is NOT written back, because the grid visits frames
/// the loupe never opens and would evict the previews navigation depends on
/// (spec: "the grid path must NOT fill the preview cache") — then resizes it
/// under a [`MidGen`] permit.
///
/// A source that has no PRVW, whose PRVW will not decode, or whose PRVW is not
/// larger than the tier answers [`GRID_THUMB_UNAVAILABLE`]: the frontend
/// latches it and the cell keeps the THMB it is already showing. A path whose
/// generation claim is held elsewhere answers [`GRID_THUMB_PENDING`], which the
/// frontend must NOT latch.
#[tauri::command]
pub(crate) async fn read_grid_thumb(
    path: String,
    gen: u64,
    cache: State<'_, Arc<TierCache>>,
    gate: State<'_, Arc<IoGate>>,
    session: State<'_, Arc<SessionGate>>,
    midgen: State<'_, Arc<MidGen>>,
) -> Result<Response, String> {
    let cache = Arc::clone(&cache);
    let session = Arc::clone(&session);
    let label = format!("read_grid_thumb({path})");
    // Stage 1 — cache probe (app-cache disk, cheap).
    let (hit, stat) = {
        let (cache, session, path) = (Arc::clone(&cache), Arc::clone(&session), path.clone());
        gated(&gate, Tier::Small, label.clone(), move || {
            let stat = resolve_stat(&session, &path);
            let hit = stat.and_then(|(ms, size)| cache.get(CacheTier::Grid, &path, ms, size));
            Ok((hit, stat))
        })
        .await?
    };
    if let Some((header, payload)) = hit {
        return Ok(Response::new(frame(header, &payload)));
    }
    let Some(stat) = stat else {
        return Err(format!("{label}: source stat failed"));
    };
    // Claim the path against a concurrent mid/grid generation on the SAME
    // shared gate (the opportunistic generator and the idle sweep use it too,
    // so this bounce is common). TRANSIENT sentinel — the frontend must keep
    // its THMB but stay free to ask again.
    if !midgen.try_begin(&path) {
        return Err(GRID_THUMB_PENDING.to_string());
    }
    let permit = midgen.acquire().await;
    let result = {
        let (cache, session, path) = (Arc::clone(&cache), Arc::clone(&session), path.clone());
        gated(&gate, Tier::Small, label.clone(), move || {
            let _permit = permit;
            let start = Instant::now();
            let cancelled = || session.is_cancelled(gen);
            // put_on_miss: false — a prvw HIT is used (zero source I/O), but a
            // miss is not written back. See preview_parts_opt.
            let (header_json, prvw, _hit) =
                preview_parts_opt(&path, &session, &cache, &cancelled, false)
                    .map_err(grid_thumb_error)?;
            let header: PreviewHeader = serde_json::from_slice(&header_json)
                .map_err(|e| format!("grid thumb prvw header parse: {e}"))?;
            let (out_header, payload) = generate_and_cache_grid_thumb(
                &cache,
                &path,
                stat,
                &prvw,
                header.orientation,
                &cancelled,
            )
            .map_err(grid_thumb_error)?;
            dlog!(
                "[cull] read_grid_thumb({}): generated {}B in {:?}",
                path,
                payload.len(),
                start.elapsed()
            );
            Ok(frame(out_header, &payload))
        })
        .await
    };
    midgen.end(&path);
    result.map(Response::new)
}

// ── Thumbnail ────────────────────────────────────────────────────────────────

/// Binary frame returned by [`extract_thumbnail`]: a small JSON header
/// ({display width/height, jpeg length, metadata}), then the THMB JPEG bytes.
/// `meta` ships on fresh parses (the moov head is already parsed — Phase 2
/// metadata fast path) AND on v2 disk-cache hits (the stored header carries
/// it — Phase 7 closed the v1 `meta: null` gap). Since the "similar groups are
/// a standing fact" change, `meta.phash` rides along the same way: computed
/// once on a fresh parse (see [`thumb_phash`]) and replayed verbatim on cache
/// hits — never recomputed on a hit.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ThumbHeader {
    width: Option<u32>,
    height: Option<u32>,
    jpeg_len: u32,
    meta: Option<ImageMetadata>,
}

/// 64-bit DCT pHash (16 lowercase hex chars) of a decoded thumbnail JPEG —
/// the STANDING near-duplicate signal for `groupSimilar`'s pHash tier,
/// independent of smart culling (that pass computes its OWN pHash from the
/// PRVW decode; the two are different resolutions and must never be
/// Hamming-compared against each other). `None` on a decode failure — never
/// observed against real THMB JPEGs in practice, but a thumb whose pixels
/// can't be hashed still serves its JPEG payload rather than erroring the
/// whole read.
fn thumb_phash(jpeg: &[u8]) -> Option<String> {
    // A thumb whose pixels can't be decoded still serves its JPEG payload
    // rather than erroring the whole read, so a decode failure is None here.
    let (rgb, w, h) = crate::jpeg_rgb::decode_rgb(jpeg).ok()?;
    let luma = crate::phash::luma_of(&rgb);
    Some(format!("{:016x}", crate::phash::phash64(&luma, w, h)))
}

/// Tiny embedded thumbnail (160×120), already EXIF-oriented, plus display
/// dimensions. Served from the on-disk tier cache when current — validated
/// against the SESSION STAT TABLE (mtime ms + size, fed by analyze's dir
/// listings), so a cache hit costs ZERO source-file round-trips; un-analyzed
/// paths stat once and memoize. Misses parse the CR3 and cache header+JPEG,
/// stamping `meta.phash` (see [`thumb_phash`]) — the standing near-duplicate
/// signal `groupSimilar` groups on, rendered whether or not smart culling runs.
#[tauri::command]
pub(crate) async fn extract_thumbnail(
    path: String,
    cache: State<'_, Arc<TierCache>>,
    gate: State<'_, Arc<IoGate>>,
    session: State<'_, Arc<SessionGate>>,
) -> Result<Response, String> {
    let cache = Arc::clone(&cache);
    let session = Arc::clone(&session);
    let label = format!("extract_thumbnail({path})");
    gated_read(&gate, Tier::Small, label, move || {
        let stat = resolve_stat(&session, &path);
        if let Some((ms, size)) = stat {
            if let Some((header, payload)) = cache.get(CacheTier::Thumb, &path, ms, size) {
                return Ok(frame(header, &payload));
            }
        }
        let t = cr3::read_thumbnail(&path).map_err(|e| format!("cr3 thumbnail: {e}"))?;
        let mut meta = ImageMetadata::from(t.meta);
        // file_size rides along from the stat already in hand: the frontend's
        // metaSink merge is wholesale, so a thumb landing AFTER the preview
        // must carry the same complete metadata (plan's idempotent-merge
        // contract) — a null here would wipe the EXIF rail's file size.
        if let Some((_, size)) = stat {
            meta.file_size = Some(size);
        }
        meta.phash = thumb_phash(&t.jpeg);
        let header = ThumbHeader {
            width: t.width,
            height: t.height,
            jpeg_len: t.jpeg.len() as u32,
            meta: Some(meta),
        };
        let header_json = serde_json::to_vec(&header).map_err(|e| format!("thumb header: {e}"))?;
        if let Some((ms, size)) = stat {
            cache.put(CacheTier::Thumb, &path, ms, size, &header_json, &t.jpeg);
        }
        Ok(frame(header_json, &t.jpeg))
    })
    .await
}

/// Wire names kept from v1 (the settings dialog invokes them); since Phase 7
/// they cover EVERY tier subdir, not just thumbnails.
#[tauri::command]
pub(crate) async fn clear_thumb_cache(cache: State<'_, Arc<TierCache>>) -> Result<(), String> {
    cache.clear();
    Ok(())
}

#[tauri::command]
pub(crate) async fn thumb_cache_size(cache: State<'_, Arc<TierCache>>) -> Result<u64, String> {
    Ok(cache.size_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::synth_jpeg;

    fn is_well_formed_phash(s: &str) -> bool {
        s.len() == 16
            && s.bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    }

    #[test]
    fn thumb_phash_hashes_a_decodable_thumb_jpeg() {
        let jpeg = synth_jpeg(160, 120, 90);
        let hex = thumb_phash(&jpeg).expect("decodable JPEG must hash");
        assert!(
            is_well_formed_phash(&hex),
            "not a well-formed 16-hex phash: {hex}"
        );
    }

    #[test]
    fn thumb_phash_identical_jpegs_hash_identically() {
        let jpeg = synth_jpeg(160, 120, 90);
        assert_eq!(thumb_phash(&jpeg), thumb_phash(&jpeg));
    }

    #[test]
    fn thumb_phash_none_on_undecodable_bytes() {
        assert_eq!(thumb_phash(b"not a jpeg"), None);
        assert_eq!(thumb_phash(&[]), None);
    }

    #[test]
    fn grid_thumb_errors_map_onto_the_right_sentinel() {
        for permanent in [
            "cr3 preview: no PRVW".to_string(),
            "source not larger than grid tier (400x300)".to_string(),
            "grid thumb invalid jpeg".to_string(),
        ] {
            assert!(
                grid_thumb_error(permanent.clone()).starts_with(GRID_THUMB_UNAVAILABLE),
                "should latch: {permanent}"
            );
        }
        // A cancellation is not a failure and must not latch anything — in
        // either of its two shapes (preview_parts wraps it as "cr3 preview:
        // cancelled", cr3.rs:684 + bundle.rs:184).
        assert_eq!(grid_thumb_error("cancelled".into()), "cancelled");
        assert_eq!(
            grid_thumb_error("cr3 preview: cancelled".into()),
            "cr3 preview: cancelled"
        );
        // A real I/O failure stays a real failure (backoff + retry apply) and
        // must NOT be confusable with either sentinel.
        let io = "read_grid_thumb(x): read timed out after 8s".to_string();
        assert_eq!(grid_thumb_error(io.clone()), io);
        assert!(!io.contains(GRID_THUMB_UNAVAILABLE) && !io.contains(GRID_THUMB_PENDING));
        // The two sentinels must never prefix-match each other, or the
        // frontend's latch test would catch the transient one.
        assert!(!GRID_THUMB_PENDING.starts_with(GRID_THUMB_UNAVAILABLE));
        assert!(!GRID_THUMB_UNAVAILABLE.starts_with(GRID_THUMB_PENDING));
    }

    /// A temp dir + a real TierCache, the shape tier_cache.rs's own tests use.
    fn grid_tmp(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("cull-gridprvw-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// Ungated: a prvw cache HIT still serves the grid, at zero source I/O —
    /// `put_on_miss: false` suppresses the write-back, never the read.
    #[test]
    fn grid_acquisition_uses_a_prvw_hit_without_writing_anything() {
        let work = grid_tmp("hit");
        let cache = TierCache::new(work.join("tiers"));
        let session = SessionGate::new();
        // Any file will do: the cache validates against ITS stat, and a hit
        // returns before cr3 parsing is ever reached.
        let src = work.join("a.cr3");
        std::fs::write(&src, b"not really a cr3").unwrap();
        let src = src.to_string_lossy().to_string();
        let (ms, size) = resolve_stat(&session, &src).expect("stat");
        cache.put(
            CacheTier::Prvw,
            &src,
            ms,
            size,
            b"{\"orientation\":1}",
            b"\xFF\xD8prvw",
        );

        let before = cache.size_bytes();
        let (header, payload, hit) =
            preview_parts_opt(&src, &session, &cache, &|| false, false).expect("hit");
        assert!(hit, "a current prvw entry must be served");
        assert_eq!(payload.as_slice(), b"\xFF\xD8prvw");
        assert_eq!(header.as_slice(), b"{\"orientation\":1}");
        assert_eq!(cache.size_bytes(), before, "a hit writes nothing");
        let _ = std::fs::remove_dir_all(&work);
    }

    /// The real assertion, corpus-gated like every other test here that needs
    /// pixels: a grid-tier acquisition on a prvw MISS reads the file and
    /// leaves the prvw store empty, while the navigation form fills it.
    /// `CULL_TEST_CR3_DIR=path cargo test -- --nocapture`.
    #[test]
    fn grid_acquisition_never_fills_the_prvw_cache_on_a_miss() {
        let Ok(dir) = std::env::var("CULL_TEST_CR3_DIR") else {
            eprintln!("skip: set CULL_TEST_CR3_DIR to a folder of .CR3 files");
            return;
        };
        let src = std::fs::read_dir(&dir)
            .expect("read dir")
            .flatten()
            .map(|e| e.path())
            .find(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("cr3")))
            .expect("a CR3 under CULL_TEST_CR3_DIR")
            .to_string_lossy()
            .to_string();

        let work = grid_tmp("miss");
        let cache = TierCache::new(work.join("tiers"));
        let session = SessionGate::new();

        // The grid's form: reads the preview, caches nothing.
        let (_, prvw, hit) =
            preview_parts_opt(&src, &session, &cache, &|| false, false).expect("grid read");
        assert!(!hit, "cold store must be a miss");
        assert!(!prvw.is_empty(), "the preview really was read");
        assert_eq!(
            cache.size_bytes(),
            0,
            "the grid path must not write the prvw tier"
        );

        // The navigation form, same file, same store: fills it.
        let (_, _, hit2) = preview_parts(&src, &session, &cache, &|| false).expect("nav read");
        assert!(!hit2);
        assert!(cache.size_bytes() > 0, "navigation still fills prvw");
        let _ = std::fs::remove_dir_all(&work);
    }

    // Real-corpus check: every THMB in a folder of real CR3s decodes to a
    // well-formed 16-hex pHash via the exact path `extract_thumbnail` uses.
    // Gated like every other corpus test in this codebase (cr3.rs, analyze.rs):
    // `CULL_TEST_CR3_DIR=path cargo test -- --nocapture`.
    #[test]
    fn thumb_phash_over_sample_dir_is_well_formed() {
        let Ok(dir) = std::env::var("CULL_TEST_CR3_DIR") else {
            eprintln!("skip: set CULL_TEST_CR3_DIR to a folder of .CR3 files");
            return;
        };
        let mut paths: Vec<_> = std::fs::read_dir(&dir)
            .expect("read dir")
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("cr3")))
            .collect();
        paths.sort();
        assert!(!paths.is_empty(), "no CR3 files in {dir}");

        for p in &paths {
            let ps = p.to_string_lossy().to_string();
            let t = cr3::read_thumbnail(&ps).unwrap_or_else(|e| panic!("{ps}: thumb {e}"));
            let hex = thumb_phash(&t.jpeg).unwrap_or_else(|| panic!("{ps}: thumb must hash"));
            assert!(is_well_formed_phash(&hex), "{ps}: not well-formed: {hex}");
        }
    }
}
