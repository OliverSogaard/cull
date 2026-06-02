# Image Loading & Display System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the real-BlurHash experiment with a three-stage image system (shimmer → blurred THMB → full-res) backed by an all-session in-memory THMB cache and a bounded on-disk THMB cache, exposed to all views through one `imageStore` module, so the shimmer is seen only on first load.

**Architecture:** A backend `thumb_cache.rs` wraps the existing CR3 thumbnail read with a 500 MB LRU on-disk cache keyed by `(pathHash, mtime)`. A frontend `imageStore` (a vanilla subscription store consumed via `useImage(path, {wantFull})`) owns the in-memory THMB cache (kept all session), the windowed full-res cache, the priority pools, the background "fill all THMBs" sweep, and per-path stage resolution. Grid/loupe/compare/strip components consume `useImage` and stop touching load logic directly.

**Tech Stack:** Rust + Tauri 2 (backend), React 19 + TypeScript + Vite (frontend), Vitest + cargo test.

**Reference:** Spec at `docs/superpowers/specs/2026-06-02-image-loading-system-design.md`.

**Conventions for every task:**
- Verify after each change set: `pnpm exec tsc`, `CI=true pnpm exec vitest run`, `cargo test --manifest-path src-tauri/Cargo.toml --lib`, `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets`.
- The live `pnpm tauri dev` server hot-reloads frontend changes and recompiles backend changes — use it to verify behavior.
- Commit at the end of each task with a conventional-commit message.

---

## Task 1: Revert the real-BlurHash stack (keep THMB display dims)

Removes the blurhash decode/encode path while preserving the THMB display dimensions (the aspect source the new system needs). After this task the app builds and runs with the pre-blurhash THMB behavior (shimmer placeholders, windowed thumbnail eviction).

**Files:**
- Modify: `src-tauri/Cargo.toml` (remove `zune-jpeg`, `blurhash` deps)
- Modify: `src-tauri/src/cr3.rs` (remove blurhash helpers; `Thumbnail` keeps `jpeg`,`width`,`height`; drop `blurhash`)
- Modify: `src-tauri/src/bundle.rs` (drop `extract_blurhash`, `BlurhashInfo`; `ThumbHeader` keeps `width`,`height`,`jpegLen`)
- Modify: `src-tauri/src/lib.rs` (unregister `bundle::extract_blurhash`)
- Modify: `src/utils/bundle.ts` (remove `fetchBlurhash`, `blurhashToDataUrl`, `decode` import; rename `BlurInfo` → `ImageDims`)
- Delete: `src/utils/blurhashCache.ts`
- Modify: `src/App.tsx` (remove warm-pass effect, `decodeBlurCached`/`blurDecodeCache`, `blurhashes`/`blurhashesRef` state, `loadBlurCache`/`saveBlurCache` import, blurhash usage)
- Modify: `src/components/GridView.tsx`, `ThumbCell.tsx`, `ThumbStrip.tsx`, `CompareStrip.tsx`, `CompareView.tsx`
- Modify: `package.json` (remove `blurhash`)

- [ ] **Step 1: Remove the npm dependency**

Run: `CI=true pnpm remove blurhash`
Expected: `blurhash` gone from `package.json` dependencies.

- [ ] **Step 2: Remove Rust crates**

In `src-tauri/Cargo.toml`, delete these two lines (and the preceding comment block added for them):

```toml
zune-jpeg = "0.4"
blurhash = "0.2"
```

- [ ] **Step 3: Strip blurhash from `cr3.rs`**

Remove the functions `thumbnail_blurhash`, `oriented_rgba`, and `read_thumbnail_meta`. Keep `display_dims`. In `struct Thumbnail`, remove the `blurhash` field. In `read_thumbnail`, remove the `let blurhash = thumbnail_blurhash(...)` line and the `blurhash,` field. Remove the cr3 test `oriented_rgba_rotation`; keep `display_dims_swaps_for_rotated_orientations`.

Resulting `Thumbnail`:

```rust
pub struct Thumbnail {
    pub jpeg: Vec<u8>,
    #[allow(dead_code)]
    pub orientation: u32,
    pub width: Option<u32>,
    pub height: Option<u32>,
}
```

