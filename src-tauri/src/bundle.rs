//! Per-image reads: navigation preview, zoom full-res, legacy bundle, and the
//! tiny embedded thumbnail.
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
//! generation for chunked-read cancellation. `read_bundle` keeps its original
//! wire format and callers — it is the legacy navigation path until Phase 3
//! flips the frontend to the preview tier.

use std::sync::Arc;
use std::time::Instant;
use tauri::ipc::Response;
use tauri::State;

use crate::cr3;
use crate::io_gate::{IoGate, SessionGate, Tier};
use crate::meta::ImageMetadata;
use crate::thumb_cache::{mtime_of, ThumbCache};

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

/// Run one blocking read under the IoGate with the tier's timeout.
///
/// On timeout the invoke REJECTS — the frontend's lane slot frees instantly —
/// while the orphaned blocking task keeps its owned permit and self-heals when
/// the syscall eventually returns (blocking fs reads can't be safely aborted
/// on Windows/macOS, so detach + ignore is the decision; see io_gate.rs). The
/// watcher logs when the orphan lands: the stuck-permit detector.
async fn gated_read(
    gate: &IoGate,
    tier: Tier,
    label: String,
    work: impl FnOnce() -> Result<Vec<u8>, String> + Send + 'static,
) -> Result<Response, String> {
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
        Ok(joined) => Ok(Response::new(
            joined.map_err(|e| format!("read task failed: {e}"))??,
        )),
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

// ── Legacy bundle (full-res as the navigation tier; dies in Phase 3) ────────

/// Binary frame returned by [`read_bundle`]: a small JSON header (metadata +
/// the preview length), then the preview JPEG bytes.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BundleHeader {
    meta: ImageMetadata,
    preview_len: u32,
}

/// Read full-res preview + metadata for one CR3 in a SINGLE file open.
/// Wire format and behavior unchanged from before Phase 2 (the frontend still
/// navigates on this until Phase 3); now rides the gate + timeout like every
/// other read.
#[tauri::command]
pub(crate) async fn read_bundle(
    path: String,
    gate: State<'_, Arc<IoGate>>,
) -> Result<Response, String> {
    let label = format!("read_bundle({path})");
    gated_read(&gate, Tier::Full, label, move || {
        let start = Instant::now();
        let b = cr3::read_bundle(&path).map_err(|e| format!("cr3 bundle: {e}"))?;
        let mut meta = ImageMetadata::from(b.meta);
        // Length came from the open handle inside read_bundle — no extra stat
        // round-trip (the NAS read path's per-file round-trips dominate latency).
        meta.file_size = Some(b.file_size);
        // lrc_rating stays None here on purpose: the analyze pass already
        // returns every sidecar's LrC stars in bulk (scan.rs lrc_ratings), and
        // re-opening the sidecar per navigation cost one NAS round-trip
        // (~37-74 ms) on every read. The frontend seeds + carries the value.
        let header = BundleHeader {
            meta,
            preview_len: b.preview.len() as u32,
        };
        let header_json =
            serde_json::to_vec(&header).map_err(|e| format!("bundle header: {e}"))?;
        dlog!(
            "[cull] read_bundle({}): orient={} preview={}B in {:?}",
            path,
            b.orientation,
            b.preview.len(),
            start.elapsed()
        );
        Ok(frame(header_json, &b.preview))
    })
    .await
}

// ── Navigation tier (Phase 2; frontend switches to it in Phase 3) ───────────

/// Header for [`read_preview`]: full metadata, the orientation (echoed back to
/// `read_fullres` so the zoom tier skips the moov re-parse), and the exact
/// full-res range hint from moov's sample tables.
#[derive(serde::Serialize)]
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
#[tauri::command]
pub(crate) async fn read_preview(
    path: String,
    gen: u64,
    gate: State<'_, Arc<IoGate>>,
    session: State<'_, Arc<SessionGate>>,
) -> Result<Response, String> {
    let session = Arc::clone(&session);
    let label = format!("read_preview({path})");
    gated_read(&gate, Tier::Small, label, move || {
        let start = Instant::now();
        let b = cr3::read_preview_bundle(&path, &|| session.is_cancelled(gen))
            .map_err(|e| format!("cr3 preview: {e}"))?;
        let mut meta = ImageMetadata::from(b.meta);
        meta.file_size = Some(b.file_size);
        let header = PreviewHeader {
            meta,
            orientation: b.orientation,
            preview_len: b.preview.len() as u32,
            full_offset: b.full_hint.map(|h| h.0),
            full_len: b.full_hint.map(|h| h.1),
        };
        let header_json =
            serde_json::to_vec(&header).map_err(|e| format!("preview header: {e}"))?;
        dlog!(
            "[cull] read_preview({}): orient={} prvw={}B hint={:?} in {:?}",
            path,
            b.orientation,
            b.preview.len(),
            b.full_hint,
            start.elapsed()
        );
        Ok(frame(header_json, &b.preview))
    })
    .await
}

