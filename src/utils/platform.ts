/** True when running on macOS (WKWebView UA contains "Mac"). */
export const isMac: boolean = typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent);

/** Modifier label for keycaps: ⌘ on macOS, spelled "Ctrl" elsewhere. */
export const modLabel = isMac ? "⌘" : "Ctrl";

/** Modifier word for prose labels: "cmd" / "ctrl". */
export const modName = isMac ? "cmd" : "ctrl";

/** Modifier + key for plain-text contexts: "⌘E" on macOS, "Ctrl+E" elsewhere. */
export function modCombo(key: string): string {
  return isMac ? `${modLabel}${key}` : `${modLabel}+${key}`;
}
