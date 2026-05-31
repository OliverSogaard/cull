import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Settings as SettingsIcon } from "lucide-react";
import type { ExportFolderMode, Filter, Settings } from "../types";
import { DEFAULT_SETTINGS } from "../types/settings";

/**
 * Settings modal. Opens with `Ctrl + ,` or the gear icons on the home screen
 * / status bar. Rows are grouped into sections; each row has a fixed-height
 * help block so toggling a value never reflows anything below.
 *
 * Edits write through immediately (no apply / cancel) — every control is a
 * quick toggle the user can flip back. The "reset all" button at the bottom
 * needs a second click within a few seconds to commit, so a stray click
 * doesn't wipe everything.
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

  return (
    <div className="cull-quitguard">
      <div className="cull-quitguard__box cull-settings">
        <div className="cull-settings__title">
          <SettingsIcon size={14} strokeWidth={2} />
          <span>settings</span>
        </div>

        <div className="cull-settings__scroll">
          {/* ───────────── Storage ───────────── */}
          <Section title="storage">
            <SettingRow
              label="where are your photos?"
              help={
                settings.storageMode === "local"
                  ? "Photos on this computer (or directly attached drive). Reads are fast, so cull caches more frames ahead and warms the zoom layer quickly."
                  : "Photos on a network drive (NAS, mapped SMB, SSHFS). Reads are slower and concurrent opens can cause stalls, so cull is more careful with prefetch."
              }
            >
              <SegmentToggle
                value={settings.storageMode}
                options={[
                  { value: "local", label: "on this computer" },
                  { value: "network", label: "on a network drive" },
                ]}
                onChange={(storageMode) => set("storageMode", storageMode)}
              />
            </SettingRow>
          </Section>

          {/* ───────────── Defaults on entering a cull ───────────── */}
          <Section title="when you start a cull">
            <SettingRow label="filter" help="Which frames are visible on entry. Status-bar 1-4 still cycle during the cull.">
              <SegmentToggle<Filter>
                value={settings.defaultFilter}
                options={[
                  { value: "all", label: "all" },
                  { value: "unrated", label: "unrated" },
                  { value: "keeps", label: "keeps" },
                  { value: "favorites", label: "★" },
                ]}
                onChange={(v) => set("defaultFilter", v)}
              />
            </SettingRow>

            <SettingRow
              label="overlays on entry"
              help="Which loupe overlays + the thumbnail strip start visible. I / H / P / O / T still toggle them during the cull."
            >
              <div className="cull-settings__checks">
                <CheckChip
                  label="thumbnails"
                  on={settings.defaultThumbsVisible}
                  onChange={(v) => set("defaultThumbsVisible", v)}
                />
                <CheckChip
                  label="info"
                  on={settings.defaultExifVisible}
                  onChange={(v) => set("defaultExifVisible", v)}
                />
                <CheckChip
                  label="clipping"
                  on={settings.defaultClippingVisible}
                  onChange={(v) => set("defaultClippingVisible", v)}
                />
                <CheckChip
                  label="peaking"
                  on={settings.defaultPeakingVisible}
                  onChange={(v) => set("defaultPeakingVisible", v)}
                />
                <CheckChip
                  label="thirds"
                  on={settings.defaultCompositionVisible}
                  onChange={(v) => set("defaultCompositionVisible", v)}
                />
              </div>
            </SettingRow>
          </Section>

          {/* ───────────── File operations ───────────── */}
          <Section title="file operations">
            <SettingRow
              label="rejected subfolder"
              help='Subfolder created inside the cull folder when you "move rejects". Default: _rejected'
            >
              <input
                type="text"
                className="cull-settings__text"
                value={settings.rejectedSubfolder}
                spellCheck={false}
                placeholder={DEFAULT_SETTINGS.rejectedSubfolder}
                onChange={(e) => set("rejectedSubfolder", e.target.value)}
              />
            </SettingRow>

            <SettingRow
              label="export folder"
              help={
                settings.exportFolder.mode === "remember"
                  ? "When you copy keeps, the picker opens at the last folder you exported to."
                  : "When you copy keeps, always export here (no picker)."
              }
            >
              <ExportFolderControl
                value={settings.exportFolder}
                onChange={(v) => set("exportFolder", v)}
              />
            </SettingRow>
          </Section>

          {/* ───────────── Launch ───────────── */}
          <Section title="on launch">
            <SettingRow
              label="open last folder"
              help="Skip the home screen and reopen the folder you last culled. Falls back to the home screen if that folder no longer exists."
            >
              <SegmentToggle
                value={settings.openLastFolderOnLaunch ? "yes" : "no"}
                options={[
                  { value: "no", label: "show home screen" },
                  { value: "yes", label: "open last folder" },
                ]}
                onChange={(v) => set("openLastFolderOnLaunch", v === "yes")}
              />
            </SettingRow>
          </Section>

          {/* ───────────── House-keeping ───────────── */}
          <Section title="reset">
            <ResetRow onReset={() => onChange(DEFAULT_SETTINGS)} />
          </Section>
        </div>

        <div className="cull-quitguard__actions">
          <button className="cull-pick-button" onClick={onClose}>
            close
          </button>
        </div>
        <div className="cull-quitguard__hint">
          esc to close · keybind <kbd>ctrl</kbd>+<kbd>,</kbd>
        </div>
      </div>
    </div>
  );
}

