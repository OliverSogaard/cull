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

  it("(a) lets Enter fall through after a pointerDown + click on the toggle — a still-focused clicked button must not swallow Enter forever", async () => {
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
    const toggle = screen.getByRole("button", { name: "Sort by capture time · on" });
    fireEvent.pointerDown(toggle);
    fireEvent.click(toggle);
    // Chromium leaves focus on a clicked button; jsdom's fireEvent.click does
    // not itself move focus (unlike a real browser), so .focus() reproduces
    // that real end state.
    toggle.focus();
    fireEvent.keyDown(toggle, { key: "Enter" });
    expect(windowKeydown).toHaveBeenCalledTimes(1);
    window.removeEventListener("keydown", windowKeydown);
  });

  it("(b) keeps Enter inside the toggle when focus arrived with no pointerDown at all", async () => {
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
    const toggle = screen.getByRole("button", { name: "Sort by capture time · on" });
    // No pointerDown anywhere in the block — e.g. Tab landed here, or this
    // is the very first thing focused after the screen mounted.
    toggle.focus();
    fireEvent.keyDown(toggle, { key: "Enter" });
    expect(windowKeydown).not.toHaveBeenCalled();
    window.removeEventListener("keydown", windowKeydown);
  });

  it("(c) a Tab after a pointerDown switches the block back to keyboard modality — Enter on the newly focused control stays local", async () => {
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
    const earlier = await screen.findByRole("button", { name: "bodyB · earlier" });
    const later = screen.getByRole("button", { name: "bodyB · later" });
    fireEvent.pointerDown(earlier);
    fireEvent.click(earlier);
    // Tab moves focus BY the keyboard — from here on, whatever ends up
    // focused inside the block is keyboard focus, even though the last
    // pointer-ish thing that happened was a click on a sibling control.
    // The Tab keydown itself legitimately bubbles to the window spy too (our
    // handler never stops IT, only reads it) — clear the spy right after, so
    // the assertion below is unambiguously about the ENTER dispatch alone.
    fireEvent.keyDown(earlier, { key: "Tab" });
    windowKeydown.mockClear();
    later.focus(); // simulate the Tab actually landing on the next stepper
    fireEvent.keyDown(later, { key: "Enter" });
    expect(windowKeydown).not.toHaveBeenCalled();
    window.removeEventListener("keydown", windowKeydown);
  });

  it("(d) focus leaving the block resets modality — a later keyboard re-focus keeps Enter local again", async () => {
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
    const toggle = screen.getByRole("button", { name: "Sort by capture time · on" });
    fireEvent.pointerDown(toggle);
    fireEvent.click(toggle);
    toggle.focus();
    // Focus leaves the block entirely (relatedTarget outside the container)
    // — this must clear the pointer flag, not leave it stuck true forever.
    fireEvent.blur(toggle, { relatedTarget: document.body });
    toggle.focus(); // e.g. Tab back into the block later
    fireEvent.keyDown(toggle, { key: "Enter" });
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

  it("cannot show a stale folder's time under a new folder's name while a re-stage's probe is still pending", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([
      Date.UTC(2026, 8, 20, 14, 2, 11),
      Date.UTC(2026, 8, 20, 14, 1, 0),
    ]);
    const { rerender } = render(
      <StagedFolders
        images={twoFolders}
        sortByCaptureTime
        onToggleSort={noop}
        offsets={{}}
        onOffsetChange={noop}
      />,
    );
    await waitFor(() => expect(screen.getByText("14:02:11")).toBeTruthy());

    // Re-stage a completely different folder set and leave ITS probe
    // pending forever \u2014 the assertions below only need the reset that
    // happens synchronously on the folder-set change, never the answer.
    vi.mocked(invoke).mockReturnValueOnce(new Promise<never>(() => {}));
    const differentFolders: Img[] = [
      img(10, "C:\\shoot\\bodyC", "C1.CR3"),
      img(11, "C:\\shoot\\bodyD", "D1.CR3"),
    ];
    rerender(
      <StagedFolders
        images={differentFolders}
        sortByCaptureTime
        onToggleSort={noop}
        offsets={{}}
        onOffsetChange={noop}
      />,
    );
    // bodyA's old "14:02:11" must be gone the instant the folder set
    // changes, not still sitting under bodyC's or bodyD's row.
    expect(screen.queryByText("14:02:11")).toBeNull();
    expect(screen.getAllByText("\u2014")).toHaveLength(2);
  });
});
