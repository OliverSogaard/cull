import { describe, expect, it } from "vitest";
import { isPermanentWriteError, MISSING_SOURCE_PREFIX } from "./writeFailure";

describe("isPermanentWriteError", () => {
  it("recognises the backend's missing-source refusal (string or Error)", () => {
    expect(isPermanentWriteError(`${MISSING_SOURCE_PREFIX} C:\\shoot\\_rejected\\a.cr3`)).toBe(true);
    expect(isPermanentWriteError(new Error("source missing: /v/a.cr3 is not a file"))).toBe(true);
  });

  it("treats every other failure as transient (retry schedule applies)", () => {
    expect(isPermanentWriteError("rename xmp: EACCES")).toBe(false);
    expect(isPermanentWriteError("stat source /v/a.cr3: EIO")).toBe(false);
    expect(isPermanentWriteError(undefined)).toBe(false);
  });
});