/// Header for [`read_fullres`]: just the JPEG length.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FullresHeader {
    full_len: u32,
}

/// Zoom tier: seek + ONE exact-range chunked read via the moov hint, SOI/EOI
/// validated; any mismatch falls back to the legacy head+grow mdat scan (with
/// a dlog line — telemetry for future bodies). Skips the moov re-parse: the
/// orientation is echoed back from the frontend (it arrived with the preview).
#[tauri::command]
pub(crate) async fn read_fullres(
    path: String,
    gen: u64,
    full_offset: Option<u64>,
    full_len: Option<u64>,
    orientation: u32,
    gate: State<'_, Arc<IoGate>>,
    session: State<'_, Arc<SessionGate>>,
) -> Result<Response, String> {
    let session = Arc::clone(&session);
    let label = format!("read_fullres({path})");
    gated_read(&gate, Tier::Full, label, move || {
        let start = Instant::now();
        let raw = match (full_offset, full_len) {
            (Some(off), Some(len)) => {
                match cr3::read_fullres_at(&path, off, len, &|| session.is_cancelled(gen)) {
                    Ok(jpeg) => jpeg,
                    Err(e) if cr3::is_cancelled(&e) => return Err("cancelled".into()),
                    Err(e) => {
                        dlog!(
                            "[cull] read_fullres({path}): hint mismatch ({e}) — mdat scan fallback"
                        );
                        cr3::read_fullres_scan(&path).map_err(|e| format!("cr3 fullres: {e}"))?
                    }
                }
            }
            _ => cr3::read_fullres_scan(&path).map_err(|e| format!("cr3 fullres: {e}"))?,
        };
        let jpeg = cr3::with_exif_orientation(raw, orientation);
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

// ── Thumbnail ────────────────────────────────────────────────────────────────

/// Binary frame returned by [`extract_thumbnail`]: a small JSON header
/// ({display width/height, jpeg length, metadata}), then the THMB JPEG bytes.
/// `meta` ships on fresh parses (the moov head is already parsed — Phase 2
/// metadata fast path); disk-cache hits carry `meta: null` (the v1 cache file
/// stores no metadata) and the EXIF arrives with the preview/bundle instead.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ThumbHeader {
    width: Option<u32>,
    height: Option<u32>,
    jpeg_len: u32,
    meta: Option<ImageMetadata>,
}

/// Tiny embedded thumbnail (160×120), already EXIF-oriented, plus display
/// dimensions. Served from the on-disk LRU cache when available — validated
/// against the SESSION MTIME TABLE (fed by analyze's dir listings), so a
/// cache hit costs ZERO filesystem round-trips; un-analyzed paths stat once
/// and memoize. Misses parse the CR3 and return full metadata for free.
#[tauri::command]
pub(crate) async fn extract_thumbnail(
    path: String,
    cache: State<'_, Arc<ThumbCache>>,
    gate: State<'_, Arc<IoGate>>,
    session: State<'_, Arc<SessionGate>>,
) -> Result<Response, String> {
    let cache = Arc::clone(&cache);
    let session = Arc::clone(&session);
    let label = format!("extract_thumbnail({path})");
    gated_read(&gate, Tier::Small, label, move || {
        // Seconds-resolution mtime for cache validation, WITHOUT a stat on the
        // hot path: the analyze pass already recorded every staged file's
        // mtime (ms) in the session table.
        let mtime = match session.mtime_ms(&path) {
            Some(ms) => Some(ms.div_euclid(1000)),
            None => {
                let s = mtime_of(&path);
                if let Some(s) = s {
                    session.note_mtime(&path, s * 1000);
                }
                s
            }
        };
        let (jpeg, w, h, meta) = match mtime.and_then(|mt| cache.get(&path, mt)) {
            Some((jpeg, w, h)) => (jpeg, w, h, None),
            None => {
                let t = cr3::read_thumbnail(&path).map_err(|e| format!("cr3 thumbnail: {e}"))?;
                if let Some(mt) = mtime {
                    cache.put(&path, mt, &t.jpeg, t.width, t.height);
                }
                (t.jpeg, t.width, t.height, Some(ImageMetadata::from(t.meta)))
            }
        };
        let header = ThumbHeader {
            width: w,
            height: h,
            jpeg_len: jpeg.len() as u32,
            meta,
        };
        let header_json = serde_json::to_vec(&header).map_err(|e| format!("thumb header: {e}"))?;
        Ok(frame(header_json, &jpeg))
    })
    .await
}

#[tauri::command]
pub(crate) async fn clear_thumb_cache(cache: State<'_, Arc<ThumbCache>>) -> Result<(), String> {
    cache.clear(); Ok(())
}

#[tauri::command]
pub(crate) async fn thumb_cache_size(cache: State<'_, Arc<ThumbCache>>) -> Result<u64, String> {
    Ok(cache.size_bytes())
}
