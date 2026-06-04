import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { Filter, Settings, StorageMode, ThumbsPosition } from "../types";
import { DEFAULT_SETTINGS } from "../types/settings";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { sanitizeFolderName } from "../utils/path";

/**
 * Settings modal. Opens with `Ctrl + ,` or the settings cog in the top-right
 * window chrome. Sections + control patterns match cull.html exactly.
 *
 * Edits write through immediately (no apply / cancel) — every control is a
 * quick toggle the user can flip back. The "Reset" button needs a second
 * click ("Yes, reset") to commit, so a stray click doesn't wipe everything.
 */
export function SettingsDialog({
  settings,
  onChange,
}: {
  settings: Settings;
  onChange: (next: Settings) => void;
}) {
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    onChange({ ...settings, [key]: value });

  const exportMode = settings.exportFolder.mode;
  const pinnedPath =
    settings.exportFolder.mode === "pinned" ? settings.exportFolder.path : "";

  const trapRef = useFocusTrap<HTMLDivElement>();

  return (
    <div className="cull-quitguard cull-settings-overlay">
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
          <span className="cull-settings__head-meta">CULL 1.0</span>
        </div>

        <div className="cull-settings__body">
          {/* ───────────── Storage ───────────── */}
          <Section title="Storage">
            <SettingRow
              label="Storage mode"
              help="Network turns down concurrency for slow NAS / SMB shares. Default Local for fast drives."
            >
              <SegmentToggle<StorageMode>
                value={settings.storageMode}
                options={[
                  { value: "local", label: "Local" },
                  { value: "network", label: "Network" },
                ]}
                onChange={(v) => set("storageMode", v)}
              />
            </SettingRow>
          </Section>

          {/* ───────────── When you start a cull ───────────── */}
          <Section title="When you start a cull">
            <SettingRow
              label="Default filter"
              help="Starts in this filter when you open a folder."
            >
              <SegmentToggle<Filter>
                value={settings.defaultFilter}
                options={[
                  { value: "all", label: "All" },
                  { value: "unrated", label: "Unrated" },
                  { value: "keeps", label: "Keeps" },
                  { value: "favorites", label: "★" },
                ]}
                onChange={(v) => set("defaultFilter", v)}
              />
            </SettingRow>

            <SettingRow
              label="Default overlays"
              help="Which overlays start on. Toggle anytime with i / h / p / o / t."
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
              help="Where the loupe / compare thumbnail strip sits."
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
          </Section>

          {/* ───────────── File operations ───────────── */}
          <Section title="File operations">
            <SettingRow
              label="Rejected subfolder"
              help="Rejected files move into this subfolder of the source."
            >
              <RejectedSubfolderInput
                value={settings.rejectedSubfolder}
                onChange={(v) => set("rejectedSubfolder", v)}
              />
            </SettingRow>

            <SettingRow
              label="Copy keeps to"
              help='Where keepers go when you run "Copy keeps".'
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
              <div className="cull-settings__pinned-config">
                <SettingRow
                  label="Pinned root"
                  help="Each session writes to a subfolder under this. Subfolder name is editable in the finish dialog."
                >
                  <PinnedRootControl
                    path={pinnedPath}
                    onPick={(p) => onChange({ ...settings, exportFolder: { mode: "pinned", path: p } })}
                  />
                </SettingRow>
              </div>
            )}
          </Section>

          {/* ───────────── On launch ───────────── */}
          <Section title="On launch">
            <SettingRow
              label="Reopen last folder"
              help="Skip the home screen when CULL starts."
            >
              <Toggle
                on={settings.openLastFolderOnLaunch}
                onChange={(v) => set("openLastFolderOnLaunch", v)}
                label="Reopen last folder"
              />
            </SettingRow>
          </Section>

          {/* ───────────── Cache ───────────── */}
          <Section title="Cache">
            <ThumbCacheRow />
          </Section>

          {/* ───────────── Reset ───────────── */}
          <Section title="Reset">
            <ResetRow onReset={() => onChange(DEFAULT_SETTINGS)} />
          </Section>
        </div>

        <div className="cull-settings__foot">
          <kbd>esc</kbd> to close · <kbd>⌃ ,</kbd> to reopen
        </div>
      </div>
    </div>
  );
}

/** Section header. */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="cull-settings__section">
      <div className="cull-settings__section-title">{title}</div>
      {children}
    </div>
  );
}

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

/** Knob-style on/off toggle (mockup .toggle). `label` is the accessible name —
 *  the knob has no text content, so AT would otherwise announce it nameless. */
function Toggle({
  on,
  onChange,
  label,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      className={`cull-settings__toggle${on ? " is-on" : ""}`}
      onClick={() => onChange(!on)}
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
      label="Thumbnail cache"
      help={`Low-res previews cached on disk for instant re-opens. Lives in the OS cache folder; safe to clear anytime.${mbLabel}`}
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
 * message with primary "Yes, reset" and a "Cancel" escape. Auto-disarms after
 * 4 s so a walked-away dialog can't be triggered. */
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
          Restores everything in this dialog. Doesn't touch your CR3s or XMPs.
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
            <button
              type="button"
              className="cull-pick-button"
              onClick={() => setArmed(false)}
            >
              Cancel
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