Resulting tail of `read_thumbnail`:

```rust
    let (width, height) = display_dims(orient, meta.pixel_width, meta.pixel_height);
    Ok(Thumbnail {
        jpeg: with_exif_orientation(raw, orient),
        orientation: orient,
        width,
        height,
    })
```

- [ ] **Step 4: Strip blurhash from `bundle.rs`**

Delete the `BlurhashInfo` struct and the `extract_blurhash` command. In `ThumbHeader`, remove the `blurhash` field (keep `width`, `height`, `jpeg_len`). In `extract_thumbnail`, remove `blurhash: t.blurhash,`.

- [ ] **Step 5: Unregister the command**

In `src-tauri/src/lib.rs`, delete `bundle::extract_blurhash,` from `generate_handler!`.

- [ ] **Step 6: Verify backend builds + tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib 2>&1 | grep -E "test result|error"` → Expected: `test result: ok`.
Run: `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets 2>&1 | grep -E "warning:|error|Finished"` → Expected: `Finished`, clean.

- [ ] **Step 7: Strip blurhash from `src/utils/bundle.ts`**

Remove `import { decode as decodeBlurhash } from "blurhash";`, `fetchBlurhash`, and `blurhashToDataUrl`. In `ThumbHeader` and `ThumbResult`, remove the `blurhash` field. Replace `BlurInfo` with:

```ts
/** Per-image display dimensions (orientation-adjusted), for placeholder aspect. */
export type ImageDims = { w: number; h: number };
```

`fetchThumbnail` returns `{ url, width, height }` (no `blurhash`).

- [ ] **Step 8: Delete the blurhash localStorage cache**

Run: `git rm src/utils/blurhashCache.ts`

- [ ] **Step 9: Strip blurhash from `App.tsx`**

Remove: the `loadBlurCache`/`saveBlurCache` import; the `blurDecodeCache` + `decodeBlurCached` module helper; the `blurhashes`/`blurhashesRef` state + mirror effect; the background warm-pass `useEffect`; the `fetchBlurhash`/`blurhashToDataUrl`/`BlurInfo` imports. In `loadThumbnailRaw`, remove the `setBlurhashes(...)` block. Re-introduce a minimal `imageDims: Record<string,{w:number;h:number}>` populated from `fetchThumbnail`'s width/height (used only for `--photo-ar`; deleted entirely in Task 5). Loupe placeholder `src` reverts to `thumbnails[current.path]` with `blur(14px)`.

- [ ] **Step 10: Strip blurhash props from components**

In `GridView.tsx`/`GridCell`, `ThumbCell.tsx`, `ThumbStrip.tsx`, `CompareStrip.tsx`, `CompareView.tsx`/`ComparePanel`: remove the `blur`/`blurhashes` props, `blurhashToDataUrl`/`BlurInfo` imports, the `blurUrl = useMemo(...)` decode, and the `blurUrl ? <img/> :` branch (back to `url ? <img/> : <shimmer/>`). Remove `blurhashes={blurhashes}` from all six App.tsx usages.

- [ ] **Step 11: Verify frontend**

Run: `pnpm exec tsc` → exit 0.
Run: `CI=true pnpm exec vitest run 2>&1 | grep -E "Tests |FAIL"` → all pass.
Dev app: open a folder → loupe shows the image, grid shows shimmer→thumb, no black screen.

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "revert: remove real-BlurHash stack, keep THMB display dims"
```

---

## Task 2: Backend on-disk THMB cache (`thumb_cache.rs`)

**Files:**
- Create: `src-tauri/src/thumb_cache.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod thumb_cache;`, register commands, init managed state)
- Modify: `src-tauri/src/bundle.rs` (`extract_thumbnail` goes through the cache)

- [ ] **Step 1: Write the cache module with failing tests**

