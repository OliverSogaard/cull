//! Backend I/O gating (Phase 2): a global read-permit backstop, the session
//! generation for chunked-read cancellation, and the session mtime table that
//! kills the thumb cache's stat-per-hit.
//!
//! ## IoGate
//!
//! A global semaphore over every image-read command. Deliberately ABOVE what
//! the frontend's lanes ever request: it is a BACKSTOP (against accounting
//! bugs, the bg sweep, future callers like the Phase 8 mid generator), not a
//! second scheduler. Profile swaps replace the semaphore wholesale — in-flight
//! owned permits release into the old instance harmlessly; new acquisitions
//! see the new cap (mirrors the frontend contract: in-flight reads finish at
//! the old numbers).
//!
//! ## Timeouts (owned here, tiered by profile)
//!
//! Blocking fs reads cannot be safely aborted on Windows/macOS
//! (`CancelSynchronousIo` is racy with pool-thread reuse; macOS has nothing),
//! so the decision is DETACH + IGNORE: on timeout the invoke rejects — the
//! frontend lane frees instantly — while the orphaned blocking task keeps its
//! owned permit and self-heals when the syscall finally returns. A truly hung
//! SMB read pins one backend permit out of 6/16, never a precious frontend
//! lane. The watcher `dlog!`s when an orphan returns (the stuck-permit
//! detector — permit leaks are visible instead of mysterious).
//!
//! ## SessionGate
//!
//! `begin_session(gen)` is called from the frontend's `imageStore.reset()` /
//! `hardReset()` (wired in Phase 3). Read commands carry their session `gen`;
//! chunked reads bail with the cancellation sentinel between ≤2 MiB chunks
//! when the gen has moved — a superseded read dies within ~one chunk instead
//! of finishing a multi-MB transfer. The mtime table is fed by
//! `analyze_folder`'s directory listings (free — it already stats every file)
//! and read by `extract_thumbnail` for cache validation: no stat, ever, for
//! analyzed files. Sound because CR3s are immutable while culling. Entries
//! are never cleared mid-run (paths are stable keys; staleness is impossible
//! for files the app never writes).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use tokio::sync::{OwnedSemaphorePermit, Semaphore};

/// Backstop permit counts (plan's profile table).
const NETWORK_PERMITS: usize = 6;
const LOCAL_PERMITS: usize = 16;

/// Read tier, for the tiered timeouts.
#[derive(Clone, Copy)]
pub enum Tier {
    /// THMB / PRVW class: small head reads.
    Small,
    /// Full-res mdat JPEG: ~10 MB transfers.
    Full,
}

/// Profile mode. Unset until the frontend pushes one (`set_io_profile`,
/// wired in Phase 3): until then permits stay at the local cap (no throttle)
/// while timeouts use the GENEROUS network values — a mis-tiered timeout must
/// never fail a healthy slow read.
const MODE_UNSET: u8 = 0;
const MODE_LOCAL: u8 = 1;
const MODE_NETWORK: u8 = 2;

pub struct IoGate {
    sem: RwLock<Arc<Semaphore>>,
    mode: AtomicU8,
}

impl IoGate {
    pub fn new() -> Self {
        IoGate {
            sem: RwLock::new(Arc::new(Semaphore::new(LOCAL_PERMITS))),
            mode: AtomicU8::new(MODE_UNSET),
        }
    }

    /// Swap the permit cap for a storage-mode change. Wholesale replacement:
    /// permits already owned belong to (and release into) the old semaphore.
    pub fn set_profile(&self, network: bool) {
        let permits = if network {
            NETWORK_PERMITS
        } else {
            LOCAL_PERMITS
        };
        let mut sem = match self.sem.write() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        *sem = Arc::new(Semaphore::new(permits));
        drop(sem);
        self.mode.store(
            if network { MODE_NETWORK } else { MODE_LOCAL },
            Ordering::Relaxed,
        );
    }

    /// Acquire an owned permit (moved into the blocking task so it is held for
    /// the WHOLE read, surviving a timeout-detach).
    pub async fn acquire(&self) -> OwnedSemaphorePermit {
        let sem = match self.sem.read() {
            Ok(guard) => Arc::clone(&guard),
            Err(poisoned) => Arc::clone(&poisoned.into_inner()),
        };
        // The semaphore is never closed, so acquire can only fail on close.
        sem.acquire_owned().await.expect("IoGate semaphore closed")
    }

    /// True only when the frontend explicitly pushed the LOCAL profile.
    /// This is the mid tier's generation privilege (Phase 8 hard rule: the
    /// NAS profile never fetches a full SOLELY to generate) — so UNSET is
    /// treated as network: no speculative source reads before the frontend
    /// has told us where the photos live.
    pub fn is_local(&self) -> bool {
        self.mode.load(Ordering::Relaxed) == MODE_LOCAL
    }

    /// Tiered read timeout for the current profile.
    pub fn read_timeout(&self, tier: Tier) -> Duration {
        let network = self.mode.load(Ordering::Relaxed) != MODE_LOCAL;
        Duration::from_secs(match (tier, network) {
            (Tier::Small, true) => 20,
            (Tier::Full, true) => 45,
            (Tier::Small, false) => 8,
            (Tier::Full, false) => 15,
        })
    }
}

