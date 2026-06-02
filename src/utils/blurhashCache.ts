import type { BlurInfo } from "./bundle";

/**
 * Persistent cache of per-image BlurHash placeholders, in localStorage, keyed by
 * folder. CR3 files are immutable (the app never rewrites them), so a path-keyed
 * cache never goes stale — re-opening a folder repopulates the grid / strip /
 * loupe placeholders instantly, with no NAS reads. Best-effort: any
 * parse/quota/availability failure degrades to "no cache" (the warm pass just
 * recomputes).
 */

const KEY = "cull:blurhashes:v1";
/** Keep the most-recent N folders; older ones are evicted. ~260KB per 5k-image
 * folder, so this fits comfortably under the ~5MB localStorage budget. */
const MAX_FOLDERS = 12;

type FolderCache = { folder: string; hashes: Record<string, BlurInfo> };

function read(): FolderCache[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function write(store: FolderCache[]): void {
  if (typeof localStorage === "undefined") return;
  const capped = store.slice(0, MAX_FOLDERS);
  try {
    localStorage.setItem(KEY, JSON.stringify(capped));
  } catch {
    // Quota exceeded — drop the oldest half and retry once, then give up.
    try {
      localStorage.setItem(KEY, JSON.stringify(capped.slice(0, Math.max(1, capped.length >> 1))));
    } catch {
      /* best-effort */
    }
  }
}

/** Cached blurhashes for a previously-opened folder (empty if none). */
export function loadBlurCache(folder: string): Record<string, BlurInfo> {
  return read().find((f) => f.folder === folder)?.hashes ?? {};
}

/** Persist a folder's blurhashes, moving it to the front (most-recently-used). */
export function saveBlurCache(folder: string, hashes: Record<string, BlurInfo>): void {
  if (Object.keys(hashes).length === 0) return;
  const store = read().filter((f) => f.folder !== folder);
  store.unshift({ folder, hashes });
  write(store);
}
