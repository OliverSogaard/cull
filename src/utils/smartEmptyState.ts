/**
 * Which empty-state variant the Smart filter's `EmptyFilter` branch shows,
 * derived from the smart-culling master switch, the "analyze on open"
 * setting, and where the current pass stands. Pure and extracted from the
 * component so the branching (disabled × analyzing × analyzed × auto-start)
 * is unit-testable without mounting `EmptyFilter`.
 *
 * Precedence, checked in order:
 * 1. `disabled` — the master switch is off. Wins over everything else: a
 *    folder analyzed before the toggle flipped off still shows "off", not
 *    stale results.
 * 2. `analyzing` — a pass is in flight.
 * 3. `analyzedNoSuggestions` — the pass has scored at least one frame and
 *    nothing (currently) matches this filter/sub-filter — covers both
 *    "never had a suggestion" and "every suggested frame got rated away".
 * 4. `notAnalyzedAutoStart` / `notAnalyzedManual` — nothing scored yet;
 *    which hint shows depends on whether the pass self-starts.
 */
export type SmartEmptyStateKind =
  | "disabled"
  | "analyzing"
  | "analyzedNoSuggestions"
  | "notAnalyzedAutoStart"
  | "notAnalyzedManual";

export function pickSmartEmptyState(params: {
  /** `settings.smartCulling` — the master switch. */
  smartCulling: boolean;
  /** `settings.smartCullingOnOpen` — whether the pass self-starts. */
  autoStart: boolean;
  analyzing: boolean;
  /** Frames the pass has scored so far. */
  scoredCount: number;
}): SmartEmptyStateKind {
  const { smartCulling, autoStart, analyzing, scoredCount } = params;
  if (!smartCulling) return "disabled";
  if (analyzing) return "analyzing";
  if (scoredCount > 0) return "analyzedNoSuggestions";
  return autoStart ? "notAnalyzedAutoStart" : "notAnalyzedManual";
}
