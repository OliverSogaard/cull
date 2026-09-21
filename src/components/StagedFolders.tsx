import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Img } from "../types";
import {
  formatCaptureClock,
  formatSignedDuration,
  groupStagedFolders,
  stepOffset,
} from "../utils/stagedFolders";

/**
 * The staged screen's capture-time controls: the sort toggle, and — only when
 * the sort is on and two or more folders are staged — one row per folder with
 * its frame count, its first frame's capture time, the signed difference from
 * the FIRST folder's first frame (which usually IS the offset between two
 * bodies), and a stepper.
 *
 * Presentational apart from one probe: it invokes `read_capture_times` with a
 * single representative frame per folder when the rows become visible. Same
 * shape as SettingsDialog's own cache-size read — one screen, one small fetch,
 * no hook to thread through App.
 *
 * Offsets are ORDERING ONLY. Nothing is written to any file, and the info rail
 * keeps showing the camera's own time.
 */
export function StagedFolders({
  images,
  sortByCaptureTime,
  onToggleSort,
  offsets,
  onOffsetChange,
}: {
  images: readonly Img[];
  sortByCaptureTime: boolean;
  onToggleSort: (next: boolean) => void;
  offsets: Readonly<Record<string, number>>;
  /** Absolute srcFolder → the folder's new offset in ms. */
  onOffsetChange: (folderPath: string, ms: number) => void;
}) {
  const folders = useMemo(() => groupStagedFolders(images), [images]);
  // Rows exist only for the two-bodies case: with one folder there is nothing
  // to offset against, and the delta hint would be "+0 s" against itself.
  const showRows = sortByCaptureTime && folders.length >= 2;
  const probePaths = useMemo(
    () => (showRows ? folders.map((f) => f.firstPath) : []),
    [showRows, folders],
  );
  const [firstTimes, setFirstTimes] = useState<readonly (number | null)[]>([]);

  useEffect(() => {
    if (probePaths.length === 0) {
      setFirstTimes([]);
      return;
    }
    let live = true;
    // `await`, not a direct `.then`/`.catch` chain: it tolerates a caller
    // whose `invoke` isn't wired for this exact call (a plain `vi.fn()` with
    // no `mockResolvedValue` returns `undefined`, and `.then` on that throws
    // synchronously inside the effect — `await` on a non-promise value just
    // resolves to it, same as a real Tauri round-trip that hasn't settled).
    void (async () => {
      try {
        const times = await invoke<(number | null)[]>("read_capture_times", {
          paths: [...probePaths],
        });
        if (live) setFirstTimes(times);
      } catch {
        // A probe that fails just leaves the rows without their hint — the
        // sort itself does not depend on it.
        if (live) setFirstTimes([]);
      }
    })();
    return () => {
      live = false;
    };
  }, [probePaths]);

  const reference = firstTimes[0] ?? null;

  return (
    <div className="cull-staged-sort">
      <button
        type="button"
        className="btn btn--sm cull-staged-sort__toggle"
        aria-pressed={sortByCaptureTime}
        onClick={() => onToggleSort(!sortByCaptureTime)}
        title="Order the shoot by the time each frame was taken, not the time the card wrote it"
      >
        Sort by capture time
      </button>
      {showRows && (
        <ul className="cull-staged-sort__folders" aria-label="Staged folders">
          {folders.map((f, i) => {
            const offset = offsets[f.path] ?? 0;
            const first = firstTimes[i] ?? null;
            const delta = first !== null && reference !== null && i > 0 ? first - reference : null;
            const step = (dir: 1 | -1) => (e: React.MouseEvent) =>
              onOffsetChange(
                f.path,
                stepOffset(offset, dir, { shift: e.shiftKey, reset: e.ctrlKey || e.metaKey }),
              );
            return (
              <li key={f.path} className="cull-staged-sort__row">
                <span className="cull-staged-sort__name" title={f.path}>
                  {f.name}
                </span>
                <span className="cull-staged-sort__count">{f.count}</span>
                <span className="cull-staged-sort__time">
                  {first !== null ? formatCaptureClock(first) : "—"}
                </span>
                <span className="cull-staged-sort__delta">
                  {delta !== null ? formatSignedDuration(delta) : ""}
                </span>
                <span className="cull-staged-sort__stepper">
                  <button
                    type="button"
                    className="btn btn--sm cull-staged-sort__step"
                    onClick={step(-1)}
                    aria-label={`${f.name} · earlier`}
                    title="Click −1 s · Shift-click −1 min · Ctrl-click resets"
                  >
                    −
                  </button>
                  <span className="cull-staged-sort__offset">{formatSignedDuration(offset)}</span>
                  <button
                    type="button"
                    className="btn btn--sm cull-staged-sort__step"
                    onClick={step(1)}
                    aria-label={`${f.name} · later`}
                    title="Click +1 s · Shift-click +1 min · Ctrl-click resets"
                  >
                    +
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
