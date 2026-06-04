//! Per-image reads: full preview + metadata in one shot, plus the tiny embedded
//! thumbnail.
//!
//! ## Invariant
//!
//! CR3 files are NEVER modified — every read goes through [`crate::cr3`]'s
//! pure-Rust parser. Orientation is applied by splicing an EXIF tag into the
//! returned JPEG bytes (the webview rotates on display); the file on disk is
//! untouched, and there is no decode/re-encode, so the embedded JPEG's quality
//! is preserved bit-for-bit.

use std::sync::Arc;
use std::time::Instant;
use tauri::ipc::Response;
use tauri::State;

use crate::cr3;
use crate::meta::ImageMetadata;
use crate::thumb_cache::ThumbCache;
use crate::xmp::read_lrc_rating;

/// Binary frame returned by [`read_bundle`]: a small JSON header (metadata +
/// the preview length), then the preview JPEG bytes. One IPC, no base64 — the
/// frontend slices the `ArrayBuffer` directly. Thumbnails are a separate
/// command and pool.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BundleHeader {
    meta: ImageMetadata,
    preview_len: u32,
}

/// Read preview + metadata for one CR3 in a SINGLE file open.
///
/// The hot path during culling: collapsing the old preview + metadata commands
/// (two opens + many seeks) into one read is the dominant latency win on the
/// NAS this app culls from. Heavy enough (a multi-MB read) to run on the
/// blocking pool so prefetch bursts never stall the async runtime or the UI.
#[tauri::command]
pub(crate) async fn read_bundle(path: String) -> Result<Response, String> {
    let framed = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let start = Instant::now();
        let b = cr3::read_bundle(&path).map_err(|e| format!("cr3 bundle: {e}"))?;
        let mut meta = ImageMetadata::from(b.meta);
        // Length came from the open handle inside read_bundle — no extra stat
        // round-trip (the NAS read path's per-file round-trips dominate latency).
        meta.file_size = Some(b.file_size);
        // Surface the user's pre-existing LrC 1–5★ rating (if any) from the
        // sidecar so the UI can show it in the (i) panel and as a tiny grid
        // badge. Sidecar reads are cheap; we already touch the dir above.
        meta.lrc_rating = read_lrc_rating(&path);
        let header = BundleHeader {
            meta,
            preview_len: b.preview.len() as u32,
        };
        let header_json =
            serde_json::to_vec(&header).map_err(|e| format!("bundle header: {e}"))?;
        let mut out = Vec::with_capacity(4 + header_json.len() + b.preview.len());
        out.extend_from_slice(&(header_json.len() as u32).to_le_bytes());
        out.extend_from_slice(&header_json);
        out.extend_from_slice(&b.preview);
        eprintln!(
            "[cull] read_bundle({}): orient={} preview={}B in {:?}",
            path,
            b.orientation,
            b.preview.len(),
            start.elapsed()
        );
        Ok(out)
    })
    .await
    .map_err(|e| format!("bundle task failed: {e}"))??;
    Ok(Response::new(framed))
}

/// Binary frame returned by [`extract_thumbnail`]: a small JSON header
/// ({display width/height, jpeg length}), then the THMB JPEG bytes —
/// same framing as [`read_bundle`]. The frontend slices the JPEG out and uses
/// the dims for an instant, correctly-shaped placeholder.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ThumbHeader {
    width: Option<u32>,
    height: Option<u32>,
    jpeg_len: u32,
}

/// Tiny embedded thumbnail (160×120), already EXIF-oriented, plus display
/// dimensions, for filmstrip cells and the loading / scrub placeholder. Loaded
/// through the frontend's bounded thumb pool. Results are served from the
/// on-disk LRU cache when available; misses are written to the cache.
#[tauri::command]
pub(crate) async fn extract_thumbnail(path: String, cache: State<'_, Arc<ThumbCache>>) -> Result<Response, String> {
    let cache = Arc::clone(&cache);
    let framed = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let (jpeg, w, h) = match cache.get(&path) {
            Some(hit) => hit,
            None => {
                let t = cr3::read_thumbnail(&path).map_err(|e| format!("cr3 thumbnail: {e}"))?;
                cache.put(&path, &t.jpeg, t.width, t.height);
                (t.jpeg, t.width, t.height)
            }
        };
        let header = ThumbHeader { width: w, height: h, jpeg_len: jpeg.len() as u32 };
        let header_json = serde_json::to_vec(&header).map_err(|e| format!("thumb header: {e}"))?;
        let mut out = Vec::with_capacity(4 + header_json.len() + jpeg.len());
        out.extend_from_slice(&(header_json.len() as u32).to_le_bytes());
        out.extend_from_slice(&header_json);
        out.extend_from_slice(&jpeg);
        Ok(out)
    }).await.map_err(|e| format!("thumbnail task failed: {e}"))??;
    Ok(Response::new(framed))
}

#[tauri::command]
pub(crate) async fn clear_thumb_cache(cache: State<'_, Arc<ThumbCache>>) -> Result<(), String> {
    cache.clear(); Ok(())
}

#[tauri::command]
pub(crate) async fn thumb_cache_size(cache: State<'_, Arc<ThumbCache>>) -> Result<u64, String> {
    Ok(cache.size_bytes())
}
