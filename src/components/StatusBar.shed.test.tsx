// @vitest-environment jsdom
import type { SetStateAction } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { StatusBar, type StatusBarProps } from "./StatusBar";
import type { Filter } from "../types";

/**
 * Below 1360 / 1240 / 1120 px of window width the footer sheds, in CSS. jsdom
 * has no layout and evaluates no media query, so what is testable here is the
 * CONTRACT the CSS needs: every shed label is rendered in BOTH forms, each in
 * its own element, and nothing the accessible name is built from moved.
 */
function props(over: Partial<StatusBarProps["frame"]> = {}): StatusBarProps {
  return {
    frame: {
      filename: "IMG_0042.CR3",
      rating: "reject",
      isZooming: true,
      zoomLevel: 2,
      scrubbing: true,
      scrubSpeed: 10,
      compareMode: false,
      comparePos: -1,
      compareCount: 0,
      ...over,
    },
    overlays: {
      visible: true,
      exif: { on: false, toggle: vi.fn((): void => {}) },
      clipping: { on: false, toggle: vi.fn((): void => {}) },
      peaking: { on: false, toggle: vi.fn((): void => {}) },
      composition: { on: false, toggle: vi.fn((): void => {}) },
      thumbs: { on: true, toggle: vi.fn((): void => {}) },
    },
    selection: { gridVisible: false, selectedCount: 0 },
    save: {
      savingCount: 0,
      failedCount: 4194,
      missingCount: 4194,
      retryFailed: vi.fn((): void => {}),
    },
    filter: {
      filter: "all",
      setFilter: vi.fn((_v: SetStateAction<Filter>): void => {}),
      stats: { total: 4194, unrated: 0, keeps: 4194 },
      qualityAnalyzing: false,
      qualityProgress: null,
      smartCulling: false,
      startAnalysis: vi.fn((): void => {}),
      suggestionCount: 0,
      chipsTooltip: {
        visible: false,
        pulse: vi.fn((): void => {}),
        hoverProps: {
          onPointerEnter: vi.fn((): void => {}),
          onPointerLeave: vi.fn((): void => {}),
        },
      },
      positionInFilter: 0,
      visibleCount: 4194,
    },
    session: { openActions: vi.fn((): void => {}), actionsOpen: false, rejectedCount: 0 },
  };
}

const q = (container: HTMLElement, sel: string): HTMLElement => {
  const el = container.querySelector<HTMLElement>(sel);
  if (!el) throw new Error(`no element matching ${sel}`);
  return el;
};

afterEach(cleanup);

describe("the footer renders both label forms", () => {
  it("splits the filename into a shrinkable stem and a droppable extension", () => {
    const { container } = render(<StatusBar {...props()} />);
    expect(q(container, ".cull-statusbar__filename-name").textContent).toBe("IMG_0042");
    expect(q(container, ".cull-statusbar__filename-ext").textContent).toBe(".CR3");
  });

  it("splits the zoom chip's word from its value", () => {
    const { container } = render(<StatusBar {...props()} />);
    expect(q(container, ".cull-statusbar__chip-label").textContent).toBe("zoom");
    expect(q(container, ".cull-statusbar__chip-value").textContent).toBe("2:1");
  });

  it("gives the scrub word and the verdict word their own elements", () => {
    const { container } = render(<StatusBar {...props()} />);
    expect(q(container, ".cull-statusbar__scrub-label").textContent).toBe("Scrubbing");
    expect(q(container, ".cull-statusbar__verdict-label").textContent).toBe("Reject");
    // The name stays on the pill, so dropping the word costs nothing to AT.
    expect(screen.getByLabelText("Reject")).toBeTruthy();
  });

  it("gives the save chip a droppable action tail without changing its name", () => {
    const { container } = render(<StatusBar {...props()} />);
    const chip = screen.getByRole("button", { name: "4194 photos missing · check again" });
    expect(q(chip, ".cull-statusbar__unsaved-tail").textContent).toBe(" · check again");
    expect(container.querySelector(".cull-statusbar__unsaved")).toBe(chip);
  });

  it("renders the long finish label and a short one beside it", () => {
    const { container } = render(<StatusBar {...props()} />);
    expect(q(container, ".cull-statusbar__finish-long").textContent).toContain("All 4194 rated");
    expect(q(container, ".cull-statusbar__finish-short").textContent).toBe("Finish");
  });
});

describe("the Rejects tab", () => {
  it("is the fifth tab, last, labelled in sentence case", () => {
    const { container } = render(<StatusBar {...props()} />);
    const tabs = container.querySelector(".cull-filter-tabs");
    if (!tabs) throw new Error("no .cull-filter-tabs");
    const labels = [...tabs.querySelectorAll(":scope > button, :scope > span > button")].map(
      (b) => b.textContent,
    );
    expect(labels).toEqual(["All", "Unrated", "Keeps", "Smart", "Rejects"]);
  });

  it("offers its key in the hover tip while inactive, and drops it while active", () => {
    const { container } = render(<StatusBar {...props()} />);
    const rejects = container.querySelector<HTMLElement>(".cull-filter-tabs > button:last-child");
    if (!rejects) throw new Error("no Rejects tab");
    expect(rejects.getAttribute("data-tip")).toBe("5 · show rejects");
  });

  it("splits Smart's count suffix into its own element, leaving the name whole", () => {
    const base = props();
    render(<StatusBar {...base} filter={{ ...base.filter, suggestionCount: 4194 }} />);
    const smart = screen.getByRole("button", { name: "Smart · 4194" });
    const count = smart.querySelector(".cull-statusbar__smart-count");
    expect(count?.textContent).toBe("· 4194");
  });
});
