import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { Filter, Settings, SmartLevel, StorageMode, ThumbsPosition } from "../types";
import { DEFAULT_SETTINGS } from "../types/settings";
import { LEVEL_THRESHOLD } from "../smart/deriveVerdict";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { sanitizeFolderName } from "../utils/path";
import { modGlyph } from "../utils/platform";

/**
 * Settings modal. Opens with `Ctrl + ,` or the settings cog in the top-right
 * window chrome.
 *
 * Edits write through immediately (no apply / cancel) — every control is a
 * quick toggle the user can flip back. The "Reset" button needs a second
 * click ("Yes, reset") to commit, so a stray click doesn't wipe everything.
 */
export function SettingsDialog({
  settings,
  onChange,
  onClose,
}: {
  settings: Settings;
  onChange: (next: Settings) => void;
  onClose: () => void;
}) {
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    onChange({ ...settings, [key]: value });

  const exportMode = settings.exportFolder.mode;
  const pinnedPath =
    settings.exportFolder.mode === "pinned" ? settings.exportFolder.path : "";

  const trapRef = useFocusTrap<HTMLDivElement>();
  const [tab, setTab] = useState<TabId>("general");

  return (
    <div
      className="cull-quitguard cull-settings-overlay"
      onClick={(e) => {
        // Click on the backdrop itself (not bubbled from inside the box) closes.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="cull-settings"
        ref={trapRef}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        tabIndex={-1}
      >
        <div className="cull-settings__head">
          <span className="cull-settings__head-title">Settings</span>
          <span className="cull-settings__head-meta">CULL</span>
        </div>

        <div className="cull-settings__layout">
          <nav className="cull-settings__nav" aria-label="Settings sections">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`cull-settings__navitem${tab === t.id ? " is-active" : ""}`}
                onClick={() => setTab(t.id)}
                aria-current={tab === t.id}
              >
                {t.label}
              </button>
            ))}
          </nav>

          <div className="cull-settings__pane">
            {tab === "general" && (
              <>
                <SettingRow
                  label="Reopen last folder"
                  help="Skip the home screen on launch."
                >
                  <Toggle
                    on={settings.openLastFolderOnLaunch}
                    onChange={(v) => set("openLastFolderOnLaunch", v)}
                    label="Reopen last folder"
                  />
                </SettingRow>
                <SettingRow
                  label="Default filter"
                  help="Filter selected when a cull starts."
                >
                  <SegmentToggle<Filter>
                    value={settings.defaultFilter}
                    options={[
                      { value: "all", label: "All" },
                      { value: "unrated", label: "Unrated" },
                      { value: "keeps", label: "Keeps" },
                      { value: "keepsFavs", label: "Keeps · ★" },
                    ]}
                    onChange={(v) => set("defaultFilter", v)}
                  />
                </SettingRow>
                <SettingRow
                  label="Default overlays"
                  help="Active at start. Toggle with i / h / p / o / t."
                >
                  <div className="cull-settings__chips">
                    <Chip
                      label="Thumbnails"
                      on={settings.defaultThumbsVisible}
                      onChange={(v) => set("defaultThumbsVisible", v)}
                    />
                    <Chip
                      label="Info"
                      on={settings.defaultExifVisible}
                      onChange={(v) => set("defaultExifVisible", v)}
                    />
                    <Chip
                      label="Clipping"
                      on={settings.defaultClippingVisible}
                      onChange={(v) => set("defaultClippingVisible", v)}
                    />
                    <Chip
                      label="Peaking"
                      on={settings.defaultPeakingVisible}
                      onChange={(v) => set("defaultPeakingVisible", v)}
                    />
                    <Chip
                      label="Thirds"
                      on={settings.defaultCompositionVisible}
                      onChange={(v) => set("defaultCompositionVisible", v)}
                    />
                  </div>
                </SettingRow>
                <SettingRow
                  label="Thumb strip position"
                  help="Placement of the thumbnail strip."
                >
                  <SegmentToggle<ThumbsPosition>
                    value={settings.thumbsPosition}
                    options={[
                      { value: "bottom", label: "Bottom" },
                      { value: "top", label: "Top" },
                    ]}
                    onChange={(v) => set("thumbsPosition", v)}
                  />
                </SettingRow>
              </>
            )}

            {tab === "smart" && (
              <>
                <SettingRow
                  label="Suggestions"
                  help={
                    settings.smartCulling
                      ? "Suggests rejects from sharpness, exposure, and burst analysis. Never rates or writes files."
                      : "No analysis runs."
                  }
                >
                  <Toggle
                    on={settings.smartCulling}
                    onChange={(v) => set("smartCulling", v)}
                    label="Smart culling suggestions"
                  />
                </SettingRow>
                <div
                  className={`cull-settings__group${settings.smartCulling ? "" : " is-off"}`}
                  aria-disabled={!settings.smartCulling}
                >
                  <SettingRow
                    label="Suggestion threshold"
                    help={`Suggests at ${Math.round(LEVEL_THRESHOLD[settings.smartCullingConfidence] * 100)}%+ confidence.`}
                  >
                    <SegmentToggle<SmartLevel>
                      value={settings.smartCullingConfidence}
                      options={[
                        { value: "low", label: "Low" },
                        { value: "medium", label: "Medium" },
                        { value: "high", label: "High" },
                      ]}
                      onChange={(v) => set("smartCullingConfidence", v)}
                      disabled={!settings.smartCulling}
                    />
                  </SettingRow>
                  <SettingRow
                    label="Deep analysis"
                    help={
                      settings.deepAnalysis
                        ? "Face and eye checks, look-alike grouping, starred picks. Runs locally."
                        : "Sharpness, exposure, and burst analysis only."
                    }
                  >
                    <Toggle
                      on={settings.deepAnalysis}
                      onChange={(v) => set("deepAnalysis", v)}
                      label="Deep analysis"
                      disabled={!settings.smartCulling}
                    />
                  </SettingRow>
                  <SettingRow
                    label="Analyze on open"
                    help={
                      settings.smartCullingOnOpen
                        ? "Analyzes when a folder opens."
                        : "Press 4 in the Smart filter to analyze."
                    }
                  >
                    <Toggle
                      on={settings.smartCullingOnOpen}
                      onChange={(v) => set("smartCullingOnOpen", v)}
                      label="Analyze on open"
                      disabled={!settings.smartCulling}
                    />
                  </SettingRow>
                </div>
              </>
            )}

            {tab === "files" && (
              <>
                <SettingRow
                  label="Rejected subfolder"
                  help="Destination subfolder for rejected files."
                >
                  <RejectedSubfolderInput
                    value={settings.rejectedSubfolder}
                    onChange={(v) => set("rejectedSubfolder", v)}
                  />
                </SettingRow>
                <SettingRow
                  label="Copy keeps to"
                  help={
                    exportMode === "pinned"
                      ? "Copies to the pinned root below without asking."
                      : "Opens a folder picker each time you copy keeps."
                  }
                >
                  <SegmentToggle<"remember" | "pinned">
                    value={exportMode}
                    options={[
                      { value: "remember", label: "Ask each time" },
                      { value: "pinned", label: "Pinned root" },
                    ]}
                    onChange={(mode) => {
                      if (mode === "remember") onChange({ ...settings, exportFolder: { mode: "remember" } });
                      else if (settings.exportFolder.mode !== "pinned") {
                        // We let the PinnedRoot row pick the folder; meanwhile set
                        // pinned with an empty path so the row appears.
                        onChange({ ...settings, exportFolder: { mode: "pinned", path: "" } });
                      }
                    }}
                  />
                </SettingRow>
                {exportMode === "pinned" && (
                  <SettingRow
                    label="Pinned root"
                    help="Each session writes a subfolder under this root."
                  >
                    <PinnedRootControl
                      path={pinnedPath}
                      onPick={(p) => onChange({ ...settings, exportFolder: { mode: "pinned", path: p } })}
                    />
                  </SettingRow>
                )}
              </>
            )}

            {tab === "storage" && (
              <>
                <SettingRow
                  label="Drive speed"
                  help={
                    settings.storageMode === "network"
                      ? "Throttles reads for slow NAS or USB drives."
                      : "Reads at full speed for a fast local drive."
                  }
                >
                  {/* Stored values stay "local"/"network" (profile keys + the
                      backend's set_io_profile wire format) — only the words are
                      user-facing: speed describes the drive better than location. */}
                  <SegmentToggle<StorageMode>
                    value={settings.storageMode}
                    options={[
                      { value: "local", label: "Normal" },
                      { value: "network", label: "Slow" },
                    ]}
                    onChange={(v) => set("storageMode", v)}
                  />
                </SettingRow>
                <ThumbCacheRow />
                <ResetRow onReset={() => onChange(DEFAULT_SETTINGS)} />
              </>
            )}
          </div>
        </div>

        <div className="cull-settings__foot">
          <kbd>esc</kbd> to close · <kbd>{modGlyph} ,</kbd> to reopen
        </div>
      </div>
    </div>
  );
}

