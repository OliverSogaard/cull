import { describe, expect, it } from "vitest";
import {
  MISSING_PHOTO_TITLE,
  missingFailureSentence,
  missingPhotosLabel,
  missingRecovery,
  missingSkippedNote,
  saveFailureKind,
  unsavedLabel,
  unsavedTitle,
} from "./saveStatusCopy";

/**
 * The wording of a failed rating write is told by four surfaces (the status-bar
 * chip, the save-status pill, the quit guard and the leave-to-home warning).
 * They read it from here so they cannot drift apart — these tests pin the
 * strings themselves.
 */

describe("saveFailureKind", () => {
  it("says 'none' when nothing failed", () => {
    expect(saveFailureKind(0, 0)).toBe("none");
  });

  it("says 'missing' only when every failure is a photo that is gone", () => {
    expect(saveFailureKind(1, 1)).toBe("missing");
    expect(saveFailureKind(4, 4)).toBe("missing");
  });

  it("says 'retry' while any failure could still succeed", () => {
    expect(saveFailureKind(1, 0)).toBe("retry");
    expect(saveFailureKind(4, 3)).toBe("retry");
  });
});

describe("the missing-photo wording", () => {
  it("counts photos, singular and plural", () => {
    expect(missingPhotosLabel(1)).toBe("1 photo missing");
    expect(missingPhotosLabel(3)).toBe("3 photos missing");
  });

  it("explains why a retry is not offered", () => {
    expect(MISSING_PHOTO_TITLE).toBe(
      "The photo is no longer at its path, so its rating could not be saved.",
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
    expect(missingRecovery(1)).toBe("Retrying cannot help — put the photo back and rate it again.");
    expect(missingRecovery(3)).toBe(
      "Retrying cannot help — put the photos back and rate them again.",
    );
  });

  it("punctuates every 'Retrying cannot help' tail the same way", () => {
    // The three surfaces build their body from this one clause, so the em dash
    // (never a comma) is settled here rather than in each of them.
    for (const count of [1, 2, 7]) {
      expect(missingRecovery(count).startsWith("Retrying cannot help — ")).toBe(true);
    }
  });
});

describe("the retryable wording", () => {
  it("keeps the unsaved chip label", () => {
    expect(unsavedLabel(1)).toBe("1 unsaved · retry");
    expect(unsavedLabel(5)).toBe("5 unsaved · retry");
  });

  it("warns in the title when part of the batch can never be retried", () => {
    expect(unsavedTitle(0)).toBe("Ratings failed to save · click to retry");
    expect(unsavedTitle(1)).toBe(
      "Ratings failed to save · click to retry (1 missing photo will be skipped)",
    );
    expect(unsavedTitle(2)).toBe(
      "Ratings failed to save · click to retry (2 missing photos will be skipped)",
    );
  });

  it("notes the skipped photos in prose, and says nothing when there are none", () => {
    expect(missingSkippedNote(0)).toBe("");
    expect(missingSkippedNote(1)).toBe("1 of them is a missing photo, which a retry will skip.");
    expect(missingSkippedNote(2)).toBe("2 of them are missing photos, which a retry will skip.");
  });
});
