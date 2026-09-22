import { useCallback, useEffect, useRef, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

/** What the home screen's update chip shows. `idle` renders nothing: a failed
 *  or empty check must never nag — the app is fully usable without it. */
export type UpdateState =
  | { status: "idle" }
  | { status: "available"; version: string }
  | { status: "downloading"; version: string; percent: number }
  | { status: "ready"; version: string }
  | { status: "failed"; version: string };

/** Checks GitHub Releases ONCE per launch (only when `enabled` — the release
 *  build; the dev exe and the test harness never talk to the network) and
 *  drives the install. The download runs on the Rust side, so the webview's
 *  CSP is not involved; `relaunch` swaps the running exe for the new one. */
export function useUpdateCheck(enabled: boolean) {
  const [state, setState] = useState<UpdateState>({ status: "idle" });
  const update = useRef<Update | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void (async () => {
      try {
        const found = await check();
        if (!alive || !found) return;
        update.current = found;
        setState({ status: "available", version: found.version });
      } catch {
        // No network, no release yet, or a signature that does not verify:
        // all of them mean "nothing to offer", never an error surface.
      }
    })();
    return () => {
      alive = false;
    };
  }, [enabled]);

  const install = useCallback(async () => {
    const found = update.current;
    if (!found) return;
    const { version } = found;
    setState({ status: "downloading", version, percent: 0 });
    let total = 0;
    let got = 0;
    try {
      await found.downloadAndInstall((ev) => {
        if (ev.event === "Started") total = ev.data.contentLength ?? 0;
        else if (ev.event === "Progress") {
          got += ev.data.chunkLength;
          const percent = total > 0 ? Math.min(100, Math.round((got / total) * 100)) : 0;
          setState({ status: "downloading", version, percent });
        } else setState({ status: "ready", version });
      });
      setState({ status: "ready", version });
      await relaunch();
    } catch {
      setState({ status: "failed", version });
    }
  }, []);

  return { state, install };
}
