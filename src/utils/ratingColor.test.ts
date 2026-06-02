import { describe, expect, it } from "vitest";
import { hasLrcRating, RATING_COLOR } from "./ratingColor";

describe("RATING_COLOR", () => {
  it("has a colour for every rating value", () => {
    expect(RATING_COLOR.keep).toMatch(/^#/);
    expect(RATING_COLOR.reject).toMatch(/^#/);
    expect(RATING_COLOR.favorite).toMatch(/^#/);
  });
});

describe("hasLrcRating", () => {
  // Pre-existing user ratings (2–5★) always count, regardless of CULL rating.
  it("treats 2–5★ as a real user rating", () => {
    for (const n of [2, 3, 4, 5]) {
      expect(hasLrcRating(n, undefined)).toBe(true);
      expect(hasLrcRating(n, "keep")).toBe(true);
      expect(hasLrcRating(n, "reject")).toBe(true);
      expect(hasLrcRating(n, "favorite")).toBe(true);
    }
  });

  it("treats 1★ as a real rating UNLESS CULL marked it as favorite", () => {
    // Lone 1★ on a non-favorite frame is a real LrC rating.
    expect(hasLrcRating(1, undefined)).toBe(true);
    expect(hasLrcRating(1, "keep")).toBe(true);
    expect(hasLrcRating(1, "reject")).toBe(true);
    // 1★ on a CULL favorite is just CULL's own stamp — suppress.
    expect(hasLrcRating(1, "favorite")).toBe(false);
  });

  it("returns false for null / undefined / 0 / negative", () => {
    expect(hasLrcRating(null, undefined)).toBe(false);
    expect(hasLrcRating(undefined, undefined)).toBe(false);
    expect(hasLrcRating(0, undefined)).toBe(false);
    expect(hasLrcRating(-1, undefined)).toBe(false);
  });
});
