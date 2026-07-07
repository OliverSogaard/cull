import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import { isMac } from "./utils/platform";

// Let CSS branch per platform (e.g. traffic-light padding on macOS).
document.documentElement.dataset.platform = isMac ? "mac" : "win";

// macOS native fullscreen hides the traffic lights — track it on the root so
// CSS can drop the 84px left padding that reserves their space (otherwise a
// dead gap sits beside the brand block in fullscreen). Resize is the only
// signal needed: entering/leaving fullscreen always resizes the window.
if (isMac) {
  const win = getCurrentWindow();
  const syncFullscreen = async () => {
    try {
      if (await win.isFullscreen()) {
        document.documentElement.dataset.fullscreen = "1";
      } else {
        delete document.documentElement.dataset.fullscreen;
      }
    } catch {
      // window API unavailable (plain-browser dev) — leave the default
    }
  };
  void syncFullscreen();
  void win.onResized(() => void syncFullscreen());
}

// Crash net: an uncaught error unmounts the whole React tree (a dead gray
// window with zero explanation). Surface the error IN the window and persist
// it to localStorage["cull:lastError"] so it can be reported after a reload.
const reportFatal = (msg: string) => {
  try {
    localStorage.setItem("cull:lastError", `${new Date().toISOString()}\n${msg}`);
  } catch {
    // storage unavailable: the on-screen report below still shows
  }
  if (!document.getElementById("cull-fatal")) {
    const pre = document.createElement("pre");
    pre.id = "cull-fatal";
    pre.style.cssText =
      "position:fixed;inset:24px;z-index:99999;overflow:auto;padding:16px;" +
      "background:#16161a;color:#c87f7f;border:1px solid #28282e;border-radius:4px;" +
      "font:11px ui-monospace,monospace;white-space:pre-wrap";
    document.body.appendChild(pre);
  }
  const el = document.getElementById("cull-fatal")!;
  el.textContent = `CULL hit an unexpected error. Restart the app.\n\n${msg}\n\n(saved to localStorage["cull:lastError"])`;
};
window.addEventListener("error", (e) => {
  const err: unknown = e.error;
  const stack = err instanceof Error ? err.stack : undefined;
  reportFatal(`${e.message}\n${stack ?? `${e.filename}:${e.lineno}`}`);
});
window.addEventListener("unhandledrejection", (e) => {
  const r: unknown = e.reason;
  reportFatal(r instanceof Error ? `${r.message}\n${r.stack ?? ""}` : String(r));
});

// No StrictMode: this app's effects fire native CR3 reads over IPC and create
// (and revoke) blob URLs. StrictMode's dev-only double-invoke would double those
// side effects, muddying latency logs. Keep dev behavior == prod behavior.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
