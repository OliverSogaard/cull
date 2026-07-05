import { describe, expect, test } from "vitest";
import { capFavorites, FAVORITE_AESTHETIC } from "./capFavorites";
import { score as baseScore } from "./testScores";
import type { Suggestion } from "./deriveVerdict";

const keep: Suggestion = { verdict: "keep", confidence: 0.8, reasons: ["sharp, well exposed"] };
const reject: Suggestion = { verdict: "reject", confidence: 0.9, reasons: ["soft focus"] };

const scored = (n: number, aesthetic: (i: number) => number | null) => {
  const scores: Record<number, ReturnType<typeof baseScore>> = {};
  const sugg: Record<number, Suggestion> = {};
  for (let i = 1; i <= n; i++) {
    scores[i] = { ...baseScore(), index: i, aesthetic: aesthetic(i) };
    sugg[i] = keep;
  }
  return { scores, sugg };
};

describe("capFavorites", () => {
  test("keep-verdict frames above the aesthetic bar become favorites, ranked, capped", () => {
    // 100 analyzed frames, aesthetic descending 0.99..0 — cap = clamp(max(3, 5%), 3, 15) = 5.
    const { scores, sugg } = scored(100, (i) => (100 - i) / 100);
    const fav = capFavorites(scores, sugg, "medium");
    expect(fav.size).toBe(5);
    expect(fav.has(1)).toBe(true); // best aesthetic
    expect(fav.has(6)).toBe(false); // first one past the cap
  });

  test("negative verdicts and null aesthetics never qualify", () => {
    const { scores, sugg } = scored(4, () => 0.9);
    sugg[2] = reject;
    scores[3] = { ...scores[3], aesthetic: null };
    const fav = capFavorites(scores, sugg, "medium");
    expect(fav.has(2)).toBe(false);
    expect(fav.has(3)).toBe(false);
  });

  test("below the aesthetic bar never qualifies even under the cap", () => {
    const { scores, sugg } = scored(4, () => FAVORITE_AESTHETIC - 0.01);
    expect(capFavorites(scores, sugg, "medium").size).toBe(0);
  });

  test("small sets keep the floor of 3 (when enough qualify)", () => {
    const { scores, sugg } = scored(10, (i) => 0.6 + i / 100);
    expect(capFavorites(scores, sugg, "medium").size).toBe(3);
  });
});
