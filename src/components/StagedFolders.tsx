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
 * The delta hint for a folder after the first: how far its first frame sits
 * from the first folder's first frame, AFTER each folder's own offset is
 * applied. Baking the offset in (rather than diffing the raw capture times)
 * is what makes the hint legible as a "done?" signal — nudging a folder's
 * clock moves this number toward 0 by exactly that nudge, and two bodies that
 * really did start together read "+0 s" once their offset is right.
 */
function offsetAdjustedDelta(
  first: number,
  offset: number,
  reference: number,
  referenceOffset: number,
): number {
  return first + offset - (reference + referenceOffset);
}

/**
 * Whether `el`'s current focus arrived via the keyboard (Tab, arrow nav)
 * rather than a mouse click — the same distinction `:focus-visible` makes in
 * a real browser: a clicked button KEEPS focus but does not match
 * `:focus-visible`, while a Tab-focused one does. Named separately from the
 * inline check so its one caller reads as a question, and so
 * `StagedFolders.test.tsx` has something to stub — this repo's jsdom
 * (30.0.1) cannot be trusted to answer it correctly from the one place
 * production code asks: checked from WITHIN a keydown handler for the very
 * key currently being pressed, jsdom's `:focus-visible` always reads true
 * (dispatching that keydown itself counts as "a keyboard interaction just
 * happened"), regardless of how focus was actually acquired. Real Chromium
 * decides `:focus-visible` once, at focus time, and does not re-derive it
 * from whatever event happens to be in flight — see the tests for the
 * jsdom probe that found this.
 */
function isKeyboardFocused(el: Element): boolean {
  return el.matches(":focus-visible");
}

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
    // Reset BEFORE the probe resolves, not after: on a re-stage the folder
    // set (and so `probePaths`) can change while an earlier probe is still
    // in flight, and without this an old folder's time could sit under a
    // new folder's name for the instant between the re-stage and the new
    // probe answering. `first !== null ? … : "—"` below then shows the dash
    // immediately, for every row, until the new answer lands.
    setFirstTimes([]);
    if (probePaths.length === 0) {
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
        // The backend's own contract is an array the same length as the
        // request, but a probe's response crosses an IPC boundary this
        // component doesn't control — trust it no further than that.
        if (live && Array.isArray(times)) setFirstTimes(times);
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
  const referenceOffset = folders.length > 0 ? (offsets[folders[0].path] ?? 0) : 0;

  return (
    <div
      className="cull-staged-sort"
      // The staged screen's Enter shortcut (useCullKeymap.ts) is a WINDOW
      // keydown listener registered in the bubble phase, and it calls
      // preventDefault before dispatching "begin culling" — which also
      // suppresses the browser's own Enter-activates-the-focused-button
      // behaviour. Stopping propagation here, before the event reaches
      // window, lets a focused toggle or stepper button take the Enter
      // itself instead of it falling through to that shortcut.
      //
      // Gated on `:focus-visible`, not every Enter: Chromium leaves focus on
      // a clicked button, and a mouse-focused button still matches `:focus`
      // but NOT `:focus-visible`. Stopping propagation unconditionally (round
      // 1's fix) meant Enter after a plain mouse click on the sort block
      // re-activated that same still-focused button on every press — the
      // toggle flipping back and forth, or the offset stepping again — and
      // "begin culling" could never fire. Gating on `:focus-visible` lets
      // Enter fall through to the window keymap in exactly the case where
      // the browser would NOT re-activate this button on its own.
      onKeyDown={(e) => {
        if (e.key === "Enter" && e.target instanceof Element && isKeyboardFocused(e.target)) {
          e.stopPropagation();
        }
      }}
    >
      <button
        type="button"
        className="btn btn--sm cull-staged-sort__toggle"
        aria-pressed={sortByCaptureTime}
        onClick={() => onToggleSort(!sortByCaptureTime)}
        title="Order the shoot by the time each frame was taken, not the time the card wrote it"
      >
        {/* The state is IN the label, not colour alone — with one folder
            staged the toggle looks the same pressed or not (no rows appear
            either way), so colour would be the only signal there. */}
        Sort by capture time · {sortByCaptureTime ? "on" : "off"}
      </button>
      {showRows && (
        <ul className="cull-staged-sort__folders" aria-label="Staged folders">
          {folders.map((f, i) => {
            const offset = offsets[f.path] ?? 0;
            const first = firstTimes[i] ?? null;
            const delta =
              first !== null && reference !== null && i > 0
                ? offsetAdjustedDelta(first, offset, reference, referenceOffset)
                : null;
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