type TabId = "general" | "smart" | "files" | "storage";

const TABS: { id: TabId; label: string }[] = [
  { id: "general", label: "General" },
  { id: "smart", label: "Smart culling" },
  { id: "files", label: "Files" },
  { id: "storage", label: "Storage" },
];

function SettingRow({
  label,
  help,
  children,
}: {
  label: string;
  help?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="cull-settings__row">
      <div className="cull-settings__row-text">
        <div className="cull-settings__row-name">{label}</div>
        {help && <div className="cull-settings__row-help">{help}</div>}
      </div>
      <div className="cull-settings__row-control">{children}</div>
    </div>
  );
}

function SegmentToggle<T extends string>({
  value,
  options,
  onChange,
  disabled,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (next: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className={`cull-settings__seg${disabled ? " is-disabled" : ""}`}>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className={`cull-settings__seg-opt${value === opt.value ? " is-active" : ""}`}
          onClick={() => !disabled && onChange(opt.value)}
          disabled={disabled}
          aria-pressed={value === opt.value}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

/** Small chip — on/off pill, used for default overlay set. */
function Chip({
  label,
  on,
  onChange,
}: {
  label: string;
  on: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      className={`cull-settings__chip${on ? " is-on" : ""}`}
      onClick={() => onChange(!on)}
      aria-pressed={on}
    >
      {label}
    </button>
  );
}

/** Knob-style on/off toggle. `label` is the accessible name —
 *  the knob has no text content, so AT would otherwise announce it nameless. */
function Toggle({
  on,
  onChange,
  label,
  disabled,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={`cull-settings__toggle${on ? " is-on" : ""}`}
      onClick={() => !disabled && onChange(!on)}
      disabled={disabled}
      aria-pressed={on}
      aria-label={label}
    />
  );
}

/**
 * Pinned-root pick row — shows the picked path (or "(no folder picked)") and
 * a Change button. The native folder picker can take seconds to appear on
 * Windows (mapped network drives, Quick Access enumeration), so we surface a
 * `opening…` state on the button and ignore further clicks until it resolves.
 */
function PinnedRootControl({
  path,
  onPick,
}: {
  path: string;
  onPick: (next: string) => void;
}) {
  const [picking, setPicking] = useState(false);

  const pick = async () => {
    if (picking) return;
    setPicking(true);
    try {
      const picked = await open({
        directory: true,
        multiple: false,
        defaultPath: path || undefined,
        title: "pin export folder",
      });
      if (typeof picked === "string") onPick(picked);
    } finally {
      setPicking(false);
    }
  };

  return (
    <div className="cull-settings__pinned-control">
      <span
        className="cull-settings__pinned-path"
        title={path || "(no folder picked)"}
      >
        {path || "(no folder picked)"}
      </span>
      <button
        type="button"
        className="cull-pick-button"
        onClick={pick}
        disabled={picking}
      >
        {picking ? "opening…" : "Change"}
      </button>
    </div>
  );
}

/**
 * Rejected-subfolder text input — silent failsafe. Sanitizes Windows-illegal
 * chars on every keystroke (so a paste of `c:\bad` collapses to `cbad`), shows
 * a red border while the value is empty (no help-text noise — purely visual),
 * and on blur restores the default with a brief champagne flash so the user
 * sees the change. Mirrors the dest-sub field in the finish dialog.
 */
function RejectedSubfolderInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [flashing, setFlashing] = useState(false);

  const isEmpty = value.trim().length === 0;

  return (
    <input
      ref={inputRef}
      type="text"
      className={`cull-settings__text${isEmpty ? " is-invalid" : ""}${flashing ? " is-flash" : ""}`}
      value={value}
      spellCheck={false}
      aria-label="Rejected subfolder name"
      placeholder={DEFAULT_SETTINGS.rejectedSubfolder}
      onChange={(e) => onChange(sanitizeFolderName(e.target.value))}
      onBlur={() => {
        if (value.trim().length === 0) {
          onChange(DEFAULT_SETTINGS.rejectedSubfolder);
          setFlashing(true);
          window.setTimeout(() => setFlashing(false), 900);
        }
      }}
    />
  );
}

/**
 * Thumbnail cache row — shows the current on-disk cache size (bytes → MB) and
 * a "Clear" button. Both values come from the Rust backend via IPC.
 */
function ThumbCacheRow() {
  const [cacheSize, setCacheSize] = useState<number | null>(null);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    invoke<number>("thumb_cache_size").then(setCacheSize).catch(() => setCacheSize(null));
  }, []);

  const handleClear = async () => {
    if (clearing) return; // guard against a double-click firing two clears
    setClearing(true);
    try {
      await invoke("clear_thumb_cache");
    } catch {
      // swallow — re-read the size below so the display reflects reality either way
    } finally {
      try {
        setCacheSize(await invoke<number>("thumb_cache_size"));
      } catch {
        setCacheSize(null); // unknown → drop the "Currently …" suffix, not a wrong 0
      }
      setClearing(false);
    }
  };

  const mbLabel =
    cacheSize !== null
      ? ` Currently ${Math.round(cacheSize / 1048576)} MB.`
      : "";

  return (
    <SettingRow
      label="Image cache"
      help={`Cached previews for faster re-opens. Safe to clear.${mbLabel}`}
    >
      <button
        type="button"
        className="cull-pick-button"
        onClick={handleClear}
        disabled={clearing}
      >
        {clearing ? "Clearing…" : "Clear"}
      </button>
    </SettingRow>
  );
}

/** Reset all settings — two-step inline confirm to prevent a misclick wiping
 * prefs. Stage 1: a red-outlined "Reset" button. Stage 2: "Sure?" inline
 * message with primary "Yes, reset". Auto-disarms after 4 s (and Esc / clicking
 * outside closes the dialog), so no explicit Cancel button is needed. */
function ResetRow({ onReset }: { onReset: () => void }) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const t = window.setTimeout(() => setArmed(false), 4000);
    return () => window.clearTimeout(t);
  }, [armed]);

  return (
    <div className="cull-settings__row">
      <div className="cull-settings__row-text">
        <div className="cull-settings__row-name">Reset to defaults</div>
        <div className="cull-settings__row-help">
          Restores all settings. Your files are never affected.
        </div>
      </div>
      <div className="cull-settings__row-control">
        {armed ? (
          <div className="cull-settings__reset-confirm">
            <span className="cull-settings__reset-msg">Sure?</span>
            <button
              type="button"
              className="cull-settings__reset is-armed"
              onClick={() => {
                onReset();
                setArmed(false);
              }}
            >
              Yes, reset
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="cull-settings__reset"
            onClick={() => setArmed(true)}
          >
            Reset
          </button>
        )}
      </div>
    </div>
  );
}

