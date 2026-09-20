import type { HelpGroup, HelpMode } from "../types";
import { modLabel, modName } from "../utils/platform";

/** Sentinel `keys` value for the one help row that needs an actual keycap for
 *  the platform modifier (see the render below) instead of plain text. */
const MOD_CLICK = "mod+click";

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
    keys: [
      [`${modName}+z`, "Undo"],
      [`${modName}+⇧+z`, "Redo"],
      [`${modName}+e`, "Finish actions"],
      ["tab (hold)", "This help"],
      ["esc", "Leave to home (clears a grid selection first)"],
    ],
  };
  if (mode === "loupe") {
    return [
      {
        title: "rate",
        keys: [
          ["enter", "Keep"],
          ["backspace", "Reject"],
          ["f", "Favorite"],
          ["u", "Unrate"],
        ],
      },
      {
        title: "navigate",
        keys: [
          ["← →", "Prev / next  (hold to scrub)"],
          ["space (hold)", "1:1 zoom · ←↑↓→ pan · rating carries zoom to the next frame"],
          ["click (hold)", "Zoom at cursor · drag to pan"],
          ["shift+space", "2:1 zoom  (shift+click too)"],
          ["1 – 4", "Filter: all / unrated / keeps / smart  (repeat to cycle sub-modes)"],
        ],
      },
      {
        title: "overlays",
        keys: [
          ["i", "EXIF + histogram"],
          ["h", "Clipping"],
          ["p", "Focus peaking"],
          ["o", "Thirds grid"],
          ["t", "Thumbnail strip"],
        ],
      },
      {
        title: "switch view",
        keys: [
          ["c", "Compare"],
          ["g", "Grid"],
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
          ["enter", "Challenger wins  (champion rejected)"],
          ["k", "Keep both"],
          ["f", "Keep both · challenger ★"],
          ["backspace", "Reject challenger"],
        ],
      },
      {
        title: "navigate",
        keys: [
          ["← →", "Pick challenger  (hold to scrub)"],
          ["space (hold)", "1:1 zoom · ←↑↓→ pan · deciding carries zoom"],
          ["shift+space", "2:1 zoom"],
        ],
      },
      {
        title: "overlays",
        keys: [
          ["i", "EXIF + histogram"],
          ["h", "Clipping"],
          ["p", "Focus peaking"],
          ["o", "Thirds grid"],
          ["t", "Candidate strip"],
        ],
      },
      {
        title: "switch view",
        keys: [
          ["l", "Loupe"],
          ["g", "Grid"],
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
        ["enter", "Keep selected"],
        ["backspace", "Reject selected"],
        ["f", "Favorite"],
        ["u", "Unrate"],
      ],
    },
    {
      title: "navigate",
      keys: [
        ["← →", "Prev / next  (hold to traverse)"],
        ["↑ ↓", "Row up / down"],
        ["1 – 4", "Filter: all / unrated / keeps / smart  (repeat to cycle sub-modes)"],
        ["click", "Open in loupe"],
        ["⇧+click", "Select range"],
        ["⇧+← → ↑ ↓", "Grow selection"],
        [MOD_CLICK, "Add to selection"],
        [`${modName}+a`, "Select all in filter"],
      ],
    },
    {
      title: "switch view",
      keys: [
        ["l", "Loupe"],
        ["c", "Compare"],
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
              {g.keys.map(([k, label]) => (
                <div key={k} className="cull-help__row">
                  <span className="cull-help__key">
                    {k === MOD_CLICK ? (
                      <>
                        <kbd className="kbd">{modLabel}</kbd> click
                      </>
                    ) : (
                      k
                    )}
                  </span>
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
