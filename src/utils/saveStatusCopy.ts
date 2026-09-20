/**
 * The one vocabulary for a rating write that didn't land.
 *
 * Five surfaces report a failed write — the status-bar chip, the save-status
 * pill in the top chrome, the quit guard, the leave-to-home warning and the
 * finish dialog — and they have to tell the same story, because a photo that
 * was not at its path when the write went out is a different situation from a
 * sidecar that simply would not write (see utils/writeFailure). Saying that in
 * five slightly different ways is how a surface ends up promising something
 * another one denies.
 *
 * Sentence case throughout, even for the chips CSS renders in another case.
 */

/** Which story the chrome tells about the current failures. */
export type SaveFailureKind =
  /** Nothing failed. */
  | "none"
  /** Every failure is a photo that was not at its path — offer a re-check. */
  | "missing"
  /** At least one failure is an ordinary one — the retry is the plain retry. */
  | "retry";

export function saveFailureKind(failedCount: number, missingCount: number): SaveFailureKind {
  if (failedCount <= 0) return "none";
  return missingCount >= failedCount ? "missing" : "retry";
}

/**
 * What the missing chip does, and when it is worth doing.
 *
 * A drive or NAS dropping out is what usually produces this, so the honest
 * offer is "check again", not "give up": the rating is still held, and one
 * click once the photos are reachable saves it.
 */
export const MISSING_PHOTO_TITLE =
  "The photo is not at its path. Check again once the drive or folder is back.";

/** The all-missing count phrase: "1 photo missing" / "3 photos missing". */
export function missingPhotosLabel(count: number): string {
  return `${count} photo${count === 1 ? "" : "s"} missing`;
}

/** The all-missing chip label — the count phrase plus what clicking it does. */
export function missingCheckAgainLabel(count: number): string {
  return `${missingPhotosLabel(count)}${MISSING_ACTION_TAIL}`;
}

/** The retryable chip's count phrase WITHOUT its action tail: "3 unsaved".
 *  The footer drops the tail below 1360px of window width — the button's
 *  title still says what clicking it does, and it is the only button there. */
export function unsavedCountLabel(failedCount: number): string {
  return `${failedCount} unsaved`;
}

/** The action tails the narrow footer drops. Kept beside the full labels so
 *  the two halves can never drift (saveStatusCopy.test asserts they compose). */
export const UNSAVED_ACTION_TAIL = " · retry";
export const MISSING_ACTION_TAIL = " · check again";

/** The retryable chip label, unchanged: "3 unsaved · retry". */
export function unsavedLabel(failedCount: number): string {
  return `${unsavedCountLabel(failedCount)}${UNSAVED_ACTION_TAIL}`;
}

/**
 * The retryable chip title. No count and no caveat: a mixed batch re-attempts
 * every failure it holds, the missing ones included.
 */
export const UNSAVED_TITLE = "Ratings failed to save · click to retry";

/** The all-missing dialog sentence, agreeing with itself in both numbers. */
export function missingFailureSentence(count: number): string {
  return count === 1
    ? "1 rating could not be saved because the photo is no longer at its path."
    : `${count} ratings could not be saved because the photos are no longer at their paths.`;
}

/**
 * The one recovery instruction. Every surface that reports a missing photo ends
 * on it. Centralised because three hand-written tails drifted apart on the
 * punctuation alone (two commas and an em dash) the first time round.
 *
 * It names the likely cause first — a drive or folder that went away, which the
 * re-check fixes by itself — and only then the case the user has to act on.
 * Each of those bodies reads fact → what it means here → this clause, so the
 * advice always lands last.
 */
export function missingRecovery(count: number): string {
  return count === 1
    ? "Check again once the drive or folder is back and it will save; if the photo was moved or deleted, put it back and rate it again."
    : "Check again once the drive or folder is back and they will save; if the photos were moved or deleted, put them back and rate them again.";
}
