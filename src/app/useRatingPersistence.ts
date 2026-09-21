import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Feedback, Label, Rating, Star } from "../types";
import { isCustomLabelKept, isPermanentWriteError } from "../utils/writeFailure";

const FEEDBACK_MS = 320;
// Sidecar-write retry schedule (ms before each retry). A write that still fails
// after the last attempt is surfaced as "unsaved" rather than silently dropped.
const WRITE_RETRY_DELAYS = [400, 1500, 4000];

/** What one queued write is trying to do — the discriminated form, so a
 *  retry can re-issue exactly it and the failure record can say which
 *  property of the sidecar did not land. */
type PendingWrite =
  | { kind: "rating"; rating: Rating | null }
  | { kind: "star"; star: Star | null }
  | { kind: "label"; label: Label | null };

/** A write that exhausted its options, and what kind of failure it was.
 *  `rating: null` = an unrate (clear) that failed, so a stuck unrate is
 *  surfaced and guarded just like a stuck rating; the same is true of a
 *  cleared star or label. `missing` = the backend refused because the photo
 *  is not at its path (utils/writeFailure), which a timer cannot fix — only
 *  the drive coming back or the photo being put back can, so it gets one
 *  attempt per deliberate retry and no schedule. `path` rides along because
 *  the record is keyed by `kind:path`, not by path alone. */
type FailedWrite = { path: string; write: PendingWrite; missing: boolean };

/** The Tauri command and arguments for one pending write. Module scope: it
 *  closes over nothing, which is what keeps `persist`'s dependency list
 *  empty and therefore its identity stable for the whole session. */
function invocation(path: string, write: PendingWrite): [string, Record<string, unknown>] {
  if (write.kind === "star") return ["write_xmp_star", { path, star: write.star }];
  if (write.kind === "label") return ["write_xmp_label", { path, label: write.label }];
  return write.rating === null
    ? ["clear_xmp_rating", { path }]
    : ["write_xmp_rating", { path, rating: write.rating }];
}

/** How many PHOTOS a set of failed writes covers. Two stuck properties of one
 *  sidecar are one photo that did not save, which is what the chrome says. */
function distinctPaths(writes: readonly FailedWrite[]): number {
  return new Set(writes.map((w) => w.path)).size;
}

/**
 * Sidecar-write durability + the rating feedback flash, verbatim from App
 * (grand cleanup Phase 6). Every rating, star and colour label writes an .xmp
 * sidecar; we count writes in flight (savingCount) and remember any that
 * exhausted their retries (failedWrites: `kind:path` → what didn't land) so we
 * can show them and block a quit that would lose work (see useQuitGuard, which
 * reads this hook's counts).
 *
 * Failures come in two kinds and the chrome must tell them apart: `failedCount`
 * is every PHOTO with a failure (so the quit guard and the leave-to-home
 * warning still refuse to lose one silently), `missingCount` is the subset
 * whose photo was not at its path. What is left — `failedCount - missingCount` — is what a
 * retry can be expected to save, and the only thing that blocks finishing the
 * cull; a missing photo warns instead, because blocking on one would leave a
 * session with no way out.
 */
