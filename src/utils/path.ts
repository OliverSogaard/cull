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
 * filenames / folder names, and cap at 32 chars so a runaway paste can't
 * produce an unwieldy path. Used by the rejected-subfolder input in Settings
 * and the editable Pinned-root subfolder in the finish dialog.
 *
 * The illegal set comes from Windows: < > : " / \\ | ? *.
 */
export function sanitizeFolderName(raw: string): string {
  return raw.replace(/[<>:"/\\|?*]/g, "").slice(0, 32);
}
