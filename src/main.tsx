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

// No StrictMode: this app's effects fire native CR3 reads over IPC and create
// (and revoke) blob URLs. StrictMode's dev-only double-invoke would double those
// side effects, muddying latency logs. Keep dev behavior == prod behavior.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
