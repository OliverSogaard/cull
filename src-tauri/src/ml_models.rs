//! Shared lazy ONNX session plumbing (feature `smart-ml`).
//!
//! Every model follows the same lifecycle: path registered at Tauri setup,
//! session built on FIRST use (app boot never pays ONNX init), per-OS EP
//! (CoreML / DirectML) with silent CPU fallback, init failure = advisory
//! feature quietly off (logged), never an error surface.
#![cfg(feature = "smart-ml")]

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

pub struct LazySession {
    name: &'static str,
    path: OnceLock<PathBuf>,
    session: OnceLock<Option<Mutex<ort::session::Session>>>,
}

impl LazySession {
    pub const fn new(name: &'static str) -> Self {
        Self { name, path: OnceLock::new(), session: OnceLock::new() }
    }

    pub fn init(&self, model_path: PathBuf) {
        let _ = self.path.set(model_path);
    }

    pub fn get(&self) -> Option<&Mutex<ort::session::Session>> {
        self.session
            .get_or_init(|| {
                let path = self.path.get()?;
                match build_session(path) {
                    Ok(s) => Some(Mutex::new(s)),
                    Err(e) => {
                        dlog!("[cull] {} session init failed: {e}", self.name);
                        None
                    }
                }
            })
            .as_ref()
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn ready(&self) -> bool {
        self.get().is_some()
    }
}

/// Platform EP with silent CPU fallback (moved verbatim from faces.rs).
fn build_session(path: &std::path::Path) -> Result<ort::session::Session, ort::Error> {
    #[allow(unused_mut)]
    let mut b = ort::session::Session::builder()?;
    #[cfg(target_os = "macos")]
    {
        b = b.with_execution_providers([ort::ep::CoreML::default().build()])?;
    }
    #[cfg(target_os = "windows")]
    {
        b = b.with_execution_providers([ort::ep::DirectML::default().build()])?;
    }
    b.commit_from_file(path)
}
