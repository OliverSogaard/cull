import { describe, expect, test } from "vitest";
import { deriveVerdict, LEVEL_THRESHOLD } from "./deriveVerdict";
import type { BurstCtx } from "./groupBursts";
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

describe("deriveVerdict", () => {
  test("canonical soft focus rejects on medium with the right reason", () => {
    const s = deriveVerdict(soft(), undefined, "medium");
    expect(s.verdict).toBe("reject");
    expect(s.reasons).toContain("soft focus");
    expect(s.confidence).toBeGreaterThanOrEqual(LEVEL_THRESHOLD.medium);
  });

  test("clipping ALONE never rejects — blown-but-sharp stays un-rejected", () => {
    const s = deriveVerdict(score({ blownPct: 0.95, exposureScore: 0.3 }), undefined, "low");
    expect(s.verdict).not.toBe("reject");
  });

  test("clipping annotates an existing reject and nudges confidence", () => {
    const plain = deriveVerdict(soft(), undefined, "medium");
    const blown = deriveVerdict({ ...soft(), blownPct: 0.4 }, undefined, "medium");
    expect(blown.reasons).toContain("blown highlights");
    expect(blown.confidence).toBeGreaterThan(plain.confidence);
    const crushed = deriveVerdict({ ...soft(), crushedPct: 0.5 }, undefined, "medium");
    expect(crushed.reasons).toContain("crushed shadows");
  });

  test("low AF texture silences soft focus — smooth subjects are unjudgeable", () => {
    const s = deriveVerdict({ ...soft(), afTexture: 0.05 }, undefined, "low");
    expect(s.verdict).toBeNull();
  });

  test("motion blur reason when the shutter heuristic implicates movement", () => {
    const s = deriveVerdict({ ...soft(), motionBlurLikelihood: 0.8 }, undefined, "medium");
    expect(s.verdict).toBe("reject");
    expect(s.reasons).toContain("motion blur");
    expect(s.reasons).not.toContain("soft focus");
  });

  test("absent AF point halves the weight — medium goes silent", () => {
    const s = deriveVerdict({ ...soft(), afValid: false }, undefined, "medium");
    expect(s.verdict).toBeNull();
  });

  test("Laplacian/Tenengrad disagreement distrusts the signal — medium goes silent", () => {
    const s = deriveVerdict({ ...soft(), tenengrad: 0.6 }, undefined, "medium");
    expect(s.verdict).toBeNull();
  });

  test("burst loser with a real margin rejects, position spelled out", () => {
    const s = deriveVerdict(score(), loser(0.3), "medium");
    expect(s.verdict).toBe("reject");
    expect(s.reasons).toContain("not best of burst (2 of 4)");
  });

  test("near-tie burst loser stays SILENT — noise-level margins never ghost-reject", () => {
    const s = deriveVerdict(score(), loser(0.01), "low");
    expect(s.verdict).toBeNull();
  });

  test("the burst winner is never rejected for burst membership", () => {
    const winner: BurstCtx = { group: 0, pos: 1, len: 4, isWinner: true, marginToWinner: 0 };
    const s = deriveVerdict(score(), winner, "low");
    expect(s.verdict).not.toBe("reject");
  });

  test("correlated reasons combine as max-plus-bump, never the product", () => {
    const both = deriveVerdict(soft(), loser(0.2), "medium");
    const softOnly = deriveVerdict(soft(), undefined, "medium");
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
    const medium = deriveVerdict(score(), loser(0.18), "medium");
    const high = deriveVerdict(score(), loser(0.18), "high");
    expect(medium.verdict).toBe("reject");
    expect(high.verdict).toBeNull();
  });

  test("decode failure yields no suggestion at any level", () => {
    const s = deriveVerdict(score({ decodeOk: false, afSharpness: 0 }), undefined, "low");
    expect(s.verdict).toBeNull();
    expect(s.confidence).toBe(0);
  });

  test("sharp + well-exposed frame earns a low-confidence keep; never a favorite", () => {
    const s = deriveVerdict(score({ afSharpness: 0.7, exposureScore: 0.9 }), undefined, "medium");
    expect(s.verdict).toBe("keep");
    expect(s.confidence).toBeLessThan(LEVEL_THRESHOLD.high);
    expect(s.verdict).not.toBe("favorite");
  });

  test("the level gates keeps too — a 56% keep shows on low, silent on medium/high", () => {
    const fiftySix = score({ afSharpness: 0.56, exposureScore: 0.9 });
    expect(deriveVerdict(fiftySix, undefined, "low").verdict).toBe("keep");
    expect(deriveVerdict(fiftySix, undefined, "medium").verdict).toBeNull();
    expect(deriveVerdict(fiftySix, undefined, "high").verdict).toBeNull();
  });

  test("a very strong keep clears even the high bar", () => {
    const s = deriveVerdict(score({ afSharpness: 0.85, exposureScore: 0.9 }), undefined, "high");
    expect(s.verdict).toBe("keep");
    expect(s.confidence).toBeGreaterThanOrEqual(LEVEL_THRESHOLD.high);
  });

  test("a merely-okay frame earns nothing — the tool speaks only on clear calls", () => {
    const s = deriveVerdict(
      score({ afSharpness: 0.3, globalSharpness: 0.3, exposureScore: 0.7 }),
      undefined,
      "medium",
    );
    expect(s.verdict).toBeNull();
  });
});
