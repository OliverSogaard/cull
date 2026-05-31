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
