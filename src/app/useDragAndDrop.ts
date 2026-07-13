import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Phase } from "../types";

/**
 * Drag-and-drop: drop folders anywhere to open them — verbatim from App
 * (grand cleanup Phase 6). Hover the window with folders → render the
 * champagne dashed overlay on the home screen (the home content dims behind
 * it). Drop → every dropped folder is scanned and staged together. Drops are
 * ignored while the cull view is active (replacing the staged set mid-cull
 * would lose state). openFoldersByPaths is captured fresh each render; we
 * mirror it into a ref so the once-registered drag-drop listener uses the
 * latest closure without unsubscribing and re-subscribing on every render
 * (which would race with active drag events).
 */
export function useDragAndDrop({
  phase,
  openFoldersByPaths,
}: {
  phase: Phase;
  openFoldersByPaths: (picked: string[], opts?: { fromRecentKey?: string }) => Promise<void>;
}) {
  const [isDragOver, setIsDragOver] = useState(false);
  const phaseRef = useRef(phase);
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);
  const openFoldersByPathsRef = useRef(openFoldersByPaths);
  useEffect(() => {
    openFoldersByPathsRef.current = openFoldersByPaths;
  }, [openFoldersByPaths]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void getCurrentWindow()
      .onDragDropEvent((event) => {
        const p = event.payload;
        // Only react when the user is on a chrome screen (start/loading/etc).
        // During an active cull we ignore drop events outright so a stray drop
        // can't kill the in-progress session.
        // Ignore drops while a cull is active OR a scan/analyze is in flight —
        // appending then would race the in-flight staging / begin-culling.
        if (
          phaseRef.current === "culling" ||
          phaseRef.current === "loading" ||
          phaseRef.current === "analyzing"
        ) {
          if (p.type === "enter" || p.type === "over") setIsDragOver(false);
          return;
        }
        if (p.type === "enter" || p.type === "over") {
          setIsDragOver(true);
        } else if (p.type === "leave") {
          setIsDragOver(false);
        } else if (p.type === "drop") {
          setIsDragOver(false);
          const dropped = (p.paths ?? []).filter(
            (path): path is string => typeof path === "string" && path.length > 0,
          );
          if (dropped.length > 0) {
            // Best-effort: stage every dropped folder in one batch; if a path
            // is a file (not a folder), Rust's scan_folder will error and we'll
            // surface that as a scan error via the regular failure path.
            void openFoldersByPathsRef.current(dropped);
          }
        }
      })
      .then((u) => {
        unlisten = u;
      });
    return () => unlisten?.();
  }, []);

  return { isDragOver };
}