Create `src-tauri/src/thumb_cache.rs`. Cache file format `[i64 LE mtime][u32 LE w][u32 LE h][jpeg]` (16-byte header); key = FNV-1a hex of path; mtime stored in the file header (validated at get-time, survives reopen). Implement `ThumbCache` with `new(dir)`, `get(path) -> Option<(Vec<u8>, Option<u32>, Option<u32>)>`, `put(path, jpeg, w, h)`, `clear()`, `size_bytes()`, an LRU `evict_locked` at 500 MB (low-water 90%). Hold internal state in `Mutex<Index>`. Include the four tests below (`put_then_get_roundtrips`, `miss_on_changed_mtime`, `clear_empties_cache`, `survives_reopen`). Cache survives reopen (mtime stored in file, validated at get-time). Full reference implementation: FNV-1a `key_for`, `mtime_of`, `Index{entries,total,tick}`, `Entry{size,used}` (no mtime field — mtime lives in the file), LRU eviction by `used` ascending.

```rust
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
```

- [ ] **Step 2: Run the tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib thumb_cache 2>&1 | grep -E "test result|error"`
Expected: `test result: ok. 4 passed`.

- [ ] **Step 3: Managed state + commands in `lib.rs`**

Add `mod thumb_cache;` and `use tauri::Manager;`. In `run()`, add a `.setup(...)` that resolves the app cache dir and `app.manage(std::sync::Arc::new(ThumbCache::new(dir.join("thumbs"))))`. Add `bundle::clear_thumb_cache,` and `bundle::thumb_cache_size,` to `generate_handler!`.

```rust
.setup(|app| {
    let dir = app.path().app_cache_dir().unwrap_or_else(|_| std::env::temp_dir());
    app.manage(std::sync::Arc::new(thumb_cache::ThumbCache::new(dir.join("thumbs"))));
    Ok(())
})
```

- [ ] **Step 4: Route `extract_thumbnail` through the cache + the two commands (bundle.rs)**

`State<'_, Arc<ThumbCache>>` cannot cross into `spawn_blocking`; clone the `Arc` first.

```rust
use std::sync::Arc;
use tauri::State;
use crate::thumb_cache::ThumbCache;

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
```

- [ ] **Step 5: Verify backend**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib 2>&1 | grep -E "test result|error"` → ok.
Run: `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets 2>&1 | grep -E "warning:|Finished"` → Finished, clean.
Dev app: open a folder, close to home, reopen → thumbnails instant (cache hit). Relaunch app, reopen → still instant.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(backend): 500MB LRU on-disk thumbnail cache behind extract_thumbnail"
```

---

## Task 3: Frontend stage reducer (pure, tested)

**Files:**
- Create: `src/image/stage.ts`
- Create: `src/image/stage.test.ts`

- [ ] **Step 1: Write failing tests** — create `src/image/stage.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { resolveStage, type ImageState } from "./stage";

const base: ImageState = { thumb: undefined, full: undefined };

describe("resolveStage", () => {
  it("nothing -> shimmer", () => expect(resolveStage(base).stage).toBe("shimmer"));
  it("thumb only -> thumb", () => {
    const s = resolveStage({ ...base, thumb: { url: "t", dims: { w: 6, h: 4 } } });
    expect(s.stage).toBe("thumb"); expect(s.url).toBe("t"); expect(s.dims).toEqual({ w: 6, h: 4 });
  });
  it("full wins over thumb regardless of order", () => {
    const s = resolveStage({ thumb: { url: "t", dims: { w: 6, h: 4 } }, full: { status: "ready", url: "f", dims: { w: 6, h: 4 } } });
    expect(s.stage).toBe("full"); expect(s.url).toBe("f");
  });
  it("evicted full -> thumb, not shimmer", () => {
    expect(resolveStage({ thumb: { url: "t", dims: { w: 6, h: 4 } }, full: undefined }).stage).toBe("thumb");
  });
  it("full error with thumb -> thumb", () => {
    const s = resolveStage({ thumb: { url: "t", dims: { w: 6, h: 4 } }, full: { status: "error", error: "boom" } });
    expect(s.stage).toBe("thumb"); expect(s.error).toBe("boom");
  });
  it("full error no thumb -> shimmer + error", () => {
    const s = resolveStage({ thumb: undefined, full: { status: "error", error: "boom" } });
    expect(s.stage).toBe("shimmer"); expect(s.error).toBe("boom");
  });
  it("dims from thumb when full not ready", () => {
    expect(resolveStage({ thumb: { url: "t", dims: { w: 3, h: 2 } }, full: { status: "loading" } }).dims).toEqual({ w: 3, h: 2 });
  });
});
```

