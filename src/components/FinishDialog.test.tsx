// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { Settings } from "../types";
import { DEFAULT_SETTINGS } from "../types/settings";
import { FinishDialog } from "./FinishDialog";

/**
 * What a failed rating write is allowed to do to the finish actions.
 *
 * The rule the dialog exists to hold: only a failure a retry can be expected
 * to fix may disable "Move rejects" and the copy CTA. A photo that was not at
 * its path is warned about and nothing more — blocking on it would leave the
 * session with no way to finish at all, since nothing inside this dialog can
 * clear it. Three lines of arithmetic, and no test pinned any of them.
 *
 * The whole dialog is rendered rather than a gating function lifted out of it:
 * the component needs only its two Tauri modules mocked, and what is under
 * test is a `disabled` a user can see, not a boolean an implementation
 * happens to compute.
 */

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

/**
 * "Ask each time" (the default): the copy half is a single "Pick destination"
 * CTA carrying exactly the gates the pinned-mode button carries, and no
 * filesystem probe runs at all — `path_exists` is a pinned-mode effect.
 */
const settings: Settings = { ...DEFAULT_SETTINGS, exportFolder: { mode: "remember" } };

/** A session with something to move and something to copy, so nothing but the
 *  write-failure counts can be what disables an action. */
function renderDialog(counts: {
  savingCount: number;
  failedCount: number;
  missingCount: number;
}): void {
  render(
    <FinishDialog
      folder="C:\\shoot"
      folderName="shoot"
      keptPaths={["C:\\shoot\\a.cr3"]}
      rejectedPaths={["C:\\shoot\\b.cr3"]}
      favorites={0}
      unrated={0}
      keepsCount={1}
      savingCount={counts.savingCount}
      failedCount={counts.failedCount}
      missingCount={counts.missingCount}
      actionBusy={null}
      moveResult={null}
      copyResult={null}
      settings={settings}
      onMoveRejects={vi.fn()}
      onCopyKeeps={vi.fn()}
      onClose={vi.fn()}
    />,
  );
}

const moveButton = (): HTMLButtonElement => screen.getByRole("button", { name: "Move rejects" });
const copyButton = (): HTMLButtonElement =>
  screen.getByRole("button", { name: "Pick destination" });

describe("FinishDialog — which failures block finishing", () => {
  afterEach(cleanup);

  it("lets the cull be finished when every failure is a photo that was not at its path", () => {
    renderDialog({ savingCount: 0, failedCount: 1, missingCount: 1 });

    expect(moveButton().disabled).toBe(false);
    expect(copyButton().disabled).toBe(false);
    // Warned about, all the same — and told it is not what is holding anything up.
    expect(screen.getByText(/do not block the actions below/)).toBeTruthy();
  });

  it("blocks both actions while a failure could still be saved", () => {
    renderDialog({ savingCount: 0, failedCount: 1, missingCount: 0 });

    expect(moveButton().disabled).toBe(true);
    expect(copyButton().disabled).toBe(true);
    expect(screen.getByText(/actions disabled until resolved/)).toBeTruthy();
  });

  it("blocks both actions while a write is still in flight, and says so first", () => {
    // A missing photo is present too: the saving note has to win, because
    // "these failures do not block the actions below" would contradict the
    // disabled buttons it would be sitting next to.
    renderDialog({ savingCount: 1, failedCount: 1, missingCount: 1 });

    expect(moveButton().disabled).toBe(true);
    expect(copyButton().disabled).toBe(true);
    expect(screen.getByText(/actions wait for the sidecars to land/)).toBeTruthy();
    expect(screen.queryByText(/do not block the actions below/)).toBeNull();
  });

  it("leaves the actions alone when nothing failed and nothing is in flight", () => {
    // The control: proves the three cases above are the counts talking, not a
    // fixture that disables the buttons for some other reason.
    renderDialog({ savingCount: 0, failedCount: 0, missingCount: 0 });

    expect(moveButton().disabled).toBe(false);
    expect(copyButton().disabled).toBe(false);
    expect(screen.queryByText(/actions disabled until resolved/)).toBeNull();
    expect(screen.queryByText(/actions wait for the sidecars to land/)).toBeNull();
    expect(screen.queryByText(/do not block the actions below/)).toBeNull();
  });
});
