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

/**
 * The missing/retry -> saving transition renders a dialog__actions with
 * fewer buttons. Without keys, React matched the old buttons by POSITION:
 * the pressed "Check again" node (position 1) got unmounted (focus fell to
 * <body>), and the pressed "Retry saving" node (position 0) was reused and
 * silently relabelled "Keep culling" — so a second Enter did something else.
 * Keys fix the matching; moving focus to "Keep culling" before firing the
 * retry keeps it there through whichever transition follows.
 */
describe("QuitGuardOverlay — keeps focus on Keep culling through a re-check", () => {
  afterEach(cleanup);

  it("from the missing-photo branch: Check again", () => {
    const retryFailed = vi.fn((): void => {});
    const { rerender } = render(
      <QuitGuardOverlay
        failedCount={2}
        missingCount={2}
        savingCount={0}
        retryFailed={retryFailed}
        onKeepCulling={vi.fn()}
        onCloseAnyway={vi.fn()}
      />,
    );
    const keepBefore = screen.getByRole("button", { name: "Keep culling" });
    const checkAgain = screen.getByRole("button", { name: "Check again" });
    checkAgain.focus();
    fireEvent.click(checkAgain);
    expect(retryFailed).toHaveBeenCalledTimes(1);

    rerender(
      <QuitGuardOverlay
        failedCount={0}
        missingCount={0}
        savingCount={1}
        retryFailed={retryFailed}
        onKeepCulling={vi.fn()}
        onCloseAnyway={vi.fn()}
      />,
    );
    const keepAfter = screen.getByRole("button", { name: "Keep culling" });
    expect(keepAfter).toBe(keepBefore);
    expect(document.activeElement).toBe(keepAfter);
  });

  it("from the ordinary-failure branch: Retry saving", () => {
    const retryFailed = vi.fn((): void => {});
    const { rerender } = render(
      <QuitGuardOverlay
        failedCount={2}
        missingCount={0}
        savingCount={0}
        retryFailed={retryFailed}
        onKeepCulling={vi.fn()}
        onCloseAnyway={vi.fn()}
      />,
    );
    const keepBefore = screen.getByRole("button", { name: "Keep culling" });
    const retrySaving = screen.getByRole("button", { name: "Retry saving" });
    retrySaving.focus();
    fireEvent.click(retrySaving);
    expect(retryFailed).toHaveBeenCalledTimes(1);

    rerender(
      <QuitGuardOverlay
        failedCount={0}
        missingCount={0}
        savingCount={1}
        retryFailed={retryFailed}
        onKeepCulling={vi.fn()}
        onCloseAnyway={vi.fn()}
      />,
    );
    const keepAfter = screen.getByRole("button", { name: "Keep culling" });
    expect(keepAfter).toBe(keepBefore);
    expect(document.activeElement).toBe(keepAfter);
    // The pressed node is retired on the transition, never silently
    // repurposed as "Keep culling" under the user's held focus.
    expect(keepAfter).not.toBe(retrySaving);
    expect(document.body.contains(retrySaving)).toBe(false);
  });

  it("keeps the Keep culling DOM node itself stable across branch changes", () => {
    const { rerender } = render(
      <QuitGuardOverlay
        failedCount={2}
        missingCount={0}
        savingCount={0}
        retryFailed={vi.fn()}
        onKeepCulling={vi.fn()}
        onCloseAnyway={vi.fn()}
      />,
    );
    const inRetryBranch = screen.getByRole("button", { name: "Keep culling" });

    rerender(
      <QuitGuardOverlay
        failedCount={2}
        missingCount={2}
        savingCount={0}
        retryFailed={vi.fn()}
        onKeepCulling={vi.fn()}
        onCloseAnyway={vi.fn()}
      />,
    );
    const inMissingBranch = screen.getByRole("button", { name: "Keep culling" });
    expect(inMissingBranch).toBe(inRetryBranch);
  });
});
