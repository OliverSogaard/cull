import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { FileOpResult, Settings } from "../types";
import { normalizeRejectedSubfolder } from "../types/settings";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { isReservedFolderName, joinPath, sanitizeFolderName } from "../utils/path";

/** How long after the last keystroke (or dialog open) before we probe disk. */
const FOLDER_EXISTS_DEBOUNCE_MS = 250;

/**
 * Finish-session dialog (the act-on-cull modal opened via `⌃E` or the status-
 * bar `✦ finish` chip). Wraps two destructive actions — *move rejects* into a
 * subfolder in the source, and *copy keeps* to an export folder — both backed
 * by idempotent Tauri commands so re-running after a partial failure is safe.
 *
 * The "Copy keeps" half has two modes that match the export-folder setting:
 *
 *  - **pinned root** — the dialog shows `[muted root]\[editable subfolder]`
 *    with the subfolder defaulting to `<source-basename>-keeps`. Live input
 *    sanitization strips Windows-illegal characters; a blank value snaps back
 *    to the default with a champagne flash on blur.
 *
 *  - **ask each time** — a two-stage flow: stage 1 the button reads `Pick
 *    destination` and opens the OS picker; stage 2 the row reads `WILL COPY
 *    TO  [path]  [Change]  [Copy keeps]` so the user can re-pick or commit.
 *
 * State that's local to one open-dialog session (the picked path in ask mode,
 * the editable subfolder text in pinned mode) lives here, not on App, so it
 * resets cleanly when the modal closes.
 */
