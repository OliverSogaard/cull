import { describe, expect, it } from "vitest";
import { withChanges } from "./withChanges";

describe("withChanges", () => {
  it("applies each change to a COPY, leaving the input untouched", () => {
    const before = { 0: "keep", 1: "reject" } as const;
    const after = withChanges(before, [{ imgId: 1, after: "favorite" }]);
    expect(after).toEqual({ 0: "keep", 1: "favorite" });
    expect(before).toEqual({ 0: "keep", 1: "reject" });
    expect(after).not.toBe(before);
  });

  it("DELETES the key when a change clears a rating", () => {
    // Not `{ 1: undefined }`: the key must be gone, or every
    // `id in ratings` / Object.keys consumer still counts the frame as rated.
    const after = withChanges({ 0: "keep", 1: "reject" }, [{ imgId: 1, after: undefined }]);
    // `Object.hasOwn` (ES2022) isn't in this project's `lib` (ES2020, tsconfig.json:5);
    // this is the ES5-safe equivalent own-property check.
    expect(Object.prototype.hasOwnProperty.call(after, "1")).toBe(false);
    expect(after).toEqual({ 0: "keep" });
  });

  it("applies changes in order, so a later one wins", () => {
    const after = withChanges({}, [
      { imgId: 7, after: "keep" },
      { imgId: 7, after: "reject" },
    ]);
    expect(after).toEqual({ 7: "reject" });
  });

  it("an empty changes array still returns a fresh copy", () => {
    const before = { 3: "keep" } as const;
    const after = withChanges(before, []);
    expect(after).toEqual(before);
    expect(after).not.toBe(before);
  });
});
