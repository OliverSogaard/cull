/** True when running on macOS (WKWebView UA contains "Mac"). */
export const isMac: boolean =
  typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent);

/** Modifier glyph for compact kbd labels: ⌘ on macOS, ⌃ elsewhere. */
export const modGlyph = isMac ? "⌘" : "⌃";

/** Modifier word for prose labels: "cmd" / "ctrl". */
export const modName = isMac ? "cmd" : "ctrl";
