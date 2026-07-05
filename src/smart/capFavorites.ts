import type { ImageScore } from "../types/ipc";
import type { SmartLevel, Suggestion } from "./deriveVerdict";

/** Aesthetic bar (0..1 scale) a frame must clear to be favorite-eligible.
 *  Calibration-dependent (LAION scores compress mid-scale) — cite the harness
 *  before moving it. */
export const FAVORITE_AESTHETIC = 0.55;
/** Session cap: top max(3, 5% of analyzed), clamped to 15 — favorites must
 *  stay RARE to mean anything. */
const CAP_PCT = 0.05;
const CAP_MIN = 3;
const CAP_MAX = 15;

/**
 * The favorite verdict Tier 1 withholds (spec 3c): candidate = keep-verdict
 * frame (already sharp, nothing negative — deriveVerdict enforced that) with
 * a standout aesthetic; survivors = the session's top-N by aesthetic.
 */
export function capFavorites(
  scores: Readonly<Record<number, ImageScore>>,
  suggestions: Readonly<Record<number, Suggestion>>,
  _level: SmartLevel,
): Set<number> {
  const analyzed = Object.keys(scores).length;
  const cap = Math.min(CAP_MAX, Math.max(CAP_MIN, Math.ceil(analyzed * CAP_PCT)));
  const candidates = Object.entries(scores)
    .map(([idStr, s]) => ({ id: Number(idStr), aesthetic: s.aesthetic }))
    .filter(
      (c): c is { id: number; aesthetic: number } =>
        c.aesthetic != null &&
        c.aesthetic >= FAVORITE_AESTHETIC &&
        suggestions[c.id]?.verdict === "keep",
    )
    .sort((a, b) => b.aesthetic - a.aesthetic);
  return new Set(candidates.slice(0, cap).map((c) => c.id));
}
