//! On-disk LRU cache for embedded thumbnails (THMB JPEG + display dims).
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

const CAP_BYTES: u64 = 500 * 1024 * 1024;
/// Per-entry ceiling. THMB JPEGs are ~15 KB; anything near this size is a
/// pathological/corrupt parse and is refused rather than cached (it would
/// crowd out hundreds of real entries and round-trip through disk for nothing).
const MAX_ENTRY_BYTES: u64 = 256 * 1024;

/// Process-wide sequence for unique temp-file names, so two overlapping put()s
/// for the same key never share a temp path and never interleave into one torn
/// file (mirrors the XMP sidecar writer's XMP_TMP_SEQ).
static TMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub struct ThumbCache {
    dir: PathBuf,
    cap_bytes: u64,
    low_water: u64,
    max_entry_bytes: u64,
    index: Mutex<Index>,
}
#[derive(Default)]
struct Index { entries: HashMap<String, Entry>, total: u64, tick: u64 }
struct Entry { size: u64, used: u64 }

fn key_for(path: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in path.as_bytes() { h ^= *b as u64; h = h.wrapping_mul(0x100000001b3); }
    format!("{h:016x}")
}
/// Stat fallback for paths the session mtime table hasn't seen (un-analyzed
/// files). The hot path passes a table-sourced mtime instead — Phase 2 killed
/// the stat-per-hit this used to cost on every cached thumbnail.
pub(crate) fn mtime_of(path: &str) -> Option<i64> {
    let d = std::fs::metadata(path).ok()?.modified().ok()?
        .duration_since(std::time::UNIX_EPOCH).ok()?;
    Some(d.as_secs() as i64)
}
fn opt_dim(v: u32) -> Option<u32> { if v == 0 { None } else { Some(v) } }

impl ThumbCache {
    pub fn new(dir: PathBuf) -> Self {
        Self::with_caps(dir, CAP_BYTES, MAX_ENTRY_BYTES)
    }

