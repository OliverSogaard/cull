import type { Rating } from "../types/rating";
import type { ImageScore } from "../types/ipc";
import type { BurstCtx } from "./groupBursts";
import type { SimilarCtx } from "./groupSimilar";

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
const SHARP_REJECT = 0.12;
const SHARP_STRONG = 0.55;
/** Below this AF-crop texture spread, focus is unjudgeable — stay silent. */
const TEXTURE_MIN = 0.12;
/**
 * Heavy-blur (Rule 2b) gates, CALIBRATED 2026-07-06 against the live-test
 * bird (`_MG_8961.CR3`, the frame that motivated this rule) and the 16-file
 * corpus (calibration harness, gsharp/gtex columns):
 *   bird:            gsharp 0.110, tenengrad 0.12, gtex 0.25, afTex 0.01
 *   softest healthy: gsharp 0.153, tenengrad 0.39
 * Gates sit between those bands; tenengrad is the strong separator (3x gap),
 * global sharpness the weak one (1.4x) — the AND of all three plus the
 * gtex >= TEXTURE_MIN content gate keeps false rejects out.
 */
export const HEAVY_BLUR_SHARP = 0.13;
/** Calibrated with HEAVY_BLUR_SHARP (see above): healthy frames measure
 *  >= 0.39 even when soft; a smeared frame has no edges anywhere. (Still
 *  AF-crop-scoped on the wire — empirically that's fine: the bird's AF crop
 *  covers the smeared subject.) */
export const HEAVY_BLUR_TENENGRAD = 0.2;
/** Burst-loser confidence = marginToWinner / MARGIN_SCALE (near-ties → silent). */
const MARGIN_SCALE = 0.25;
/** Similar-set loser: a lookalike group is WEAKER evidence than a camera-
 *  clocked burst — bigger divisor (lower confidence per margin) and a hard
 *  near-tie floor below which we say nothing at all. */
const SIMILAR_MARGIN_SCALE = 0.35;
const SIMILAR_MARGIN_FLOOR = 0.05;
/** Laplacian-vs-Tenengrad gap past which the sharpness signal is distrusted. */
const TENENGRAD_DISAGREE = 0.35;
/** Primary-face prob_open below this fires "closed eyes", margin-scaled —
 *  deliberately far under the 0.5 open/closed line: our eye crops come from
 *  landmark heuristics, so only a CLEAR blink may reject (advisory bias). */
