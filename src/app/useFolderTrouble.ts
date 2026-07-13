import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Img, ScanResult } from "../types";
import { runFolderRetry, type TroubleState } from "../image/folderRetry";
import { imageStore } from "../image/imageStore";
import { normalizeRejectedSubfolder } from "../types/settings";

/**
 * Folder-trouble chip state + retry flow, verbatim from App (grand cleanup
 * Phase 6). Latched by the store when several paths reach terminal
 * read-failure (NAS unmounted / sleep-wake): shows the non-blocking "folder
 * unreachable" chip. Full retry-flow state (checking / still / recovered)
 * lives in folderRetry.ts.
 */
export function useFolderTrouble({
  images,
  imagesRef,
  rejectedSubfolder,
}: {
  images: Img[];
  imagesRef: RefObject<Img[]>;
  rejectedSubfolder: string;
}) {
  const [folderTrouble, setFolderTrouble] = useState<TroubleState>("hidden");

  // Folder-trouble chip: the store latches once when several paths go
  // terminal; any new path-set (re-open / append → reset) clears it.
  useEffect(() => {
    // Mid-probe ("checking"/"still") the retry flow owns the chip — the sink
    // re-latches from anywhere else, including over a brief "reconnected".
    imageStore.setTroubleSink(() =>
      setFolderTrouble((s) => (s === "checking" || s === "still" ? s : "latched")),
    );
    return () => imageStore.setTroubleSink(undefined);
  }, []);
  useEffect(() => {
    setFolderTrouble("hidden");
  }, [images]);

  // Folder-trouble retry: re-run the scan as a reachability probe on every
  // source folder, then re-arm the store's queues IN PLACE — same session,
  // same cursor, no phase change — so a NAS reconnect self-heals without
  // restarting the app. Still unreachable → the chip re-latches.
  const folderRetryRunning = useRef(false);
  const retryUnreachableFolders = useCallback(async () => {
    // The chip disables itself while checking, but a double-click can land
    // before the "checking" render — hard-guard reentry.
    if (folderRetryRunning.current) return;
    folderRetryRunning.current = true;
    const seen = new Set<string>();
    const folders: string[] = [];
    for (const im of imagesRef.current) {
      if (!seen.has(im.srcFolder)) {
        seen.add(im.srcFolder);
        folders.push(im.srcFolder);
      }
    }
    try {
      await runFolderRetry({
        folders,
        probe: (f) =>
          invoke<ScanResult>("scan_folder", {
            path: f,
            ignoreSubdir: normalizeRejectedSubfolder(rejectedSubfolder),
          }),
        setState: setFolderTrouble,
        rearm: () => imageStore.rearm(),
      });
    } finally {
      folderRetryRunning.current = false;
    }
  }, [rejectedSubfolder, imagesRef]);

  return { folderTrouble, retryUnreachableFolders };
}
