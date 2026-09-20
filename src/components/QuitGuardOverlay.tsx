import { useRef } from "react";
import type { ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import { ICON } from "./icons";
import {
  missingFailureSentence,
  missingPhotosLabel,
  missingRecovery,
  saveFailureKind,
} from "../utils/saveStatusCopy";

type Props = {
  failedCount: number;
  missingCount: number;
  savingCount: number;
  retryFailed: () => void;
  onKeepCulling: () => void;
  onCloseAnyway: () => void;
};

/** The close-request guard: shown while ratings are still being written (auto-closes
 *  when they land) or when writes exhausted their retries (explicit choice, never
 *  silent loss). When every failure is a photo that wasn't at its path, "Check
 *  again" re-attempts the same writes the footer's chip would: if the drive or
 *  folder is back, the writes land and the guard's own auto-close finishes the
 *  job, same as "Retry saving" does for an ordinary failure; if not, the choice
 *  is still keep culling / close anyway. */
export function QuitGuardOverlay({
  failedCount,
  missingCount,
  savingCount,
  retryFailed,
  onKeepCulling,
  onCloseAnyway,
}: Props): ReactNode {
  const failure = saveFailureKind(failedCount, missingCount);
  // "Keep culling" carries key="keep" in every branch below, so it is the
  // SAME DOM node across a branch change (React reconciles dialog__actions'
  // children by key, not position) — this ref always points at whichever
  // one is currently mounted, with no re-attach needed on the transition.
  const keepCullingRef = useRef<HTMLButtonElement>(null);

  // Move focus to "Keep culling" before firing the retry: it is the one
  // control every branch renders, so focus survives into whichever branch
  // follows (most often "saving") instead of falling to <body> when the
  // pressed button's key disappears from the next render.
  function focusKeepCullingThenRetry(): void {
    keepCullingRef.current?.focus();
    retryFailed();
  }

  return (
    <div className="dialog">
      <div className="dialog__box">
        {failure === "missing" ? (
          <>
            <div className="dialog__title dialog__title--warn">
              <TriangleAlert className="dialog__title-icon" {...ICON.lg} aria-hidden />
              {missingPhotosLabel(missingCount)}
            </div>
            {/* Fact → what closing costs → how to recover. The "Check again"
                button below IS the recovery's first half; the second half —
                put the photo back and rate it again — is what has to happen
                first if the photo was actually moved or deleted, since no
                amount of re-checking saves a write whose photo is gone. */}
            <div className="dialog__body">
              {missingFailureSentence(missingCount)} Closing now loses{" "}
              {missingCount > 1 ? "them" : "it"}. {missingRecovery(missingCount)}
            </div>
            <div className="dialog__actions">
              <button
                key="keep"
                ref={keepCullingRef}
                className="btn btn--primary"
                onClick={onKeepCulling}
              >
                Keep culling
              </button>
              <button key="check" className="btn" onClick={focusKeepCullingThenRetry}>
                Check again
              </button>
              <button key="close" className="btn cull-quitguard__danger" onClick={onCloseAnyway}>
                Close anyway
              </button>
            </div>
          </>
        ) : failure === "retry" ? (
          <>
            <div className="dialog__title dialog__title--warn">
              <TriangleAlert className="dialog__title-icon" {...ICON.lg} aria-hidden />
              {failedCount} rating{failedCount > 1 ? "s" : ""} didn’t save
            </div>
            <div className="dialog__body">
              {failedCount} {failedCount > 1 ? "ratings are" : "rating is"} not on disk (the sidecar
              write kept failing). Closing now will lose {failedCount > 1 ? "them" : "it"}.
            </div>
            <div className="dialog__actions">
              <button key="retry" className="btn btn--primary" onClick={focusKeepCullingThenRetry}>
                Retry saving
              </button>
              <button key="keep" ref={keepCullingRef} className="btn" onClick={onKeepCulling}>
                Keep culling
              </button>
              <button key="close" className="btn cull-quitguard__danger" onClick={onCloseAnyway}>
                Close anyway
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="dialog__title">
              Saving {savingCount} rating{savingCount > 1 ? "s" : ""}…
            </div>
            <div className="dialog__body">
              The app will close on its own the moment your ratings are safely on disk.
            </div>
            <div className="dialog__actions">
              <button key="keep" ref={keepCullingRef} className="btn" onClick={onKeepCulling}>
                Keep culling
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
