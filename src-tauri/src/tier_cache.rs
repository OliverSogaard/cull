//! On-disk LRU cache for image tiers, format v2 (pipeline Phase 7).
//! Generalizes the v1 thumbnail cache to per-tier subdirs — `thumb/` (THMB
//! JPEGs), `prvw/` (1620×1080 PRVW JPEGs, filled by piggyback on
//! `read_preview` misses ONLY — never a standalone NAS sweep), `mid/`
//! (reserved for the Phase 8 generated tier).
//!
//! ## Entry format v2 (little-endian)
//!
//! `"CUL2"` magic · version u8 · tier u8 · source mtime i64 in MILLISECONDS
//! (matches `analyze_folder`'s ms mtimes) · source file size u64 (second
//! cheap validator) · header_len u32 · header JSON · JPEG payload.
//!
//! The header JSON is the command's own wire header (dims + metadata +
//! orientation + range hints), stored verbatim so a cache hit serves a frame
//! byte-identical to a fresh parse — which also fixes the v1 limitation where
//! disk-cache thumbnail hits carried `meta: null`. v1 files fail the magic
//! check and regenerate silently (the plan's accepted one-time invalidation).
//! CONTRACT: any semantic change to a stored wire header (ThumbHeader /
//! PreviewHeader shape or meaning) must bump [`VERSION`] — otherwise old
//! headers replay from disk into the new frontend.
//!
//! ## Contracts (from the plan)
//!
//! - Validation never stats the source: callers pass (mtime_ms, file_size)
//!   from the session stat table (fed by analyze's dir listings) or a
//!   once-memoized [`stat_of`]. Sound because CR3s are immutable while culling.
//! - Eviction/clear select victims and mutate the index UNDER the Mutex, then
//!   delete files OUTSIDE it; a failed delete re-indexes at next startup scan.
//! - `put()` refuses payloads above the per-entry cap.
//! - Cross-process: temp names carry the PROCESS ID (`{key}.{pid}.{seq}.tmp`)
//!   so two instances can't interleave a torn file; publishes are atomic
//!   renames (last-writer-wins); any `get()` whose read or validators fail is
//!   a miss dropped from the index; divergence self-heals at startup scan.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

const MAGIC: &[u8; 4] = b"CUL2";
const VERSION: u8 = 2;
/// magic + version + tier + mtime_ms + file_size + header_len
const PRELUDE: usize = 4 + 1 + 1 + 8 + 8 + 4;

/// Process-wide sequence for unique temp-file names (the pid in the name
/// guards across processes; this guards across threads in THIS one).
static TMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum CacheTier {
    Thumb,
    Prvw,
    /// Generated ≤2560px tier (Phase 8) — written by `read_mid` misses, the
    /// opportunistic generator, and the local-profile idle sweep.
    Mid,
}

impl CacheTier {
    fn byte(self) -> u8 {
        match self {
            CacheTier::Thumb => 0,
            CacheTier::Prvw => 1,
            CacheTier::Mid => 2,
        }
    }
    fn subdir(self) -> &'static str {
        match self {
            CacheTier::Thumb => "thumb",
            CacheTier::Prvw => "prvw",
            CacheTier::Mid => "mid",
        }
    }
    /// (total cap, per-entry ceiling) — the plan's table. Per-entry refusal:
    /// a pathological/corrupt parse must not crowd out hundreds of real
    /// entries; misses just regenerate from the CR3.
    fn caps(self) -> (u64, u64) {
        match self {
            CacheTier::Thumb => (500 * 1024 * 1024, 256 * 1024),
            CacheTier::Prvw => (2 * 1024 * 1024 * 1024, 2 * 1024 * 1024),
            CacheTier::Mid => (4 * 1024 * 1024 * 1024, 4 * 1024 * 1024),
        }
    }
}