- [ ] **Step 2: Run, expect fail** — `CI=true pnpm exec vitest run src/image/stage.test.ts 2>&1 | grep -E "FAIL|Cannot find"` → fails (no `./stage`).

- [ ] **Step 3: Implement `stage.ts`:**

```ts
import type { ImageDims } from "../utils/bundle";

export type FullState =
  | { status: "loading" }
  | { status: "ready"; url: string; dims: ImageDims }
  | { status: "error"; error: string };

export type ImageState = {
  thumb: { url: string; dims: ImageDims } | undefined;
  full: FullState | undefined;
};

export type Stage = "shimmer" | "thumb" | "full";
export type Resolved = { stage: Stage; url: string | undefined; dims: ImageDims | undefined; error: string | undefined };

export function resolveStage(s: ImageState): Resolved {
  const error = s.full?.status === "error" ? s.full.error : undefined;
  if (s.full?.status === "ready") return { stage: "full", url: s.full.url, dims: s.full.dims, error: undefined };
  if (s.thumb) return { stage: "thumb", url: s.thumb.url, dims: s.thumb.dims, error };
  return { stage: "shimmer", url: undefined, dims: undefined, error };
}
```

- [ ] **Step 4: Run, expect pass** — `CI=true pnpm exec vitest run src/image/stage.test.ts 2>&1 | grep -E "Tests |FAIL"` → pass.

- [ ] **Step 5: Commit**

```bash
git add src/image/stage.ts src/image/stage.test.ts
git commit -m "feat(image): pure stage-resolution reducer + tests"
```

---

## Task 4: `imageStore` + `useImage`

**Files:**
- Create: `src/image/imageStore.ts`
- Create: `src/image/useImage.ts`
- Modify: `src/types/settings.ts` (add `backgroundFillConcurrency`: network 2, local 8)

- [ ] **Step 1: Add the new profile knob** — in `src/types/settings.ts`, add `backgroundFillConcurrency: number;` to the perf-profile type and set it in both profiles (network `2`, local `8`), mirroring the existing `bundleConcurrency`/`thumbConcurrency`.

- [ ] **Step 2: Implement `imageStore.ts`** — a class with: `thumbs: Map<path,{url,dims}>` (session cache, 15 000-entry LRU cap), `fulls: Map<path,FullState>` (windowed), per-path `subs`, queues + in-flight counters for full-res / on-demand thumbs / background-fill, and the pump/priority logic. Methods: `setProfile`, `reset(paths)` (revoke full-res only), `hardReset()` (revoke all), `setCursor`, `setGridRange`, `registerWantFull`/`unregisterWantFull`, `requestThumbFor`, `subscribe`, `snapshot`. Reuse `fetchBundle`/`fetchThumbnail`. Prefer the THMB's `dims` (orientation-adjusted) as the authoritative aspect for both thumb and full stages. Reproduce the reference implementation from the spec discussion (the `ImageStore` class with `pump()`, `loadThumb()`, `fillOrder()` cursor-outward, `takeNearest()` for full-res priority, `evictFull()` by `previewKeep`), and export `export const imageStore = new ImageStore();`. Add the 15 000-cap in `loadThumb` after `this.thumbs.set(...)`:

```ts
if (this.thumbs.size > 15000) {
  const oldest = this.thumbs.keys().next().value;
  if (oldest !== undefined && oldest !== path) {
    const v = this.thumbs.get(oldest);
    if (v) URL.revokeObjectURL(v.url);
    this.thumbs.delete(oldest);
    this.requestedThumb.delete(oldest);
    this.invalidate(oldest);
  }
}
```

- [ ] **Step 3: Implement `useImage.ts`:**

```ts
import { useEffect, useSyncExternalStore } from "react";
import { imageStore } from "./imageStore";
import type { Resolved } from "./stage";

export function useImage(path: string, opts: { wantFull: boolean }): Resolved {
  const snap = useSyncExternalStore(
    (cb) => imageStore.subscribe(path, cb),
    () => imageStore.snapshot(path),
  );
  useEffect(() => {
    if (opts.wantFull) {
      imageStore.registerWantFull(path);
      return () => imageStore.unregisterWantFull(path);
    }
    imageStore.requestThumbFor(path);
    return undefined;
  }, [path, opts.wantFull]);
  return snap;
}
```

