import { useCallback, useEffect, useState } from "react";
import { DEFAULT_SETTINGS, SETTINGS_STORAGE_KEY, type Settings } from "../types/settings";

/**
 * localStorage-backed settings store. Reads once on mount and writes through
 * on every change. Failures (private mode, quota) fall back silently to the
 * in-memory state — the cull still works, the choice just won't persist.
 *
 * The hook intentionally returns the full `Settings` shape rather than a tuple
 * of `(field, setField)` per setting, so the menu can render every field
 * generically and we don't grow N hooks as settings grow.
 */
export function useSettings(): [Settings, (next: Settings) => void] {
  const [settings, setSettings] = useState<Settings>(() => {
    if (typeof localStorage === "undefined") return DEFAULT_SETTINGS;
    try {
      const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
      if (!raw) return DEFAULT_SETTINGS;
      const parsed = JSON.parse(raw) as Partial<Settings>;
      // Shallow-merge against defaults so a missing field from an older app
      // version (or hand-edited storage) is filled in, not crashing us.
      return { ...DEFAULT_SETTINGS, ...parsed };
    } catch {
      return DEFAULT_SETTINGS;
    }
  });

  useEffect(() => {
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
