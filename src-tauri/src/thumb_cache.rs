//! On-disk LRU cache for embedded thumbnails (THMB JPEG + display dims).
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

const CAP_BYTES: u64 = 500 * 1024 * 1024;
const LOW_WATER: u64 = CAP_BYTES * 9 / 10;

pub struct ThumbCache { dir: PathBuf, index: Mutex<Index> }
#[derive(Default)]
struct Index { entries: HashMap<String, Entry>, total: u64, tick: u64 }
struct Entry { size: u64, used: u64 }

fn key_for(path: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in path.as_bytes() { h ^= *b as u64; h = h.wrapping_mul(0x100000001b3); }
    format!("{h:016x}")
}
fn mtime_of(path: &str) -> Option<i64> {
    let d = std::fs::metadata(path).ok()?.modified().ok()?
        .duration_since(std::time::UNIX_EPOCH).ok()?;
    Some(d.as_secs() as i64)
}
fn opt_dim(v: u32) -> Option<u32> { if v == 0 { None } else { Some(v) } }

impl ThumbCache {
    pub fn new(dir: PathBuf) -> Self {
        let _ = std::fs::create_dir_all(&dir);
        let mut index = Index::default();
        if let Ok(rd) = std::fs::read_dir(&dir) {
            for e in rd.flatten() {
                if let Ok(meta) = e.metadata() {
                    if meta.is_file() {
                        if let Some(key) = e.file_name().to_str().map(|s| s.to_string()) {
                            index.total += meta.len();
                            index.tick += 1;
                            index.entries.insert(key, Entry { size: meta.len(), used: index.tick });
                        }
                    }
                }
            }
        }
        ThumbCache { dir, index: Mutex::new(index) }
    }
    pub fn get(&self, src_path: &str) -> Option<(Vec<u8>, Option<u32>, Option<u32>)> {
        let key = key_for(src_path);
        let src_mtime = mtime_of(src_path)?;
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
    pub fn put(&self, src_path: &str, jpeg: &[u8], w: Option<u32>, h: Option<u32>) {
        let Some(mtime) = mtime_of(src_path) else { return };
        let key = key_for(src_path);
        let mut buf = Vec::with_capacity(16 + jpeg.len());
        buf.extend_from_slice(&mtime.to_le_bytes());
        buf.extend_from_slice(&w.unwrap_or(0).to_le_bytes());
        buf.extend_from_slice(&h.unwrap_or(0).to_le_bytes());
        buf.extend_from_slice(jpeg);
        if std::fs::write(self.dir.join(&key), &buf).is_err() { return; }
        let size = buf.len() as u64;
        let mut idx = match self.index.lock() { Ok(g) => g, Err(_) => return };
        if let Some(old) = idx.entries.remove(&key) { idx.total = idx.total.saturating_sub(old.size); }
        idx.tick += 1; let used = idx.tick; idx.total += size;
        idx.entries.insert(key, Entry { size, used });
        if idx.total > CAP_BYTES { self.evict_locked(&mut idx); }
    }
    fn evict_locked(&self, idx: &mut Index) {
        let mut v: Vec<(String, u64)> = idx.entries.iter().map(|(k, e)| (k.clone(), e.used)).collect();
        v.sort_by_key(|(_, u)| *u);
        for (key, _) in v {
            if idx.total <= LOW_WATER { break; }
            if let Some(e) = idx.entries.remove(&key) {
                idx.total = idx.total.saturating_sub(e.size);
                let _ = std::fs::remove_file(self.dir.join(&key));
            }
        }
    }
    pub fn clear(&self) {
        if let Ok(mut idx) = self.index.lock() {
            for key in idx.entries.keys() { let _ = std::fs::remove_file(self.dir.join(key)); }
            idx.entries.clear(); idx.total = 0;
        }
    }
    pub fn size_bytes(&self) -> u64 { self.index.lock().map(|i| i.total).unwrap_or(0) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
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
        cache.put(&src, b"\xFF\xD8jpeg", Some(6000), Some(4000));
        let (jpeg, w, h) = cache.get(&src).expect("hit");
        assert_eq!(jpeg, b"\xFF\xD8jpeg"); assert_eq!((w, h), (Some(6000), Some(4000)));
        let _ = std::fs::remove_dir_all(&work);
    }
    #[test]
    fn miss_on_changed_mtime() {
        let work = tmp("mtime"); std::fs::create_dir_all(&work).unwrap();
        let cache = ThumbCache::new(work.join("cache"));
        let src = src_file(&work, "a.cr3", b"cr3");
        cache.put(&src, b"jpeg", Some(1), Some(1));
        std::thread::sleep(std::time::Duration::from_millis(1100));
        std::fs::write(&src, b"cr3-changed").unwrap();
        assert!(cache.get(&src).is_none());
        let _ = std::fs::remove_dir_all(&work);
    }
    #[test]
    fn clear_empties_cache() {
        let work = tmp("clear"); std::fs::create_dir_all(&work).unwrap();
        let cache = ThumbCache::new(work.join("cache"));
        let src = src_file(&work, "a.cr3", b"cr3");
        cache.put(&src, b"jpeg", None, None);
        assert!(cache.size_bytes() > 0);
        cache.clear();
        assert_eq!(cache.size_bytes(), 0); assert!(cache.get(&src).is_none());
        let _ = std::fs::remove_dir_all(&work);
    }
    #[test]
    fn survives_reopen() {
        let work = tmp("reopen"); std::fs::create_dir_all(&work).unwrap();
        let dir = work.join("cache");
        let src = src_file(&work, "a.cr3", b"cr3");
        {
            let cache = ThumbCache::new(dir.clone());
            cache.put(&src, b"\xFF\xD8jpeg", Some(6000), Some(4000));
        } // drop cache → simulate app close
        let reopened = ThumbCache::new(dir); // new instance, same dir → app restart
        let (jpeg, w, h) = reopened.get(&src).expect("hit after reopen");
        assert_eq!(jpeg, b"\xFF\xD8jpeg");
        assert_eq!((w, h), (Some(6000), Some(4000)));
        let _ = std::fs::remove_dir_all(&work);
    }
}
