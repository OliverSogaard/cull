import { TriangleAlert } from "lucide-react";
import { ICON } from "./icons";
import {
  missingFailureSentence,
  missingPhotosLabel,
  missingSkippedNote,
  saveFailureKind,
} from "../utils/saveStatusCopy";

type Props = {
  failedCount: number;
  missingCount: number;
  onLeave: () => void;
  onStay: () => void;
};

/** Esc-to-leave confirmation shown while culling: warns about unsaved ratings
 *  when there are failed writes, otherwise just confirms the reopen-restores
 *  guarantee (ratings live in .xmp sidecars). When every failure is a photo
 *  that is gone, staying to retry is not the safer option — the dialog says so
 *  instead of promising a retry that cannot succeed. */
export function ConfirmHomeDialog({ failedCount, missingCount, onLeave, onStay }: Props) {
  const failure = saveFailureKind(failedCount, missingCount);
  const title =
    failure === "missing"
      ? `Leave with ${missingPhotosLabel(missingCount)}?`
      : `Leave with ${failedCount} unsaved rating${failedCount > 1 ? "s" : ""}?`;
  const retryBody = `${failedCount} rating${failedCount > 1 ? "s have" : " has"} not saved to disk yet. Leaving won't lose ${failedCount > 1 ? "them" : "it"}: the unsaved flag stays on the home screen for retrying. Staying to retry first is safer.`;
  const missingBody = `${missingFailureSentence(missingCount)} Retrying cannot help — put the photo${missingCount > 1 ? "s" : ""} back and rate ${missingCount > 1 ? "them" : "it"} again.`;
  return (
    <div className="dialog">
      <div className="dialog__box">
        <div className={`dialog__title${failure !== "none" ? " dialog__title--warn" : ""}`}>
          {failure !== "none" ? (
            <>
              <TriangleAlert className="dialog__title-icon" {...ICON.lg} aria-hidden />
              {title}
            </>
          ) : (
            "Leave to home?"
          )}
        </div>
        <div className="dialog__body">
          {failure === "missing" && missingBody}
          {failure === "retry" &&
            (missingCount > 0 ? `${retryBody} ${missingSkippedNote(missingCount)}` : retryBody)}
          {failure === "none" &&
            "Ratings are saved in .xmp sidecars. Reopening the folder restores them."}
        </div>
        <div className="dialog__actions">
          <button className="btn btn--primary" onClick={onLeave}>
            Leave to home
          </button>
          <button className="btn" onClick={onStay}>
            Stay
          </button>
        </div>
        <div className="dialog__hint">enter · leave · · · esc · stay</div>
      </div>
    </div>
  );
}