const EYES_CLOSED_REJECT = 0.2;
/** Clipping annotation thresholds — clipping NEVER rejects alone (RAW workflow). */
const BLOWN_NOTE_PCT = 0.25;
const CRUSHED_NOTE_PCT = 0.35;
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
 * Would this frame earn a keep suggestion at `level` on its own? Doubles as
 * burst-winner candidacy: the winner is a smart-culling suggestion ("keep
 * THIS one"), so it must clear the same bar — a burst where nobody does
 * picks no winner at all.
 */
export function keepEligible(score: ImageScore, level: SmartLevel): boolean {
  return (
    score.decodeOk &&
    score.afSharpness >= SHARP_STRONG &&
    score.exposureScore >= 0.6 &&
    Math.min(score.afSharpness, score.exposureScore) >= LEVEL_THRESHOLD[level]
  );
}

/**
 * The advisory cascade. Rejects fire only on judgeable evidence — the costly
 * error is the false reject, so every gate biases toward silence:
 * 1. clipping is annotation-only (RAW recoverability; backlit/high-key intent);
 * 2. soft focus needs texture to judge, is weighted by AF validity, and is
 *    distrusted when the two sharpness operators disagree; when the AF crop
 *    can't judge at all, rule 2b falls back to a full-frame noise-floor
 *    check ("heavy blur") so a giant smeared subject isn't silently missed;
 * 3. burst-loser confidence scales with the margin to the winner (near-ties
 *    are noise, not verdicts);
 * 4. correlated reasons combine as max-plus-bump, never the product.
 * `favorite` is never emitted in Tier 1.
 */
export function deriveVerdict(
  score: ImageScore,
  burst: BurstCtx | undefined,
  similar: SimilarCtx | undefined,
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

  // Rule 2b — heavy blur: a WHOLE-FRAME smear the AF crop couldn't judge
  // (giant blurred subject filling the frame, or an AF point that landed on
  // smooth/empty content — either way Rule 2's afTexture gate fails and
  // softConf stays 0). Evaluated ONLY when Rule 2 stayed silent: the two
  // rules read the SAME underlying blur via different crops, so they are
  // correlated signals — firing both would double-count one defect. The
  // distinguisher for "smeared content" vs. a flat-but-fine scene (sky,
  // bokeh wall) is full-frame luma spread: real content contrast
  // (globalTexture) coexisting with sharpness at the noise floor means the
  // content itself is smeared, not merely smooth. All three gates are
  // AND-ed — false-reject bias means a lone dissenting signal (e.g. Tenengrad
  // disagreeing) keeps this silent. Feeds the SAME combiner slot as softConf
  // (it IS the soft-focus signal, just judged globally instead of at the AF
  // point); reason stays "heavy blur" even when motionBlurLikelihood is high
  // — we don't have enough signal here to tell soft-focus-style heavy blur
  // apart from motion-blur-style heavy blur, so we don't try.
  if (
    softConf === 0 &&
    score.globalTexture >= TEXTURE_MIN &&
    score.globalSharpness < HEAVY_BLUR_SHARP &&
    score.tenengrad < HEAVY_BLUR_TENENGRAD
  ) {
    // Confidence rides tenengrad, the STRONG separator (healthy >= 0.39,
    // smeared ~0.12): zero at 2x the gate, 1 at zero edges. The calibrated
    // bird lands at 0.70 (rejects at Balanced); a barely-through-the-gate
    // frame (ten 0.19) lands at 0.53 (speaks only on Chatty) — boundary
    // caution falls out of the slope. Sharpness-based scaling was too flat:
    // the gates' sharpness band is only 1.4x wide, so even a clear smear
    // scored ~0.15 and never cleared any speaking threshold.
    softConf = clamp01(
      (2 * HEAVY_BLUR_TENENGRAD - score.tenengrad) / (2 * HEAVY_BLUR_TENENGRAD),
    );
    if (softConf > 0) reasons.push("heavy blur");
  }

  // Rule 3 — burst loser, margin-scaled.
  let burstConf = 0;
  if (burst && !burst.isWinner) {
    burstConf = clamp01(burst.marginToWinner / MARGIN_SCALE);
    if (burstConf > 0) reasons.push(`not best of burst (${burst.pos} of ${burst.len})`);
  }

  // Rule 3s — similar-set loser: like the burst rule but stricter (floor +
  // bigger scale), because grouping came from lookalike heuristics, not the
  // camera's burst clock.
  let similarConf = 0;
  if (similar && !similar.isWinner && similar.marginToWinner > SIMILAR_MARGIN_FLOOR) {
    similarConf = clamp01((similar.marginToWinner - SIMILAR_MARGIN_FLOOR) / SIMILAR_MARGIN_SCALE);
    if (similarConf > 0) {
      reasons.push(`not best of similar set (${similar.pos} of ${similar.len})`);
    }
  }

  // Rule 3b — closed eyes on the primary (largest) face, margin-scaled.
  // −1 sentinel = unknown → silent; the borderline band stays silent too.
  let eyesConf = 0;
  const primaryFace = score.faces.reduce(
    (best, f) =>
      f.bbox[2] * f.bbox[3] > (best?.bbox[2] ?? 0) * (best?.bbox[3] ?? 0) ? f : best,
    null as (typeof score.faces)[number] | null,
  );
  if (primaryFace && primaryFace.eyesOpen >= 0 && primaryFace.eyesOpen < EYES_CLOSED_REJECT) {
    eyesConf = clamp01((EYES_CLOSED_REJECT - primaryFace.eyesOpen) / EYES_CLOSED_REJECT);
    if (eyesConf > 0) reasons.push("closed eyes");
  }

  // Conservative stacking: strongest signal plus a small bump per extra —
  // NEVER the product (independence math would inflate near-tie frames).
  const [c0, c1, c2, c3] = [softConf, burstConf, eyesConf, similarConf].sort((a, b) => b - a);
  let conf = c0 + 0.1 * c1 + 0.05 * c2 + 0.05 * c3;

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
  // a keep, gated by the SAME level threshold as rejects (keepEligible). The
  // burst winner rides this rule — its pick is explained here, in the
  // SUGGESTION surface (the rail's Burst section stays purely factual).
  // Never a favorite in Tier 1.
  //
  // Group membership gates the keep itself, not just its wording: a frame
  // that belongs to a burst or similar-set group but is NOT that group's
  // winner must stay silent here, even when individually keep-eligible.
  // Eleven near-identical frames are each individually "sharp, well
  // exposed" — but eleven individually-true keeps are collectively noise
  // inside a lookalike group. The group's keep IS the winner crown; there
  // is exactly one per group. `!burst.isWinner` / `!similar.isWinner` also
  // covers the winner-unknown state (isWinner is false for every member
  // while the group is half-scored or has no eligible member yet), so a
  // premature keep never leaks out before the real winner is known — it
  // self-corrects the moment the winner lands.
  const isNonWinningGroupMember = (burst && !burst.isWinner) || (similar && !similar.isWinner);
  if (keepEligible(score, level) && !isNonWinningGroupMember) {
    const keepConf = Math.min(score.afSharpness, score.exposureScore);
    const keepReasons = ["sharp, well exposed"];
    if (burst?.isWinner) keepReasons.unshift("best of burst");
    if (similar?.isWinner) keepReasons.unshift("best of similar set");
    return { verdict: "keep", confidence: keepConf, reasons: keepReasons };
  }
  return { verdict: null, confidence: 0, reasons: [] };
}