/** Section header — a thin top-line and a small uppercase label. */
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
      <div className="cull-settings__row-head">
        <div className="cull-settings__row-name">{label}</div>
        <div className="cull-settings__row-control">{children}</div>
      </div>
      {help && <div className="cull-settings__row-help">{help}</div>}
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
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

/** Small on/off chip — used for grouping related boolean toggles in one row. */
function CheckChip({
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
      className={`cull-settings__check${on ? " is-active" : ""}`}
      onClick={() => onChange(!on)}
      aria-pressed={on}
    >
      {label}
    </button>
  );
}

/**
 * Export-folder control: a remember-vs-pin toggle plus, when pinned, a path
 * display and a Browse button. The native folder picker can take seconds to
 * appear on Windows (mapped network drives, Quick Access enumeration), so we
 * surface a `picking…` state on both the segment toggle and the Browse button
 * while the OS dialog is in flight — and ignore further clicks until it
 * resolves.
 */
function ExportFolderControl({
  value,
  onChange,
}: {
  value: ExportFolderMode;
  onChange: (next: ExportFolderMode) => void;
}) {
  const [picking, setPicking] = useState(false);

  const pick = async () => {
    if (picking) return;
    setPicking(true);
    try {
      const picked = await open({
        directory: true,
        multiple: false,
        defaultPath: value.mode === "pinned" ? value.path : undefined,
        title: "pin export folder",
      });
      if (typeof picked === "string") {
        onChange({ mode: "pinned", path: picked });
      }
    } finally {
      setPicking(false);
    }
  };

  return (
    <div className="cull-settings__export">
      <SegmentToggle
        value={value.mode}
        disabled={picking}
        options={[
          { value: "remember", label: "remember last" },
          { value: "pinned", label: picking ? "opening picker…" : "always to…" },
        ]}
        onChange={(mode) => {
          if (mode === "remember") onChange({ mode: "remember" });
          else if (value.mode !== "pinned") pick();
          else onChange(value);
        }}
      />
      {value.mode === "pinned" && (
        <div className="cull-settings__export-pinned">
          <code className="cull-settings__path">{value.path || "(no folder picked)"}</code>
          <button
            type="button"
            className="cull-settings__browse"
            onClick={pick}
            disabled={picking}
          >
            {picking ? "opening…" : "browse…"}
          </button>
        </div>
      )}
    </div>
  );
}

/** Reset all settings — two-click confirm to prevent a misclick wiping prefs. */
function ResetRow({ onReset }: { onReset: () => void }) {
  const [armed, setArmed] = useState(false);

  return (
    <div className="cull-settings__row">
      <div className="cull-settings__row-head">
        <div className="cull-settings__row-name">reset everything to defaults</div>
        <button
          type="button"
          className={`cull-settings__reset${armed ? " is-armed" : ""}`}
          onClick={() => {
            if (armed) {
              onReset();
              setArmed(false);
            } else {
              setArmed(true);
              window.setTimeout(() => setArmed(false), 4000);
            }
          }}
        >
          {armed ? "click again to confirm" : "reset"}
        </button>
      </div>
      <div className="cull-settings__row-help">
        Returns every setting on this page to its default. Doesn't touch any
        ratings or sidecars — those live on disk.
      </div>
    </div>
  );
}
