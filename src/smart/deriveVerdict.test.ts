import { describe, expect, test } from "vitest";
import { deriveVerdict, LEVEL_THRESHOLD } from "./deriveVerdict";
import type { BurstCtx } from "./groupBursts";
import type { SimilarCtx } from "./groupSimilar";
import { score } from "./testScores";

const loser = (margin: number): BurstCtx => ({
  group: 0,
  pos: 2,
  len: 4,
  isWinner: false,
  marginToWinner: margin,
});

/** Clearly soft, judgeable, signals agreeing — the canonical soft-focus reject. */
const soft = () =>
  score({ afSharpness: 0.02, tenengrad: 0.05, afTexture: 0.5, globalSharpness: 0.05 });

/** Baseline score for comparison tests — healthy, judgeable, but below keep eligibility. */
const baseScore = () => score({ afSharpness: 0.3 });

/** Score that passes keep eligibility — sharp, well-exposed. */
const keepableScore = () => score({ afSharpness: 0.7, exposureScore: 0.9 });

describe("deriveVerdict", () => {
  test("canonical soft focus rejects on medium with the right reason", () => {
    const s = deriveVerdict(soft(), undefined, undefined, "medium");
    expect(s.verdict).toBe("reject");
    expect(s.reasons).toContain("soft focus");
    expect(s.confidence).toBeGreaterThanOrEqual(LEVEL_THRESHOLD.medium);
  });

  test("clipping ALONE never rejects — blown-but-sharp stays un-rejected", () => {
    const s = deriveVerdict(score({ blownPct: 0.95, exposureScore: 0.3 }), undefined, undefined, "low");
    expect(s.verdict).not.toBe("reject");
  });

  test("clipping annotates an existing reject and nudges confidence", () => {
    const plain = deriveVerdict(soft(), undefined, undefined, "medium");
    const blown = deriveVerdict({ ...soft(), blownPct: 0.4 }, undefined, undefined, "medium");
    expect(blown.reasons).toContain("blown highlights");
    expect(blown.confidence).toBeGreaterThan(plain.confidence);
    const crushed = deriveVerdict({ ...soft(), crushedPct: 0.5 }, undefined, undefined, "medium");
    expect(crushed.reasons).toContain("crushed shadows");
  });

  test("low AF texture silences soft focus — smooth subjects are unjudgeable", () => {
    const s = deriveVerdict({ ...soft(), afTexture: 0.05 }, undefined, undefined, "low");
    expect(s.verdict).toBeNull();
  });

  test("motion blur reason when the shutter heuristic implicates movement", () => {
    const s = deriveVerdict({ ...soft(), motionBlurLikelihood: 0.8 }, undefined, undefined, "medium");
    expect(s.verdict).toBe("reject");
    expect(s.reasons).toContain("motion blur");
    expect(s.reasons).not.toContain("soft focus");
  });

  test("absent AF point halves the weight — medium goes silent", () => {
    const s = deriveVerdict({ ...soft(), afValid: false }, undefined, undefined, "medium");
    expect(s.verdict).toBeNull();
  });

  test("Laplacian/Tenengrad disagreement distrusts the signal — medium goes silent", () => {
    const s = deriveVerdict({ ...soft(), tenengrad: 0.6 }, undefined, undefined, "medium");
    expect(s.verdict).toBeNull();
  });

  test("burst loser with a real margin rejects, position spelled out", () => {
    const s = deriveVerdict(score(), loser(0.3), undefined, "medium");
    expect(s.verdict).toBe("reject");
    expect(s.reasons).toContain("not best of burst (2 of 4)");
  });

  test("near-tie burst loser stays SILENT — noise-level margins never ghost-reject", () => {
    const s = deriveVerdict(score(), loser(0.01), undefined, "low");
    expect(s.verdict).toBeNull();
  });

  test("the burst winner is never rejected for burst membership", () => {
    const winner: BurstCtx = { group: 0, pos: 1, len: 4, isWinner: true, marginToWinner: 0 };
    const s = deriveVerdict(score(), winner, undefined, "low");
    expect(s.verdict).not.toBe("reject");
  });

  test("correlated reasons combine as max-plus-bump, never the product", () => {
    const both = deriveVerdict(soft(), loser(0.2), undefined, "medium");
    const softOnly = deriveVerdict(soft(), undefined, undefined, "medium");
    const burstConf = Math.min(0.2 / 0.25, 1);
    const product = 1 - (1 - softOnly.confidence) * (1 - burstConf);
    expect(both.confidence).toBeLessThan(product);
    expect(both.confidence).toBeGreaterThanOrEqual(Math.max(softOnly.confidence, burstConf));
    expect(both.reasons).toEqual(
      expect.arrayContaining(["soft focus", "not best of burst (2 of 4)"]),
    );
  });

  test("confidence levels gate rejects: same frame flips medium→high", () => {
    // Margin 0.18/0.25 → 0.72: above medium (0.65), below high (0.8).
    const medium = deriveVerdict(score(), loser(0.18), undefined, "medium");
    const high = deriveVerdict(score(), loser(0.18), undefined, "high");
    expect(medium.verdict).toBe("reject");
    expect(high.verdict).toBeNull();
  });

  test("decode failure yields no suggestion at any level", () => {
    const s = deriveVerdict(score({ decodeOk: false, afSharpness: 0 }), undefined, undefined, "low");
    expect(s.verdict).toBeNull();
    expect(s.confidence).toBe(0);
  });

  test("sharp + well-exposed frame earns a low-confidence keep; never a favorite", () => {
    const s = deriveVerdict(score({ afSharpness: 0.7, exposureScore: 0.9 }), undefined, undefined, "medium");
    expect(s.verdict).toBe("keep");
    expect(s.confidence).toBeLessThan(LEVEL_THRESHOLD.high);
    expect(s.verdict).not.toBe("favorite");
  });

  test("the level gates keeps too — a 56% keep shows on low, silent on medium/high", () => {
    const fiftySix = score({ afSharpness: 0.56, exposureScore: 0.9 });
    expect(deriveVerdict(fiftySix, undefined, undefined, "low").verdict).toBe("keep");
    expect(deriveVerdict(fiftySix, undefined, undefined, "medium").verdict).toBeNull();
    expect(deriveVerdict(fiftySix, undefined, undefined, "high").verdict).toBeNull();
  });

  test("a very strong keep clears even the high bar", () => {
    const s = deriveVerdict(score({ afSharpness: 0.85, exposureScore: 0.9 }), undefined, undefined, "high");
    expect(s.verdict).toBe("keep");
    expect(s.confidence).toBeGreaterThanOrEqual(LEVEL_THRESHOLD.high);
  });

  test("a burst non-winner never earns a keep, even when keep-eligible — only the winner is crowned", () => {
    // marginToWinner: 0 + isWinner: false is BOTH the genuine-tie case and the
    // half-scored/no-eligible-winner case (pickWinner's winnerIdx === -1) —
    // either way this frame is not the crowned winner and must stay silent.
    const s = deriveVerdict(keepableScore(), loser(0), undefined, "low");
    expect(s.verdict).toBeNull();
    expect(s.confidence).toBe(0);
  });

  test("a burst winner keeps exactly as before: keep verdict, 'best of burst' reason", () => {
    const winner: BurstCtx = { group: 0, pos: 1, len: 4, isWinner: true, marginToWinner: 0 };
    const s = deriveVerdict(keepableScore(), winner, undefined, "low");
    expect(s.verdict).toBe("keep");
    expect(s.reasons).toContain("best of burst");
  });

  test("clearly closed eyes reject on medium with the right reason (Phase 3b)", () => {
    const s = deriveVerdict(
      score({
        afSharpness: 0.7,
        exposureScore: 0.9,
        faces: [{ bbox: [0.4, 0.3, 0.2, 0.25], eyesOpen: 0.02, faceSharpness: 0.7 }],
      }),
      undefined,
      undefined,
      "medium",
    );
    expect(s.verdict).toBe("reject");
    expect(s.reasons).toContain("closed eyes");
  });

  test("borderline eye probability stays silent — no reject, keep can fire", () => {
    const s = deriveVerdict(
      score({
        afSharpness: 0.7,
        exposureScore: 0.9,
        faces: [{ bbox: [0.4, 0.3, 0.2, 0.25], eyesOpen: 0.45, faceSharpness: 0.7 }],
      }),
      undefined,
      undefined,
      "medium",
    );
    expect(s.verdict).toBe("keep");
  });

  test("unknown eye state (sentinel) never fires the closed-eyes rule", () => {
    const s = deriveVerdict(
      score({
        afSharpness: 0.7,
        exposureScore: 0.9,
        faces: [{ bbox: [0.4, 0.3, 0.2, 0.25], eyesOpen: -1, faceSharpness: 0.7 }],
      }),
      undefined,
      undefined,
      "low",
    );
    expect(s.verdict).toBe("keep");
  });

  test("closed eyes stack with soft focus via max-plus-bump, not product", () => {
    const withEyes = deriveVerdict(
      {
        ...soft(),
        faces: [{ bbox: [0.4, 0.3, 0.2, 0.25], eyesOpen: 0.0, faceSharpness: 0.05 }],
      },
      undefined,
      undefined,
      "medium",
    );
    const plain = deriveVerdict(soft(), undefined, undefined, "medium");
    expect(withEyes.verdict).toBe("reject");
    expect(withEyes.reasons).toContain("closed eyes");
    expect(withEyes.confidence).toBeGreaterThan(plain.confidence);
    expect(withEyes.confidence).toBeLessThanOrEqual(1);
  });

  test("a merely-okay frame earns nothing — the tool speaks only on clear calls", () => {
    const s = deriveVerdict(
      score({ afSharpness: 0.3, globalSharpness: 0.3, exposureScore: 0.7 }),
      undefined,
      undefined,
      "medium",
    );
    expect(s.verdict).toBeNull();
  });
});

