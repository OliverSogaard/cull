// @vitest-environment jsdom
import { useState } from "react";
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
  it("offers the sort as one pressed-state button, and says its state in words", () => {
    render(
      <StagedFolders
        images={twoFolders}
        sortByCaptureTime
        onToggleSort={noop}
        offsets={{}}
        onOffsetChange={noop}
      />,
    );
    // The label carries on/off itself — a single folder staged renders no
    // rows either way, so colour alone would be the only signal there.
    const toggle = screen.getByRole("button", { name: "Sort by capture time · on" });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
  });

  it("says 'off' in the label when the sort is off", () => {
    render(
      <StagedFolders
        images={twoFolders}
        sortByCaptureTime={false}
        onToggleSort={noop}
        offsets={{}}
        onOffsetChange={noop}
      />,
    );
    const toggle = screen.getByRole("button", { name: "Sort by capture time · off" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
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
    // A probe that resolves to no times at all pins the "—" fallback, not
    // just an unasserted default — both rows show it, since both are null.
    expect(screen.getAllByText("—")).toHaveLength(2);
    // fireEvent, not a raw dispatchEvent: it wraps the dispatch in act(), and
    // its init carries the modifier flags the stepper reads.
    fireEvent.click(later);
    expect(onOffsetChange).toHaveBeenLastCalledWith("C:\\shoot\\bodyB", 6000);
    fireEvent.click(later, { shiftKey: true });
    expect(onOffsetChange).toHaveBeenLastCalledWith("C:\\shoot\\bodyB", 65000);
    fireEvent.click(later, { ctrlKey: true });
    expect(onOffsetChange).toHaveBeenLastCalledWith("C:\\shoot\\bodyB", 0);
  });

  it("keeps Enter inside the row — it must not fall through to the staged screen's begin-culling shortcut", async () => {
    vi.mocked(invoke).mockResolvedValue([null, null]);
    const windowKeydown = vi.fn();
    window.addEventListener("keydown", windowKeydown);
    render(
      <StagedFolders
        images={twoFolders}
        sortByCaptureTime
        onToggleSort={noop}
        offsets={{}}
        onOffsetChange={noop}
      />,
    );
    const later = await screen.findByRole("button", { name: "bodyB · later" });
    // The staged screen's real Enter shortcut is a window-level keydown
    // listener (useCullKeymap.ts); a spy standing in for it here is enough to
    // prove the event never reaches that far — not just that some handler
    // somewhere ran.
    fireEvent.keyDown(later, { key: "Enter" });
    expect(windowKeydown).not.toHaveBeenCalled();
    window.removeEventListener("keydown", windowKeydown);
  });

  it("bakes each folder's offset into its delta — nudging the stepper moves the delta by exactly the nudge", async () => {
    vi.mocked(invoke).mockResolvedValue([
      Date.UTC(2026, 8, 20, 14, 2, 11),
      Date.UTC(2026, 8, 20, 14, 1, 0),
    ]);
    function Harness() {
      const [offsets, setOffsets] = useState<Record<string, number>>({});
      return (
        <StagedFolders
          images={twoFolders}
          sortByCaptureTime
          onToggleSort={noop}
          offsets={offsets}
          onOffsetChange={(folder, ms) => setOffsets((prev) => ({ ...prev, [folder]: ms }))}
        />
      );
    }
    render(<Harness />);
    // Baseline: no offset applied yet, so the delta is the raw gap between
    // the two folders' first frames (also covered by the probe test above).
    await waitFor(() => expect(screen.getByText("\u22121 min 11 s")).toBeTruthy());
    const later = screen.getByRole("button", { name: "bodyB · later" });
    fireEvent.click(later); // +1 s nudge to bodyB's offset
    // (first + offset) − (reference + referenceOffset) moved by the same +1 s
    // the stepper just applied: −1 min 11 s → −1 min 10 s, not still −1:11.
    await waitFor(() => expect(screen.getByText("\u22121 min 10 s")).toBeTruthy());
    expect(screen.queryByText("\u22121 min 11 s")).toBeNull();
  });
});
