import type { HelpGroup, HelpMode } from "../types";
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
function helpGroupsFor(mode: HelpMode): HelpGroup[] {
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
          {
            keys: ["1", "4"],
            range: true,
            desc: "Filter: all / unrated / keeps / smart  (repeat to cycle sub-modes)",
          },
        ],
      },
      {
        title: "overlays",
        rows: [
          { keys: ["I"], desc: "EXIF + histogram" },
          { keys: ["H"], desc: "Clipping" },
          { keys: ["P"], desc: "Focus peaking" },
          { keys: ["O"], desc: "Thirds grid" },
          { keys: ["T"], desc: "Thumbnail strip" },
        ],
      },
      {
        title: "switch view",
        rows: [
          { keys: ["C"], desc: "Compare" },
          { keys: ["G"], desc: "Grid" },
        ],
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
        ],
      },
      {
        title: "overlays",
        rows: [
          { keys: ["I"], desc: "EXIF + histogram" },
          { keys: ["H"], desc: "Clipping" },
          { keys: ["P"], desc: "Focus peaking" },
          { keys: ["O"], desc: "Thirds grid" },
          { keys: ["T"], desc: "Candidate strip" },
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
    {
      title: "navigate",
      rows: [
        { keys: ["←", "→"], desc: "Prev / next  (hold to traverse)" },
        { keys: ["↑", "↓"], desc: "Row up / down" },
        { keys: ["+", "−"], desc: "Bigger / smaller cells" },
        { keys: ["mod", "0"], desc: "Medium cells" },
        {
          keys: ["1", "4"],
          range: true,
          desc: "Filter: all / unrated / keeps / smart  (repeat to cycle sub-modes)",
        },
        { keys: ["Click"], desc: "Open in loupe" },
        { keys: ["Shift", "Click"], desc: "Select range" },
        { keys: ["Shift", "←", "→", "↑", "↓"], desc: "Grow selection" },
        { keys: ["mod", "Click"], desc: "Add to selection" },
        { keys: ["mod", "A"], desc: "Select all in filter" },
      ],
    },
    {
      title: "switch view",
      rows: [
        { keys: ["L"], desc: "Loupe" },
        { keys: ["C"], desc: "Compare" },
      ],
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
}: {
  mode: HelpMode;
  intro?: boolean;
  onDismiss?: () => void;
}) {
  const groups = helpGroupsFor(mode);
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
                      <>
                        <KeyCombo keys={[row.keys[0]]} />
                        <span className="cull-help__range">–</span>
                        <KeyCombo keys={[row.keys[1]]} />
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
                  <span className="cull-help__desc">{row.desc}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
