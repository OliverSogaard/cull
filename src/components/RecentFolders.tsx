import { recentKey, type RecentEntry } from "../hooks/useRecents";
import { formatFolderSet, formatRelativeTime } from "../utils/format";
import { KeyCombo } from "./KeyCombo";

/**
 * Recent-sessions section on the home screen. Renders nothing on a totally
 * fresh launch (empty state replaces the list). Click a row to re-open that
 * session's folder set; rows that don't have a `count` yet hide the count
 * column rather than show a stub `0`.
 *
 * Three columns: folder names (`wedding-d1 + wedding-d2`, overflowing to
 * `+N more` — full paths in the tooltip), count badge (`327 / 372`, plain
 * `421`, or `932 ✓`), and a relative-time stamp.
 */
export function RecentFolders({
  recents,
  onPick,
  pickerBusy,
}: {
  recents: RecentEntry[];
  onPick: (entry: RecentEntry) => void;
  pickerBusy: boolean;
}) {
  return (
    <div className="cull-recent">
      <div className="eyebrow cull-recent__label">Recent</div>
      {recents.length === 0 ? (
        <div className="cull-recent__empty">
          No folders yet. Drop some anywhere, or press{" "}
          <KeyCombo keys={["mod", "O"]} className="cull-recent__kbd" />.
        </div>
      ) : (
        <div className="cull-recent__items">
          {recents.map((r) => (
            <RecentRow key={recentKey(r.paths)} entry={r} onPick={() => !pickerBusy && onPick(r)} />
          ))}
        </div>
      )}
    </div>
  );
}

function RecentRow({ entry, onPick }: { entry: RecentEntry; onPick: () => void }) {
  // Folder NAMES, not paths — budgeted at ~52 chars so the count + time
  // columns still fit at the 620px hero width. The tooltip carries the full
  // paths (one per line), which also disambiguates duplicate basenames.
  const display = formatFolderSet(entry.paths, 52);
  const rel = formatRelativeTime(entry.lastOpened);
  return (
    <div
      className="cull-recent__item"
      role="button"
      tabIndex={0}
      onClick={onPick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onPick();
        }
      }}
      title={entry.paths.join("\n")}
    >
      <span className="cull-recent__path">{display}</span>
      <span className="cull-recent__count">
        {entry.count > 0 ? (
          entry.done ? (
            <>
              <b>{entry.count}</b>
              <span className="cull-recent__done" aria-label="finished">
                {" "}
                ✓
              </span>
            </>
          ) : entry.rated > 0 ? (
            <>
              <b>{entry.rated}</b>
              <span className="cull-recent__of"> / {entry.count}</span>
            </>
          ) : (
            <b>{entry.count}</b>
          )
        ) : null}
      </span>
      <span className="cull-recent__time">{rel ?? ""}</span>
    </div>
  );
}