- [ ] **Step 4: Typecheck** — `pnpm exec tsc` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/image/imageStore.ts src/image/useImage.ts src/types/settings.ts
git commit -m "feat(image): imageStore subscription store + useImage hook + bg-fill profile knob"
```

---

## Task 5: Rewire views to `useImage`; remove old load/evict logic

**Files:** `src/App.tsx` (large deletion + store wiring); `GridView.tsx`, `ThumbCell.tsx`, `ThumbStrip.tsx`, `CompareStrip.tsx`, `CompareView.tsx`.

- [ ] **Step 1: Drive the store from App.tsx** — import `{ imageStore }`. Add effects: `useEffect(() => imageStore.setProfile(profile), [profile])`; on folder open (`beginCulling`, after `setImages`) call `imageStore.reset(imgs.map(i => i.path))`; in `resetSession` call `imageStore.hardReset()`; in the cursor effect call `imageStore.setCursor(compareMode ? challengerIndex : currentIndex)`; where `GridView` reports its viewport, call `imageStore.setGridRange(range)`.

- [ ] **Step 2: Loupe main image via useImage** — call `const cur = useImage(current?.path ?? "", { wantFull: !!current })` UNCONDITIONALLY near the other render-prep consts (BEFORE the `if (phase !== "culling")` early return — rules of hooks). Derive `const photoAr = cur.dims ? \`${cur.dims.w} / ${cur.dims.h}\` : undefined;`. Replace the frame's inner `<img>` with:

```tsx
{cur.stage === "shimmer" ? (
  <div className="cull-photo-frame__shimmer" />
) : (
  <img
    ref={imgRef}
    className="cull-image"
    src={cur.url}
    alt=""
    style={{
      transform: isZooming ? `scale(${zoomZ})` : undefined,
      transformOrigin: `${originX}% ${originY}%`,
      transition: "transform 200ms ease-out, filter 200ms ease-out",
      objectFit: cur.stage === "thumb" ? "cover" : "contain",
      filter: cur.stage === "full" ? undefined : "blur(14px) brightness(0.85)",
    }}
    onLoad={() => { if (cur.stage === "full") setMeasureNonce((n) => n + 1); }}
  />
)}
```

Gate the hi-res zoom layer on `cur.stage === "full"`. Add `.cull-photo-frame__shimmer { position:absolute; inset:10px; }` reusing the existing shimmer animation, in `App.css`.

- [ ] **Step 3: Compare panes via useImage** — `ComparePanel` takes a `path: string` prop (drop `previewUrl`/`thumbUrl`); inside it `const img = useImage(path, { wantFull: true })`; derive `photoAr` from `img.dims`; render shimmer/`<img>` exactly like the loupe (cover for thumb, blur for non-full). `CompareView` passes `path={champion.path}` / `path={challenger.path}`.

- [ ] **Step 4: Grid + strip cells via useImage** — `GridCell`: drop `url`/`loadThumbnail`; `const img = useImage(p.path, { wantFull: false })`; `img.stage === "shimmer" ? <shimmer/> : <img className="cull-grid__img" src={img.url} />` (no blur — THMB is the grid asset). `ThumbCell`: same with `{ wantFull: false }`; shimmer → `cull-thumb__placeholder`, else THMB `<img>`. Remove `url`/`loadThumbnail`/`thumbnails`/`blur` plumbing from `GridView`, `ThumbStrip`, `CompareStrip` and their App.tsx call sites.

- [ ] **Step 5: Delete dead loading code from App.tsx** — remove `previews`/`thumbnails`/`imageDims` state; `loadImageRaw`, `loadThumbnailRaw`, `pumpBundles`, `pumpThumbs`, `scheduleBundles`, `loadThumbnail`, the queue refs + in-flight counters; the two eviction effects and the unmount blob-cleanup effect; now-unused `fetchBundle`/`fetchThumbnail` imports.

