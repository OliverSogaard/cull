import type { ReactNode } from "react";
import type { Filter } from "../types";
import { topOf } from "../utils/filterModes";
import { modGlyph } from "../utils/platform";
import { pickSmartEmptyState } from "../utils/smartEmptyState";

/**
 * Shared markup for the two true "no match" empty states (not-analyzed and
 * filter-empty) — both drop the old `⌀` glyph for a faint desert backdrop
 * instead. The "analyzing" / "analyzed" variants above them are transient
 * or informational rather than "nothing here", so they keep their glyph
 * and skip the backdrop.
 */
function NoMatchEmptyState({
  eyebrow,
  title,
  hint,
}: {
  eyebrow: string;
  title: ReactNode;
  hint: ReactNode;
}) {
  return (
    <div className="cull-empty-state cull-empty-state--desert">
      <div className="cull-empty-state__eyebrow">{eyebrow}</div>
      <div className="cull-empty-state__title">{title}</div>
      <div className="cull-empty-state__hint">{hint}</div>
    </div>
  );
}

/**
 * Centered empty-state shown in loupe / grid when the active filter has zero
 * matches. Small icon,
 * uppercase eyebrow, headline with the missing filter highlighted, and a key
 * hint to switch out.
 */
export function EmptyFilter({
  filter,
  smartCulling,
  smartCullingOnOpen,
  analyzing,
  scoredCount,
  progress,
}: {
  filter: Filter;
  /** `settings.smartCulling` — the master switch. Smart is now a valid filter
   *  state even when off, so this drives the "disabled" empty screen. */
  smartCulling?: boolean;
  /** `settings.smartCullingOnOpen` — whether the pass self-starts; changes
   *  the not-analyzed hint (self-starting passes never need a "press 4"). */
  smartCullingOnOpen?: boolean;
  analyzing?: boolean;
  /** How many frames the smart pass has scored — distinguishes "analyzed,
   *  no obvious calls" (the healthy quiet case) from "never analyzed". */
  scoredCount?: number;
  /** Live pass progress — on a 5000-frame NAS folder the pass runs for many
   *  minutes (by design: it always yields to interactive reads), and without
   *  a count "analyzing" is indistinguishable from "hung". */
  progress?: { done: number; total: number } | null;
}) {
  // The whole "suggested" family (base + verdict sub-modes) has five empty
  // states, and telling them apart is the difference between "working as
  // designed" and "looks broken". All five are NoMatchEmptyState (desert
  // backdrop, no icon circle) — see pickSmartEmptyState for the precedence.
  if (topOf(filter) === "suggested") {
    const state = pickSmartEmptyState({
      smartCulling: smartCulling ?? false,
      autoStart: smartCullingOnOpen ?? false,
      analyzing: analyzing ?? false,
      scoredCount: scoredCount ?? 0,
    });
    switch (state) {
      case "disabled":
        return (
          <NoMatchEmptyState
            eyebrow="Smart culling off"
            title="Smart culling is turned off"
            hint={
              <>
                <kbd>{modGlyph} ,</kbd> for Settings · <kbd>1</kbd> for all
              </>
            }
          />
        );
      case "analyzing":
        // Not done yet — suggestions fill in progressively per chunk.
        return (
          <NoMatchEmptyState
            eyebrow="Analyzing"
            title={
              <>
                Looking for obvious calls
                {progress
                  ? ` · ${progress.done.toLocaleString()} of ${progress.total.toLocaleString()} scored`
                  : ""}
              </>
            }
            hint={
              <>
                fills in as frames are scored · culling comes first · <kbd>1</kbd> for all
              </>
            }
          />
        );
      case "analyzedNoSuggestions":
        // The healthy quiet case: everything scored (or since rated away),
        // nothing worth flagging. An advisory tool only speaks on clear
        // calls — silence is a verdict, whether this filter never had a hit
        // or every hit it had has since been rated.
        return (
          <NoMatchEmptyState
            eyebrow="Analyzed"
            title={<>Analysis done · no suggestions left here ({scoredCount} scored)</>}
            hint={
              <>
                <kbd>1</kbd> for all
              </>
            }
          />
        );
      case "notAnalyzedAutoStart":
        // The pass self-starts — this screen is a blink, no "press 4" needed.
        return (
          <NoMatchEmptyState
            eyebrow="Not analyzed"
            title="No frames have been scored yet"
            hint={
              <>
                <kbd>1</kbd> for all
              </>
            }
          />
        );
      case "notAnalyzedManual":
        // Auto-analyze off: the pass hasn't run, or every chunk failed
        // (drive hiccup) — 5 retries in both cases.
        return (
          <NoMatchEmptyState
            eyebrow="Not analyzed"
            title="No frames have been scored yet"
            hint={
              <>
                <kbd>4</kbd> to analyze · <kbd>1</kbd> for all
              </>
            }
          />
        );
    }
  }
  // Label the user-facing filter name. "All" can never actually be empty (it
  // includes unrated), so falling back to "this" covers the impossible-case.
  const label =
    filter === "keepsFavs"
      ? "Favorites"
      : filter === "keeps"
        ? "Keeps"
        : filter === "unrated"
          ? "Unrated"
          : "this"; // "suggested*" fully handled (and narrowed away) above
  return (
    <NoMatchEmptyState
      eyebrow="No matches"
      title={
        <>
          No images in the <em>{label}</em> filter
        </>
      }
      hint={
        <>
          <kbd>1</kbd> for all
        </>
      }
    />
  );
}