/// Same FNV-1a key as v1 — stable across versions on purpose (key collisions
/// across formats are impossible anyway: tier subdirs are disjoint and v1
/// files fail the magic check).
fn key_for(path: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in path.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

/// One stat for paths the session table hasn't seen: (mtime ms, file size).
/// Callers memoize the answer into the session table so it never repeats.
pub(crate) fn stat_of(path: &str) -> Option<(i64, u64)> {
    let md = std::fs::metadata(path).ok()?;
    let ms = md
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis() as i64;
    Some((ms, md.len()))
}

struct Entry {
    size: u64,
    used: u64,
}
#[derive(Default)]
struct Index {
    entries: HashMap<String, Entry>,
    total: u64,
    tick: u64,
}

struct TierStore {
    dir: PathBuf,
    tier_byte: u8,
    cap_bytes: u64,
    low_water: u64,
    max_entry_bytes: u64,
    index: Mutex<Index>,
}

impl TierStore {
    fn new(dir: PathBuf, tier_byte: u8, cap_bytes: u64, max_entry_bytes: u64) -> Self {
        let _ = std::fs::create_dir_all(&dir);
        let mut index = Index::default();
        if let Ok(rd) = std::fs::read_dir(&dir) {
            for e in rd.flatten() {
                if let Ok(meta) = e.metadata() {
                    if meta.is_file() {
                        if let Some(key) = e.file_name().to_str().map(|s| s.to_string()) {
                            // Crash-orphaned temp from an interrupted write —
                            // clean up; never index it as a (bogus) cache key.
                            // (Another live instance's in-flight tmp lives for
                            // ~ms; losing one is a failed put, already-graceful.)
                            if key.ends_with(".tmp") {
                                let _ = std::fs::remove_file(e.path());
                                continue;
                            }
                            index.total += meta.len();
                            index.tick += 1;
                            index
                                .entries
                                .insert(key, Entry { size: meta.len(), used: index.tick });
                        }
                    }
                }
            }
        }
        TierStore {
            dir,
            tier_byte,
            cap_bytes,
            low_water: cap_bytes * 9 / 10,
            max_entry_bytes,
            index: Mutex::new(index),
        }
    }

    /// Forget `key` (index + totals under the lock) and optionally delete its
    /// file OUTSIDE the lock — the validator-failure / read-failure path.
    ///
    /// ACCEPTED RACE (reviewed): a stale get()'s drop can momentarily collide
    /// with a concurrent same-key put() republishing a fresh entry — deleting
    /// it (one redundant re-parse) or leaving a phantom index entry (inflated
    /// totals until the next get / startup rescan). Reaching it needs a source
    /// file changed BETWEEN sessions plus same-key concurrency in a ~ms
    /// window; every end state self-heals, same envelope as the plan's
    /// cross-process divergence contract.
    fn drop_entry(&self, key: &str, delete_file: bool) {
        let known = {
            let Ok(mut idx) = self.index.lock() else { return };
            match idx.entries.remove(key) {
                Some(e) => {
                    idx.total = idx.total.saturating_sub(e.size);
                    true
                }
                None => false,
            }
        };
        if known && delete_file {
            let _ = std::fs::remove_file(self.dir.join(key));
        }
    }

    /// Validated read: every check failing → miss, entry dropped (and the dead
    /// file deleted), caller regenerates from the CR3. Returns
    /// (header JSON, payload) exactly as stored by `put`.
    fn get(&self, src_path: &str, mtime_ms: i64, file_size: u64) -> Option<(Vec<u8>, Vec<u8>)> {
        let key = key_for(src_path);
        // Must be tracked by the index (size/LRU). Cheap existence check.
        {
            let idx = self.index.lock().ok()?;
            if !idx.entries.contains_key(&key) {
                return None;
            }
        }
        let bytes = match std::fs::read(self.dir.join(&key)) {
            Ok(b) => b,
            Err(_) => {
                // Another instance evicted it (or the disk lost it): miss,
                // drop from the index; nothing left to delete.
                self.drop_entry(&key, false);
                return None;
            }
        };
        let valid = bytes.len() >= PRELUDE
            && &bytes[0..4] == MAGIC
            && bytes[4] == VERSION
            && bytes[5] == self.tier_byte
            && i64::from_le_bytes(bytes[6..14].try_into().ok()?) == mtime_ms
            && u64::from_le_bytes(bytes[14..22].try_into().ok()?) == file_size
            && {
                let header_len = u32::from_le_bytes(bytes[22..26].try_into().ok()?) as usize;
                PRELUDE.checked_add(header_len).is_some_and(|end| end <= bytes.len())
            };
        if !valid {
            // Corrupt / stale (source changed) / v1 format / torn by another
            // process: refuse and delete — the next read re-caches it fresh.
            self.drop_entry(&key, true);
            return None;
        }
        let header_len = u32::from_le_bytes(bytes[22..26].try_into().ok()?) as usize;
        // Fresh hit → bump LRU recency.
        if let Ok(mut idx) = self.index.lock() {
            idx.tick += 1;
            let t = idx.tick;
            if let Some(e) = idx.entries.get_mut(&key) {
                e.used = t;
            }
        }
        Some((
            bytes[PRELUDE..PRELUDE + header_len].to_vec(),
            bytes[PRELUDE + header_len..].to_vec(),
        ))
    }

    fn put(&self, src_path: &str, mtime_ms: i64, file_size: u64, header: &[u8], payload: &[u8]) {
        let entry_len = PRELUDE as u64 + header.len() as u64 + payload.len() as u64;
        if entry_len > self.max_entry_bytes {
            dlog!(
                "[cull] tier_cache: refusing oversized entry ({entry_len}B) for {src_path}"
            );
            return;
        }
        let key = key_for(src_path);
        let mut buf = Vec::with_capacity(entry_len as usize);
        buf.extend_from_slice(MAGIC);
        buf.push(VERSION);
        buf.push(self.tier_byte);
        buf.extend_from_slice(&mtime_ms.to_le_bytes());
        buf.extend_from_slice(&file_size.to_le_bytes());
        buf.extend_from_slice(&(header.len() as u32).to_le_bytes());
        buf.extend_from_slice(header);
        buf.extend_from_slice(payload);
        // Atomic publish: unique temp sibling (pid guards across PROCESSES,
        // seq across threads) then rename over the key — a concurrent
        // lock-free get() sees the old complete file or the new complete
        // file, never a torn JPEG.
        let dst = self.dir.join(&key);
        let seq = TMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let tmp = self
            .dir
            .join(format!("{key}.{}.{seq}.tmp", std::process::id()));
        if std::fs::write(&tmp, &buf).is_err() {
            let _ = std::fs::remove_file(&tmp);
            return;
        }
        if std::fs::rename(&tmp, &dst).is_err() {
            let _ = std::fs::remove_file(&tmp);
            return;
        }
        let size = buf.len() as u64;
        let victims = {
            let mut idx = match self.index.lock() {
                Ok(g) => g,
                Err(_) => return,
            };
            if let Some(old) = idx.entries.remove(&key) {
                idx.total = idx.total.saturating_sub(old.size);
            }
            idx.tick += 1;
            let used = idx.tick;
            idx.total += size;
            idx.entries.insert(key, Entry { size, used });
            if idx.total > self.cap_bytes {
                self.select_victims_locked(&mut idx)
            } else {
                Vec::new()
            }
        };
        // File deletes happen OUTSIDE the index lock: an eviction batch on a
        // slow disk must never stall concurrent get()/put() index access. The
        // index already forgot these keys, so a racing get() is at worst a
        // miss; a failed delete leaves an orphan the startup scan re-indexes.
        for key in victims {
            let _ = std::fs::remove_file(self.dir.join(&key));
        }
    }

    /// Pick LRU victims until total ≤ low water, removing them from the index
    /// (and totals) under the lock. The CALLER deletes the files after the
    /// lock is dropped.
    fn select_victims_locked(&self, idx: &mut Index) -> Vec<String> {
        let mut v: Vec<(String, u64)> =
            idx.entries.iter().map(|(k, e)| (k.clone(), e.used)).collect();
        // unstable sort: the `used` tick is unique + monotonic, so ordering is
        // deterministic regardless of stability.
        v.sort_unstable_by_key(|(_, u)| *u);
        let mut victims = Vec::new();
        for (key, _) in v {
            if idx.total <= self.low_water {
                break;
            }
            if let Some(e) = idx.entries.remove(&key) {
                idx.total = idx.total.saturating_sub(e.size);
                victims.push(key);
            }
        }
        victims
    }

    /// Cheap currency check WITHOUT reading the payload or bumping LRU
    /// recency: index membership plus a prelude-only read validating
    /// magic/version/tier/mtime/size. Used by the opportunistic mid
    /// generator to skip already-cached paths before cloning a ~10 MB full;
    /// a stale or torn entry just reads false — the imminent `put`
    /// overwrites it (and a later `get` would drop it anyway).
    fn has_current(&self, src_path: &str, mtime_ms: i64, file_size: u64) -> bool {
        let key = key_for(src_path);
        {
            let Ok(idx) = self.index.lock() else { return false };
            if !idx.entries.contains_key(&key) {
                return false;
            }
        }
        let mut buf = [0u8; PRELUDE];
        let Ok(mut f) = std::fs::File::open(self.dir.join(&key)) else { return false };
        if std::io::Read::read_exact(&mut f, &mut buf).is_err() {
            return false;
        }
        &buf[0..4] == MAGIC
            && buf[4] == VERSION
            && buf[5] == self.tier_byte
            && buf[6..14] == mtime_ms.to_le_bytes()
            && buf[14..22] == file_size.to_le_bytes()
    }

    fn clear(&self) {
        // Same outside-the-lock discipline as eviction.
        let keys: Vec<String> = {
            let Ok(mut idx) = self.index.lock() else { return };
            let keys = idx.entries.keys().cloned().collect();
            idx.entries.clear();
            idx.total = 0;
            keys
        };
        for key in keys {
            let _ = std::fs::remove_file(self.dir.join(&key));
        }
    }

    fn size_bytes(&self) -> u64 {
        self.index.lock().map(|i| i.total).unwrap_or(0)
    }
}

pub struct TierCache {
    stores: [TierStore; 3],
}

impl TierCache {
    pub fn new(root: PathBuf) -> Self {
        let store = |tier: CacheTier| {
            let (cap, max_entry) = tier.caps();
            TierStore::new(root.join(tier.subdir()), tier.byte(), cap, max_entry)
        };
        TierCache {
            stores: [
                store(CacheTier::Thumb),
                store(CacheTier::Prvw),
                store(CacheTier::Mid),
            ],
        }
    }

    fn store(&self, tier: CacheTier) -> &TierStore {
        &self.stores[tier.byte() as usize]
    }

    /// (header JSON, payload) for `src_path` if cached, current, and intact —
    /// validated against the caller-supplied (mtime ms, file size); ZERO
    /// source-file round-trips.
    pub fn get(
        &self,
        tier: CacheTier,
        src_path: &str,
        mtime_ms: i64,
        file_size: u64,
    ) -> Option<(Vec<u8>, Vec<u8>)> {
        self.store(tier).get(src_path, mtime_ms, file_size)
    }

    pub fn put(
        &self,
        tier: CacheTier,
        src_path: &str,
        mtime_ms: i64,
        file_size: u64,
        header: &[u8],
        payload: &[u8],
    ) {
        self.store(tier).put(src_path, mtime_ms, file_size, header, payload);
    }

    /// True when a current entry exists for `src_path` (prelude validation
    /// only — no payload read, no LRU bump). See [`TierStore::has_current`].
    pub fn has_current(&self, tier: CacheTier, src_path: &str, mtime_ms: i64, file_size: u64) -> bool {
        self.store(tier).has_current(src_path, mtime_ms, file_size)
    }

    /// Wipe every tier (the settings dialog's "clear cache").
    pub fn clear(&self) {
        for s in &self.stores {
            s.clear();
        }
    }

    /// Total bytes across tiers (the settings dialog's size readout).
    pub fn size_bytes(&self) -> u64 {
        self.stores.iter().map(|s| s.size_bytes()).sum()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "cull-tiercache-{}-{}",
            name,
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&d);
        d
    }
    fn src_file(dir: &Path, name: &str, bytes: &[u8]) -> String {
        let p = dir.join(name);
        std::fs::write(&p, bytes).unwrap();
        p.to_string_lossy().to_string()
    }
    /// A small store with test-sized caps (production goes through caps()).
    fn small_store(dir: PathBuf, cap: u64, max_entry: u64) -> TierStore {
        TierStore::new(dir, CacheTier::Thumb.byte(), cap, max_entry)
    }

    #[test]
    fn roundtrips_header_and_payload_per_tier_independently() {
        let work = tmp("rt");
        std::fs::create_dir_all(&work).unwrap();
        let cache = TierCache::new(work.join("tiers"));
        let src = src_file(&work, "a.cr3", b"cr3");
        cache.put(CacheTier::Thumb, &src, 1_700_000_000_123, 3, b"{\"t\":1}", b"\xFF\xD8thumb");
        cache.put(CacheTier::Prvw, &src, 1_700_000_000_123, 3, b"{\"p\":2}", b"\xFF\xD8prvw");
        let (th, tp) = cache.get(CacheTier::Thumb, &src, 1_700_000_000_123, 3).expect("thumb hit");
        assert_eq!((th.as_slice(), tp.as_slice()), (&b"{\"t\":1}"[..], &b"\xFF\xD8thumb"[..]));
        let (ph, pp) = cache.get(CacheTier::Prvw, &src, 1_700_000_000_123, 3).expect("prvw hit");
        assert_eq!((ph.as_slice(), pp.as_slice()), (&b"{\"p\":2}"[..], &b"\xFF\xD8prvw"[..]));
        // Mid never written → miss.
        assert!(cache.get(CacheTier::Mid, &src, 1_700_000_000_123, 3).is_none());
        let _ = std::fs::remove_dir_all(&work);
    }

    #[test]
    fn miss_and_drop_on_stale_mtime_or_size() {
        let work = tmp("stale");
        std::fs::create_dir_all(&work).unwrap();
        let store = small_store(work.join("t"), 10_000, 1_000);
        let src = src_file(&work, "a.cr3", b"cr3");
        store.put(&src, 1000, 3, b"{}", b"jpeg");
        // Wrong mtime → miss, entry dropped AND its dead file deleted.
        assert!(store.get(&src, 2000, 3).is_none());
        assert_eq!(store.size_bytes(), 0);
        assert_eq!(std::fs::read_dir(&store.dir).unwrap().count(), 0);
        // Re-cache, then wrong size → same refusal.
        store.put(&src, 1000, 3, b"{}", b"jpeg");
        assert!(store.get(&src, 1000, 4).is_none());
        assert_eq!(store.size_bytes(), 0);
        let _ = std::fs::remove_dir_all(&work);
    }

    #[test]
    fn refuses_corrupt_and_foreign_format_entries() {
        let work = tmp("corrupt");
        std::fs::create_dir_all(&work).unwrap();
        let store = small_store(work.join("t"), 10_000, 1_000);
        let src = src_file(&work, "a.cr3", b"cr3");
        let key = key_for(&src);

        // v1-format bytes (no CUL2 magic) under a valid index entry.
        store.put(&src, 1000, 3, b"{}", b"jpeg");
        std::fs::write(store.dir.join(&key), b"\x01\x02\x03not-a-v2-entry").unwrap();
        assert!(store.get(&src, 1000, 3).is_none(), "v1/garbage refused");
        assert!(!store.dir.join(&key).exists(), "dead file deleted");

        // Truncated prelude.
        store.put(&src, 1000, 3, b"{}", b"jpeg");
        std::fs::write(store.dir.join(&key), b"CUL2").unwrap();
        assert!(store.get(&src, 1000, 3).is_none(), "short file refused");

        // header_len pointing past EOF (torn write survived a rename race).
        store.put(&src, 1000, 3, b"{}", b"jpeg");
        let mut bytes = std::fs::read(store.dir.join(&key)).unwrap();
        bytes[22..26].copy_from_slice(&u32::MAX.to_le_bytes());
        std::fs::write(store.dir.join(&key), &bytes).unwrap();
        assert!(store.get(&src, 1000, 3).is_none(), "overlong header refused");

        // Wrong tier byte (a prvw entry can't serve a thumb request).
        store.put(&src, 1000, 3, b"{}", b"jpeg");
        let mut bytes = std::fs::read(store.dir.join(&key)).unwrap();
        bytes[5] = CacheTier::Prvw.byte();
        std::fs::write(store.dir.join(&key), &bytes).unwrap();
        assert!(store.get(&src, 1000, 3).is_none(), "tier mismatch refused");

        let _ = std::fs::remove_dir_all(&work);
    }

    #[test]
    fn refuses_oversized_entry() {
        let work = tmp("cap");
        std::fs::create_dir_all(&work).unwrap();
        let store = small_store(work.join("t"), 10_000, 64);
        let src = src_file(&work, "a.cr3", b"cr3");
        store.put(&src, 1000, 3, b"{}", &[0u8; 100]); // 26 + 2 + 100 > 64
        assert!(store.get(&src, 1000, 3).is_none());
        assert_eq!(store.size_bytes(), 0);
        assert_eq!(std::fs::read_dir(&store.dir).unwrap().count(), 0, "nothing written");
        let _ = std::fs::remove_dir_all(&work);
    }

    #[test]
    fn evicts_lru_to_low_water_and_deletes_files() {
        let work = tmp("evict");
        std::fs::create_dir_all(&work).unwrap();
        // Entries are 26 + 2 + 50 = 78 bytes. Cap 200 (low water 180): the
        // third put reaches 234 → evict the LRU entry (a) → 156 ≤ 180.
        let store = small_store(work.join("t"), 200, 100);
        let a = src_file(&work, "a.cr3", b"cr3");
        let b = src_file(&work, "b.cr3", b"cr3");
        let c = src_file(&work, "c.cr3", b"cr3");
        store.put(&a, 1000, 3, b"{}", &[1u8; 50]);
        store.put(&b, 1000, 3, b"{}", &[2u8; 50]);
        store.put(&c, 1000, 3, b"{}", &[3u8; 50]);
        assert!(store.get(&a, 1000, 3).is_none(), "LRU entry evicted");
        assert!(store.get(&b, 1000, 3).is_some());
        assert!(store.get(&c, 1000, 3).is_some());
        assert_eq!(store.size_bytes(), 156);
        assert_eq!(std::fs::read_dir(&store.dir).unwrap().count(), 2, "evicted file deleted");
        let _ = std::fs::remove_dir_all(&work);
    }

    #[test]
    fn survives_reopen_and_cleans_orphaned_tmps() {
        let work = tmp("reopen");
        std::fs::create_dir_all(&work).unwrap();
        let dir = work.join("t");
        let src = src_file(&work, "a.cr3", b"cr3");
        {
            let store = small_store(dir.clone(), 10_000, 1_000);
            store.put(&src, 1000, 3, b"{\"w\":160}", b"\xFF\xD8jpeg");
        } // drop → simulate app close
        std::fs::write(dir.join("deadbeef.1234.7.tmp"), b"orphan").unwrap();
        let reopened = small_store(dir.clone(), 10_000, 1_000);
        let (h, p) = reopened.get(&src, 1000, 3).expect("hit after reopen");
        assert_eq!((h.as_slice(), p.as_slice()), (&b"{\"w\":160}"[..], &b"\xFF\xD8jpeg"[..]));
        assert!(!dir.join("deadbeef.1234.7.tmp").exists(), "orphan tmp cleaned");
        let _ = std::fs::remove_dir_all(&work);
    }

    #[test]
    fn clear_empties_all_tiers() {
        let work = tmp("clear");
        std::fs::create_dir_all(&work).unwrap();
        let cache = TierCache::new(work.join("tiers"));
        let src = src_file(&work, "a.cr3", b"cr3");
        cache.put(CacheTier::Thumb, &src, 1000, 3, b"{}", b"t");
        cache.put(CacheTier::Prvw, &src, 1000, 3, b"{}", b"p");
        assert!(cache.size_bytes() > 0);
        cache.clear();
        assert_eq!(cache.size_bytes(), 0);
        assert!(cache.get(CacheTier::Thumb, &src, 1000, 3).is_none());
        assert!(cache.get(CacheTier::Prvw, &src, 1000, 3).is_none());
        let _ = std::fs::remove_dir_all(&work);
    }

    /// Phase 8: the mid tier roundtrips through the REAL production caps and
    /// refuses an entry past its 4 MiB per-entry ceiling (a pathological
    /// generation must not crowd out hundreds of real mids).
    #[test]
    fn mid_tier_roundtrips_and_refuses_oversized_entries() {
        let work = tmp("mid");
        std::fs::create_dir_all(&work).unwrap();
        let cache = TierCache::new(work.join("tiers"));
        let src = src_file(&work, "a.cr3", b"cr3");
        let jpeg = vec![0xFFu8; 1_200_000]; // a realistic q80 2560px payload
        cache.put(CacheTier::Mid, &src, 1000, 3, b"{\"midLen\":1200000}", &jpeg);
        let (h, p) = cache.get(CacheTier::Mid, &src, 1000, 3).expect("mid hit");
        assert_eq!(h.as_slice(), b"{\"midLen\":1200000}");
        assert_eq!(p.len(), jpeg.len());
        // Over the 4 MiB cap → refused outright, the old entry replaced by
        // nothing (put bails before touching the index or the disk).
        let huge = vec![0u8; 4 * 1024 * 1024];
        let before = cache.size_bytes();
        cache.put(CacheTier::Mid, &src, 2000, 4, b"{}", &huge);
        assert_eq!(cache.size_bytes(), before, "oversized put must be a no-op");
        assert!(cache.get(CacheTier::Mid, &src, 2000, 4).is_none());
        let _ = std::fs::remove_dir_all(&work);
    }

    /// has_current: true only for a present + validator-matching entry; never
    /// bumps recency and never deletes (the stale answer is just `false`).
    #[test]
    fn has_current_validates_without_mutating() {
        let work = tmp("hascur");
        std::fs::create_dir_all(&work).unwrap();
        let store = small_store(work.join("t"), 10_000, 1_000);
        let src = src_file(&work, "a.cr3", b"cr3");
        assert!(!store.has_current(&src, 1000, 3), "empty store");
        store.put(&src, 1000, 3, b"{}", b"jpeg");
        assert!(store.has_current(&src, 1000, 3));
        // Stale validators → false, but the entry survives for the matching
        // stat (unlike get(), which deletes on mismatch).
        assert!(!store.has_current(&src, 2000, 3));
        assert!(!store.has_current(&src, 1000, 4));
        assert!(store.has_current(&src, 1000, 3), "mismatch probe must not evict");
        assert!(store.get(&src, 1000, 3).is_some());
        let _ = std::fs::remove_dir_all(&work);
    }

    #[test]
    fn stat_of_returns_ms_mtime_and_size() {
        let work = tmp("stat");
        std::fs::create_dir_all(&work).unwrap();
        let src = src_file(&work, "a.cr3", b"12345");
        let (ms, size) = stat_of(&src).expect("stat");
        assert_eq!(size, 5);
        assert!(ms > 1_500_000_000_000, "mtime is in milliseconds: {ms}");
        let _ = std::fs::remove_dir_all(&work);
    }
}
