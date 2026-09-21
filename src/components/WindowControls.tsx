import { useEffect, useState } from "react";
import { Copy, Minus, Settings as SettingsIcon, Square, X as XIcon } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isMac } from "../utils/platform";
import { ICON } from "./icons";

/**
 * Top-right chrome buttons for the borderless window. Order is
 * settings cog · minimize · maximize/restore · close. On macOS the native
 * traffic lights own minimize/zoom/close, so only the settings gear renders.
 * The close button routes through Tauri's normal close-request handler so the
 * quit guard still gets a chance to protect unsaved work. Each button blurs
 * itself on click so the focus ring doesn't linger after pointer interaction.
 *
 * The icon SIZES here are off the shared scale on purpose — they follow the
 * Windows caption-button metric so the title bar matches every other window
 * on the desktop (see icons.ts). Their stroke is the scale's lightest, so they
 * still weigh the same as the icons in the app below them.
 */
export function WindowControls({ onSettings }: { onSettings?: () => void }) {
  // Maximized-state for the middle button's icon/title (□ maximize vs ❐
  // restore). Resize is the only signal needed: maximize/restore — by button,
  // double-click on the drag region, Win+arrow or a snap — always resizes.
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (isMac) return undefined;
    let w: ReturnType<typeof getCurrentWindow>;
    try {
      w = getCurrentWindow();
    } catch {
      return undefined; // window API unavailable (plain-browser dev / jsdom) — keep the default
    }
    let unlisten: (() => void) | undefined;
    let dead = false;
    const sync = async () => {
      try {
        const m = await w.isMaximized();
        if (!dead) setMaximized(m);
      } catch {
        // window API unavailable (plain-browser dev) — keep the default
      }
    };
    void sync();
    void w
      .onResized(() => void sync())
      .then((u) => {
        if (dead) u();
        else unlisten = u;
      });
    return () => {
      dead = true;
      unlisten?.();
    };
  }, []);
  return (
    <div className="cull-wincontrols">
      {onSettings && (
        <button
          className="cull-winbtn"
          title={`Settings  (${isMac ? "Cmd" : "Ctrl"} + , )`}
          aria-label="Settings"
          // NOTE: deliberately NOT blurring here (unlike minimize/close). The
          // settings dialog's focus trap restores focus to whatever was focused
          // when it opened; blurring first would lose the gear as that target
          // (focus would fall to <body>), so closing wouldn't return focus here.
          onClick={onSettings}
        >
          <SettingsIcon size={13} strokeWidth={ICON.lg.strokeWidth} aria-hidden />
        </button>
      )}
      {!isMac && (
        <>
          <button
            className="cull-winbtn"
            title="Minimize"
            aria-label="Minimize"
            onClick={(e) => {
              e.currentTarget.blur();
              void getCurrentWindow().minimize();
            }}
          >
            <Minus size={13} strokeWidth={ICON.lg.strokeWidth} aria-hidden />
          </button>
          <button
            className="cull-winbtn"
            title={maximized ? "Restore" : "Maximize"}
            aria-label={maximized ? "Restore window" : "Maximize window"}
            onClick={(e) => {
              e.currentTarget.blur();
              void getCurrentWindow().toggleMaximize();
            }}
          >
            {maximized ? (
              // Two offset squares — the Windows "restore down" glyph.
              <Copy size={11} strokeWidth={ICON.lg.strokeWidth} aria-hidden />
            ) : (
              <Square size={11} strokeWidth={ICON.lg.strokeWidth} aria-hidden />
            )}
          </button>
          <button
            className="cull-winbtn cull-winbtn--close"
            title="Close"
            aria-label="Close"
            onClick={(e) => {
              e.currentTarget.blur();
              void getCurrentWindow().close();
            }}
          >
            <XIcon size={14} strokeWidth={ICON.lg.strokeWidth} aria-hidden />
          </button>
        </>
      )}
    </div>
  );
}
