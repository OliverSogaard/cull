// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StatusBar, type StatusBarProps } from "./StatusBar";

/**
 * The save-failure chip used to change element type under the user's cursor:
 * a real <button> while failed, a plain <span> while saving. That swap drops
 * keyboard focus to <body> the instant a retry starts landing its writes.
 * These tests pin the fix — one <button> in one code path for every state,
 * disabled only via aria-disabled so focus survives the transition.
 */

function baseProps(save: StatusBarProps["save"]): StatusBarProps {
  return {
    frame: {
      filename: null,
      rating: null,
      isZooming: false,
      zoomLevel: 1,
      scrubbing: false,
      scrubSpeed: 1,
      compareMode: false,
      comparePos: -1,
      compareCount: 0,
    },
    overlays: {
      visible: false,
      exif: { on: false, toggle: vi.fn() },
      clipping: { on: false, toggle: vi.fn() },
      peaking: { on: false, toggle: vi.fn() },
      composition: { on: false, toggle: vi.fn() },
      thumbs: { on: false, toggle: vi.fn() },
    },
    selection: { gridVisible: false, selectedCount: 0 },
    save,
    filter: {
      filter: "all",
      setFilter: vi.fn(),
      stats: { total: 0, unrated: 0, keeps: 0 },
      qualityAnalyzing: false,
      qualityProgress: null,
      smartCulling: false,
      startAnalysis: vi.fn(),
      suggestionCount: 0,
      chipsTooltip: {
        visible: false,
        pulse: vi.fn(),
        hoverProps: { onPointerEnter: vi.fn(), onPointerLeave: vi.fn() },
      },
      positionInFilter: 0,
      visibleCount: 0,
    },
    session: { openActions: vi.fn(), actionsOpen: false, rejectedCount: 0 },
  };
}

describe("StatusBar save chip — keeps focus through a retry", () => {
  afterEach(cleanup);

  it("keeps the same button focused across failed -> saving -> failed, and blocks the click while saving", () => {
    const retryFailed = vi.fn((): void => {});
    const { rerender } = render(
      <StatusBar
        {...baseProps({ savingCount: 0, failedCount: 3, missingCount: 0, retryFailed })}
      />,
    );
    const chip = screen.getByRole<HTMLButtonElement>("button", { name: "3 unsaved · retry" });
    chip.focus();
    expect(document.activeElement).toBe(chip);

    // retryFailed deletes the failed paths and bumps savingCount in the same
    // commit — failedCount and savingCount cross over in one render.
    rerender(
      <StatusBar
        {...baseProps({ savingCount: 1, failedCount: 0, missingCount: 0, retryFailed })}
      />,
    );
    expect(document.body.contains(chip)).toBe(true);
    expect(document.activeElement).toBe(chip);
    expect(chip.getAttribute("aria-disabled")).toBe("true");
    expect(chip.disabled).toBe(false);
    expect(chip.textContent).toBe("Saving 1…");

    fireEvent.click(chip);
    expect(retryFailed).not.toHaveBeenCalled();

    rerender(
      <StatusBar
        {...baseProps({ savingCount: 0, failedCount: 3, missingCount: 0, retryFailed })}
      />,
    );
    expect(screen.getByRole("button", { name: "3 unsaved · retry" })).toBe(chip);
    fireEvent.click(chip);
    expect(retryFailed).toHaveBeenCalledTimes(1);
  });

  it("keeps focus through a retry for an all-missing failure too", () => {
    const retryFailed = vi.fn((): void => {});
    const { rerender } = render(
      <StatusBar
        {...baseProps({ savingCount: 0, failedCount: 2, missingCount: 2, retryFailed })}
      />,
    );
    const chip = screen.getByRole("button", { name: "2 photos missing · check again" });
    chip.focus();

    rerender(
      <StatusBar
        {...baseProps({ savingCount: 2, failedCount: 0, missingCount: 0, retryFailed })}
      />,
    );
    expect(document.activeElement).toBe(chip);
    fireEvent.click(chip);
    expect(retryFailed).not.toHaveBeenCalled();
  });

  it("renders the plain saving state — never preceded by a failure — as the same kind of button, unchanged in look", () => {
    render(
      <StatusBar
        {...baseProps({ savingCount: 2, failedCount: 0, missingCount: 0, retryFailed: vi.fn() })}
      />,
    );
    const chip = screen.getByRole("button", { name: "Saving 2…" });
    expect(chip.tagName).toBe("BUTTON");
    expect(chip.className).toContain("cull-statusbar__unsaved");
    expect(chip.getAttribute("aria-disabled")).toBe("true");
    expect(chip.querySelector("svg")).toBeNull();
  });

  it("renders nothing when there is nothing saving and nothing failed", () => {
    render(
      <StatusBar
        {...baseProps({ savingCount: 0, failedCount: 0, missingCount: 0, retryFailed: vi.fn() })}
      />,
    );
    expect(screen.queryByText(/Saving/)).toBeNull();
    expect(screen.queryByText(/unsaved/)).toBeNull();
  });
});
