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

    const base = props();
    const { container: activeContainer } = render(
      <StatusBar {...base} filter={{ ...base.filter, filter: "rejects" }} />,
    );
    const activeRejects = activeContainer.querySelector<HTMLElement>(
      ".cull-filter-tabs > button:last-child",
    );
    if (!activeRejects) throw new Error("no active Rejects tab");
    expect(activeRejects.getAttribute("data-tip")).toBeNull();
    // Same active class the other four tabs use (All / Unrated / Keeps / Smart).
    expect(activeRejects.className).toBe("is-active");
  });

  it("splits Smart's count suffix into its own element, leaving the name whole", () => {
    const base = props();
    render(<StatusBar {...base} filter={{ ...base.filter, suggestionCount: 4194 }} />);
    // The Smart tab now carries role="tab" (StatusBar.tabs.test.tsx), so its
    // accessible role is "tab", not the button default.
    const smart = screen.getByRole("tab", { name: "Smart · 4194" });
    const count = smart.querySelector(".cull-statusbar__smart-count");
    expect(count?.textContent).toBe("· 4194");
  });
});

/**
 * Every footer tip names a key, and with the stars-and-labels layer on the
 * bare digit row belongs to the stars — so the five filters move to Shift.
 * A hint that still said "3" would send the user's keeps press into a star.
 */
describe("the filter tabs' key hints follow the stars-and-labels setting", () => {
  /** Tab label → its hover tip (null while that tab is the active one). */
  function tips(over: Partial<StatusBarProps["filter"]>): Record<string, string | null> {
    const base = props();
    const { container } = render(<StatusBar {...base} filter={{ ...base.filter, ...over }} />);
    const tabs = container.querySelector(".cull-filter-tabs");
    if (!tabs) throw new Error("no .cull-filter-tabs");
    const out: Record<string, string | null> = {};
    for (const b of tabs.querySelectorAll(":scope > button, :scope > span > button")) {
      out[b.textContent ?? ""] = b.getAttribute("data-tip");
    }
    return out;
  }

  it("names the bare digits while the layer is off", () => {
    expect(tips({ filter: "unrated" })).toEqual({
      All: "1 · show all",
      Unrated: null,
      Keeps: "3 · show keeps",
      Smart: "4 · show suggestions",
      Rejects: "5 · show rejects",
    });
    cleanup();
    expect(tips({ filter: "all" }).Unrated).toBe("2 · show unrated");
  });

  it("moves every tip onto Shift once the digits are stars", () => {
    expect(tips({ filter: "unrated", starsAndLabels: true })).toEqual({
      All: "Shift+1 · show all",
      Unrated: null,
      Keeps: "Shift+3 · show keeps",
      Smart: "Shift+4 · show suggestions",
      Rejects: "Shift+5 · show rejects",
    });
    cleanup();
    expect(tips({ filter: "all", starsAndLabels: true }).Unrated).toBe("Shift+2 · show unrated");
  });
});
