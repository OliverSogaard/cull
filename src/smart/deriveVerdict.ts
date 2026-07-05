import type { Rating } from "../types/rating";
import type { ImageScore } from "../types/ipc";
import type { BurstCtx } from "./groupBursts";

/** An advisory suggestion — never persisted, superseded in place by a real rating. */
export type Suggestion = {
  verdict: Rating | null;
  /** 0..1; shown only in the loupe/ExifRail. */
  confidence: number;
  reasons: string[];
};

export type SmartLevel = "low" | "medium" | "high";

/**
 * Soft-focus reject line for the noise-normalized afSharpness. Calibrated DOWN
 * from the plan's 0.15 draft: the Phase-1 harness false-rejected a kept frame
 * at 0.148 while true user-rejects sat at 0.56 (composition — correctly silent).
 */
export const SHARP_REJECT = 0.12;
export const SHARP_STRONG = 0.55;
/** Below this AF-crop texture spread, focus is unjudgeable — stay silent. */
export const TEXTURE_MIN = 0.12;
/** Burst-loser confidence = marginToWinner / MARGIN_SCALE (near-ties → silent). */
export const MARGIN_SCALE = 0.25;
/** Laplacian-vs-Tenengrad gap past which the sharpness signal is distrusted. */
export const TENENGRAD_DISAGREE = 0.35;
/** Clipping annotation thresholds — clipping NEVER rejects alone (RAW workflow). */
export const BLOWN_NOTE_PCT = 0.25;
export const CRUSHED_NOTE_PCT = 0.35;
/** Minimum confidence to SPEAK (reject and keep alike), per
 *  smartCullingConfidence level — High means fewer, surer suggestions of
 *  every kind, exactly what the settings copy promises. */
export const LEVEL_THRESHOLD: Record<SmartLevel, number> = {
  low: 0.5,
  medium: 0.65,
  high: 0.8,
};

const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1);

/**
 * The advisory cascade. Rejects fire only on judgeable evidence — the costly
 * error is the false reject, so every gate biases toward silence:
 * 1. clipping is annotation-only (RAW recoverability; backlit/high-key intent);
 * 2. soft focus needs texture to judge, is weighted by AF validity, and is
 *    distrusted when the two sharpness operators disagree;
 * 3. burst-loser confidence scales with the margin to the winner (near-ties
 *    are noise, not verdicts);
 * 4. correlated reasons combine as max-plus-bump, never the product.
 * `favorite` is never emitted in Tier 1.
 */
export function deriveVerdict(
  score: ImageScore,
  burst: BurstCtx | undefined,
  level: SmartLevel,
): Suggestion {
  if (!score.decodeOk) return { verdict: null, confidence: 0, reasons: [] };
  const reasons: string[] = [];

  // Rule 2 — soft focus / motion blur (needs judgeable texture).
  let softConf = 0;
  if (score.afSharpness < SHARP_REJECT && score.afTexture >= TEXTURE_MIN) {
    softConf = (SHARP_REJECT - score.afSharpness) / SHARP_REJECT;
    if (!score.afValid) softConf *= 0.5;
    if (Math.abs(score.tenengrad - score.afSharpness) > TENENGRAD_DISAGREE) softConf *= 0.6;
    softConf = clamp01(softConf);
    if (softConf > 0) {
      reasons.push(score.motionBlurLikelihood > 0.5 ? "motion blur" : "soft focus");
    }
  }

  // Rule 3 — burst loser, margin-scaled.
  let burstConf = 0;
  if (burst && !burst.isWinner) {
    burstConf = clamp01(burst.marginToWinner / MARGIN_SCALE);
    if (burstConf > 0) reasons.push(`not best of burst (${burst.pos} of ${burst.len})`);
  }

  // Both signals derive from afSharpness — max plus a small bump, NOT the
  // product (independence would inflate exactly the near-tie frames).
  let conf =
    softConf > 0 && burstConf > 0
      ? Math.max(softConf, burstConf) + 0.1 * Math.min(softConf, burstConf)
      : Math.max(softConf, burstConf);

  if (conf > 0) {
    // Rule 1 — clipping annotates a live reject; it NEVER rejects alone.
    if (score.blownPct >= BLOWN_NOTE_PCT) {
      reasons.push("blown highlights");
      conf += 0.05;
    }
    if (score.crushedPct >= CRUSHED_NOTE_PCT) {
      reasons.push("crushed shadows");
      conf += 0.05;
    }
    conf = clamp01(conf);
    return conf >= LEVEL_THRESHOLD[level]
      ? { verdict: "reject", confidence: conf, reasons }
      : { verdict: null, confidence: conf, reasons };
  }

  // Rule 4 — nothing negative fired: a clearly sharp, well-exposed frame earns
  // a keep, gated by the SAME level threshold as rejects. Never a favorite in
  // Tier 1.
  if (score.afSharpness >= SHARP_STRONG && score.exposureScore >= 0.6) {
    const keepConf = Math.min(score.afSharpness, score.exposureScore);
    if (keepConf >= LEVEL_THRESHOLD[level]) {
      return { verdict: "keep", confidence: keepConf, reasons: ["sharp, well exposed"] };
    }
  }
  return { verdict: null, confidence: 0, reasons: [] };
}
