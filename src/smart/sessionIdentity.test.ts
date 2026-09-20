import { describe, expect, test } from "vitest";
import { isPrunedSubset } from "./sessionIdentity";
import { img } from "./__fixtures__/testScores";

describe("isPrunedSubset", () => {
  test("true when frames were only removed", () => {
    expect(isPrunedSubset([img(0), img(1), img(2)], [img(0), img(2)])).toBe(true);
  });

  test("false for an empty next (session ended)", () => {
    expect(isPrunedSubset([img(0)], [])).toBe(false);
  });

  test("false when nothing was removed or frames were added", () => {
    expect(isPrunedSubset([img(0)], [img(0)])).toBe(false);
    expect(isPrunedSubset([img(0)], [img(0), img(1)])).toBe(false);
  });

  test("false when an id maps to a different path (another folder reusing ids)", () => {
    // Ids restart at 0 per folder, so id alone would call this a prune.
    expect(isPrunedSubset([img(0), img(1)], [img(0, "/other")])).toBe(false);
  });
});
