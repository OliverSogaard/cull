import { describe, expect, it } from "vitest";
import { withChanges, withMeta } from "./withChanges";

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

describe("withMeta — the generic map update for stars and labels", () => {
  it("sets, replaces and DELETES, never storing undefined", () => {
    // The delete is the whole point, exactly as in withChanges: an absent key
    // is how "no star" and "no label" are spelled, so a stored `undefined`
    // would make `id in stars` and Object.keys(...).length lie.
    const before = { 1: 3, 2: 5 } as Record<number, number>;
    const after = withMeta(before, [
      { imgId: 1, after: 4 },
      { imgId: 2, after: undefined },
      { imgId: 7, after: 1 },
    ]);
    expect(after).toEqual({ 1: 4, 7: 1 });
    expect(Object.keys(after)).not.toContain("2");
    expect(before).toEqual({ 1: 3, 2: 5 }); // input untouched
  });

  it("an empty change list returns an equal copy, not the same object", () => {
    const before = { 1: "red" } as Record<number, string>;
    const after = withMeta(before, []);
    expect(after).toEqual(before);
    expect(after).not.toBe(before);
  });
});
