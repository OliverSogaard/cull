import { describe, expect, it } from "vitest";
import {
  MISSING_PHOTO_TITLE,
  UNSAVED_TITLE,
  missingCheckAgainLabel,
  missingFailureSentence,
  missingPhotosLabel,
  missingRecovery,
  saveFailureKind,
  unsavedLabel,
} from "./saveStatusCopy";

/**
 * The wording of a failed rating write is told by five surfaces (the status-bar
 * chip, the save-status pill, the quit guard, the leave-to-home warning and the
 * finish dialog). They read it from here so they cannot drift apart — these
 * tests pin the strings themselves.
 */

describe("saveFailureKind", () => {
  it("says 'none' when nothing failed", () => {
    expect(saveFailureKind(0, 0)).toBe("none");
  });

  it("says 'missing' only when every failure is a photo that was not at its path", () => {
    expect(saveFailureKind(1, 1)).toBe("missing");
    expect(saveFailureKind(4, 4)).toBe("missing");
  });

  it("says 'retry' while any failure is an ordinary one", () => {
    expect(saveFailureKind(1, 0)).toBe("retry");
    expect(saveFailureKind(4, 3)).toBe("retry");
  });
});

describe("the missing-photo wording", () => {
  it("counts photos, singular and plural", () => {
    expect(missingPhotosLabel(1)).toBe("1 photo missing");
    expect(missingPhotosLabel(3)).toBe("3 photos missing");
  });

  it("offers the check again on the chip itself", () => {
    expect(missingCheckAgainLabel(1)).toBe("1 photo missing · check again");
    expect(missingCheckAgainLabel(3)).toBe("3 photos missing · check again");
  });

  it("builds the chip label on the same count phrase the dialogs use", () => {
    // The chip and the dialog titles have to say "3 photos missing" the same
    // way; only the trailing offer belongs to the chip.
    for (const count of [1, 2, 7]) {
      expect(missingCheckAgainLabel(count)).toBe(`${missingPhotosLabel(count)} · check again`);
    }
  });

  it("explains what the check again is for", () => {
    expect(MISSING_PHOTO_TITLE).toBe(
      "The photo is not at its path. Check again once the drive or folder is back.",
    );
  });

  it("writes a sentence that agrees with itself", () => {
    expect(missingFailureSentence(1)).toBe(
      "1 rating could not be saved because the photo is no longer at its path.",
    );
    expect(missingFailureSentence(3)).toBe(
      "3 ratings could not be saved because the photos are no longer at their paths.",
    );
  });

  it("always ends on how to recover, in one wording", () => {
    expect(missingRecovery(1)).toBe(
      "Check again once the drive or folder is back and it will save; if the photo was moved or deleted, put it back and rate it again.",
    );
    expect(missingRecovery(3)).toBe(
      "Check again once the drive or folder is back and they will save; if the photos were moved or deleted, put them back and rate them again.",
    );
  });

  it("opens every recovery tail on the check again, never on a dead end", () => {
    // The three dialogs build their body from this one clause. It used to open
    // "Retrying cannot help — ", which stopped being true the moment the manual
    // retry started re-attempting missing writes; pinned here so no surface can
    // quietly go back to telling the user there is nothing to do.
    for (const count of [1, 2, 7]) {
      expect(missingRecovery(count).startsWith("Check again once the drive or folder is back")).toBe(
        true,
      );
      expect(missingRecovery(count)).not.toContain("cannot help");
    }
  });
});

describe("the retryable wording", () => {
  it("keeps the unsaved chip label", () => {
    expect(unsavedLabel(1)).toBe("1 unsaved · retry");
    expect(unsavedLabel(5)).toBe("5 unsaved · retry");
  });

  it("promises the retry without an exception, because there is none", () => {
    // A mixed batch retries everything now, missing photos included, so the
    // title carries no "(n will be skipped)" caveat and needs no count at all.
    expect(UNSAVED_TITLE).toBe("Ratings failed to save · click to retry");
    expect(UNSAVED_TITLE).not.toContain("skip");
  });
});
