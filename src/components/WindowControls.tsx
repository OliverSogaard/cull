import { Minus, Square, X as XIcon } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * Custom min / maximize / close buttons for the borderless window. Close
 * routes through Tauri's normal close-request handler so the quit guard still
 * gets a chance to protect unsaved work. Each button blurs itself on click so
 * the focus ring doesn't linger after pointer interaction.
 */
export function WindowControls() {
  const win = getCurrentWindow();
  return (
    <div className="cull-wincontrols">
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
        className="cull-winbtn"
        title="maximize / restore"
        aria-label="maximize"
        onClick={(e) => {
          e.currentTarget.blur();
          win.toggleMaximize();
        }}
      >
        <Square size={10} strokeWidth={2.5} />
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
