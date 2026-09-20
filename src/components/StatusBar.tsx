import { memo, type Dispatch, type SetStateAction } from "react";
import { ArrowRight, Check, Star, TriangleAlert, X as XIcon } from "lucide-react";
import type { Filter, Rating } from "../types";
import type { useChipsTooltipVisibility } from "../hooks/useChipsTooltipVisibility";
import { cycleFilter, topOf } from "../utils/filterModes";
import { modCombo } from "../utils/platform";
import {
  MISSING_PHOTO_TITLE,
  UNSAVED_TITLE,
  missingCheckAgainLabel,
  saveFailureKind,
  unsavedLabel,
} from "../utils/saveStatusCopy";
import { ICON } from "./icons";
import { verdictGlyph } from "./verdictGlyph";

type ChipsTooltip = ReturnType<typeof useChipsTooltipVisibility>;

export type OverlayToggle = { on: boolean; toggle: () => void };

/** The frame under judgement. `rating` is null in compare (no verdict pill there);
 *  compare navigates candidates, so it carries its own position pair (-1 = unresolved). */
export type StatusBarFrame = {
  filename: string | null;
  rating: Rating | null;
  isZooming: boolean;
  zoomLevel: number;
  scrubbing: boolean;
  scrubSpeed: number;
  compareMode: boolean;
  comparePos: number;
  compareCount: number;
};

/** The five overlay chips. `visible` is false in grid — they don't apply there. */
export type StatusBarOverlays = {
  visible: boolean;
  exif: OverlayToggle;
  clipping: OverlayToggle;
  peaking: OverlayToggle;
  composition: OverlayToggle;
  thumbs: OverlayToggle;
};

export type StatusBarSelection = { gridVisible: boolean; selectedCount: number };

/** XMP write durability: in-flight writes, failed writes (`missingCount` = the
 *  permanent subset whose photo is gone), and the retry. */
export type StatusBarSave = {
  savingCount: number;
  failedCount: number;
  missingCount: number;
  retryFailed: () => void;
};

/** The filter tabs and what they print. `smartCulling` is the SETTING (it gates the
 *  lazy `startAnalysis()`), not the analysis state; `chipsTooltip` is passed whole. */
export type StatusBarFilter = {
  filter: Filter;
  setFilter: Dispatch<SetStateAction<Filter>>;
  stats: { total: number; unrated: number; keeps: number };
  qualityAnalyzing: boolean;
  qualityProgress: { done: number; total: number } | null;
  smartCulling: boolean;
  startAnalysis: () => void;
  suggestionCount: number;
  chipsTooltip: ChipsTooltip;
  positionInFilter: number;
  visibleCount: number;
};

/** The act-on-the-cull chip. */
export type StatusBarSession = {
  openActions: () => void;
  actionsOpen: boolean;
  rejectedCount: number;
};

export type StatusBarProps = {
  frame: StatusBarFrame;
  overlays: StatusBarOverlays;
  selection: StatusBarSelection;
  save: StatusBarSave;
  filter: StatusBarFilter;
  session: StatusBarSession;
};

/**
 * The bottom status bar. It renders inside each culling view's flex column
 * AFTER the thumb strip (the last row, with a border-top). The top chrome row
 * above just holds the brand block and window controls, like a title bar.
 *
 * Layout (left → right):
 *   filename · MP  ·  verdict pill (glyph + label)
 *   overlay cluster (i h p o t — circular toggle chips, on/off state)
 *   spacer
 *   position N / M  ·  filter tabs (loupe + grid)  ·  finish button
 */
