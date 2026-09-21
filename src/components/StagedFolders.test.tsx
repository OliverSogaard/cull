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

  it("PROBE — documents this jsdom's :focus-visible: modality-aware from OUTSIDE a handler, but not from inside the keydown handler for the key in flight", () => {
    // Outside any handler, this repo's jsdom (30.0.1) tracks input modality
    // correctly: a mouse click (fireEvent.click does not itself move focus
    // in jsdom, unlike a real browser — .focus() reproduces the real
    // post-click end state) does not count as keyboard focus…
    const clicked = render(<button type="button">clicked</button>);
    const clickedBtn = clicked.getByRole("button");
    fireEvent.click(clickedBtn);
    clickedBtn.focus();
    expect(clickedBtn.matches(":focus-visible")).toBe(false);
    clicked.unmount();

    // …while a keydown immediately before .focus() — what a real Tab press
    // leaves behind — DOES.
    const tabbed = render(<button type="button">tabbed</button>);
    const tabbedBtn = tabbed.getByRole("button");
    fireEvent.keyDown(document.body, { key: "Tab" });
    tabbedBtn.focus();
    expect(tabbedBtn.matches(":focus-visible")).toBe(true);
    tabbed.unmount();

    // BUT: re-checked from WITHIN a keydown handler for the very key that's
    // currently being dispatched, it always reads true — regardless of how
    // focus was acquired — because jsdom treats "a keyboard event is
    // dispatching right now" as sufficient evidence on its own. Real
    // Chromium decides `:focus-visible` once, at focus time, and does not
    // re-derive it from whatever event happens to be in flight, so this is a
    // jsdom-only confound — but it means a live `fireEvent.keyDown` cannot
    // exercise `isKeyboardFocused` the way the two tests below need to, and
    // they stub `Element.prototype.matches` instead.
    const mouseFocused = render(<button type="button">mouse-focused</button>);
    const mouseFocusedBtn = mouseFocused.getByRole("button");
    let insideHandler: boolean | null = null;
    mouseFocusedBtn.addEventListener("keydown", () => {
      insideHandler = mouseFocusedBtn.matches(":focus-visible");
    });
    fireEvent.click(mouseFocusedBtn);
    mouseFocusedBtn.focus();
    expect(mouseFocusedBtn.matches(":focus-visible")).toBe(false); // true just before…
    fireEvent.keyDown(mouseFocusedBtn, { key: "Enter" });
    expect(insideHandler).toBe(true); // …but true once inside the Enter handler
    mouseFocused.unmount();
  });

  it("keeps Enter inside the row when focus is keyboard-style (:focus-visible) — it must not fall through to the staged screen's begin-culling shortcut", async () => {
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
    later.focus();
    // Pin the exact case the fix branches on, independent of the jsdom
    // confound the PROBE test above documents: delegate every OTHER selector
    // to the real implementation, and answer `:focus-visible` ourselves.
    const originalMatches = Element.prototype.matches;
    const matchesSpy = vi.spyOn(Element.prototype, "matches").mockImplementation(function (
      this: Element,
      selector: string,
    ): boolean {
      if (selector === ":focus-visible") return this === later;
      return originalMatches.call(this, selector);
    });
    try {
      // The staged screen's real Enter shortcut is a window-level keydown
      // listener (useCullKeymap.ts); a spy standing in for it here is enough
      // to prove the event never reaches that far.
      fireEvent.keyDown(later, { key: "Enter" });
      expect(windowKeydown).not.toHaveBeenCalled();
    } finally {
      matchesSpy.mockRestore();
      window.removeEventListener("keydown", windowKeydown);
    }
  });

  it("lets Enter fall through when focus is NOT keyboard-style (a mouse-clicked button) — so a re-activated button cannot swallow Enter forever", async () => {
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
    later.focus();
    const originalMatches = Element.prototype.matches;
    const matchesSpy = vi.spyOn(Element.prototype, "matches").mockImplementation(function (
      this: Element,
      selector: string,
    ): boolean {
      if (selector === ":focus-visible") return false; // a mouse-clicked button
      return originalMatches.call(this, selector);
    });
    try {
      fireEvent.keyDown(later, { key: "Enter" });
      expect(windowKeydown).toHaveBeenCalledTimes(1);
    } finally {
      matchesSpy.mockRestore();
      window.removeEventListener("keydown", windowKeydown);
    }
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
