import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Feedback, Rating } from "../types";

const FEEDBACK_MS = 320;
// Rating-write retry schedule (ms before each retry). A rating that still fails
// after the last attempt is surfaced as "unsaved" rather than silently dropped.
const WRITE_RETRY_DELAYS = [400, 1500, 4000];

/**
 * Rating-write durability + the rating feedback flash, verbatim from App
 * (grand cleanup Phase 6). Every rating writes an .xmp sidecar; we count
 * writes in flight (savingCount) and remember any that exhausted their
 * retries (failedWrites: path → the rating that didn't land) so we can show
 * them and block a quit that would lose work (see useQuitGuard, which reads
 * this hook's counts).
 */
export function useRatingPersistence() {
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const feedbackTimer = useRef<number | null>(null);

  const [savingCount, setSavingCount] = useState(0);
  // path → the rating that didn't land. `null` = an unrate (clear) that failed,
  // so a stuck unrate is surfaced and guarded just like a stuck rating.
  const [failedWrites, setFailedWrites] = useState<Record<string, Rating | null>>({});
  // Mirrors of the above for the (once-registered) close-request handler, which
  // would otherwise capture stale values.
  const savingRef = useRef(0);
  const failedCountRef = useRef(0);
  const failedCount = Object.keys(failedWrites).length;

  const flashFeedback = useCallback((rating: Rating, imageId: number) => {
    setFeedback({ rating, imageId, ts: Date.now() });
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    feedbackTimer.current = window.setTimeout(() => setFeedback(null), FEEDBACK_MS);
  }, []);

  // Durably write a rating's .xmp sidecar. Retries on failure (NAS blips happen),
  // and if every attempt fails the path is recorded in failedWrites so the UI can
  // flag it and the quit guard can refuse to lose it. The backend write is
  // idempotent, so retries (and a later rating superseding this one) are safe.
  // `rating === null` clears the rating (unrate) via clear_xmp_rating; otherwise
  // it writes the rating. Both go through the same retry + failure tracking.
  // Per-path serial write queue: each new persistRating chains after the prior
  // write to the SAME path, so an Undo immediately after a rate can never lose
  // the race with the original write (which used to fire-and-forget). Different
  // paths still run in parallel (subject to backend bounds).
  const writeQueue = useRef<Map<string, Promise<unknown>>>(new Map());
  // Monotonic per-path write sequence. A write only owns the failed/saved verdict
  // for a path while it's still the LATEST write to that path — otherwise an
  // older write that exhausts its retries AFTER a newer write already succeeded
  // would re-stamp a phantom "unsaved" failure (and falsely block quit).
  const writeSeq = useRef<Map<string, number>>(new Map());

  const persistRating = useCallback((path: string, rating: Rating | null) => {
    const seq = (writeSeq.current.get(path) ?? 0) + 1;
    writeSeq.current.set(path, seq);
    const isLatest = () => writeSeq.current.get(path) === seq;

    // A fresh write/clear for this path supersedes any earlier failure.
    setFailedWrites((f) => {
      if (!(path in f)) return f;
      const next = { ...f };
      delete next[path];
      failedCountRef.current = Object.keys(next).length;
      return next;
    });
    setSavingCount((c) => c + 1);
    savingRef.current += 1; // synchronous: the close guard reads this, not lagged state
    const cmd = rating === null ? "clear_xmp_rating" : "write_xmp_rating";
    const args = rating === null ? { path } : { path, rating };

    // tryWrite returns a promise that resolves on success, rejects only after
    // every retry slot has been exhausted — so the queue holds the next write
    // until ALL retries of this one have finished.
    const tryWrite = (n: number): Promise<unknown> =>
      invoke(cmd, args).catch((e) => {
        if (n < WRITE_RETRY_DELAYS.length) {
          return new Promise((resolve, reject) =>
            window.setTimeout(() => tryWrite(n + 1).then(resolve, reject), WRITE_RETRY_DELAYS[n]),
          );
        }
        throw e;
      });

    const prev = writeQueue.current.get(path) ?? Promise.resolve();
    const next = prev
      .then(
        () => tryWrite(0),
        () => tryWrite(0),
      )
      .finally(() => {
        if (writeQueue.current.get(path) === next) writeQueue.current.delete(path);
      });
    writeQueue.current.set(path, next);

    next.then(
      () => {
        setSavingCount((c) => c - 1);
        savingRef.current -= 1;
      },
      (e) => {
        setSavingCount((c) => c - 1);
        savingRef.current -= 1;
        // Only the latest write to this path may stamp a failure; a superseded
        // older write failing must not resurrect an "unsaved" flag the newer
        // (successful) write already cleared.
        if (isLatest()) {
          console.error(`${cmd} failed permanently`, path, e);
          setFailedWrites((f) => {
            const next = { ...f, [path]: rating };
            failedCountRef.current = Object.keys(next).length;
            return next;
          });
        }
      },
    );
  }, []);

  // Re-attempt every rating that exhausted its retries (triggered from the unsaved
  // indicator or the quit guard).
  const retryFailed = useCallback(() => {
    Object.entries(failedWrites).forEach(([path, rating]) => persistRating(path, rating));
  }, [failedWrites, persistRating]);

  // savingRef / failedCountRef are maintained SYNCHRONOUSLY inside persistRating
  // (above) rather than via a passive effect, so the once-registered close handler
  // can never read a stale zero in the commit-lag window right after a rating
  // keystroke — which would otherwise let the window close with a write in flight.

  useEffect(() => {
    return () => {
      if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    };
  }, []);

  return {
    feedback,
    setFeedback,
    flashFeedback,
    persistRating,
    retryFailed,
    savingCount,
    failedCount,
    savingRef,
    failedCountRef,
  };
}
