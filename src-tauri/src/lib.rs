//! CULL — Tauri backend.
//!
//! Module map:
//!
//! | Module        | Responsibility                                          |
//! |---------------|---------------------------------------------------------|
//! | [`cr3`]       | Pure-Rust CR3 parser: preview + EXIF + thumbnail bytes. |
//! | [`meta`]      | [`meta::ImageMetadata`] for the UI + `From<cr3::Cr3Meta>`. |
//! | [`bundle`]    | `read_bundle` + `extract_thumbnail` Tauri commands.     |
//! | [`scan`]      | `scan_folder` + `analyze_folder` Tauri commands.        |
//! | [`xmp`]       | XMP sidecar I/O: `write_xmp_rating` / `clear_xmp_rating` + the parser the analyze step uses to restore ratings. |
//! | [`file_ops`]  | Post-cull file operations: `move_rejects_to_subfolder` / `copy_keeps_to_export`. |
//!
//! ## Invariants
//!
//! - CR3 files are **never modified.** All CR3 reads go through [`cr3`]; the
//!   only writes any module makes are to a `{basename}.xmp` sidecar.
//! - Folder walks are read-only.
//! - All Tauri commands that touch the filesystem run on the blocking pool, so
//!   a slow NAS read can't stall the async runtime or the UI thread.

mod bundle;
mod cr3;
mod file_ops;
mod meta;
mod scan;
mod xmp;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            bundle::read_bundle,
            bundle::extract_thumbnail,
            bundle::extract_blurhash,
            scan::scan_folder,
            scan::analyze_folder,
            xmp::write_xmp_rating,
            xmp::clear_xmp_rating,
            file_ops::move_rejects_to_subfolder,
            file_ops::copy_keeps_to_export,
            file_ops::path_exists,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
