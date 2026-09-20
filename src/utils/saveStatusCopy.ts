/**
 * The one vocabulary for a rating write that didn't land.
 *
 * Four surfaces report a failed write — the status-bar chip, the save-status
 * pill in the top chrome, the quit guard and the leave-to-home warning — and
 * they have to tell the same story, because a photo that is no longer at its
 * path can never be saved by retrying (see utils/writeFailure). Offering
 * "unsaved · retry" there is a lie; saying so in three slightly different ways
 * is how the lie comes back.
 *
 * Sentence case throughout, even for the chips CSS renders in another case.
 */

/** Which story the chrome tells about the current failures. */
export type SaveFailureKind =
  /** Nothing failed. */
  | "none"
  /** Every failure is a photo that is gone — warn, but never offer a retry. */
  | "missing"
  /** At least one failure could still succeed — the retry is real. */
  | "retry";

export function saveFailureKind(failedCount: number, missingCount: number): SaveFailureKind {
  if (failedCount <= 0) return "none";
  return missingCount >= failedCount ? "missing" : "retry";
}

/** Why the missing chip is not a button. */
export const MISSING_PHOTO_TITLE =
  "The photo is no longer at its path, so its rating could not be saved.";

/** The all-missing chip label: "1 photo missing" / "3 photos missing". */
export function missingPhotosLabel(count: number): string {
  return `${count} photo${count === 1 ? "" : "s"} missing`;
}

/** The retryable chip label, unchanged: "3 unsaved · retry". */
export function unsavedLabel(failedCount: number): string {
  return `${failedCount} unsaved · retry`;
}

/** The retryable chip title, warning about the part of the batch a retry skips. */
export function unsavedTitle(missingCount: number): string {
  const base = "Ratings failed to save · click to retry";
  if (missingCount <= 0) return base;
  const photos = missingCount === 1 ? "missing photo" : "missing photos";
  return `${base} (${missingCount} ${photos} will be skipped)`;
}

/** The all-missing dialog sentence, agreeing with itself in both numbers. */
export function missingFailureSentence(count: number): string {
  return count === 1
    ? "1 rating could not be saved because the photo is no longer at its path."
    : `${count} ratings could not be saved because the photos are no longer at their paths.`;
}

/** The mixed-failure dialog tail — empty when nothing would be skipped. */
export function missingSkippedNote(missingCount: number): string {
  if (missingCount <= 0) return "";
  return missingCount === 1
    ? "1 of them is a missing photo, which a retry will skip."
    : `${missingCount} of them are missing photos, which a retry will skip.`;
}
