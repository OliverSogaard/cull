import { describe, expect, test } from "vitest";
import { capFavorites, FAVORITE_AESTHETIC } from "./capFavorites";
import { score as baseScore } from "./__fixtures__/testScores";
import { deriveVerdict } from "./deriveVerdict";
import type { Suggestion } from "./deriveVerdict";
import type { BurstCtx } from "./groupBursts";

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

  test("two frames in the same burst can't both be favorites — only the winner's keep survives", () => {
    // Both frames are individually keep-eligible and both clear the
    // aesthetic bar, but deriveVerdict now only crowns the winner: the
    // non-winner's suggestion is silent, so it can never reach capFavorites'
    // keep-verdict filter, however good its aesthetic score.
    const winnerCtx: BurstCtx = { group: 0, pos: 1, len: 2, isWinner: true, marginToWinner: 0 };
    const loserCtx: BurstCtx = { group: 0, pos: 2, len: 2, isWinner: false, marginToWinner: 0 };
    const s1 = { ...baseScore(), index: 1, afSharpness: 0.7, exposureScore: 0.9, aesthetic: 0.9 };
    const s2 = { ...baseScore(), index: 2, afSharpness: 0.7, exposureScore: 0.9, aesthetic: 0.95 };
    const scores = { 1: s1, 2: s2 };
    const sugg = {
      1: deriveVerdict(s1, winnerCtx, undefined, "low"),
      2: deriveVerdict(s2, loserCtx, undefined, "low"),
    };
    expect(sugg[1].verdict).toBe("keep");
    expect(sugg[2].verdict).toBeNull();
    const fav = capFavorites(scores, sugg, "low");
    expect(fav.has(1)).toBe(true);
    expect(fav.has(2)).toBe(false);
    expect(fav.size).toBe(1);
  });
});
