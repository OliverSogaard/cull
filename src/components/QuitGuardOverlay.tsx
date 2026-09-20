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
 *  silent loss). When every failure is a photo that wasn't at its path, the way back
 *  is the footer's "check again" once the drive is up — not a retry from in here,
 *  which would fire against the same outage — so the guard says so and leaves the
 *  choice at keep culling / close anyway. */
export function QuitGuardOverlay({
  failedCount,
  missingCount,
  savingCount,
  retryFailed,
  onKeepCulling,
  onCloseAnyway,
}: Props): ReactNode {
  const failure = saveFailureKind(failedCount, missingCount);
  return (
    <div className="dialog">
      <div className="dialog__box">
        {failure === "missing" ? (
          <>
            <div className="dialog__title dialog__title--warn">
              <TriangleAlert className="dialog__title-icon" {...ICON.lg} aria-hidden />
              {missingPhotosLabel(missingCount)}
            </div>
            {/* Fact → what closing costs → how to recover. Nothing in this
                dialog can clear the guard while the photos are unreachable, so
                the last clause is the only way out that keeps the rating — it
                must be on screen, not just in the other dialog. */}
            <div className="dialog__body">
              {missingFailureSentence(missingCount)} Closing now loses{" "}
              {missingCount > 1 ? "them" : "it"}. {missingRecovery(missingCount)}
            </div>
            <div className="dialog__actions">
              <button className="btn btn--primary" onClick={onKeepCulling}>
                Keep culling
              </button>
              <button className="btn cull-quitguard__danger" onClick={onCloseAnyway}>
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
              <button className="btn btn--primary" onClick={retryFailed}>
                Retry saving
              </button>
              <button className="btn" onClick={onKeepCulling}>
                Keep culling
              </button>
              <button className="btn cull-quitguard__danger" onClick={onCloseAnyway}>
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
              <button className="btn" onClick={onKeepCulling}>
                Keep culling
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