export function FinishDialog({
  folder,
  folderName,
  keptPaths,
  rejectedPaths,
  favorites,
  unrated,
  keepsCount,
  savingCount,
  failedCount,
  actionBusy,
  moveResult,
  copyResult,
  settings,
  onMoveRejects,
  onCopyKeeps,
  onClose,
}: {
  folder: string | null;
  folderName: string;
  keptPaths: string[];
  rejectedPaths: string[];
  favorites: number;
  unrated: number;
  keepsCount: number;
  savingCount: number;
  failedCount: number;
  actionBusy: "move" | "copy" | null;
  moveResult: FileOpResult | null;
  copyResult: FileOpResult | null;
  settings: Settings;
  onMoveRejects: () => void;
  onCopyKeeps: (dest: string) => void;
  onClose: () => void;
}) {
  const pinnedMode = settings.exportFolder.mode === "pinned";
  const pinnedRoot =
    settings.exportFolder.mode === "pinned" ? settings.exportFolder.path : "";
  // Default the editable subfolder to <source-basename>-keeps. If the user opens
  // the finish dialog without a folder for some reason we still produce a sane
  // default ("session-keeps") so the input never starts blank.
  const defaultSub = `${folderName || "session"}-keeps`;

  // ── Pinned-root subfolder editor (silent failsafe) ─────────────────────────
  // Local to this dialog session: we want a fresh default each time the modal
  // opens, but typing should persist within one open. `flashing` reapplies the
  // `flash-restore` animation when blur snaps the value back to default.
  const [sub, setSub] = useState(defaultSub);
  const [flashing, setFlashing] = useState(false);

  // Reset the subfolder field when the source folder (and thus the default)
  // changes — covers the case where the user closes, opens a new folder, then
  // reopens the dialog.
  useEffect(() => {
    setSub(defaultSub);
  }, [defaultSub]);

  // ── Ask-each-time: stage-2 picked destination ──────────────────────────────
  // null = stage 1 (button says "Pick destination"). String = stage 2 (row
  // shows the picked path + Change + Copy keeps).
  const [pickedDestination, setPickedDestination] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);

  // ── Pinned-mode folder-exists detection ───────────────────────────────────
  // Real check, not just visual: on dialog open + on every subfolder edit
  // (debounced) we probe the filesystem and flip the banner. When true:
  //   - banner appears in red ("already exists")
  //   - the primary button reads "Confirm (merge)" so the user knows the copy
  //     will write into the existing folder (batch_files skips collisions,
  //     so this is a safe merge, not an overwrite).
  // Only meaningful in pinned mode — ask-each-time goes through the OS picker
  // which can't produce a stale conflict path.
  const [folderExists, setFolderExists] = useState(false);

  useEffect(() => {
    if (!pinnedMode) {
      setFolderExists(false);
      return;
    }
    const trimmedSub = sub.trim();
    if (!pinnedRoot || trimmedSub.length === 0) {
      setFolderExists(false);
      return;
    }
    const fullPath = joinPath(pinnedRoot, trimmedSub);
    // Debounce: don't fire a backend call on every keystroke (especially when
    // the destination root is a slow NAS).
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const exists = await invoke<boolean>("path_exists", { path: fullPath });
        if (!cancelled) setFolderExists(exists);
      } catch {
        if (!cancelled) setFolderExists(false);
      }
    }, FOLDER_EXISTS_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [pinnedMode, pinnedRoot, sub]);

  // ── Pinned-root existence check ────────────────────────────────────────────
  // The pinned ROOT (not just the dest subfolder) is validated on open + when it
  // changes. If the user pinned a folder that's since been deleted or is on an
  // unmounted drive, copy_keeps_to_export's create_dir_all would silently re-make
  // the tree and scatter keepers somewhere they'd never look — so we block the
  // copy and tell them to re-pick it in Settings instead.
  const [rootMissing, setRootMissing] = useState(false);
  useEffect(() => {
    if (!pinnedMode || !pinnedRoot) {
      setRootMissing(false);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const exists = await invoke<boolean>("path_exists", { path: pinnedRoot });
        if (!cancelled) setRootMissing(!exists);
      } catch {
        if (!cancelled) setRootMissing(false);
      }
    }, FOLDER_EXISTS_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [pinnedMode, pinnedRoot]);

  // Disable copy when something would block it — same gates as before, plus the
  // pinned-mode subfolder must be non-empty, not a Windows reserved device name,
  // and its pinned root must still exist on disk.
  const subTrimmed = sub.trim();
  const subInvalid =
    pinnedMode && (subTrimmed.length === 0 || isReservedFolderName(subTrimmed));
  const copyDisabled =
    keptPaths.length === 0 ||
    actionBusy !== null ||
    savingCount > 0 ||
    failedCount > 0 ||
    (pinnedMode && (subInvalid || !pinnedRoot || rootMissing));

  const pickDestination = async () => {
    if (picking) return;
    setPicking(true);
    try {
      const lastExport = localStorage.getItem("cull:lastExportDest") ?? undefined;
      const picked = await open({
        directory: true,
        multiple: false,
        defaultPath: lastExport,
        title: "choose export folder",
      });
      if (typeof picked === "string") {
        setPickedDestination(picked);
      }
    } finally {
      setPicking(false);
    }
  };

  const commitCopy = () => {
    if (pinnedMode) {
      const finalDest = joinPath(pinnedRoot, subTrimmed);
      onCopyKeeps(finalDest);
    } else if (pickedDestination) {
      onCopyKeeps(pickedDestination);
    }
  };

  const trapRef = useFocusTrap<HTMLDivElement>();

  return (
    <div className="cull-quitguard">
      <div
        className="cull-quitguard__box cull-actions"
        ref={trapRef}
        role="dialog"
        aria-modal="true"
        aria-label="Finish session"
        tabIndex={-1}
      >
        <div className="cull-settings__title">
          <span>Finish session</span>
          <span className="cull-settings__title-meta">{folderName || "session"}</span>
        </div>

        {/* Two-stat summary — keeps (with fav sub-line) + rejects. */}
        <div className="cull-actions__summary">
          <div className="cull-actions__stat">
            <div className="cull-actions__stat-label">Keeps</div>
            <div
              className={`cull-actions__stat-value is-keep${keepsCount === 0 ? " is-zero" : ""}`}
            >
              {keepsCount}
            </div>
            {favorites > 0 && (
              <div className="cull-actions__stat-sub">
                <span>★</span> {favorites} favorite{favorites === 1 ? "" : "s"}
              </div>
            )}
          </div>
          <div className="cull-actions__stat">
            <div className="cull-actions__stat-label">Rejects</div>
            <div
              className={`cull-actions__stat-value is-reject${rejectedPaths.length === 0 ? " is-zero" : ""}`}
            >
              {rejectedPaths.length}
            </div>
          </div>
        </div>

        {unrated > 0 && (
          <div className="cull-actions__unrated">
            <span className="cull-actions__unrated-icon">⚠</span>
            <span>
              <b>{unrated} unrated</b> will stay in the source untouched.
            </span>
          </div>
        )}

        {(savingCount > 0 || failedCount > 0) && (
          <div
            className={`cull-actions__pending${failedCount > 0 ? " cull-actions__pending--err" : ""}`}
          >
            {failedCount > 0
              ? `⚠ ${failedCount} rating${failedCount > 1 ? "s" : ""} haven't saved — actions disabled until resolved (status bar · retry)`
              : `saving ${savingCount} rating${savingCount > 1 ? "s" : ""}… actions wait for the sidecars to land first`}
          </div>
        )}

        <div className="cull-actions__rows">
          <MoveRejectsRow
            rejectedCount={rejectedPaths.length}
            folder={folder}
            actionBusy={actionBusy}
            savingCount={savingCount}
            failedCount={failedCount}
            moveResult={moveResult}
            settings={settings}
            onMoveRejects={onMoveRejects}
          />

          <div className="cull-actions__row">
            <div className="cull-actions__row-label">Copy keeps</div>
            <div className="cull-actions__row-help">
              Copies the {keptPaths.length} keeper{keptPaths.length === 1 ? "" : "s"} + their XMP
              sidecars
              {pinnedMode ? " to the path below." : "."}
            </div>

            {pinnedMode ? (
              <>
                {rootMissing && (
                  <div className="cull-finish__folder-exists">
                    <span className="cull-finish__folder-exists-icon">⚠</span>
                    <span>
                      The pinned export root no longer exists. Re-pick it in{" "}
                      <b>Settings</b> before copying.
                    </span>
                  </div>
                )}
                {folderExists && (
                  <div className="cull-finish__folder-exists">
                    <span className="cull-finish__folder-exists-icon">⚠</span>
                    <span>
                      A folder with this name already exists at your pinned root. Rename
                      it in the field below, or click <b>Confirm (merge)</b> to copy
                      into the existing one.
                    </span>
                  </div>
                )}
                <div className="cull-finish__dest-edit">
                  <span
                    className="cull-finish__dest-root"
                    title={pinnedRoot || "(pinned root not set)"}
                  >
                    {pinnedRoot ? `${pinnedRoot.replace(/[\\/]+$/, "")}${pinnedRoot.includes("\\") ? "\\" : "/"}` : "(no pinned root) "}
                  </span>
                  <input
                    className={`cull-finish__dest-sub${subInvalid ? " is-invalid" : ""}${flashing ? " is-flash" : ""}`}
                    value={sub}
                    spellCheck={false}
                    onChange={(e) => setSub(sanitizeFolderName(e.target.value))}
                    onBlur={() => {
                      if (sub.trim().length === 0) {
                        setSub(defaultSub);
                        setFlashing(true);
                        window.setTimeout(() => setFlashing(false), 900);
                      }
                    }}
                  />
                  <button
                    className="cull-pick-button cull-pick-button--primary cull-finish__dest-cta"
                    disabled={copyDisabled}
                    onClick={commitCopy}
                  >
                    {actionBusy === "copy"
                      ? "copying…"
                      : folderExists
                      ? "Confirm (merge)"
                      : "Copy keeps"}
                  </button>
                </div>
              </>
            ) : pickedDestination === null ? (
              // Ask each time, stage 1: a single button that opens the picker.
              <button
                className="cull-pick-button cull-pick-button--primary"
                disabled={
                  keptPaths.length === 0 ||
                  actionBusy !== null ||
                  savingCount > 0 ||
                  failedCount > 0 ||
                  picking
                }
                onClick={pickDestination}
              >
                {picking ? "opening picker…" : "Pick destination"}
              </button>
            ) : (
              // Ask each time, stage 2: confirm or change.
              <div className="cull-finish__picked">
                <span className="cull-finish__picked-label">Will copy to</span>
                <code className="cull-finish__picked-path" title={pickedDestination}>
                  {pickedDestination}
                </code>
                <button
                  className="cull-pick-button"
                  disabled={actionBusy !== null || picking}
                  onClick={pickDestination}
                >
                  {picking ? "opening…" : "Change"}
                </button>
                <button
                  className="cull-pick-button cull-pick-button--primary"
                  disabled={
                    keptPaths.length === 0 ||
                    actionBusy !== null ||
                    savingCount > 0 ||
                    failedCount > 0
                  }
                  onClick={commitCopy}
                >
                  {actionBusy === "copy" ? "copying…" : "Copy keeps"}
                </button>
              </div>
            )}

            {copyResult && <FileOpResultLine verb="copied" result={copyResult} />}
          </div>
        </div>

        <div className="cull-quitguard__actions" style={{ padding: "16px 26px" }}>
          <button className="cull-pick-button" onClick={onClose}>
            close
          </button>
        </div>
        <div
          className="cull-quitguard__hint"
          style={{ padding: "0 26px 16px", margin: 0, borderTop: 0 }}
        >
          <kbd>esc</kbd> to close
        </div>
      </div>
    </div>
  );
}