export const StatusBar = memo(function StatusBar({
  frame,
  overlays,
  selection,
  save,
  filter,
  session,
}: StatusBarProps) {
  const verdictLabel: Record<Rating, string> = {
    keep: "Keep",
    reject: "Reject",
    favorite: "Fav",
  };
  const verdictCls: Record<Rating, string> = {
    keep: "cull-statusbar__verdict--keep",
    reject: "cull-statusbar__verdict--reject",
    favorite: "cull-statusbar__verdict--fav",
  };
  const totalKeeps = filter.stats.keeps; // includes favorites
  // Both kinds of failure are one button running one action (retryFailed);
  // only the words change, because a missing photo is usually a drive that
  // went away rather than a write that won't take (see utils/saveStatusCopy).
  const failureKind = saveFailureKind(save.failedCount, save.missingCount);
  return (
    <footer className="cull-statusbar">
      <div className="cull-statusbar__left">
        {frame.filename && (
          <span className="cull-statusbar__filename">
            <span className="cull-statusbar__filename-name">{frame.filename}</span>
          </span>
        )}
        {frame.rating && (
          <span
            className={`cull-statusbar__verdict ${verdictCls[frame.rating]}`}
            aria-label={verdictLabel[frame.rating]}
          >
            <span className="cull-statusbar__verdict-glyph" aria-hidden>
              {verdictGlyph(frame.rating, 9)}
            </span>
            {verdictLabel[frame.rating]}
          </span>
        )}
        {frame.isZooming && (
          <span className="chip chip--soft chip--accent cull-statusbar__chip">
            zoom {frame.zoomLevel}:1
          </span>
        )}
        {frame.scrubbing && (
          <span className="cull-statusbar__scrub" aria-label="scrubbing">
            <ArrowRight className="cull-statusbar__scrub-arrow" {...ICON.sm} aria-hidden />
            Scrubbing
            {frame.scrubSpeed > 1 && (
              <span className="chip chip--soft chip--accent cull-statusbar__scrubspeed">
                {frame.scrubSpeed}×
              </span>
            )}
          </span>
        )}
        {/* Overlay cluster — five circular toggle chips. Hidden in grid (those
            overlays don't apply there). The thumb-strip chip (t) shows in
            loupe / compare only too. */}
        {overlays.visible && (
          <div className="cull-statusbar__overlay-cluster" aria-label="overlays">
            <button
              type="button"
              className={`cull-statusbar__ov${overlays.exif.on ? " is-on" : ""}`}
              onClick={overlays.exif.toggle}
              title="i · info"
              aria-pressed={overlays.exif.on}
            >
              i
            </button>
            <button
              type="button"
              className={`cull-statusbar__ov${overlays.clipping.on ? " is-on" : ""}`}
              onClick={overlays.clipping.toggle}
              title="h · clipping"
              aria-pressed={overlays.clipping.on}
            >
              h
            </button>
            <button
              type="button"
              className={`cull-statusbar__ov${overlays.peaking.on ? " is-on" : ""}`}
              onClick={overlays.peaking.toggle}
              title="p · focus peaking"
              aria-pressed={overlays.peaking.on}
            >
              p
            </button>
            <button
              type="button"
              className={`cull-statusbar__ov${overlays.composition.on ? " is-on" : ""}`}
              onClick={overlays.composition.toggle}
              title="o · thirds"
              aria-pressed={overlays.composition.on}
            >
              o
            </button>
            <button
              type="button"
              className={`cull-statusbar__ov${overlays.thumbs.on ? " is-on" : ""}`}
              onClick={overlays.thumbs.toggle}
              title="t · thumb strip"
              aria-pressed={overlays.thumbs.on}
            >
              t
            </button>
          </div>
        )}
        {selection.gridVisible && selection.selectedCount >= 1 && (
          <span
            className="chip cull-statusbar__multi"
            title="Selection · rating keys apply to all selected"
          >
            {selection.selectedCount} selected
          </span>
        )}
        {failureKind !== "none" ? (
          <button
            type="button"
            className="cull-statusbar__unsaved"
            onClick={save.retryFailed}
            title={failureKind === "missing" ? MISSING_PHOTO_TITLE : UNSAVED_TITLE}
          >
            <TriangleAlert {...ICON.sm} aria-hidden />
            {failureKind === "missing"
              ? missingCheckAgainLabel(save.missingCount)
              : unsavedLabel(save.failedCount)}
          </button>
        ) : (
          save.savingCount > 0 && (
            <span className="cull-statusbar__saving">Saving {save.savingCount}…</span>
          )
        )}
      </div>
      <div className="cull-statusbar__spacer" />
      <div className="cull-statusbar__right">
        <span className="eyebrow cull-statusbar__keyhint" aria-hidden>
          tab · keys
        </span>
        <span
          className="cull-statusbar__pos"
          title={
            frame.compareMode
              ? "Challenger position / total candidates"
              : "Current position / filtered total"
          }
        >
          {frame.compareMode ? (
            <>
              <b>{Math.max(0, frame.comparePos + 1)}</b>
              <span className="of"> / {frame.compareCount}</span>
            </>
          ) : (
            <>
              <b>{filter.positionInFilter >= 0 ? filter.positionInFilter + 1 : 0}</b>
              <span className="of"> / {filter.visibleCount}</span>
            </>
          )}
        </span>
        {/* Filter tabs disabled in compare. */}
        {!frame.compareMode && (
          <div className="cull-filter-tabs" role="tablist" aria-label="filter">
            <button
              type="button"
              className={filter.filter === "all" ? "is-active" : ""}
              onClick={() => filter.setFilter((f) => cycleFilter(f, "all"))}
              data-tip={filter.filter === "all" ? undefined : "1 · show all"}
            >
              All
            </button>
            <button
              type="button"
              className={filter.filter === "unrated" ? "is-active" : ""}
              onClick={() => filter.setFilter((f) => cycleFilter(f, "unrated"))}
              data-tip={filter.filter === "unrated" ? undefined : "2 · show unrated"}
            >
              Unrated
            </button>
            <span className="cull-filter-tab-group">
              <button
                type="button"
                className={topOf(filter.filter) === "keeps" ? "is-active" : ""}
                onClick={() => {
                  filter.setFilter((f) => cycleFilter(f, "keeps"));
                  filter.chipsTooltip.pulse();
                }}
                // Tip only while INACTIVE (the active tab floats the sub-chip
                // tooltip in the same spot). data-tip renders instantly via
                // CSS — the OS title delay made it lose the race against the
                // neighbouring chip tooltip's fade-out.
                data-tip={topOf(filter.filter) === "keeps" ? undefined : "3 · show keeps"}
                {...(topOf(filter.filter) === "keeps" ? filter.chipsTooltip.hoverProps : undefined)}
              >
                Keeps
              </button>
              {topOf(filter.filter) === "keeps" && (
                <span
                  className={`cull-filter-tab-tooltip${filter.chipsTooltip.visible ? " is-on" : ""}`}
                  {...filter.chipsTooltip.hoverProps}
                >
                  <button
                    type="button"
                    className={filter.filter === "keeps" ? "is-active" : ""}
                    onClick={() => {
                      filter.setFilter("keeps");
                      filter.chipsTooltip.pulse();
                    }}
                    title="Keeps and favorites"
                  >
                    all
                  </button>
                  <button
                    type="button"
                    className={`is-icon${filter.filter === "keepsFavs" ? " is-active" : ""}`}
                    onClick={() => {
                      filter.setFilter("keepsFavs");
                      filter.chipsTooltip.pulse();
                    }}
                    // `title` is this button's only accessible name once the
                    // star is an aria-hidden SVG — same for the three below.
                    title="Favorites only"
                  >
                    <Star {...ICON.sm} fill="currentColor" aria-hidden />
                  </button>
                </span>
              )}
            </span>
            {/* Always visible — smart culling off just lands on the
                "disabled" empty screen (see EmptyFilter) instead of a tab
                that vanishes out from under an active filter. */}
            <span className="cull-filter-tab-group">
              <button
                type="button"
                className={topOf(filter.filter) === "suggested" ? "is-active" : ""}
                onClick={() => {
                  filter.setFilter((f) => cycleFilter(f, "suggested"));
                  filter.chipsTooltip.pulse();
                  if (filter.smartCulling) {
                    filter.startAnalysis(); // no-op unless "analyze on open" is off and unrun
                  }
                }}
                // Same inactive-only instant tip as the Keeps tab above.
                data-tip={topOf(filter.filter) === "suggested" ? undefined : "4 · show suggestions"}
                {...(topOf(filter.filter) === "suggested"
                  ? filter.chipsTooltip.hoverProps
                  : undefined)}
              >
                {filter.qualityAnalyzing && filter.qualityProgress
                  ? `Smart ${Math.round((filter.qualityProgress.done / Math.max(filter.qualityProgress.total, 1)) * 100)}%`
                  : filter.suggestionCount > 0
                    ? `Smart · ${filter.suggestionCount}`
                    : "Smart"}
              </button>
              {topOf(filter.filter) === "suggested" && (
                <span
                  className={`cull-filter-tab-tooltip${filter.chipsTooltip.visible ? " is-on" : ""}`}
                  {...filter.chipsTooltip.hoverProps}
                >
                  <button
                    type="button"
                    className={filter.filter === "suggested" ? "is-active" : ""}
                    onClick={() => {
                      filter.setFilter("suggested");
                      filter.chipsTooltip.pulse();
                    }}
                    title="Any suggestion"
                  >
                    all
                  </button>
                  <button
                    type="button"
                    className={`is-icon${filter.filter === "suggestedRejects" ? " is-active" : ""}`}
                    onClick={() => {
                      filter.setFilter("suggestedRejects");
                      filter.chipsTooltip.pulse();
                    }}
                    title="Suggested rejects"
                  >
                    <XIcon {...ICON.sm} aria-hidden />
                  </button>
                  <button
                    type="button"
                    className={`is-icon${filter.filter === "suggestedKeeps" ? " is-active" : ""}`}
                    onClick={() => {
                      filter.setFilter("suggestedKeeps");
                      filter.chipsTooltip.pulse();
                    }}
                    title="Suggested keeps"
                  >
                    <Check {...ICON.sm} aria-hidden />
                  </button>
                  <button
                    type="button"
                    className={`is-icon${filter.filter === "suggestedFavs" ? " is-active" : ""}`}
                    onClick={() => {
                      filter.setFilter("suggestedFavs");
                      filter.chipsTooltip.pulse();
                    }}
                    title="Suggested favorites"
                  >
                    <Star {...ICON.sm} fill="currentColor" aria-hidden />
                  </button>
                </span>
              )}
            </span>
          </div>
        )}
        {(filter.stats.keeps > 0 || session.rejectedCount > 0) && !session.actionsOpen && (
          // The finish moment: once every frame is rated the button announces it
          // and brightens — the one nudge from "culling" to "act on the cull".
          <button
            type="button"
            className={`btn btn--sm cull-statusbar__finish${
              filter.stats.unrated === 0 && filter.stats.total > 0 ? " is-done" : ""
            }`}
            onClick={session.openActions}
            title="Finish the cull · move rejects / copy keeps"
          >
            {filter.stats.unrated === 0 && filter.stats.total > 0
              ? `All ${filter.stats.total} rated · ${modCombo("E")} finish`
              : `${modCombo("E")} · ${totalKeeps} keeps`}
          </button>
        )}
      </div>
    </footer>
  );
});
