import type { ReactNode } from "react";

type Props = {
  failedCount: number;
  savingCount: number;
  retryFailed: () => void;
  onKeepCulling: () => void;
  onCloseAnyway: () => void;
};

/** The close-request guard: shown while ratings are still being written (auto-closes
 *  when they land) or when writes failed permanently (explicit choice, never silent loss). */
export function QuitGuardOverlay({
  failedCount,
  savingCount,
  retryFailed,
  onKeepCulling,
  onCloseAnyway,
}: Props): ReactNode {
  return (
    <div className="cull-quitguard">
      <div className="cull-quitguard__box">
        {failedCount > 0 ? (
          <>
            <div className="cull-quitguard__title cull-quitguard__title--warn">
              ⚠ {failedCount} rating{failedCount > 1 ? "s" : ""} didn’t save
            </div>
            <div className="cull-quitguard__body">
              {failedCount} {failedCount > 1 ? "ratings are" : "rating is"} not on disk (the sidecar
              write kept failing). Closing now will lose {failedCount > 1 ? "them" : "it"}.
            </div>
            <div className="cull-quitguard__actions">
              <button className="cull-pick-button cull-pick-button--primary" onClick={retryFailed}>
                retry saving
              </button>
              <button className="cull-pick-button" onClick={onKeepCulling}>
                keep culling
              </button>
              <button className="cull-pick-button cull-quitguard__danger" onClick={onCloseAnyway}>
                close anyway
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="cull-quitguard__title">
              saving {savingCount} rating{savingCount > 1 ? "s" : ""}…
            </div>
            <div className="cull-quitguard__body">
              The app will close on its own the moment your ratings are safely on disk.
            </div>
            <div className="cull-quitguard__actions">
              <button className="cull-pick-button" onClick={onKeepCulling}>
                keep culling
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
