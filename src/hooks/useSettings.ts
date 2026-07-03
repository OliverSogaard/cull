import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_SETTINGS,
  normalizeRejectedSubfolder,
  SETTINGS_STORAGE_KEY,
  type ExportFolderMode,
  type Settings,
  type StorageMode,
  type ThumbsPosition,
} from "../types/settings";
import type { Filter } from "../types/rating";
import { sanitizeFolderName } from "../utils/path";

const FILTERS: readonly Filter[] = ["all", "unrated", "keeps", "favorites"];

/**
 * Validate a parsed-from-storage blob into a known-good Settings, per field. The
 * stored JSON is untrusted (hand-edited, older/newer schema, corrupt): a present
 * but wrong-typed field must NOT win over its default, or it leaks garbage
 * downstream — e.g. a bad `storageMode` makes `PERFORMANCE_PROFILES[mode]`
 * undefined and crashes the image store at mount. Each field falls back to its
 * default unless it passes a guard; `exportFolder` (the one nested field) gets a
 * dedicated shape check.
 */
export function coerceSettings(raw: unknown): Settings {
  const d = DEFAULT_SETTINGS;
  if (typeof raw !== "object" || raw === null) return d;
  const p = raw as Record<string, unknown>;
  const bool = (v: unknown, fb: boolean) => (typeof v === "boolean" ? v : fb);

  let exportFolder: ExportFolderMode = d.exportFolder;
  if (typeof p.exportFolder === "object" && p.exportFolder !== null) {
    const ef = p.exportFolder as Record<string, unknown>;
    if (ef.mode === "remember") exportFolder = { mode: "remember" };
    else if (ef.mode === "pinned" && typeof ef.path === "string")
      exportFolder = { mode: "pinned", path: ef.path };
    // any other shape (partial pinned w/o a string path, unknown mode) → default
  }

  return {
    storageMode:
      p.storageMode === "local" || p.storageMode === "network"
        ? (p.storageMode as StorageMode)
        : d.storageMode,
    defaultFilter: FILTERS.includes(p.defaultFilter as Filter)
      ? (p.defaultFilter as Filter)
      : d.defaultFilter,
    defaultThumbsVisible: bool(p.defaultThumbsVisible, d.defaultThumbsVisible),
    defaultExifVisible: bool(p.defaultExifVisible, d.defaultExifVisible),
    defaultClippingVisible: bool(p.defaultClippingVisible, d.defaultClippingVisible),
    defaultPeakingVisible: bool(p.defaultPeakingVisible, d.defaultPeakingVisible),
    defaultCompositionVisible: bool(p.defaultCompositionVisible, d.defaultCompositionVisible),
    thumbsPosition:
      p.thumbsPosition === "bottom" || p.thumbsPosition === "top"
        ? (p.thumbsPosition as ThumbsPosition)
        : d.thumbsPosition,
    rejectedSubfolder:
      typeof p.rejectedSubfolder === "string"
        ? normalizeRejectedSubfolder(sanitizeFolderName(p.rejectedSubfolder))
        : d.rejectedSubfolder,
    exportFolder,
    openLastFolderOnLaunch: bool(p.openLastFolderOnLaunch, d.openLastFolderOnLaunch),
    smartCulling: bool(p.smartCulling, d.smartCulling),
    smartCullingConfidence:
      p.smartCullingConfidence === "low" ||
      p.smartCullingConfidence === "medium" ||
      p.smartCullingConfidence === "high"
        ? p.smartCullingConfidence
        : d.smartCullingConfidence,
    smartCullingOnOpen: bool(p.smartCullingOnOpen, d.smartCullingOnOpen),
  };
}

/**
 * localStorage-backed settings store. Reads + validates once on mount and writes
 * through on every change. Failures (private mode, quota) fall back silently to
 * the in-memory state — the cull still works, the choice just won't persist.
 *
 * Returns the full `Settings` shape (not per-field tuples) so the menu renders
 * every field generically and we don't grow N hooks as settings grow.
 */
export function useSettings(): [Settings, (next: Settings) => void] {
  const [settings, setSettings] = useState<Settings>(() => {
    if (typeof localStorage === "undefined") return DEFAULT_SETTINGS;
    try {
      const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
      if (!raw) return DEFAULT_SETTINGS;
      return coerceSettings(JSON.parse(raw));
    } catch {
      return DEFAULT_SETTINGS;
    }
  });

  // Skip the mount pass: the initializer already loaded this value, so writing
  // it straight back is a wasted serialize + storage write on every cold start.
  const firstWrite = useRef(true);
  useEffect(() => {
    if (firstWrite.current) {
      firstWrite.current = false;
      return;
    }
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // Quota / private mode — already living in memory, so no further action.
    }
  }, [settings]);

  const update = useCallback((next: Settings) => setSettings(next), []);

  return [settings, update];
}
