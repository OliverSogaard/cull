/**
 * Pure path helpers — no Node/Tauri dependencies, so they run anywhere
 * (including the Vitest sandbox).
 */

/**
 * Last path segment. Splits on both `\` and `/` so paths display correctly on
 * Windows (where Tauri returns backslashes) and on Unix (forward slashes).
 *
 * @example basename("C:\\Users\\Olive\\photo.cr3") === "photo.cr3"
 * @example basename("/home/o/photo.cr3")          === "photo.cr3"
 */
export function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/**
 * Drop the last `.ext` from a filename. Multi-part extensions
 * (`photo.cr3.xmp`) drop only the trailing one.
 *
 * @example stripExt("photo.cr3") === "photo"
 */
export function stripExt(filename: string): string {
  return filename.replace(/\.[^.]+$/, "");
}

/**
 * Join a root path to a subfolder segment, picking the separator from the root
 * (backslash on Windows, forward slash on POSIX). Trailing separators on the
 * root are trimmed so the result never has a doubled-up "C:\\foo\\\\bar".
 *
 * @example joinPath("C:\\Exports", "Reception-keeps") === "C:\\Exports\\Reception-keeps"
 * @example joinPath("/home/u/exports", "shoot")      === "/home/u/exports/shoot"
 */
export function joinPath(root: string, sub: string): string {
  const sep = root.includes("\\") ? "\\" : "/";
  const trimmed = root.replace(/[\\/]+$/, "");
  return `${trimmed}${sep}${sub}`;
}

/**
 * Strip characters that Windows (and most other filesystems) refuse in
 * filenames / folder names, cap at 32 chars so a runaway paste can't produce an
 * unwieldy path, and drop trailing dots/spaces + leading spaces (Windows
 * silently coerces those away on create — which would de-sync the on-disk folder
 * name from the string we also pass to the scan-ignore filter, re-importing the
 * moved rejects on reopen). Used by the rejected-subfolder input in Settings and
 * the editable Pinned-root subfolder in the finish dialog.
 *
 * The illegal set comes from Windows: < > : " / \\ | ? *. Does NOT itself reject
 * the reserved device names (CON/NUL/…) — doing that per keystroke would wipe a
 * legitimate name the moment it passed through "CON"; see {@link isReservedFolderName},
 * applied at commit time instead.
 */
export function sanitizeFolderName(raw: string): string {
  return raw
    .replace(/[<>:"/\\|?*]/g, "")
    .slice(0, 32)
    .replace(/^ +/, "")
    .replace(/[. ]+$/, "");
}

/**
 * True if `name`'s base (the part before the first dot) is a Windows reserved
 * device name — a folder so named can't be created on Windows, so the whole
 * move/copy would fail. Checked at commit time so call sites can fall back to a
 * safe default. Case-insensitive; "CON.foo" is reserved too, hence the pre-dot base.
 */
export function isReservedFolderName(name: string): boolean {
  const base = name.split(".")[0].trim().toUpperCase();
  return /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(base);
}

/**
 * Truncate a path for DISPLAY from the LEFT, keeping the tail — the end of a
 * path is the part that identifies it ("…/Downloads/exports/"), and a leading
 * cut can never eat the trailing separator the way a CSS clip does. Prefers
 * starting at a separator inside the kept tail so the result reads as whole
 * segments; falls back to a raw tail when none is in range. Callers keep the
 * full path in a tooltip.
 */
export function truncatePathDisplay(path: string, max: number): string {
  if (path.length <= max) return path;
  const tail = path.slice(-(max - 1));
  const sep = tail.search(/[\\/]/);
  // A separator strictly inside the tail (not its last char) gives a clean
  // segment boundary; otherwise show the raw tail.
  return "…" + (sep >= 0 && sep < tail.length - 1 ? tail.slice(sep) : tail);
}