describe("similar-set verdicts", () => {
  const similarLoser = (margin: number): SimilarCtx => ({
    group: 0,
    pos: 2,
    len: 3,
    isWinner: false,
    marginToWinner: margin,
  });

  test("clear similar-set loser gets a margin-scaled reject reason", () => {
    const s = deriveVerdict(baseScore(), undefined, similarLoser(0.4), "low");
    expect(s.reasons).toContain("not best of similar set (2 of 3)");
    expect(s.verdict).toBe("reject");
  });

  test("near-tie similar loser stays silent (stricter floor than bursts)", () => {
    const s = deriveVerdict(baseScore(), undefined, similarLoser(0.04), "low");
    expect(s.reasons).not.toContain("not best of similar set (2 of 3)");
    expect(s.confidence).toBe(0);
  });

  test("similar margin confidence is weaker than the same burst margin", () => {
    const burstLoser = { group: 0, pos: 2, len: 3, isWinner: false, marginToWinner: 0.2 };
    const viaBurst = deriveVerdict(baseScore(), burstLoser, undefined, "low");
    const viaSimilar = deriveVerdict(baseScore(), undefined, similarLoser(0.2), "low");
    expect(viaSimilar.confidence).toBeLessThan(viaBurst.confidence);
  });

  test("similar winner's keep says so", () => {
    const winner = { group: 0, pos: 1, len: 3, isWinner: true, marginToWinner: 0 };
    const s = deriveVerdict(keepableScore(), undefined, winner, "low");
    expect(s.verdict).toBe("keep");
    expect(s.reasons).toContain("best of similar set");
  });

  test("a similar-set non-winner never earns a keep, even when keep-eligible — only the winner is crowned", () => {
    // Same tie/half-scored logic as bursts: isWinner false + marginToWinner 0
    // means this frame is not (yet, or ever) the group's crowned winner.
    const s = deriveVerdict(keepableScore(), undefined, similarLoser(0), "low");
    expect(s.verdict).toBeNull();
    expect(s.confidence).toBe(0);
  });

  test("all-equal similar set (e.g. an 11-up lookalike run): only the winner keeps, everyone else stays silent", () => {
    // Regression for the live-test finding: eleven near-identical frames each
    // individually keep-eligible must NOT each earn a keep ghost — exactly
    // one (the winner) is crowned, the rest are silent.
    const results = Array.from({ length: 11 }, (_, i) =>
      deriveVerdict(
        keepableScore(),
        undefined,
        { group: 0, pos: i + 1, len: 11, isWinner: i === 0, marginToWinner: 0 },
        "low",
      ),
    );
    const keeps = results.filter((r) => r.verdict === "keep");
    expect(keeps).toHaveLength(1);
    expect(results.filter((r) => r.verdict === null)).toHaveLength(10);
  });
});
