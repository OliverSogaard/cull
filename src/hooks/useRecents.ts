import { useCallback, useEffect, useRef, useState } from "react";

/**
 * One entry in the recent list. Since v2 an entry is a SESSION — the full set
 * of folders that were staged together — not a single folder. `lastOpened` is
 * an ISO timestamp so relative time can be derived from it on render (no stale
 * "2 hours ago" after sitting on the home screen for an hour).
 *
 *  - `paths` are the session's folders in the order they were opened (display
 *    order). Identity is the unordered set — see {@link recentKey}.
 *  - `count` is the combined staged CR3 count across all folders.
 *  - `rated` is the count of frames we'd already rated when the session ended.
 *    Together with `count` this drives the `327 / 372` or `932 ✓` display.
 *  - `done` is true when the user finished the cull (every frame is rated and
 *    we'd render the count with a green check on the home screen).
 */
export type RecentEntry = {
  paths: string[];
  count: number;
  rated: number;
  lastOpened: string;
  done: boolean;
};

const RECENTS_STORAGE_KEY = "cull:recents:v2";
/** Pre-multi-folder key — single `path` per entry. Read once for migration. */
const RECENTS_V1_KEY = "cull:recents:v1";
export const RECENTS_CAP = 5;

/**
 * Identity of an entry: the unordered set of its folders. `[A,B]` and `[B,A]`
 * are the same session; `[A]` and `[A,B]` are distinct. NUL can't occur in a
 * real path (POSIX and Windows both forbid it), so it's a collision-proof
 * separator — a comma-joined key would make ["a,b"] collide with ["a","b"].
 */
export function recentKey(paths: string[]): string {
  return [...paths].sort().join("\0");
}

/**
 * Merge an entry into the recents list — dedupes by folder set (the newer
 * entry fully replaces the old one, so a re-scanned now-empty session
 * correctly drops to a `0` count instead of advertising a stale total) and
 * caps the list at {@link RECENTS_CAP}.
 *
 * Pure so it's testable; the hook just delegates here on every push.
 */
export function mergeRecent(list: RecentEntry[], entry: RecentEntry): RecentEntry[] {
  const key = recentKey(entry.paths);
  const next = [entry, ...list.filter((r) => recentKey(r.paths) !== key)];
  return next.slice(0, RECENTS_CAP);
}

/** A v1 entry's `path` wrapped into `paths` so the v2 validator accepts it. */
function migrateV1(parsed: unknown): unknown[] {
  if (!Array.isArray(parsed)) return [];
  return parsed.map((e) =>
    !!e && typeof e === "object" && typeof (e as { path?: unknown }).path === "string"
      ? { ...(e as object), paths: [(e as { path: string }).path] }
      : null,
  );
}

/**
 * Parse + validate the stored recents list. Prefers v2; falls back to v1
 * (wrapping each `path` into a one-element `paths`). Pure — the hook passes in
 * the raw localStorage strings — so the migration and the clamping are
 * testable without a DOM.
 *
 * Drops anything that doesn't have the v2 shape, dedupes paths within an
 * entry, and clamps to the invariants the renderer assumes (0 ≤ rated ≤ count,
 * done only when fully rated) so corrupt / hand-edited storage can't produce
 * impossible rows like "500 / 100".
 */
export function parseStoredRecents(rawV2: string | null, rawV1: string | null): RecentEntry[] {
  let candidates: unknown[] = [];
  if (rawV2 != null) {
    try {
      const parsed = JSON.parse(rawV2) as unknown;
      if (Array.isArray(parsed)) candidates = parsed;
    } catch {
      // Corrupt v2 — start empty rather than resurrecting stale v1 entries.
    }
  } else if (rawV1 != null) {
    try {
      candidates = migrateV1(JSON.parse(rawV1) as unknown);
    } catch {
      // Corrupt v1 — nothing to migrate.
    }
  }
  return candidates
    .filter(
      (e): e is { paths: string[] } & Record<string, unknown> =>
        !!e &&
        typeof e === "object" &&
        Array.isArray((e as { paths?: unknown }).paths) &&
        (e as { paths: unknown[] }).paths.length > 0 &&
        (e as { paths: unknown[] }).paths.every((p) => typeof p === "string" && p.length > 0) &&
        typeof (e as { lastOpened?: unknown }).lastOpened === "string",
    )
    .slice(0, RECENTS_CAP)
    .map((e) => {
      const paths = [...new Set(e.paths)];
      const count = Math.max(0, typeof e.count === "number" ? e.count : 0);
      const rated = Math.min(Math.max(0, typeof e.rated === "number" ? e.rated : 0), count);
      return {
        paths,
        count,
        rated,
        lastOpened: e.lastOpened as string,
        done: !!e.done && count > 0 && rated === count,
      };
    });
}

/**
 * localStorage-backed recent-sessions list. Front of the list = most recently
 * opened. Capped at {@link RECENTS_CAP}; entries are deduped by folder set.
 *
 * The hook returns the current list plus two mutators:
 *  - `push(entry)` — add or update an entry; cap + dedupe via {@link mergeRecent}.
 *  - `removeEntry(key)` — drop the entry whose {@link recentKey} matches (used
 *    when scan_folder says a folder is gone, and to replace a session's stale
 *    entry when its folder set grows).
 */
export function useRecents(): {
  recents: RecentEntry[];
  push: (entry: RecentEntry) => void;
  removeEntry: (key: string) => void;
} {
  const [recents, setRecents] = useState<RecentEntry[]>(() => {
    if (typeof localStorage === "undefined") return [];
    const rawV2 = localStorage.getItem(RECENTS_STORAGE_KEY);
    const rawV1 = localStorage.getItem(RECENTS_V1_KEY);
    const parsed = parseStoredRecents(rawV2, rawV1);
    // Persist a v1 migration immediately — the skip-first-write effect below
    // would otherwise never write it (the list only persists when it changes).
    // The v1 key stays on disk, harmless, in case an old build runs again.
    if (rawV2 == null && rawV1 != null) {
      try {
        localStorage.setItem(RECENTS_STORAGE_KEY, JSON.stringify(parsed));
      } catch {
        // Quota / private mode — migration just re-runs next launch.
      }
    }
    return parsed;
  });

  // Skip the mount pass: the initializer already loaded this exact value, so
  // writing it straight back is a wasted serialize + storage write on every
  // cold start. Persist only once the list actually changes.
  const firstWrite = useRef(true);
  useEffect(() => {
    if (firstWrite.current) {
      firstWrite.current = false;
      return;
    }
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(RECENTS_STORAGE_KEY, JSON.stringify(recents));
    } catch {
      // Quota / private mode — live in memory; nothing else to do.
    }
  }, [recents]);

  const push = useCallback((entry: RecentEntry) => {
    setRecents((list) => mergeRecent(list, entry));
  }, []);

  const removeEntry = useCallback((key: string) => {
    setRecents((list) => list.filter((r) => recentKey(r.paths) !== key));
  }, []);

  return { recents, push, removeEntry };
}
