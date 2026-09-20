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
  return (
    <div className="dialog">
      <div className="dialog__box">
        {failure === "missing" ? (
          <>
            <div className="dialog__title dialog__title--warn">
              <TriangleAlert className="dialog__title-icon" {...ICON.lg} aria-hidden />
              {missingPhotosLabel(missingCount)}
            </div>
            {/* Fact → what closing costs → how to recover. "Check again" below
                is that recovery, on screen rather than only in the footer, so
                the last clause matters only if the user closes without
                pressing it. */}
            <div className="dialog__body">
              {missingFailureSentence(missingCount)} Closing now loses{" "}
              {missingCount > 1 ? "them" : "it"}. {missingRecovery(missingCount)}
            </div>
            <div className="dialog__actions">
              <button className="btn btn--primary" onClick={onKeepCulling}>
                Keep culling
              </button>
              <button className="btn" onClick={retryFailed}>
                Check again
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
