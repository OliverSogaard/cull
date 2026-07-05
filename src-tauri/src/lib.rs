//! CULL — Tauri backend.
//!
//! Module map:
//!
//! | Module        | Responsibility                                          |
//! |---------------|---------------------------------------------------------|
//! | [`cr3`]       | Pure-Rust CR3 parser: preview + EXIF + thumbnail bytes. |
//! | [`meta`]      | [`meta::ImageMetadata`] for the UI + `From<cr3::Cr3Meta>`. |
//! | [`bundle`]    | `read_bundle` / `read_preview` / `read_fullres` / `read_mid` / `generate_mid` + `extract_thumbnail` Tauri commands. |
//! | [`io_gate`]   | Read-permit backstop (IoGate), session gen + mtime table (SessionGate), `begin_session` / `set_io_profile`. |
//! | [`midtier`]   | Phase 8 mid-tier generation: decode → SIMD resize ≤2560 → q80 encode + the MidGen concurrency gate. |
//! | [`scan`]      | `scan_folder` + `analyze_folder` Tauri commands.        |
//! | [`tier_cache`]| On-disk LRU cache for image tiers (thumb/prvw/mid), format v2. |
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

// CULL ships for Windows and macOS only — Linux and mobile are deliberately
// unsupported (no CI runners, no platform handling anywhere). Fail fast.
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
compile_error!("CULL supports Windows and macOS only.");

/// Diagnostic logging: forwards to `eprintln!` in debug builds (or under the
/// `verbose-logs` feature); compiles to a no-op in release so per-navigation
/// hot paths never pay for stderr writes. The no-op arm still type-checks and
/// evaluates the format arguments, so a release build can neither rot nor warn
/// about bindings only the log line uses. Defined before the `mod` items so
/// `macro_rules!` textual scope covers every module — no imports needed.
macro_rules! dlog {
    ($($arg:tt)*) => {{
        #[cfg(any(debug_assertions, feature = "verbose-logs"))]
        eprintln!($($arg)*);
        #[cfg(not(any(debug_assertions, feature = "verbose-logs")))]
        {
            let _ = format_args!($($arg)*);
        }
    }};
}

mod analyze;
// Without smart-ml only the (always-compiled, always-tested) pure decode math
// is present — no callers, by design. Never dead in feature builds.
#[cfg_attr(not(feature = "smart-ml"), allow(dead_code))]
mod faces;
mod bundle;
mod cr3;
mod file_ops;
mod io_gate;
mod meta;
mod midtier;
mod scan;
mod tier_cache;
mod xmp;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = app.path().app_cache_dir().unwrap_or_else(|_| std::env::temp_dir());
            app.manage(std::sync::Arc::new(tier_cache::TierCache::new(dir.join("tiers"))));
            app.manage(std::sync::Arc::new(io_gate::IoGate::new()));
            app.manage(std::sync::Arc::new(io_gate::SessionGate::new()));
            app.manage(std::sync::Arc::new(midtier::MidGen::new()));

            // Phase 3a (smart-ml builds only): hand the YuNet model path to
            // the lazy detector — session creation itself waits for first use.
            #[cfg(feature = "smart-ml")]
            if let Ok(p) = app.path().resolve(
                "models/face_detection_yunet_2023mar.onnx",
                tauri::path::BaseDirectory::Resource,
            ) {
                faces::init_detector(p);
            }
            // Phase 3b: the OCEC eye-state model rides the same lazy pattern.
            #[cfg(feature = "smart-ml")]
            if let Ok(p) = app.path().resolve(
                "models/ocec_s.onnx",
                tauri::path::BaseDirectory::Resource,
            ) {
                faces::init_eye_classifier(p);
            }
            // One-time cleanup of the v1 thumbnail cache (format v2 lives under
            // tiers/): without this, up to 500 MB of dead v1 files sit in
            // app-cache forever. Best-effort and detached — it's a local-disk
            // delete that must not delay startup.
            let legacy = dir.join("thumbs");
            tauri::async_runtime::spawn_blocking(move || {
                let _ = std::fs::remove_dir_all(&legacy);
            });

            // macOS: replace the default menu so Cmd+Q routes through
            // window.close() and the JS close-guard (pending XMP writes) gets
            // its normal chance to object. The default menu's predefined Quit
            // item maps to the native `terminate:` selector, which hard-kills
            // the app — no close-request, no RunEvent::ExitRequested, nothing
            // interceptable (verified against tauri 2.11.2 / tao 0.35.3).
            // The Edit submenu is rebuilt verbatim: its predefined roles are
            // what make Cmd+C/V/X work inside WKWebView text fields.
            // Known gap, accepted for personal use: Dock-icon Quit and
            // logout/shutdown still terminate natively, bypassing the guard.
            #[cfg(target_os = "macos")]
            {
                use tauri::menu::{MenuBuilder, MenuItem, SubmenuBuilder};

                let quit = MenuItem::with_id(
                    app,
                    "cull-quit",
                    "Quit CULL",
                    true,
                    Some("CmdOrCtrl+Q"),
                )?;
                let app_menu = SubmenuBuilder::new(app, "CULL")
                    .about(None)
                    .separator()
                    .services()
                    .separator()
                    .hide()
                    .hide_others()
                    .show_all()
                    .separator()
                    .item(&quit)
                    .build()?;
                let edit_menu = SubmenuBuilder::new(app, "Edit")
                    .undo()
                    .redo()
                    .separator()
                    .cut()
                    .copy()
                    .paste()
                    .select_all()
                    .build()?;
                let window_menu = SubmenuBuilder::new(app, "Window")
                    .minimize()
                    .maximize()
                    .separator()
                    .close_window()
                    .build()?;
                let menu = MenuBuilder::new(app)
                    .items(&[&app_menu, &edit_menu, &window_menu])
                    .build()?;
                app.set_menu(menu)?;
                app.on_menu_event(|app, event| {
                    if event.id().as_ref() == "cull-quit" {
                        // close(), never destroy(): close raises the JS
                        // onCloseRequested guard, exactly like the red light.
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.close();
                        }
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            analyze::analyze_quality,
            bundle::read_bundle,
            bundle::read_preview,
            bundle::read_fullres,
            bundle::read_mid,
            bundle::generate_mid,
            bundle::extract_thumbnail,
            bundle::clear_thumb_cache,
            bundle::thumb_cache_size,
            io_gate::begin_session,
            io_gate::set_io_profile,
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
