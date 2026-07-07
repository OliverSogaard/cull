//! OS memory-pressure → frontend "memory-pressure" event.
//!
//! Why this exists: 2026-07-07 the compare-zoom decide spiked the WKWebView
//! WebContent process to 2.25 GB lifetimeMax and macOS jetsam-killed it — a
//! dead gray window with no catchable JS error. The OS *warns* before it
//! kills; this module forwards that warning so the frontend can shed its
//! image caches first (see `src/image/pressureProfile.ts`).
//!
//! - macOS: a `DISPATCH_SOURCE_TYPE_MEMORYPRESSURE` source — the same signal
//!   jetsam-aware apps use. Event-driven, no polling.
//! - Windows: `GlobalMemoryStatusEx().dwMemoryLoad` polled every 5 s with
//!   hysteresis (WebView2 suffers commit exhaustion rather than jetsam, but
//!   the shedding response is equally valid there).
//!
//! Payload is one of "normal" | "warn" | "critical" (mirrors the frontend's
//! `PressureLevel`). Transitions only — repeats are suppressed platform-side
//! (macOS notifies on change; the Windows poller diffs).

pub(crate) const EVENT: &str = "memory-pressure";

/// Map a Windows memory-load percentage (0–100) to a level, with hysteresis
/// against the previous level so a load hovering at a boundary can't flap:
/// escalation at 90/96, de-escalation only once clearly below (85/92).
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub(crate) fn level_from_load(pct: u32, prev: &'static str) -> &'static str {
    match prev {
        "critical" => {
            if pct >= 92 {
                "critical"
            } else if pct >= 85 {
                "warn"
            } else {
                "normal"
            }
        }
        "warn" => {
            if pct >= 96 {
                "critical"
            } else if pct >= 85 {
                "warn"
            } else {
                "normal"
            }
        }
        _ => {
            if pct >= 96 {
                "critical"
            } else if pct >= 90 {
                "warn"
            } else {
                "normal"
            }
        }
    }
}

/// Map the dispatch source's data word to a level. The mask bits are
/// DISPATCH_MEMORYPRESSURE_NORMAL(1) / WARN(2) / CRITICAL(4); CRITICAL wins
/// when several are coalesced into one delivery.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn level_from_dispatch(data: usize) -> &'static str {
    if data & 0x4 != 0 {
        "critical"
    } else if data & 0x2 != 0 {
        "warn"
    } else {
        "normal"
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::{level_from_dispatch, EVENT};
    use std::ffi::c_void;
    use tauri::Emitter;

    #[repr(C)]
    pub struct DispatchSourceType {
        _private: [u8; 0],
    }
    type DispatchSource = *mut c_void;
    type DispatchQueue = *mut c_void;

    extern "C" {
        static _dispatch_source_type_memorypressure: DispatchSourceType;
        fn dispatch_source_create(
            r#type: *const DispatchSourceType,
            handle: usize,
            mask: usize,
            queue: DispatchQueue,
        ) -> DispatchSource;
        fn dispatch_source_set_event_handler_f(
            source: DispatchSource,
            handler: extern "C" fn(*mut c_void),
        );
        fn dispatch_set_context(obj: *mut c_void, context: *mut c_void);
        fn dispatch_source_get_data(source: DispatchSource) -> usize;
        fn dispatch_resume(obj: *mut c_void);
        fn dispatch_get_global_queue(identifier: isize, flags: usize) -> DispatchQueue;
    }

    /// App-lifetime context handed to the C handler. Leaked on purpose: the
    /// dispatch source lives until process exit, so there is no free site.
    struct Ctx {
        source: DispatchSource,
        app: tauri::AppHandle,
    }
    // SAFETY: the raw source pointer is only ever used from the handler the
    // source itself invokes; AppHandle is Send + Sync.
    unsafe impl Send for Ctx {}

    extern "C" fn on_pressure(context: *mut c_void) {
        // SAFETY: context is the leaked Ctx from start(); never freed.
        let ctx = unsafe { &*(context as *const Ctx) };
        let data = unsafe { dispatch_source_get_data(ctx.source) };
        let level = level_from_dispatch(data);
        let _ = ctx.app.emit(EVENT, level);
        dlog!("[cull] memory-pressure: {level} (dispatch data {data:#x})");
    }

    pub fn start(app: tauri::AppHandle) {
        const MASK_ALL: usize = 0x1 | 0x2 | 0x4; // NORMAL | WARN | CRITICAL
        unsafe {
            let queue = dispatch_get_global_queue(0, 0); // QOS default
            let source =
                dispatch_source_create(&_dispatch_source_type_memorypressure, 0, MASK_ALL, queue);
            if source.is_null() {
                dlog!("[cull] memory-pressure source unavailable");
                return;
            }
            let ctx = Box::into_raw(Box::new(Ctx { source, app }));
            dispatch_set_context(source, ctx as *mut c_void);
            dispatch_source_set_event_handler_f(source, on_pressure);
            dispatch_resume(source);
        }
    }
}

#[cfg(windows)]
mod platform {
    use super::{level_from_load, EVENT};
    use tauri::Emitter;

    #[repr(C)]
    #[allow(non_snake_case)]
    struct MemoryStatusEx {
        dwLength: u32,
        dwMemoryLoad: u32,
        ullTotalPhys: u64,
        ullAvailPhys: u64,
        ullTotalPageFile: u64,
        ullAvailPageFile: u64,
        ullTotalVirtual: u64,
        ullAvailVirtual: u64,
        ullAvailExtendedVirtual: u64,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GlobalMemoryStatusEx(lpBuffer: *mut MemoryStatusEx) -> i32;
    }

    const POLL_MS: u64 = 5000;

    pub fn start(app: tauri::AppHandle) {
        std::thread::spawn(move || {
            let mut prev: &'static str = "normal";
            loop {
                let mut st = MemoryStatusEx {
                    dwLength: std::mem::size_of::<MemoryStatusEx>() as u32,
                    dwMemoryLoad: 0,
                    ullTotalPhys: 0,
                    ullAvailPhys: 0,
                    ullTotalPageFile: 0,
                    ullAvailPageFile: 0,
                    ullTotalVirtual: 0,
                    ullAvailVirtual: 0,
                    ullAvailExtendedVirtual: 0,
                };
                // SAFETY: st is a correctly sized, initialised out-param.
                let ok = unsafe { GlobalMemoryStatusEx(&mut st) } != 0;
                if ok {
                    let level = level_from_load(st.dwMemoryLoad, prev);
                    if level != prev {
                        prev = level;
                        let _ = app.emit(EVENT, level);
                        dlog!(
                            "[cull] memory-pressure: {level} (load {}%)",
                            st.dwMemoryLoad
                        );
                    }
                }
                std::thread::sleep(std::time::Duration::from_millis(POLL_MS));
            }
        });
    }
}

/// Start forwarding OS memory-pressure to the webview. Fire-and-forget;
/// failure to start just means no pressure events (never an error surface).
pub(crate) fn start(app: tauri::AppHandle) {
    platform::start(app);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Dispatch data word → level, CRITICAL winning coalesced deliveries.
    #[test]
    fn dispatch_mapping() {
        assert_eq!(level_from_dispatch(0x1), "normal");
        assert_eq!(level_from_dispatch(0x2), "warn");
        assert_eq!(level_from_dispatch(0x4), "critical");
        assert_eq!(level_from_dispatch(0x6), "critical"); // warn+critical coalesced
        assert_eq!(level_from_dispatch(0x0), "normal");
    }

    /// Windows load% → level with hysteresis: no flapping at the boundaries.
    #[test]
    fn load_mapping_with_hysteresis() {
        assert_eq!(level_from_load(50, "normal"), "normal");
        assert_eq!(level_from_load(90, "normal"), "warn");
        assert_eq!(level_from_load(96, "normal"), "critical");
        // De-escalation needs clear air, not a 1% dip.
        assert_eq!(level_from_load(89, "warn"), "warn");
        assert_eq!(level_from_load(84, "warn"), "normal");
        assert_eq!(level_from_load(93, "critical"), "critical");
        assert_eq!(level_from_load(91, "critical"), "warn");
        assert_eq!(level_from_load(80, "critical"), "normal");
        // Escalation from warn.
        assert_eq!(level_from_load(96, "warn"), "critical");
    }
}
