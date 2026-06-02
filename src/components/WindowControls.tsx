import { Minus, Settings as SettingsIcon, X as XIcon } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * Top-right chrome buttons for the borderless window. Order matches the
 * mockup: settings cog · minimize · close. The close button routes through
 * Tauri's normal close-request handler so the quit guard still gets a chance
 * to protect unsaved work. Each button blurs itself on click so the focus
 * ring doesn't linger after pointer interaction.
 */
export function WindowControls({ onSettings }: { onSettings?: () => void }) {
  const win = getCurrentWindow();
  return (
    <div className="cull-wincontrols">
      {onSettings && (
        <button
          className="cull-winbtn"
          title="settings  (Ctrl + , )"
          aria-label="settings"
          onClick={(e) => {
            e.currentTarget.blur();
            onSettings();
          }}
        >
          <SettingsIcon size={13} strokeWidth={2} />
        </button>
      )}
      <button
        className="cull-winbtn"
        title="minimize"
        aria-label="minimize"
        onClick={(e) => {
          e.currentTarget.blur();
          win.minimize();
        }}
      >
        <Minus size={13} strokeWidth={2.5} />
      </button>
      <button
        className="cull-winbtn cull-winbtn--close"
        title="close"
        aria-label="close"
        onClick={(e) => {
          e.currentTarget.blur();
          win.close();
        }}
      >
        <XIcon size={14} strokeWidth={2.5} />
      </button>
    </div>
  );
}
