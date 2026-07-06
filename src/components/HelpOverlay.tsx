import type { HelpGroup, HelpMode } from "../types";
import { modGlyph, modName } from "../utils/platform";

/**
 * Context-aware keyboard reference. The "switch view" group lists only the
 * two OTHER sites — pressing the current site's key is a no-op, so showing
 * it would be misleading. ESC always pops one step back through the site
 * history (or, at LOUPE with empty history, opens the home confirm).
 *
 * Universal bindings (ctrl+z, ctrl+e, tab, esc) live in the bottom "session"
 * group on every page, so the user doesn't have to remember which mode
 * surfaces which utility.
 */
function helpGroupsFor(mode: HelpMode): HelpGroup[] {
  const session: HelpGroup = {
    title: "session",
    keys: [
      [`${modName}+z`, "undo"],
      [`${modName}+⇧+z`, "redo"],
      [`${modName}+e`, "finish actions"],
      ["tab (hold)", "this help"],
      ["esc", "back  (or home at loupe with no history)"],
    ],
  };
  if (mode === "loupe") {
    return [
      {
        title: "rate",
        keys: [
          ["enter", "keep"],
          ["backspace", "reject"],
          ["f", "favorite"],
          ["u", "unrate"],
        ],
      },
      {
        title: "navigate",
        keys: [
          ["← →", "prev / next  (hold to scrub)"],
          ["space (hold)", "1:1 zoom · ←↑↓→ pan"],
          ["shift+space", "2:1 zoom"],
          ["1 – 4", "filter: all / unrated / keeps / smart  (repeat to cycle sub-modes)"],
        ],
      },
      {
        title: "overlays",
        keys: [
          ["i", "exif + histogram"],
          ["h", "clipping"],
          ["p", "focus peaking"],
          ["o", "thirds grid"],
          ["t", "thumbnail strip"],
        ],
      },
      {
        title: "switch view",
        keys: [
          ["c", "compare"],
          ["g", "grid"],
        ],
      },
      session,
    ];
  }
  if (mode === "compare") {
    return [
      {
        title: "decide",
        keys: [
          ["enter", "challenger wins"],
          ["backspace", "reject challenger"],
        ],
      },
      {
        title: "navigate",
        keys: [
          ["← →", "pick challenger  (hold to scrub)"],
          ["space (hold)", "1:1 zoom · ←↑↓→ pan"],
          ["shift+space", "2:1 zoom"],
        ],
      },
      {
        title: "overlays",
        keys: [
          ["i", "exif + histogram"],
          ["h", "clipping"],
          ["p", "focus peaking"],
          ["o", "thirds grid"],
          ["t", "candidate strip"],
        ],
      },
      {
        title: "switch view",
        keys: [
          ["l", "loupe"],
          ["g", "grid"],
        ],
      },
      session,
    ];
  }
  // mode === "grid"
  return [
    {
      title: "rate",
      keys: [
        ["enter", "keep selected"],
        ["backspace", "reject selected"],
        ["f", "favorite"],
        ["u", "unrate"],
      ],
    },
    {
      title: "navigate",
      keys: [
        ["← →", "prev / next  (hold to traverse)"],
        ["↑ ↓", "row up / down"],
        ["1 – 4", "filter: all / unrated / keeps / smart  (repeat to cycle sub-modes)"],
        ["click", "open in loupe"],
        ["⇧+click", "select range"],
        ["⇧+← → ↑ ↓", "grow selection"],
        [`${modGlyph}+click`, "add to selection"],
        [`${modName}+a`, "select all in filter"],
      ],
    },
    {
      title: "switch view",
      keys: [
        ["l", "loupe"],
        ["c", "compare"],
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
        <div className="cull-help__eyebrow">CULL · {mode.toUpperCase()} KEYS</div>
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
              <div className="cull-help__group">{g.title}</div>
              {g.keys.map(([k, label]) => (
                <div key={k} className="cull-help__row">
                  <span className="cull-help__key">{k}</span>
                  <span className="cull-help__desc">{label}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
