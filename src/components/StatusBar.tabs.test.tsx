// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { StatusBar, type StatusBarProps } from "./StatusBar";

/**
 * The five footer filter tabs sit in a `role="tablist"` div but, until now,
 * carried no `role="tab"` / `aria-selected` of their own — a screen reader had
 * no way to tell which of the five was active, or that they were tabs at all.
 */

function baseProps(filter: StatusBarProps["filter"]): StatusBarProps {
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
    save: { savingCount: 0, failedCount: 0, missingCount: 0, retryFailed: vi.fn() },
    filter,
    session: { openActions: vi.fn(), actionsOpen: false, rejectedCount: 0 },
  };
}

function filterProps(over: Partial<StatusBarProps["filter"]>): StatusBarProps["filter"] {
  return {
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
    ...over,
  };
}

describe("the footer's filter tabs are real tabs", () => {
  afterEach(cleanup);

  it("marks exactly one of the five tabs selected — the active filter", () => {
    render(<StatusBar {...baseProps(filterProps({ filter: "keeps" }))} />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(5);
    const selected = tabs.filter((t) => t.getAttribute("aria-selected") === "true");
    expect(selected).toHaveLength(1);
    expect(selected[0]).toBe(screen.getByRole("tab", { name: "Keeps" }));
  });

  it("moves the selected tab when the active filter moves", () => {
    render(<StatusBar {...baseProps(filterProps({ filter: "rejects" }))} />);
    const selected = screen
      .getAllByRole("tab")
      .filter((t) => t.getAttribute("aria-selected") === "true");
    expect(selected).toHaveLength(1);
    expect(selected[0]).toBe(screen.getByRole("tab", { name: "Rejects" }));
  });
});