export function useRatingPersistence(opts?: {
  /**
   * The backend refused to overwrite a label CULL did not write, so the
   * frame's label in memory is out of date (Lightroom edited the sidecar
   * while the session was open). Called with the photo's path so the owner
   * can put `"custom"` back in its map — the file itself is untouched and
   * correct, and this is NOT counted as a failed save.
   */
  onCustomLabelKept?: (path: string) => void;
}) {
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const feedbackTimer = useRef<number | null>(null);
  // Through a ref so `persist` below keeps its empty dependency list, and
  // therefore its identity, for the whole session.
  const onCustomLabelKeptRef = useRef(opts?.onCustomLabelKept);
  onCustomLabelKeptRef.current = opts?.onCustomLabelKept;

  const [savingCount, setSavingCount] = useState(0);
  // `kind:path` → the failure. One record rather than a second parallel set of
  // missing paths: the two could drift apart (a missingCount above failedCount
  // would make the retryable remainder go negative), and they never have to.
  // Keyed per PROPERTY, so a stuck rating and a stuck label on one photo are
  // two separate records: retryFailed has two things to re-issue, each with
  // its own command and value. What the CHROME counts is photos — see below.
  const [failedWrites, setFailedWrites] = useState<Record<string, FailedWrite>>({});
  // Mirrors of the above for the (once-registered) close-request handler, which
  // would otherwise capture stale values.
  const savingRef = useRef(0);
  const failedCountRef = useRef(0);
  // …but the COUNTS are per PHOTO, because every surface that reports them
  // says so ("3 photos missing", "3 ratings didn't save"). One photo whose
  // rating and label are both stuck is one photo the user has to rescue, not
  // two; `retryFailed` still replays both of its records.
  const failedCount = distinctPaths(Object.values(failedWrites));
  const missingCount = distinctPaths(Object.values(failedWrites).filter((w) => w.missing));

  const flashFeedback = useCallback((rating: Rating, imageId: number) => {
    setFeedback({ rating, imageId, ts: Date.now() });
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    feedbackTimer.current = window.setTimeout(() => setFeedback(null), FEEDBACK_MS);
  }, []);

  // Per-PHOTO serial write queue: each new write chains after the prior write
  // to the SAME path, so an Undo immediately after a rate can never lose the
  // race with the original write (which used to fire-and-forget). A rating, a
  // star and a label for one frame are three read-modify-writes of ONE file, so
  // they share this queue rather than getting one each. Different paths still
  // run in parallel (subject to backend bounds).
  const writeQueue = useRef<Map<string, Promise<unknown>>>(new Map());
  // Monotonic per-PROPERTY write sequence (`kind:path`). A write only owns the
  // failed/saved verdict for a property while it's still the LATEST write to
  // that property — otherwise an older write that exhausts its retries AFTER a
  // newer write already succeeded would re-stamp a phantom "unsaved" failure
  // (and falsely block quit).
  const writeSeq = useRef<Map<string, number>>(new Map());

  /**
   * Durably write ONE property of a photo's `.xmp` sidecar. Retries on
   * failure (NAS blips happen), and if every attempt fails the write is
   * recorded in `failedWrites` so the UI can flag it and the quit guard can
   * refuse to lose it. Every backend write is idempotent, so retries (and a
   * later write superseding this one) are safe.
   *
   * TWO different keys, deliberately:
   *  - `writeQueue` is keyed by PATH. A rating, a star and a label for one
   *    frame are three read-modify-writes of ONE file, so they must not
   *    overlap; different photos still run in parallel.
   *  - `writeSeq` and `failedWrites` are keyed by `kind:path`, because
   *    "a newer write superseded this one" is only true of the SAME property.
   *    Keyed by path alone, a successful star write would clear a rating
   *    write's unsaved flag while the rating was still not on disk.
   */
  const persist = useCallback((path: string, write: PendingWrite) => {
    const key = `${write.kind}:${path}`;
    const seq = (writeSeq.current.get(key) ?? 0) + 1;
    writeSeq.current.set(key, seq);
    const isLatest = () => writeSeq.current.get(key) === seq;

    // A fresh write of THIS property supersedes any earlier failure of it.
    setFailedWrites((f) => {
      if (!(key in f)) return f;
      const next = { ...f };
      delete next[key];
      failedCountRef.current = distinctPaths(Object.values(next));
      return next;
    });
    setSavingCount((c) => c + 1);
    savingRef.current += 1; // synchronous: the close guard reads this, not lagged state

    const [cmd, args] = invocation(path, write);

    // tryWrite returns a promise that resolves on success, rejects only after
    // every retry slot has been exhausted — so the queue holds the next write
    // until ALL retries of this one have finished.
    const tryWrite = (n: number): Promise<unknown> =>
      invoke(cmd, args).catch((e) => {
        // A missing-source refusal is permanent: retrying only delays the
        // honest "didn't save" by six seconds. A kept custom label is not a
        // failure at all — the file is already what it should be, so there is
        // nothing for a retry to achieve either. `isCustomLabelKept` is a bare
        // string-prefix test, so it is scoped to `kind === "label"` here too —
        // otherwise a rating or star write that ever collided with the same
        // prefix would be swallowed rather than retried.
        const isKeptCustomLabel = write.kind === "label" && isCustomLabelKept(e);
        if (n < WRITE_RETRY_DELAYS.length && !isPermanentWriteError(e) && !isKeptCustomLabel) {
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
        // The backend kept the user's own Lightroom label and left the file
        // exactly as it was. Nothing was lost and nothing is pending, so this
        // never becomes a failed write — the only thing that was wrong is our
        // copy of the label, which the owner corrects from here. Scoped to
        // `kind === "label"`, same reason as the retry guard above: the
        // message-prefix test alone must never be able to swallow a rating or
        // star failure.
        if (write.kind === "label" && isCustomLabelKept(e)) {
          onCustomLabelKeptRef.current?.(path);
          return;
        }
        // Only the latest write of this property may stamp a failure; a
        // superseded older write failing must not resurrect an "unsaved" flag
        // the newer (successful) write already cleared.
        if (isLatest()) {
          console.error(`${cmd} failed permanently`, path, e);
          const missing = isPermanentWriteError(e);
          setFailedWrites((f) => {
            const nextFailed = { ...f, [key]: { path, write, missing } };
            failedCountRef.current = distinctPaths(Object.values(nextFailed));
            return nextFailed;
          });
        }
      },
    );
  }, []);

  const persistRating = useCallback(
    (path: string, rating: Rating | null) => persist(path, { kind: "rating", rating }),
    [persist],
  );
  /** Set or clear the star (`xmp:Rating` 1–5). Same queue, same retries, same
   *  failure tracking as a rating — it is the same file. */
  const persistStar = useCallback(
    (path: string, star: Star | null) => persist(path, { kind: "star", star }),
    [persist],
  );
  /** Set or clear the colour label (`xmp:Label`). */
  const persistLabel = useCallback(
    (path: string, label: Label | null) => persist(path, { kind: "label", label }),
    [persist],
  );

  // Re-attempt every write that exhausted its retries (triggered from the
  // unsaved indicator or the quit guard) — the missing ones included. A photo
  // is usually "missing" because the drive or NAS it lives on dropped out, and
  // the user clicking this is saying it may be back; skipping them would strand
  // every mark made during an outage with no way to ever save it. What the
  // missing flag still buys them is no automatic SCHEDULE (tryWrite above):
  // one attempt per click, fail fast. Each record replays the write it carried,
  // so a star retries as a star and a stuck unrate as an unrate.
  const retryFailed = useCallback(() => {
    Object.values(failedWrites).forEach((failed) => {
      persist(failed.path, failed.write);
    });
  }, [failedWrites, persist]);

  // savingRef / failedCountRef are maintained SYNCHRONOUSLY inside persist
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
    persistStar,
    persistLabel,
    retryFailed,
    savingCount,
    failedCount,
    missingCount,
    savingRef,
    failedCountRef,
  };
}