pub struct SessionGate {
    gen: AtomicU64,
    mtimes: RwLock<HashMap<String, i64>>,
    /// File sizes from the same dir listings (Phase 7): the tier cache's
    /// SECOND validator, free for the same reason the mtimes are.
    sizes: RwLock<HashMap<String, u64>>,
}

impl SessionGate {
    pub fn new() -> Self {
        SessionGate {
            gen: AtomicU64::new(0),
            mtimes: RwLock::new(HashMap::new()),
            sizes: RwLock::new(HashMap::new()),
        }
    }

    pub fn begin(&self, gen: u64) {
        self.gen.store(gen, Ordering::Relaxed);
    }

    /// True when `gen` is no longer the live session — chunked reads poll this
    /// between chunks and bail with the cancellation sentinel.
    pub fn is_cancelled(&self, gen: u64) -> bool {
        self.gen.load(Ordering::Relaxed) != gen
    }

    /// Record a file's mtime in MILLISECONDS (matches analyze_folder's ms
    /// mtimes; the thumb cache's seconds-resolution validator floors it).
    pub fn note_mtime(&self, path: &str, ms: i64) {
        if let Ok(mut m) = self.mtimes.write() {
            m.insert(path.to_string(), ms);
        }
    }

    pub fn mtime_ms(&self, path: &str) -> Option<i64> {
        self.mtimes.read().ok()?.get(path).copied()
    }

    /// Bulk feed from analyze's directory listings — one lock for the batch.
    pub fn note_mtimes(&self, entries: &HashMap<String, i64>) {
        if let Ok(mut m) = self.mtimes.write() {
            for (p, ms) in entries {
                m.insert(p.clone(), *ms);
            }
        }
    }

    pub fn note_size(&self, path: &str, size: u64) {
        if let Ok(mut m) = self.sizes.write() {
            m.insert(path.to_string(), size);
        }
    }

    /// Bulk feed from analyze's directory listings (Phase 7).
    pub fn note_sizes(&self, entries: &HashMap<String, u64>) {
        if let Ok(mut m) = self.sizes.write() {
            for (p, size) in entries {
                m.insert(p.clone(), *size);
            }
        }
    }

    /// (mtime ms, file size) when BOTH are known — the tier cache's dual
    /// validators in one lookup; None sends the caller to a one-time stat.
    pub fn file_stat(&self, path: &str) -> Option<(i64, u64)> {
        let ms = self.mtime_ms(path)?;
        let size = self.sizes.read().ok()?.get(path).copied()?;
        Some((ms, size))
    }
}

/// Frontend session handshake (Phase 3 wires the calls from
/// `imageStore.reset()`/`hardReset()`): every read command carries this gen.
#[tauri::command]
pub(crate) async fn begin_session(
    gen: u64,
    session: tauri::State<'_, Arc<SessionGate>>,
) -> Result<(), String> {
    session.begin(gen);
    Ok(())
}

/// Storage-mode push (Phase 3 wires it next to the frontend's setProfile):
/// swaps the backstop permit cap + timeout tier live, plus the mid tier's
/// generation concurrency (Phase 8: 1 network / 2 local).
#[tauri::command]
pub(crate) async fn set_io_profile(
    mode: String,
    gate: tauri::State<'_, Arc<IoGate>>,
    midgen: tauri::State<'_, Arc<crate::midtier::MidGen>>,
) -> Result<(), String> {
    let network = mode == "network";
    gate.set_profile(network);
    midgen.set_profile(network);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_gate_cancels_old_generations_only() {
        let g = SessionGate::new();
        g.begin(3);
        assert!(!g.is_cancelled(3));
        assert!(g.is_cancelled(2));
        g.begin(4);
        assert!(g.is_cancelled(3));
    }

    #[test]
    fn mtime_table_roundtrips() {
        let g = SessionGate::new();
        assert_eq!(g.mtime_ms("/a.cr3"), None);
        g.note_mtime("/a.cr3", 1_700_000_123_456);
        assert_eq!(g.mtime_ms("/a.cr3"), Some(1_700_000_123_456));
    }

    #[tokio::test]
    async fn gate_profile_swap_changes_cap_without_blocking_inflight() {
        let gate = IoGate::new();
        // Local default: plenty of permits.
        let p1 = gate.acquire().await;
        gate.set_profile(true); // network: new semaphore, 6 permits
                                // New acquisitions come from the new instance even with p1 alive.
        let mut held = Vec::new();
        for _ in 0..NETWORK_PERMITS {
            held.push(gate.acquire().await);
        }
        // The 7th would block: try_acquire on the live semaphore must fail.
        let sem = match gate.sem.read() {
            Ok(g) => Arc::clone(&g),
            Err(_) => unreachable!(),
        };
        assert!(sem.try_acquire().is_err(), "network cap not enforced");
        drop(p1); // releases into the OLD semaphore — harmless
        assert!(
            sem.try_acquire().is_err(),
            "old-instance release leaked into new cap"
        );
        drop(held);
        assert!(sem.try_acquire().is_ok());
        // Timeouts follow the mode.
        assert_eq!(gate.read_timeout(Tier::Full), Duration::from_secs(45));
        gate.set_profile(false);
        assert_eq!(gate.read_timeout(Tier::Full), Duration::from_secs(15));
    }
}
