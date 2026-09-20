type Props = {
  failedCount: number;
  onLeave: () => void;
  onStay: () => void;
};

/** Esc-to-leave confirmation shown while culling: warns about unsaved ratings
 *  when there are failed writes, otherwise just confirms the reopen-restores
 *  guarantee (ratings live in .xmp sidecars). */
export function ConfirmHomeDialog({ failedCount, onLeave, onStay }: Props) {
  return (
    <div className="dialog">
      <div className="dialog__box">
        <div className={`dialog__title${failedCount > 0 ? " dialog__title--warn" : ""}`}>
          {failedCount > 0
            ? `⚠ Leave with ${failedCount} unsaved rating${failedCount > 1 ? "s" : ""}?`
            : "Leave to home?"}
        </div>
        <div className="dialog__body">
          {failedCount > 0
            ? `${failedCount} rating${failedCount > 1 ? "s have" : " has"} not saved to disk yet. Leaving won't lose ${failedCount > 1 ? "them" : "it"}: the unsaved flag stays on the home screen for retrying. Staying to retry first is safer.`
            : "Ratings are saved in .xmp sidecars. Reopening the folder restores them."}
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
