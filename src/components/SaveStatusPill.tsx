import {
  MISSING_PHOTO_TITLE,
  UNSAVED_TITLE,
  missingCheckAgainLabel,
  saveFailureKind,
} from "../utils/saveStatusCopy";

/**
 * XMP save-status pill rendered in the top chrome (next to the brand). The
 * bottom status bar also surfaces failed saves — this is a peripheral mirror
 * the user catches with their peripheral vision so a failed write doesn't sit
 * unnoticed when the bottom bar is occluded by a modal.
 *
 * Four states, fully derived from existing state (no new state machinery):
 *  - missing  → red pill, a real button: the photo wasn't at its path, which
 *               is usually a drive that dropped out, so it offers the re-check
 *               in the same words as the bottom bar's chip
 *  - failed   → red pill, a real button, same retry path as the bottom bar
 *  - saving   → champagne dot pulsing, "saving…" text; still a real button
 *               (aria-disabled, not clickable) so a retry that lands mid-flight
 *               doesn't drop keyboard focus to the page
 *  - idle     → muted dot, "saved" text (default)
 *
 * A failure wins over saving so an in-flight retry doesn't visually mask the
 * still-failing batch behind it.
 */
export function SaveStatusPill({
  failedCount,
  missingCount,
  savingCount,
  onRetry,
}: {
  failedCount: number;
  missingCount: number;
  savingCount: number;
  onRetry: () => void;
}) {
  const failure = saveFailureKind(failedCount, missingCount);
  const state =
    failure === "missing"
      ? "missing"
      : failure === "retry"
        ? "failed"
        : savingCount > 0
          ? "saving"
          : "idle";
  // Quiet when there's nothing to say: a standing "saved" on a fresh home
  // screen reads as noise. The pill exists for in-flight and failed writes.
  if (state === "idle") return null;
  const isSaving = state === "saving";
  const className = `chip cull-save-status cull-save-status--${state}`;
  const body = (
    <>
      <span className="cull-save-status__dot" />
      <span className="cull-save-status__label">
        {state === "missing"
          ? missingCheckAgainLabel(missingCount)
          : state === "failed"
            ? "failed · retry"
            : "saving…"}
      </span>
    </>
  );
  // One <button> for every non-idle state (mirrors the status-bar chip): a
  // retry that lands and flips this straight to "saving" must not swap the
  // element type out from under keyboard focus. aria-disabled, not the
  // `disabled` attribute — a disabled button drops focus in Chromium.
  return (
    <button
      type="button"
      className={className}
      aria-disabled={isSaving || undefined}
      onClick={() => {
        if (isSaving) return;
        onRetry();
      }}
      title={
        isSaving
          ? `Saving ${savingCount} rating${savingCount > 1 ? "s" : ""}`
          : state === "missing"
            ? MISSING_PHOTO_TITLE
            : UNSAVED_TITLE
      }
    >
      {body}
    </button>
  );
}
