// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QuitGuardOverlay } from "./QuitGuardOverlay";

/**
 * The missing-photo branch used to leave "check again" behind the dialog it
 * was blocking: only "Keep culling" (close the guard, go fix the drive) and
 * "Close anyway" (lose the rating) were on offer. "Check again" re-attempts
 * the same writes the footer's chip would, so the user who just plugged the
 * drive back in doesn't have to close the guard first.
 */

describe("QuitGuardOverlay", () => {
  afterEach(cleanup);

  it("offers Check again for missing photos, between Keep culling and Close anyway", () => {
    const retryFailed = vi.fn((): void => {});
    const onKeepCulling = vi.fn((): void => {});
    const onCloseAnyway = vi.fn((): void => {});
    render(
      <QuitGuardOverlay
        failedCount={2}
        missingCount={2}
        savingCount={0}
        retryFailed={retryFailed}
        onKeepCulling={onKeepCulling}
        onCloseAnyway={onCloseAnyway}
      />,
    );
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual([
      "Keep culling",
      "Check again",
      "Close anyway",
    ]);
    expect(buttons[0].className).toContain("btn--primary");

    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(retryFailed).toHaveBeenCalledTimes(1);
    expect(onKeepCulling).not.toHaveBeenCalled();
    expect(onCloseAnyway).not.toHaveBeenCalled();
  });

  it("still offers exactly Retry saving, Keep culling, Close anyway for an ordinary failure", () => {
    render(
      <QuitGuardOverlay
        failedCount={2}
        missingCount={0}
        savingCount={0}
        retryFailed={vi.fn()}
        onKeepCulling={vi.fn()}
        onCloseAnyway={vi.fn()}
      />,
    );
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual([
      "Retry saving",
      "Keep culling",
      "Close anyway",
    ]);
  });

  it("leaves the saving branch unchanged: just Keep culling", () => {
    render(
      <QuitGuardOverlay
        failedCount={0}
        missingCount={0}
        savingCount={1}
        retryFailed={vi.fn()}
        onKeepCulling={vi.fn()}
        onCloseAnyway={vi.fn()}
      />,
    );
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["Keep culling"]);
  });
});
