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

use std::time::Instant;
use tauri::ipc::Response;

use crate::cr3;
use crate::meta::ImageMetadata;

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
        meta.file_size = std::fs::metadata(&path).ok().map(|m| m.len());
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

/// Tiny embedded thumbnail (160×120), already EXIF-oriented, for filmstrip
/// cells and the loading placeholder. Loaded through the frontend's bounded
/// thumb pool.
#[tauri::command]
pub(crate) async fn extract_thumbnail(path: String) -> Result<Response, String> {
    let bytes = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
        cr3::read_thumbnail(&path)
            .map(|(jpeg, _)| jpeg)
            .map_err(|e| format!("cr3 thumbnail: {e}"))
    })
    .await
    .map_err(|e| format!("thumbnail task failed: {e}"))??;
    Ok(Response::new(bytes))
}
