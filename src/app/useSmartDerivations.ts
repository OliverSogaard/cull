import { useMemo } from "react";
import type { Img, ImageMetadata, Phase, Rating, Settings } from "../types";
import { useSmartCulling } from "../smart/useSmartCulling";
import { groupBursts } from "../smart/groupBursts";
import { groupSimilar } from "../smart/groupSimilar";
import { buildBurstInputs, buildSimilarInputs } from "../smart/burstInputs";
import { capFavorites } from "../smart/capFavorites";
import { deriveVerdict, keepEligible, type Suggestion } from "../smart/deriveVerdict";

/**
 * Smart culling (advisory) — the pure derivation chain, verbatim from App
 * (grand cleanup Phase 6). The driver owns the chunked, gen-guarded background
 * pass; scores accumulate keyed by Img.id. ALL cross-frame derivation is pure
 * TS below — bursts and verdicts re-derive instantly on settings changes and
 * self-correct as chunks land. Nothing here writes anything, ever
 * (advisory-only invariant). Rated frames need no suggestion: the pass
 * dispatches unrated-only, so it starts from where the user has reached (see
 * useSmartCulling).
 */
export function useSmartDerivations({
  images,
  ratings,
  metadata,
  settings,
  phase,
}: {
  images: Img[];
  ratings: Record<number, Rating>;
  metadata: Record<string, ImageMetadata>;
  settings: Settings;
  phase: Phase;
}) {
  const ratedIds = useMemo(() => {
    const ids = new Set<number>();
    for (const [id, r] of Object.entries(ratings)) if (r) ids.add(Number(id));
    return ids;
  }, [ratings]);
  const {
    scores: qualityScores,
    analyzing: qualityAnalyzing,
    progress: qualityProgress,
    startAnalysis,
  } = useSmartCulling({
    enabled: settings.smartCulling,
    autoStart: settings.smartCullingOnOpen,
    ml: settings.deepAnalysis,
    active: phase === "culling",
    images,
    ratedIds,
    storageMode: settings.storageMode,
  });

  // Bursts are a standing fact about the shoot, NOT a smart-culling feature:
  // grouping inputs come from the EXIF metadata every frame's thumbnail
  // already delivered, upgraded in place by scores (which add the mtime
  // fallback and the sharpness that determines a winner) when the pass runs.
  const burstData = useMemo(
    () => buildBurstInputs(images, qualityScores, metadata),
    [images, qualityScores, metadata],
  );
  // Winner candidacy is SMART CULLING's call: a member must clear the active
  // keep threshold to be pickable, and with the feature off nothing wins —
  // burst detection/boxes stay factual, the "best frame" is advisory. Shared
  // between burstCtx and similarCtx so it's computed exactly once.
  const keepEligibleMap = useMemo(() => {
    const eligible: Record<number, boolean> = {};
    if (settings.smartCulling) {
      for (const [idStr, sc] of Object.entries(qualityScores)) {
        eligible[Number(idStr)] = keepEligible(sc, settings.smartCullingConfidence);
      }
    }
    return eligible;
  }, [qualityScores, settings.smartCulling, settings.smartCullingConfidence]);
  const burstCtx = useMemo(
    () => groupBursts(images, burstData.inputs, burstData.sharp, keepEligibleMap),
    [images, burstData, keepEligibleMap],
  );
  // Similar sets are ALSO a standing fact about the shoot, like bursts: the
  // pHash tier rides every frame's thumbnail (buildSimilarInputs), so groups
  // render with smart culling off too. `qualityScores` here contributes ONLY
  // the embedding-tier upgrade (adjacent frames the pHash tier missed, ML
  // builds only) — never the pHash tier itself (groupSimilar ignores
  // `ImageScore.phash`; see groupSimilar.ts). Winner selection is still smart
  // culling's call: with the pass off there's no `sharp`/`eligible` data, so
  // pickWinner structurally finds no winner — no special-casing needed here.
  const similarData = useMemo(
    () => buildSimilarInputs(images, qualityScores, metadata),
    [images, qualityScores, metadata],
  );
  const similarCtx = useMemo(
    () =>
      groupSimilar(images, similarData, qualityScores, burstCtx, burstData.sharp, keepEligibleMap),
    [images, similarData, qualityScores, burstCtx, burstData.sharp, keepEligibleMap],
  );
  // Only frames with an emitted verdict land in the map — the badge/filter
  // predicate is a simple presence check. Session-capped favorites (spec 3c)
  // overlay a "favorite" verdict onto the top-N standout-aesthetic keeps.
  const suggestions = useMemo(() => {
    if (!settings.smartCulling) return {};
    const out: Record<number, Suggestion> = {};
    for (const [idStr, s] of Object.entries(qualityScores)) {
      const id = Number(idStr);
      const sug = deriveVerdict(
        s,
        burstCtx.get(id),
        similarCtx.get(id),
        settings.smartCullingConfidence,
      );
      if (sug.verdict) out[id] = sug;
    }
    for (const id of capFavorites(qualityScores, out, settings.smartCullingConfidence)) {
      out[id] = {
        ...out[id],
        verdict: "favorite",
        reasons: ["standout aesthetic", ...out[id].reasons],
      };
    }
    return out;
  }, [qualityScores, burstCtx, similarCtx, settings.smartCulling, settings.smartCullingConfidence]);

  // Live suggestion count for the Smart tab label: suggestions on still-
  // unrated frames only (rating one drops it, matching the filter's predicate).
  const liveSuggestionCount = useMemo(() => {
    let n = 0;
    for (const idStr of Object.keys(suggestions)) {
      if (!ratings[Number(idStr)]) n++;
    }
    return n;
  }, [suggestions, ratings]);

  return {
    suggestions,
    burstCtx,
    similarCtx,
    liveSuggestionCount,
    keepEligibleMap,
    qualityScores,
    qualityAnalyzing,
    qualityProgress,
    startAnalysis,
    ratedIds,
  };
}
