import { memo, type Dispatch, type SetStateAction } from "react";
import type { Filter, Rating } from "../types";
import type { useChipsTooltipVisibility } from "../hooks/useChipsTooltipVisibility";
import { cycleFilter, topOf } from "../utils/filterModes";
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

/** XMP write durability: in-flight writes, failed writes, and the retry. */
export type StatusBarSave = { savingCount: number; failedCount: number; retryFailed: () => void };

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

/** The act-on-the-cull chip and the platform modifier glyph it prints. */
export type StatusBarSession = {
  openActions: () => void;
  actionsOpen: boolean;
  rejectedCount: number;
  keyhint: string;
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
          <span className="cull-statusbar__chip cull-statusbar__chip--zoom">
            zoom {frame.zoomLevel}:1
          </span>
        )}
        {frame.scrubbing && (
          <span className="cull-statusbar__scrub" aria-label="scrubbing">
            Scrubbing
            {frame.scrubSpeed > 1 && (
              <span className="cull-statusbar__scrubspeed">{frame.scrubSpeed}×</span>
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
            className="cull-statusbar__multi"
            title="selection · rating keys apply to all selected"
          >
            {selection.selectedCount} selected
          </span>
        )}
        {save.failedCount > 0 ? (
          <span
            className="cull-statusbar__unsaved"
            onClick={save.retryFailed}
            title="ratings failed to save · click to retry"
          >
            ⚠ {save.failedCount} unsaved · retry
          </span>
        ) : (
          save.savingCount > 0 && (
            <span className="cull-statusbar__saving">saving {save.savingCount}…</span>
          )
        )}
      </div>
      <div className="cull-statusbar__spacer" />
      <div className="cull-statusbar__right">
        <span className="cull-statusbar__keyhint" aria-hidden>
          tab · keys
        </span>
        <span
          className="cull-statusbar__pos"
          title={
            frame.compareMode
              ? "challenger position / total candidates"
              : "current position / filtered total"
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
                    title="keeps and favorites"
                  >
                    all
                  </button>
                  <button
                    type="button"
                    className={filter.filter === "keepsFavs" ? "is-active" : ""}
                    onClick={() => {
                      filter.setFilter("keepsFavs");
                      filter.chipsTooltip.pulse();
                    }}
                    title="favorites only"
                  >
                    ★
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
                    title="any suggestion"
                  >
                    all
                  </button>
                  <button
                    type="button"
                    className={filter.filter === "suggestedRejects" ? "is-active" : ""}
                    onClick={() => {
                      filter.setFilter("suggestedRejects");
                      filter.chipsTooltip.pulse();
                    }}
                    title="suggested rejects"
                  >
                    ✕
                  </button>
                  <button
                    type="button"
                    className={filter.filter === "suggestedKeeps" ? "is-active" : ""}
                    onClick={() => {
                      filter.setFilter("suggestedKeeps");
                      filter.chipsTooltip.pulse();
                    }}
                    title="suggested keeps"
                  >
                    ✓
                  </button>
                  <button
                    type="button"
                    className={filter.filter === "suggestedFavs" ? "is-active" : ""}
                    onClick={() => {
                      filter.setFilter("suggestedFavs");
                      filter.chipsTooltip.pulse();
                    }}
                    title="suggested favorites"
                  >
                    ★
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
            className={`cull-statusbar__finish${
              filter.stats.unrated === 0 && filter.stats.total > 0 ? " is-done" : ""
            }`}
            onClick={session.openActions}
            title="finish the cull · move rejects / copy keeps"
          >
            {filter.stats.unrated === 0 && filter.stats.total > 0
              ? `All ${filter.stats.total} rated · ${session.keyhint}E finish`
              : `${session.keyhint}E · ${totalKeeps} keeps`}
          </button>
        )}
      </div>
    </footer>
  );
});
