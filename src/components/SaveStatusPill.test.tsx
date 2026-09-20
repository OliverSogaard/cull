// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SaveStatusPill } from "./SaveStatusPill";

/**
 * The top-chrome mirror of the status-bar chip has the same focus-loss bug:
 * the saving state used to be a plain <span>, so a retry that lands and flips
 * the pill to "saving" dropped keyboard focus to <body>. Pinned the same way.
 */

describe("SaveStatusPill — keeps focus through a retry", () => {
  afterEach(cleanup);

  it("keeps the same button focused across failed -> saving -> failed, and blocks the click while saving", () => {
    const onRetry = vi.fn((): void => {});
    const { rerender } = render(
      <SaveStatusPill failedCount={2} missingCount={0} savingCount={0} onRetry={onRetry} />,
    );
    const pill = screen.getByRole<HTMLButtonElement>("button");
    pill.focus();
    expect(document.activeElement).toBe(pill);

    rerender(<SaveStatusPill failedCount={0} missingCount={0} savingCount={2} onRetry={onRetry} />);
    expect(document.body.contains(pill)).toBe(true);
    expect(document.activeElement).toBe(pill);
    expect(pill.getAttribute("aria-disabled")).toBe("true");
    expect(pill.disabled).toBe(false);

    fireEvent.click(pill);
    expect(onRetry).not.toHaveBeenCalled();

    rerender(<SaveStatusPill failedCount={2} missingCount={0} savingCount={0} onRetry={onRetry} />);
    expect(screen.getByRole("button")).toBe(pill);
    fireEvent.click(pill);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("keeps focus through a retry for an all-missing failure too", () => {
    const onRetry = vi.fn((): void => {});
    const { rerender } = render(
      <SaveStatusPill failedCount={1} missingCount={1} savingCount={0} onRetry={onRetry} />,
    );
    const pill = screen.getByRole("button");
    pill.focus();

    rerender(<SaveStatusPill failedCount={0} missingCount={0} savingCount={1} onRetry={onRetry} />);
    expect(document.activeElement).toBe(pill);
    fireEvent.click(pill);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("renders the plain saving state — never preceded by a failure — as a real button too", () => {
    render(<SaveStatusPill failedCount={0} missingCount={0} savingCount={1} onRetry={vi.fn()} />);
    const pill = screen.getByRole("button");
    expect(pill.tagName).toBe("BUTTON");
    expect(pill.getAttribute("aria-disabled")).toBe("true");
  });

  it("renders nothing once idle", () => {
    render(<SaveStatusPill failedCount={0} missingCount={0} savingCount={0} onRetry={vi.fn()} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
