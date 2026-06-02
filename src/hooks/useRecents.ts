import { useCallback, useEffect, useState } from "react";

/**
 * One entry in the recent-folders list. `lastOpened` is an ISO timestamp so
 * relative time can be derived from it on render (no stale "2 hours ago" after
 * sitting on the home screen for an hour).
 *
 *  - `count` is the total CR3 count returned by `scan_folder` on the last open.
 *  - `rated` is the count of frames we'd already rated when the session ended.
 *    Together with `count` this drives the `327 / 372` or `932 ✓` display.
 *  - `done` is true when the user finished the cull (every frame is rated and
 *    we'd render the count with a green check on the home screen).
 */
export type RecentEntry = {
  path: string;
  count: number;
  rated: number;
  lastOpened: string;
  done: boolean;
};

export const RECENTS_STORAGE_KEY = "cull:recents:v1";
export const RECENTS_CAP = 5;

/**
 * Merge an entry into the recents list — dedupes by `path` (newer entry wins
 * but keeps the larger of the two counts so a freshly-opened folder that's
 * still scanning doesn't drop the previously-known total to zero) and caps
 * the list at {@link RECENTS_CAP}.
 *
 * Pure so it's testable; the hook just delegates here on every push.
 */
export function mergeRecent(list: RecentEntry[], entry: RecentEntry): RecentEntry[] {
  const existing = list.find((r) => r.path === entry.path);
  const merged: RecentEntry = existing
    ? {
        ...entry,
        // If we don't yet know the new count (e.g. a stub push before scan
        // completes), keep the previous one. The done flag and rated count
        // always reflect the latest known state.
        count: entry.count > 0 ? entry.count : existing.count,
      }
    : entry;
  const next = [merged, ...list.filter((r) => r.path !== entry.path)];
  return next.slice(0, RECENTS_CAP);
}

/**
 * localStorage-backed recent-folders list. Front of the list = most recently
 * opened. Capped at {@link RECENTS_CAP}; entries are deduped by `path`.
 *
 * The hook returns the current list plus two mutators:
 *  - `push(entry)` — add or update an entry; cap + dedupe via {@link mergeRecent}.
 *  - `remove(path)` — drop a specific path (used when scan_folder fails so
 *    the home screen never lists a folder we know is broken).
 */
export function useRecents(): {
  recents: RecentEntry[];
  push: (entry: RecentEntry) => void;
  remove: (path: string) => void;
} {
  const [recents, setRecents] = useState<RecentEntry[]>(() => {
    if (typeof localStorage === "undefined") return [];
    try {
      const raw = localStorage.getItem(RECENTS_STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      // Light validation — drop anything that doesn't have the shape we expect.
      return parsed
        .filter(
          (e): e is RecentEntry =>
            !!e &&
            typeof e === "object" &&
            typeof (e as RecentEntry).path === "string" &&
            typeof (e as RecentEntry).lastOpened === "string",
        )
        .slice(0, RECENTS_CAP)
        .map((e) => ({
          path: e.path,
          count: typeof e.count === "number" ? e.count : 0,
          rated: typeof e.rated === "number" ? e.rated : 0,
          lastOpened: e.lastOpened,
          done: !!e.done,
        }));
    } catch {
      return [];
    }
  });

  useEffect(() => {
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

  const remove = useCallback((path: string) => {
    setRecents((list) => list.filter((r) => r.path !== path));
  }, []);

  return { recents, push, remove };
}
