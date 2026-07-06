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
  it("treats 2–5★ as a real user rating", () => {
    for (const n of [2, 3, 4, 5]) {
      expect(hasLrcRating(n)).toBe(true);
    }
  });

  it("treats 1★ as a real rating — the backend excludes CULL's stamp at read time", () => {
    // Star ownership lives in Rust now (parse_lrc_rating returns None for
    // cull:fav="star"), so any 1★ that reaches the frontend IS the user's.
    expect(hasLrcRating(1)).toBe(true);
  });

  it("returns false for null / undefined / 0 / negative", () => {
    expect(hasLrcRating(null)).toBe(false);
    expect(hasLrcRating(undefined)).toBe(false);
    expect(hasLrcRating(0)).toBe(false);
    expect(hasLrcRating(-1)).toBe(false);
  });
});
