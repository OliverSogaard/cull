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
import { missingTargets, unratedTargets } from "./analysisTargets";
import type { ImageScore } from "../types/ipc";
import type { Img } from "../types/image";
import type { StorageMode } from "../types/settings";

/** Head start for the first screenful of thumbs before the pass begins. */
const FIRST_SCREENFUL_DELAY_MS = 1200;

/** Quiet period after a ratings change before a catch-up pass dispatches —
 *  batches a burst of unrates into one pass instead of one per keypress. */
const CATCHUP_DEBOUNCE_MS = 800;

/**
 * The smart-culling driver hook: owns the chunked, gen-guarded, backpressure-
 * aware pass (`runAnalysis` — the tested engine) and the accumulated `scores`
 * keyed by `Img.id`. Restarts fresh when the staged set changes; a folder
 * switch mid-pass dies via the generation guard (frontend drop + backend
 * mid-chunk cancel, both keyed to `imageStore.getGeneration()`, which
 * `begin_session` already pushed to the backend's SessionGate).
 *
 * The pass starts from where the user has reached: only UNRATED frames are
 * dispatched (rated frames need no suggestion), so a half-culled folder gets
 * suggestions where they matter without re-reading thousands of decided
 * frames. Frames unrated afterwards are swept up by a debounced catch-up
 * pass; frames scored before being rated keep their score for free.
 */
export function useSmartCulling(opts: {
  enabled: boolean;
  autoStart: boolean;
  /** phase === "culling" */
  active: boolean;
  /** Tier-2 face analysis flag — forwarded to the backend per chunk. */
  ml: boolean;
  /** The frozen post-beginCulling array — its identity IS the session key. */
  images: readonly Img[];
  /** Ids the user has rated — fresh identity per ratings change (drives the
   *  catch-up effect); the initial dispatch reads it at click time only. */
  ratedIds: ReadonlySet<number>;
  storageMode: StorageMode;
}): {
  scores: Record<number, ImageScore>;
  analyzing: boolean;
  progress: { done: number; total: number } | null;
  startAnalysis: () => void;
} {
  const { enabled, autoStart, active, ml, images, ratedIds, storageMode } = opts;
  const [scores, setScores] = useState<Record<number, ImageScore>>({});
  const [analyzing, setAnalyzing] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  /** Double-run guard (mirrors beginCulling's analyzingRef). */
  const runningRef = useRef(false);
  /** Which staged set the auto-start already fired for. */
  const startedForRef = useRef<readonly Img[] | null>(null);
  /** Did the last MAIN pass land ANY scores? A fully-failed pass (drive
   *  vanished, every chunk skipped) may be retried manually via `5`/the Smart
   *  tab. Catch-up passes don't touch it — a failed 1-frame catch-up must not
   *  re-open the door to a full re-run. */
  const gotScoresRef = useRef(false);
  /** Frames a catch-up pass already dispatched for this staged set — one shot
   *  per frame, so a frame whose analysis fails can't loop forever. */
  const attemptedRef = useRef<Set<number>>(new Set());
  /** Live scores mirror for the catch-up effect's missing-frame check. */
  const scoresRef = useRef(scores);
  scoresRef.current = scores;

  // A new staged set invalidates everything derived from the old one.
  useEffect(() => {
    setScores({});
    setProgress(null);
    startedForRef.current = null;
    attemptedRef.current = new Set();
  }, [images]);

  /** Shared engine dispatch: main pass and catch-up differ only in the frame
   *  list and whether they own the retry latch. */
  const runPass = useCallback(
    (dispatched: readonly Img[], isMainPass: boolean) => {
      if (runningRef.current || dispatched.length === 0) return;
      runningRef.current = true;
      if (isMainPass) gotScoresRef.current = false;
      const gen = imageStore.getGeneration();
      setAnalyzing(true);
      setProgress({ done: 0, total: dispatched.length });
      void runAnalysis(
        dispatched.map((im) => im.path),
        gen,
        {
          invokeChunk: (paths, chunkStart, g) =>
            invoke<ImageScore[]>("analyze_quality", { paths, chunkStart, gen: g, ml }),
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
            if (isMainPass) gotScoresRef.current = true;
            setScores((prev) => {
              const next = { ...prev };
              for (const s of chunk) {
                // s.index is absolute within the DISPATCHED array — which is
                // a filtered subset of the staged set, so the map back to ids
                // must go through the frozen dispatch, never `images`.
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
    },
    [storageMode, ml],
  );

  const startAnalysis = useCallback(() => {
    // Once per staged set (running OR completed): the `5` key and the Smart
    // tab call this unconditionally as the manual-start escape hatch when
    // "analyze on open" is off — repeat presses must not re-run the pass.
    // Exception: a pass that produced ZERO scores (every chunk failed) may be
    // retried — that's a drive hiccup, not a completed analysis.
    if (runningRef.current || images.length === 0) return;
    if (startedForRef.current === images && gotScoresRef.current) return;
    startedForRef.current = images;
    const dispatched = unratedTargets(images, ratedIds);
    if (dispatched.length === 0) {
      // Fully-rated folder: the pass is vacuously complete — latch it so `5`
      // doesn't retry, and let the catch-up effect own any later unrates.
      gotScoresRef.current = true;
      return;
    }
    runPass(dispatched, true);
  }, [images, ratedIds, runPass]);

  // Auto-start, once per staged set, after the first screenful settles. Reads
  // startAnalysis through a ref: its identity churns with every rating (via
  // ratedIds) and rating during the head start must not keep resetting the
  // timer.
  const startAnalysisRef = useRef(startAnalysis);
  startAnalysisRef.current = startAnalysis;
  useEffect(() => {
    if (!enabled || !autoStart || !active || images.length === 0) return;
    if (startedForRef.current === images) return;
    const t = setTimeout(() => startAnalysisRef.current(), FIRST_SCREENFUL_DELAY_MS);
    return () => clearTimeout(t);
  }, [enabled, autoStart, active, images]);

  // Catch-up: a frame unrated AFTER the pass dispatched has no score — sweep
  // such frames in a small follow-up pass once the engine is idle. Debounced
  // so a burst of unrates lands as one dispatch; `attempted` is marked only
  // when the pass actually starts, so a cancelled timer costs nothing.
  useEffect(() => {
    if (!enabled || !active || analyzing) return;
    if (startedForRef.current !== images || !gotScoresRef.current) return;
    const missing = missingTargets(
      images,
      ratedIds,
      (id) => id in scoresRef.current,
      attemptedRef.current,
    );
    if (missing.length === 0) return;
    const t = setTimeout(() => {
      if (runningRef.current) return; // re-checked on the next ratings change
      for (const im of missing) attemptedRef.current.add(im.id);
      runPass(missing, false);
    }, CATCHUP_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [enabled, active, analyzing, images, ratedIds, runPass]);

  return { scores, analyzing, progress, startAnalysis };
}
