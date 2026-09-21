// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { StagedFolders } from "./StagedFolders";
import type { Img } from "../types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const img = (id: number, srcFolder: string, name: string): Img => ({
  id,
  path: `${srcFolder}\\${name}`,
  filename: name,
  srcFolder,
});

const twoFolders: Img[] = [
  img(0, "C:\\shoot\\bodyA", "A1.CR3"),
  img(1, "C:\\shoot\\bodyA", "A2.CR3"),
  img(2, "C:\\shoot\\bodyB", "B1.CR3"),
];

beforeEach(() => vi.mocked(invoke).mockReset());
afterEach(cleanup);

const noop = (): void => {};

describe("the staged screen's capture-time controls", () => {
  it("offers the sort as one pressed-state button", () => {
    render(
      <StagedFolders
        images={twoFolders}
        sortByCaptureTime
        onToggleSort={noop}
        offsets={{}}
        onOffsetChange={noop}
      />,
    );
    const toggle = screen.getByRole("button", { name: "Sort by capture time" });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
  });

  it("shows no folder rows when the sort is off, and probes nothing", () => {
    render(
      <StagedFolders
        images={twoFolders}
        sortByCaptureTime={false}
        onToggleSort={noop}
        offsets={{}}
        onOffsetChange={noop}
      />,
    );
    expect(screen.queryByRole("list", { name: "Staged folders" })).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("shows no folder rows for a single staged folder — there is nothing to offset against", () => {
    render(
      <StagedFolders
        images={[img(0, "C:\\shoot\\bodyA", "A1.CR3")]}
        sortByCaptureTime
        onToggleSort={noop}
        offsets={{}}
        onOffsetChange={noop}
      />,
    );
    expect(screen.queryByRole("list", { name: "Staged folders" })).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("probes ONE frame per folder and prints each folder's first capture time", async () => {
    vi.mocked(invoke).mockResolvedValue([
      Date.UTC(2026, 8, 20, 14, 2, 11),
      Date.UTC(2026, 8, 20, 14, 1, 0),
    ]);
    render(
      <StagedFolders
        images={twoFolders}
        sortByCaptureTime
        onToggleSort={noop}
        offsets={{}}
        onOffsetChange={noop}
      />,
    );
    await waitFor(() => expect(screen.getByText("14:02:11")).toBeTruthy());
    expect(invoke).toHaveBeenCalledWith("read_capture_times", {
      paths: ["C:\\shoot\\bodyA\\A1.CR3", "C:\\shoot\\bodyB\\B1.CR3"],
    });
    // The second folder's hint is its signed difference from the first's.
    expect(screen.getByText("\u22121 min 11 s")).toBeTruthy();
  });

  it("steps the offset by a second, a minute with Shift, and back to 0 with Ctrl", async () => {
    vi.mocked(invoke).mockResolvedValue([null, null]);
    const onOffsetChange = vi.fn((_folder: string, _ms: number): void => {});
    render(
      <StagedFolders
        images={twoFolders}
        sortByCaptureTime
        onToggleSort={noop}
        offsets={{ "C:\\shoot\\bodyB": 5000 }}
        onOffsetChange={onOffsetChange}
      />,
    );
    const later = await screen.findByRole("button", { name: "bodyB · later" });
    // fireEvent, not a raw dispatchEvent: it wraps the dispatch in act(), and
    // its init carries the modifier flags the stepper reads.
    fireEvent.click(later);
    expect(onOffsetChange).toHaveBeenLastCalledWith("C:\\shoot\\bodyB", 6000);
    fireEvent.click(later, { shiftKey: true });
    expect(onOffsetChange).toHaveBeenLastCalledWith("C:\\shoot\\bodyB", 65000);
    fireEvent.click(later, { ctrlKey: true });
    expect(onOffsetChange).toHaveBeenLastCalledWith("C:\\shoot\\bodyB", 0);
  });
});