- [ ] **Step 6: Verify** — `pnpm exec tsc` → 0; `CI=true pnpm exec vitest run` → pass. Dev app: open folder → grid fills via background fill; loupe shimmer→blurred-THMB→full with correct aspect mid-scrub; compare correctly shaped; scroll grid prioritizes viewport; nav back to evicted full → blurred THMB (not shimmer).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(image): route all views through imageStore.useImage; remove scattered load/evict code"
```

---

## Task 6: Settings — "Clear thumbnail cache" row

**Files:** `src/components/SettingsDialog.tsx`.

- [ ] **Step 1: Add the row** (in the general / file-ops section):

```tsx
const [cacheSize, setCacheSize] = useState<number | null>(null);
useEffect(() => { invoke<number>("thumb_cache_size").then(setCacheSize).catch(() => setCacheSize(null)); }, []);
// row:
<div className="cull-settings__row">
  <div className="cull-settings__row-text">
    <div className="cull-settings__row-name">Thumbnail cache</div>
    <div className="cull-settings__row-help">
      Low-res previews cached on disk for instant re-opens. Lives in the OS cache folder; safe to clear anytime.
      {cacheSize != null && ` Currently ${(cacheSize / 1048576).toFixed(0)} MB.`}
    </div>
  </div>
  <button className="cull-pick-button" onClick={async () => {
    await invoke("clear_thumb_cache");
    setCacheSize(await invoke<number>("thumb_cache_size").catch(() => 0));
  }}>Clear</button>
</div>
```

Ensure `import { invoke } from "@tauri-apps/api/core";` is present.

- [ ] **Step 2: Verify** — `pnpm exec tsc` → 0. Dev app: Settings shows "Currently N MB"; Clear → 0; reopening a folder re-shimmers once then re-caches.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat(settings): thumbnail cache size + clear control"
```

---

## Task 7: Full verification + cleanup

- [ ] **Step 1: Full suite** — `pnpm exec tsc` → 0; `CI=true pnpm exec vitest run` → pass; `cargo test --manifest-path src-tauri/Cargo.toml --lib` → ok; `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets` → clean; `pnpm exec vite build` → built.
- [ ] **Step 2: Remove the now-dead `.cull-photo-clip` CSS rule** and any unused imports tsc flags.
- [ ] **Step 3: Update `ARCHITECTURE.md`** — replace the read-pipeline/eviction sections with the imageStore model (stages, all-session THMB cache, disk cache, background fill, the new profile knob).
- [ ] **Step 4: Live smoke test** (NAS): first open warms; close+reopen instant; relaunch+reopen still instant; zoom/compare/finish unaffected; no black screen; correct aspect at every stage.
- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs+chore: imageStore architecture notes; remove dead clip CSS"
```

---

## Self-Review

**Spec coverage:** §2 stages → Tasks 3+5. §3a disk cache → Task 2. §3b imageStore/useImage → Task 4. §4 stage rules → Task 3 tests + Task 5 render (cover/blur/evict→thumb). §5 priority + bg fill → Task 4. §6 profile knob → Task 4 Step 1. §7 Settings → Task 6. §8 revert → Task 1. §9 edge cases → Task 3 tests + Task 4 (reset/evict/15k-cap) + Task 5 (no-thumb, virtualization). §10 testing → Tasks 2+3. No gaps.

**Placeholder scan:** Task 2 Step 1 and Task 4 Step 2 reference "reproduce the reference implementation from the spec discussion" — the full code blocks ARE included inline (Task 2) or specified field-by-field with the one non-obvious snippet (the 15k cap) shown (Task 4); the `imageStore` body is large but fully determined by the method list + reused `fetchBundle`/`fetchThumbnail` + the stage reducer. The executor implements the pump/queue mechanics from the explicit method contracts. No "TODO/handle errors" placeholders.

**Type consistency:** `ImageDims` ({w,h}) consistent across `bundle.ts`, `stage.ts`, `imageStore.ts`, `useImage`. `Resolved`/`FullState`/`ImageState`/`Stage` names consistent. IPC `ThumbHeader {width,height,jpegLen}` matches `fetchThumbnail` parse. Backend `ThumbCache` methods (`new/get/put/clear/size_bytes`) match the command bodies and the `Arc<ThumbCache>` managed-state signature.
