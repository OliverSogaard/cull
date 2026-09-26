import type { HelpGroup, HelpMode, HelpRow } from "../types";
import { KeyCombo } from "./KeyCombo";

/**
 * Context-aware keyboard reference. The "switch view" group lists only the
 * two OTHER sites — pressing the current site's key is a no-op, so showing
 * it would be misleading. ESC clears a grid selection if there is one;
 * otherwise it opens the leave-to-home confirm from any site.
 *
 * Universal bindings (ctrl+z, ctrl+e, tab, esc) live in the bottom "session"
 * group on every page, so the user doesn't have to remember which mode
 * surfaces which utility.
 */
function helpGroupsFor(
  mode: HelpMode,
  starsAndLabels?: boolean,
  rejectsFilterActive?: boolean,
): HelpGroup[] {
  // The five filters live on the bare digit row, unless the stars-and-labels
  // layer has taken it — then they move to Shift and the digits mark instead.
  const filterRow: HelpRow = {
    keys: ["1", "5"],
    range: true,
    ...(starsAndLabels ? { mod: "Shift" } : {}),
    desc: "Filter: all / unrated / keeps / smart / rejects  (repeat to cycle sub-modes)",
  };
  // Lightroom's own row, and only ever in loupe and grid: the digits are
  // unbound in compare, which decides a pair rather than grading a frame.
  const markGroup: HelpGroup = {
    title: "mark",
    rows: [
      { keys: ["1", "5"], range: true, desc: "Stars 1–5" },
      { keys: ["0"], desc: "Clear the stars" },
      {
        keys: ["6", "9"],
        range: true,
        desc: "Colour label: red / yellow / green / blue (re-press clears)",
      },
      { keys: ["Shift", "6"], desc: "Purple label (re-press clears)" },
    ],
  };
  const marks: HelpGroup[] = starsAndLabels ? [markGroup] : [];
  // C is a silent no-op from the Rejects filter (a reject can't champion a
  // compare — goToSite's pre-existing guard) — name the rule here rather than
  // leave it unexplained, but only while that filter is actually live.
  const compareRow: HelpRow = {
    keys: ["C"],
    desc: "Compare",
    ...(rejectsFilterActive ? { note: "not from Rejects" } : {}),
  };
  const session: HelpGroup = {
    title: "session",
    rows: [
      { keys: ["mod", "Z"], desc: "Undo" },
      { keys: ["mod", "Shift", "Z"], desc: "Redo" },
      { keys: ["mod", "E"], desc: "Finish actions" },
      { keys: ["Tab"], hold: true, desc: "This help" },
      { keys: ["Esc"], desc: "Leave to home (clears a grid selection first)" },
    ],
  };
  if (mode === "loupe") {
    return [
      {
        title: "rate",
        rows: [
          { keys: ["Enter"], desc: "Keep" },
          { keys: ["Backspace"], desc: "Reject" },
          { keys: ["F"], desc: "Favorite" },
          { keys: ["U"], desc: "Unrate" },
        ],
      },
      ...marks,
      {
        title: "navigate",
        rows: [
          { keys: ["←", "→"], desc: "Prev / next  (hold to scrub)" },
          {
            keys: ["Space"],
            hold: true,
            desc: "1:1 zoom · ←↑↓→ pan · rating carries zoom to the next frame",
          },
          { keys: ["Click"], hold: true, desc: "Zoom at cursor · drag to pan" },
          { keys: ["Shift", "Space"], desc: "2:1 zoom  (shift+click too)" },
          { keys: ["Home", "End"], desc: "First / last in the filter" },
          { keys: ["PgUp", "PgDn"], desc: "Jump one strip-width" },
          filterRow,
        ],
      },
      {
        title: "overlays",
        rows: [
          { keys: ["T"], desc: "Thumbnail strip" },
          { keys: ["I"], desc: "EXIF + histogram" },
          { keys: ["H"], desc: "Clipping" },
          { keys: ["P"], desc: "Focus peaking" },
          { keys: ["O"], desc: "Thirds grid" },
        ],
      },
      {
        title: "switch view",
        rows: [compareRow, { keys: ["G"], desc: "Grid" }],
      },
      session,
    ];
  }
  if (mode === "compare") {
    return [
      {
        title: "decide",
        rows: [
          { keys: ["Enter"], desc: "Challenger wins  (champion rejected)" },
          { keys: ["K"], desc: "Keep both" },
          { keys: ["F"], desc: "Keep both · challenger ★" },
          { keys: ["Backspace"], desc: "Reject challenger" },
        ],
      },
      {
        title: "navigate",
        rows: [
          { keys: ["←", "→"], desc: "Pick challenger  (hold to scrub)" },
          { keys: ["Space"], hold: true, desc: "1:1 zoom · ←↑↓→ pan · deciding carries zoom" },
          { keys: ["Shift", "Space"], desc: "2:1 zoom" },
          { keys: ["PgUp", "PgDn"], desc: "Jump one strip-width" },
        ],
      },
      {
        title: "overlays",
        rows: [
          { keys: ["T"], desc: "Candidate strip" },
          { keys: ["I"], desc: "EXIF + histogram" },
          { keys: ["H"], desc: "Clipping" },
          { keys: ["P"], desc: "Focus peaking" },
          { keys: ["O"], desc: "Thirds grid" },
        ],
      },
      {
        title: "switch view",
        rows: [
          { keys: ["L"], desc: "Loupe" },
          { keys: ["G"], desc: "Grid" },
        ],
      },
      session,
    ];
  }
  // mode === "grid"
  return [
    {
      title: "rate",
      rows: [
        { keys: ["Enter"], desc: "Keep selected" },
        { keys: ["Backspace"], desc: "Reject selected" },
        { keys: ["F"], desc: "Favorite" },
        { keys: ["U"], desc: "Unrate" },
      ],
    },
    ...marks,
    {
      title: "navigate",
      rows: [
        { keys: ["←", "→"], desc: "Prev / next  (hold to traverse)" },
        { keys: ["↑", "↓"], desc: "Row up / down" },
        { keys: ["+", "−"], desc: "Bigger / smaller cells" },
        { keys: ["mod", "0"], desc: "Medium cells" },
        { keys: ["Home", "End"], desc: "First / last in the filter" },
        { keys: ["PgUp", "PgDn"], desc: "One screen" },
        filterRow,
        { keys: ["Click"], desc: "Open in loupe" },
        { keys: ["Shift", "Click"], desc: "Select range" },
        { keys: ["Shift", "←", "→", "↑", "↓"], desc: "Grow selection" },
        { keys: ["Shift", "Home", "End"], desc: "Extend selection to edge" },
        { keys: ["Shift", "PgUp", "PgDn"], desc: "Extend selection one screen" },
        { keys: ["mod", "Click"], desc: "Add to selection" },
        { keys: ["mod", "A"], desc: "Select all in filter" },
      ],
    },
    {
      title: "switch view",
      rows: [{ keys: ["L"], desc: "Loupe" }, compareRow],
    },
    session,
  ];
}