    /// Custom caps so tests can exercise eviction/refusal without writing
    /// hundreds of MB. Production always goes through [`ThumbCache::new`].
    fn with_caps(dir: PathBuf, cap_bytes: u64, max_entry_bytes: u64) -> Self {
        let _ = std::fs::create_dir_all(&dir);
        let mut index = Index::default();
        if let Ok(rd) = std::fs::read_dir(&dir) {
            for e in rd.flatten() {
                if let Ok(meta) = e.metadata() {
                    if meta.is_file() {
                        if let Some(key) = e.file_name().to_str().map(|s| s.to_string()) {
                            // Crash-orphaned temp from an interrupted write — clean it
                            // up; never index it as a (bogus) cache key.
                            if key.ends_with(".tmp") {
                                let _ = std::fs::remove_file(e.path());
                                continue;
                            }
                            index.total += meta.len();
                            index.tick += 1;
                            index.entries.insert(key, Entry { size: meta.len(), used: index.tick });
                        }
                    }
                }
            }
        }
        ThumbCache {
            dir,
            cap_bytes,
            low_water: cap_bytes * 9 / 10,
            max_entry_bytes,
            index: Mutex::new(index),
        }
    }
    /// `src_mtime` (epoch SECONDS) comes from the caller — the session mtime
    /// table when available, a one-time stat otherwise — so a cache HIT costs
    /// zero filesystem round-trips (the stat-per-hit was one NAS round-trip
    /// per cached thumbnail, exactly what the cache exists to avoid).
    pub fn get(&self, src_path: &str, src_mtime: i64) -> Option<(Vec<u8>, Option<u32>, Option<u32>)> {
        let key = key_for(src_path);
        // Must be tracked by the index (size/LRU). Cheap existence check.
        { let idx = self.index.lock().ok()?; if !idx.entries.contains_key(&key) { return None; } }
        let bytes = std::fs::read(self.dir.join(&key)).ok()?;
        if bytes.len() < 16 { return None; }
        let stored_mtime = i64::from_le_bytes(bytes[0..8].try_into().ok()?);
        if stored_mtime != src_mtime { return None; } // source changed → stale, treat as miss
        let w = u32::from_le_bytes(bytes[8..12].try_into().ok()?);
        let h = u32::from_le_bytes(bytes[12..16].try_into().ok()?);
        // Fresh hit → bump LRU recency.
        if let Ok(mut idx) = self.index.lock() {
            idx.tick += 1; let t = idx.tick;
            if let Some(e) = idx.entries.get_mut(&key) { e.used = t; }
        }
        Some((bytes[16..].to_vec(), opt_dim(w), opt_dim(h)))
    }
    pub fn put(&self, src_path: &str, mtime: i64, jpeg: &[u8], w: Option<u32>, h: Option<u32>) {
        // Per-entry cap: refuse pathological payloads instead of caching them
        // (one oversized entry would crowd out hundreds of real thumbs).
        // Misses just regenerate from the CR3, so refusal is safe.
        if 16 + jpeg.len() as u64 > self.max_entry_bytes {
            dlog!(
                "[cull] thumb_cache: refusing oversized entry ({}B) for {}",
                jpeg.len(),
                src_path
            );
            return;
        }
        let key = key_for(src_path);
        let mut buf = Vec::with_capacity(16 + jpeg.len());
        buf.extend_from_slice(&mtime.to_le_bytes());
        buf.extend_from_slice(&w.unwrap_or(0).to_le_bytes());
        buf.extend_from_slice(&h.unwrap_or(0).to_le_bytes());
        buf.extend_from_slice(jpeg);
        // Atomic publish: write to a unique temp sibling then rename over the key,
        // so a concurrent lock-free get() sees either the old complete file or the
        // new complete file — never a torn/partial JPEG handed to the decoder.
        let dst = self.dir.join(&key);
        let seq = TMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let tmp = self.dir.join(format!("{key}.{seq}.tmp"));
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
            let mut idx = match self.index.lock() { Ok(g) => g, Err(_) => return };
            if let Some(old) = idx.entries.remove(&key) { idx.total = idx.total.saturating_sub(old.size); }
            idx.tick += 1; let used = idx.tick; idx.total += size;
            idx.entries.insert(key, Entry { size, used });
            if idx.total > self.cap_bytes { self.select_victims_locked(&mut idx) } else { Vec::new() }
        };
        // File deletes happen OUTSIDE the index lock: an eviction batch on a slow
        // disk/NAS must never stall concurrent get()/put() index access. The index
        // already forgot these keys, so a get() racing the delete is at worst a
        // miss; a delete that fails leaves an orphan file that the startup scan
        // re-indexes (and eviction re-selects) next launch.
        for key in victims { let _ = std::fs::remove_file(self.dir.join(&key)); }
    }
    /// Pick LRU victims until total ≤ low water, removing them from the index
    /// (and totals) under the lock. The CALLER deletes the files after the
    /// lock is dropped.
    fn select_victims_locked(&self, idx: &mut Index) -> Vec<String> {
        let mut v: Vec<(String, u64)> = idx.entries.iter().map(|(k, e)| (k.clone(), e.used)).collect();
        // unstable sort: the `used` tick is unique + monotonic, so ordering is
        // deterministic regardless of stability — and we hold the index lock here.
        v.sort_unstable_by_key(|(_, u)| *u);
        let mut victims = Vec::new();
        for (key, _) in v {
            if idx.total <= self.low_water { break; }
            if let Some(e) = idx.entries.remove(&key) {
                idx.total = idx.total.saturating_sub(e.size);
                victims.push(key);
            }
        }
        victims
    }
    pub fn clear(&self) {
        // Same outside-the-lock discipline as eviction: drain the index under
        // the Mutex, delete the files after dropping it.
        let keys: Vec<String> = {
            let Ok(mut idx) = self.index.lock() else { return };
            let keys = idx.entries.keys().cloned().collect();
            idx.entries.clear();
            idx.total = 0;
            keys
        };
        for key in keys { let _ = std::fs::remove_file(self.dir.join(&key)); }
    }
    pub fn size_bytes(&self) -> u64 { self.index.lock().map(|i| i.total).unwrap_or(0) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    fn mt(p: &str) -> i64 { mtime_of(p).unwrap() }
    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("cull-thumbcache-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&d); d
    }
    fn src_file(dir: &Path, name: &str, bytes: &[u8]) -> String {
        let p = dir.join(name); std::fs::write(&p, bytes).unwrap(); p.to_string_lossy().to_string()
    }
    #[test]
    fn put_then_get_roundtrips() {
        let work = tmp("rt"); std::fs::create_dir_all(&work).unwrap();
        let cache = ThumbCache::new(work.join("cache"));
        let src = src_file(&work, "a.cr3", b"cr3");
        cache.put(&src, mt(&src), b"\xFF\xD8jpeg", Some(6000), Some(4000));
        let (jpeg, w, h) = cache.get(&src, mt(&src)).expect("hit");
        assert_eq!(jpeg, b"\xFF\xD8jpeg"); assert_eq!((w, h), (Some(6000), Some(4000)));
        let _ = std::fs::remove_dir_all(&work);
    }
    #[test]
    fn miss_on_changed_mtime() {
        let work = tmp("mtime"); std::fs::create_dir_all(&work).unwrap();
        let cache = ThumbCache::new(work.join("cache"));
        let src = src_file(&work, "a.cr3", b"cr3");
        cache.put(&src, mt(&src), b"jpeg", Some(1), Some(1));
        std::thread::sleep(std::time::Duration::from_millis(1100));
        std::fs::write(&src, b"cr3-changed").unwrap();
        assert!(cache.get(&src, mt(&src)).is_none());
        let _ = std::fs::remove_dir_all(&work);
    }
    #[test]
    fn clear_empties_cache() {
        let work = tmp("clear"); std::fs::create_dir_all(&work).unwrap();
        let cache = ThumbCache::new(work.join("cache"));
        let src = src_file(&work, "a.cr3", b"cr3");
        cache.put(&src, mt(&src), b"jpeg", None, None);
        assert!(cache.size_bytes() > 0);
        cache.clear();
        assert_eq!(cache.size_bytes(), 0); assert!(cache.get(&src, mt(&src)).is_none());
        let _ = std::fs::remove_dir_all(&work);
    }
    #[test]
    fn survives_reopen() {
        let work = tmp("reopen"); std::fs::create_dir_all(&work).unwrap();
        let dir = work.join("cache");
        let src = src_file(&work, "a.cr3", b"cr3");
        {
            let cache = ThumbCache::new(dir.clone());
            cache.put(&src, mt(&src), b"\xFF\xD8jpeg", Some(6000), Some(4000));
        } // drop cache → simulate app close
        let reopened = ThumbCache::new(dir); // new instance, same dir → app restart
        let (jpeg, w, h) = reopened.get(&src, mt(&src)).expect("hit after reopen");
        assert_eq!(jpeg, b"\xFF\xD8jpeg");
        assert_eq!((w, h), (Some(6000), Some(4000)));
        let _ = std::fs::remove_dir_all(&work);
    }
    #[test]
    fn refuses_oversized_entry() {
        let work = tmp("cap"); std::fs::create_dir_all(&work).unwrap();
        let dir = work.join("cache");
        // 64-byte per-entry cap; a 100-byte payload (116 with header) must be refused.
        let cache = ThumbCache::with_caps(dir.clone(), 1000, 64);
        let src = src_file(&work, "a.cr3", b"cr3");
        cache.put(&src, mt(&src), &[0u8; 100], Some(1), Some(1));
        assert!(cache.get(&src, mt(&src)).is_none());
        assert_eq!(cache.size_bytes(), 0);
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0, "nothing written to disk");
        let _ = std::fs::remove_dir_all(&work);
    }
    #[test]
    fn evicts_lru_when_over_cap_and_keeps_newest() {
        let work = tmp("evict"); std::fs::create_dir_all(&work).unwrap();
        let dir = work.join("cache");
        // Entries are 16 + 50 = 66 bytes. Cap 150 (low water 135): the third put
        // reaches 198 → evict the LRU entry (a) → 132 ≤ 135, b + c survive.
        let cache = ThumbCache::with_caps(dir.clone(), 150, 100);
        let a = src_file(&work, "a.cr3", b"cr3");
        let b = src_file(&work, "b.cr3", b"cr3");
        let c = src_file(&work, "c.cr3", b"cr3");
        cache.put(&a, mt(&a), &[1u8; 50], Some(1), Some(1));
        cache.put(&b, mt(&b), &[2u8; 50], Some(1), Some(1));
        cache.put(&c, mt(&c), &[3u8; 50], Some(1), Some(1));
        assert!(cache.get(&a, mt(&a)).is_none(), "LRU entry evicted");
        assert!(cache.get(&b, mt(&b)).is_some());
        assert!(cache.get(&c, mt(&c)).is_some());
        assert_eq!(cache.size_bytes(), 132);
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 2, "evicted file deleted from disk");
        let _ = std::fs::remove_dir_all(&work);
    }
}
