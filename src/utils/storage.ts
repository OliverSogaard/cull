/**
 * localStorage write that never throws. Quota errors and private-mode
 * refusals are a warning, not a failure of whatever the caller was doing —
 * the `cull:lastDir` write used to sit inside the scan's try/catch, so a full
 * storage was reported as "couldn't open folder" and the folder never staged.
 */
export function writeLocalStorage(key: string, value: string): boolean {
  try {
    if (typeof localStorage === "undefined") return false;
    localStorage.setItem(key, value);
    return true;
  } catch (e) {
    console.warn(`[cull] localStorage write failed for ${key}`, e);
    return false;
  }
}