/**
 * `intro` = the one-time first-cull showing (auto-shown, no Tab held): the
 * title teaches the recall gesture instead of instructing a release, and any
 * key or click dismisses (App owns that). `onDismiss` enables click-to-close.
 */
export function HelpOverlay({
  mode,
  intro,
  onDismiss,
  starsAndLabels,
  rejectsFilterActive,
}: {
  mode: HelpMode;
  intro?: boolean;
  onDismiss?: () => void;
  /** `settings.starsAndLabels` — which of the two keymap shapes to teach.
   *  Absent or false: every row is what it has always been. */
  starsAndLabels?: boolean;
  /** `filter === "rejects"` — names the Compare row's reject-champion rule
   *  only while it actually applies. */
  rejectsFilterActive?: boolean;
}) {
  const groups = helpGroupsFor(mode, starsAndLabels, rejectsFilterActive);
  return (
    <div className="cull-help" onClick={onDismiss}>
      <div className="cull-help__inner">
        <div className="eyebrow cull-help__eyebrow">CULL · {mode.toUpperCase()} KEYS</div>
        <h2 className="cull-help__title">
          {intro ? (
            <>
              Hold <em>tab</em> anytime for this. Any key to begin
            </>
          ) : (
            <>
              Release <em>tab</em> to dismiss
            </>
          )}
        </h2>
        <div className="cull-help__grid">
          {groups.map((g) => (
            <div key={g.title}>
              <div className="eyebrow cull-help__group">{g.title}</div>
              {g.rows.map((row) => (
                <div key={`${row.keys.join("+")}·${row.desc}`} className="cull-help__row">
                  <span className="cull-help__key">
                    {row.range ? (
                      // A range's modifier rides BOTH caps: "Shift 1 – 5"
                      // would read as if only the first end took Shift.
                      <>
                        <KeyCombo keys={row.mod ? [row.mod, row.keys[0]] : [row.keys[0]]} />
                        <span className="cull-help__range">–</span>
                        <KeyCombo keys={row.mod ? [row.mod, row.keys[1]] : [row.keys[1]]} />
                      </>
                    ) : row.keys.length > 3 ? (
                      // Four or more caps overflow the 132px key column inside
                      // one `white-space: nowrap` combo. Splitting the leading
                      // modifier off gives .cull-help__key's flex-wrap a seam
                      // to break at, without changing the caps or their order.
                      <>
                        <KeyCombo keys={[row.keys[0]]} />
                        <KeyCombo keys={row.keys.slice(1)} />
                      </>
                    ) : (
                      <KeyCombo keys={row.keys} />
                    )}
                    {row.hold && <span className="cull-help__hold">hold</span>}
                  </span>
                  <span className="cull-help__desc">
                    {row.desc}
                    {row.note && (
                      <>
                        {" "}
                        <span className="cull-help__note">({row.note})</span>
                      </>
                    )}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
