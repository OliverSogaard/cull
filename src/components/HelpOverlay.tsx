import type { HelpGroup, HelpMode } from "../types";

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
      ["ctrl+z", "undo"],
      ["ctrl+⇧+z", "redo"],
      ["ctrl+e", "finish actions"],
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
          ["1 – 4", "filter: all / unrated / keeps / ★"],
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
        ["1 – 4", "filter: all / unrated / keeps / ★"],
        ["click", "open in loupe"],
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

export function HelpOverlay({ mode }: { mode: HelpMode }) {
  const groups = helpGroupsFor(mode);
  return (
    <div className="cull-help">
      <div className="cull-help__inner">
        <div className="cull-help__eyebrow">cull · {mode} keys</div>
        <h2 className="cull-help__title">release tab to dismiss</h2>
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
