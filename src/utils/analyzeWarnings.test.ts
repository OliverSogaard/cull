import { describe, expect, it } from "vitest";
import { summarizeAnalyzeWarnings } from "./analyzeWarnings";

describe("summarizeAnalyzeWarnings", () => {
  it("is null when nothing went wrong", () => {
    expect(
      summarizeAnalyzeWarnings({ unreadableDirs: [], restoreErrors: [], restoreErrorCount: 0 }),
    ).toBeNull();
  });
  it("labels folders and ratings with correct plurals and lists the detail", () => {
    const w = summarizeAnalyzeWarnings({
      unreadableDirs: ["D:\\shoot\\b: access denied"],
      restoreErrors: ["D:\\shoot\\a.xmp: EIO"],
      restoreErrorCount: 3,
    });
    expect(w?.label).toBe("1 folder not listed · 3 ratings not restored");
    expect(w?.detail).toContain("D:\\shoot\\b: access denied");
    expect(w?.detail).toContain("…and 2 more");
    expect(w?.detail).toContain("click to dismiss");
  });
  it("omits the part that is clean", () => {
    expect(
      summarizeAnalyzeWarnings({
        unreadableDirs: [],
        restoreErrors: ["x: y"],
        restoreErrorCount: 1,
      })?.label,
    ).toBe("1 rating not restored");
  });
});