/**
 * Move-rejects row with an inline "Sure?" two-step confirm and a progress UI
 * during the move. Three-stage flow:
 *   stage 1: [Move rejects] button
 *   stage 2 (armed): "Sure? This moves N files." [Yes, move] [Cancel]
 *   stage 3 (in flight): progress bar with breathing animation
 * The confirm auto-disarms after 4s if the user walks away.
 */
function MoveRejectsRow({
  rejectedCount,
  folder,
  actionBusy,
  savingCount,
  failedCount,
  moveResult,
  settings,
  onMoveRejects,
}: {
  rejectedCount: number;
  folder: string | null;
  actionBusy: "move" | "copy" | null;
  savingCount: number;
  failedCount: number;
  moveResult: FileOpResult | null;
  settings: Settings;
  onMoveRejects: () => void;
}) {
  const [armed, setArmed] = useState(false);

  // Auto-disarm so a confirmed-then-walked-away dialog doesn't sit primed.
  useEffect(() => {
    if (!armed) return;
    const t = window.setTimeout(() => setArmed(false), 4000);
    return () => window.clearTimeout(t);
  }, [armed]);

  const disabled =
    !folder ||
    rejectedCount === 0 ||
    actionBusy !== null ||
    savingCount > 0 ||
    failedCount > 0;

  return (
    <div className="cull-actions__row">
      <div className="cull-actions__row-label">Move rejects</div>
      <div className="cull-actions__row-help">
        Moves the {rejectedCount} rejected CR3s + their XMP sidecars into a{" "}
        <b>{normalizeRejectedSubfolder(settings.rejectedSubfolder)}/</b> subfolder in the source.
      </div>

      {actionBusy === "move" ? (
        // Progress UI — indeterminate breathing bar; the backend op is
        // batched and doesn't stream per-file progress, so we don't show a %.
        <div className="cull-finish__progress">
          <span className="cull-finish__progress-label">
            <b>moving</b> {rejectedCount}…
          </span>
          <div className="cull-finish__progress-bar">
            <div className="cull-finish__progress-fill" />
          </div>
        </div>
      ) : armed ? (
        <div className="cull-finish__confirm">
          <span className="cull-finish__confirm-msg">
            Sure? This moves {rejectedCount} files.
          </span>
          <button
            className="cull-pick-button cull-pick-button--primary cull-finish__confirm-yes"
            onClick={() => {
              setArmed(false);
              onMoveRejects();
            }}
          >
            Yes, move
          </button>
          <button
            className="cull-pick-button"
            onClick={() => setArmed(false)}
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          className="cull-pick-button cull-pick-button--primary"
          disabled={disabled}
          onClick={() => setArmed(true)}
        >
          Move rejects
        </button>
      )}

      {moveResult && <FileOpResultLine verb="moved" result={moveResult} />}
    </div>
  );
}

/**
 * One-line result summary for a batch file op. Shows the TRUE error total
 * (`errorCount`, which the backend caps the message list at 20 but counts in
 * full) so a 200-failure batch never reads as "only 20 errors". Falls back to
 * the capped list length for older backends that don't send `errorCount`.
 */
function FileOpResultLine({ verb, result }: { verb: string; result: FileOpResult }) {
  const errs = result.errorCount ?? result.errors.length;
  return (
    <div className={`cull-actions__result${errs > 0 ? " cull-actions__result--err" : ""}`}>
      {verb} {result.completed} · skipped {result.skipped}
      {errs > 0 && ` · ${errs} error${errs > 1 ? "s" : ""}`}
    </div>
  );
}

