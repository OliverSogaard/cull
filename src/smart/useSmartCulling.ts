import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { imageStore } from "../image/imageStore";
import {
  LOCAL_CHUNK,
  LOCAL_IDLE_MS,
  NET_CHUNK,
  NET_IDLE_MS,
  runAnalysis,
} from "./analysisDriver";
import type { ImageScore } from "../types/ipc";
import type { Img } from "../types/image";
import type { StorageMode } from "../types/settings";

/** Head start for the first screenful of thumbs before the pass begins. */
const FIRST_SCREENFUL_DELAY_MS = 1200;

/**
 * The smart-culling driver hook: owns the chunked, gen-guarded, backpressure-
 * aware pass (`runAnalysis` — the tested engine) and the accumulated `scores`
 * keyed by `Img.id`. Restarts fresh when the staged set changes; a folder
 * switch mid-pass dies via the generation guard (frontend drop + backend
 * mid-chunk cancel, both keyed to `imageStore.getGeneration()`, which
 * `begin_session` already pushed to the backend's SessionGate).
 */
export function useSmartCulling(opts: {
  enabled: boolean;
  autoStart: boolean;
  /** phase === "culling" */
  active: boolean;
  /** The frozen post-beginCulling array — its identity IS the session key. */
  images: readonly Img[];
  storageMode: StorageMode;
}): {
  scores: Record<number, ImageScore>;
  analyzing: boolean;
  progress: { done: number; total: number } | null;
  startAnalysis: () => void;
} {
  const { enabled, autoStart, active, images, storageMode } = opts;
  const [scores, setScores] = useState<Record<number, ImageScore>>({});
  const [analyzing, setAnalyzing] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  /** Double-run guard (mirrors beginCulling's analyzingRef). */
  const runningRef = useRef(false);
  /** Which staged set the auto-start already fired for. */
  const startedForRef = useRef<readonly Img[] | null>(null);
  /** Did the last pass land ANY scores? A fully-failed pass (drive vanished,
   *  every chunk skipped) may be retried manually via `5`/the Sugg tab. */
  const gotScoresRef = useRef(false);

  // A new staged set invalidates everything derived from the old one.
  useEffect(() => {
    setScores({});
    setProgress(null);
    startedForRef.current = null;
  }, [images]);

  const startAnalysis = useCallback(() => {
    // Once per staged set (running OR completed): the `5` key and the Sugg tab
    // call this unconditionally as the manual-start escape hatch when
    // "analyze on open" is off — repeat presses must not re-run the pass.
    // Exception: a pass that produced ZERO scores (every chunk failed) may be
    // retried — that's a drive hiccup, not a completed analysis.
    if (runningRef.current || images.length === 0) return;
    if (startedForRef.current === images && gotScoresRef.current) return;
    runningRef.current = true;
    startedForRef.current = images;
    gotScoresRef.current = false;
    // Frozen locals: the index→id map must come from the DISPATCHED array
    // even if the component re-renders with a new set mid-pass.
    const dispatched = images;
    const gen = imageStore.getGeneration();
    setAnalyzing(true);
    setProgress({ done: 0, total: dispatched.length });
    void runAnalysis(
      dispatched.map((im) => im.path),
      gen,
      {
        invokeChunk: (paths, chunkStart, g) =>
          invoke<ImageScore[]>("analyze_quality", { paths, chunkStart, gen: g }),
        getGeneration: () => imageStore.getGeneration(),
        isBusyLoading: () => imageStore.isBusyLoading(),
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        onChunkFailed: (chunkStart, message) => {
          // Diagnostics ride the same flag as the dev HUD — never console
          // noise in normal use, one line per skipped chunk when debugging.
          if (localStorage.getItem("cull:devhud") === "1") {
            console.debug(`[cull] analyze chunk @${chunkStart} skipped: ${message}`);
          }
        },
        onScores: (chunk) => {
          gotScoresRef.current = true;
          setScores((prev) => {
            const next = { ...prev };
            for (const s of chunk) {
              const im = dispatched[s.index];
              if (im) next[im.id] = s;
            }
            return next;
          });
        },
        onProgress: (done, total) => setProgress({ done, total }),
        chunkLen: storageMode === "network" ? NET_CHUNK : LOCAL_CHUNK,
        idleWaitMs: storageMode === "network" ? NET_IDLE_MS : LOCAL_IDLE_MS,
      },
    ).finally(() => {
      runningRef.current = false;
      setAnalyzing(false);
    });
  }, [images, storageMode]);

  // Auto-start, once per staged set, after the first screenful settles.
  useEffect(() => {
    if (!enabled || !autoStart || !active || images.length === 0) return;
    if (startedForRef.current === images) return;
    const t = setTimeout(startAnalysis, FIRST_SCREENFUL_DELAY_MS);
    return () => clearTimeout(t);
  }, [enabled, autoStart, active, images, startAnalysis]);

  return { scores, analyzing, progress, startAnalysis };
}
