// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SettingsDialog } from "./SettingsDialog";
import { DEFAULT_SETTINGS } from "../types/settings";
import type { Settings } from "../types";

declare const __APP_VERSION__: string;

/**
 * The stars-and-labels switch, and the one piece of Settings copy that names
 * a filter digit. Both are about the SETTING being the single source of
 * truth: the toggle writes a whole Settings object (there is no updater
 * form), and the copy has to name the key the keymap actually binds.
 */

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

afterEach(cleanup);

function open(over: Partial<Settings> = {}) {
  const onChange = vi.fn((_next: Settings): void => {});
  const settings: Settings = { ...DEFAULT_SETTINGS, ...over };
  render(<SettingsDialog settings={settings} onChange={onChange} onClose={() => {}} />);
  return { onChange, settings };
}

describe("the stars and colour labels toggle", () => {
  it("is off by default and writes a WHOLE settings object when flipped", () => {
    const { onChange, settings } = open();
    const toggle = screen.getByRole("button", { name: "Stars and colour labels" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(toggle);

    expect(onChange).toHaveBeenCalledWith({ ...settings, starsAndLabels: true });
  });

  it("flips back off from on", () => {
    const { onChange, settings } = open({ starsAndLabels: true });
    const toggle = screen.getByRole("button", { name: "Stars and colour labels" });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(toggle);

    expect(onChange).toHaveBeenCalledWith({ ...settings, starsAndLabels: false });
  });

  it("says which keys it takes over", () => {
    open();
    expect(
      screen.getByText(
        "Lightroom's keys: 1–5 stars, 0 clears, 6–9 colour labels, Shift+6 purple. Filters move to Shift+1–5.",
      ),
    ).toBeTruthy();
  });
});

describe("the analyze hint names the key the keymap binds", () => {
  it("is the bare digit with the layer off", () => {
    open({ smartCullingOnOpen: false });
    fireEvent.click(screen.getByRole("button", { name: "Smart culling" }));
    expect(screen.getByText("Press 4 in the Smart filter to analyze.")).toBeTruthy();
  });

  it("moves to Shift with the layer on — 4 is a star there", () => {
    open({ smartCullingOnOpen: false, starsAndLabels: true });
    fireEvent.click(screen.getByRole("button", { name: "Smart culling" }));
    expect(screen.getByText("Press Shift+4 in the Smart filter to analyze.")).toBeTruthy();
  });
});

describe("the About tab", () => {
  it("sits last in the rail and names the version the build carries", () => {
    open();
    const items = screen.getAllByRole("button", {
      name: /General|Smart culling|Files|Storage|About/,
    });
    expect(items[items.length - 1].textContent).toBe("About");
    fireEvent.click(screen.getByRole("button", { name: "About" }));
    expect(screen.getByText("CULL", { selector: ".cull-about__name" })).toBeTruthy();
    expect(screen.getByText(__APP_VERSION__)).toBeTruthy();
    expect(screen.getByText("github.com/OliverSogaard/cull")).toBeTruthy();
    // Without a check result it must not claim to be current.
    expect(screen.getByText("Could not check for updates at launch.")).toBeTruthy();
  });

  it("tells a finished check apart from one that could not run, and offers a found release", () => {
    const onInstall = vi.fn();
    const base = { settings: DEFAULT_SETTINGS, onChange: () => {}, onClose: () => {} };
    const { unmount } = render(
      <SettingsDialog {...base} update={{ state: { status: "current" }, onInstall }} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "About" }));
    expect(screen.getByText("Up to date.")).toBeTruthy();
    unmount();

    render(
      <SettingsDialog
        {...base}
        update={{ state: { status: "available", version: "1.0.2" }, onInstall }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "About" }));
    expect(screen.getByText("Update 1.0.2 is ready to install")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Install and restart" }));
    expect(onInstall).toHaveBeenCalledTimes(1);
  });
});
