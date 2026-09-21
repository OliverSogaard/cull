// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { createRef, type RefObject } from "react";

const thumb = vi.hoisted(() => ({
  value: {
    url: "blob:thmb",
    gridUrl: undefined as string | undefined,
    shimmerDelayMs: 0,
    probeOnLoad: undefined,
  },
}));
vi.mock("../image/useThumb", () => ({
  useThumb: () => thumb.value,
  thumbDisplayUrl: (i: { thumbUrl?: string }) => i.thumbUrl,
}));

import { GridView } from "./GridView";
import { ThumbCell } from "./ThumbCell";
import type { Img, LabelValue, Star } from "../types";

// jsdom has no ResizeObserver; GridView's tracking effects only need
// observe/disconnect to exist for this fixed-size fixture.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverStub);

const images: Img[] = [{ id: 1, path: "/a.cr3", filename: "IMG_0001.CR3", srcFolder: "/" }];

function renderGrid(
  over: {
    starsAndLabels?: boolean;
    stars?: Record<number, Star>;
    labels?: Record<number, LabelValue>;
    metadata?: Record<string, { lrcRating: number | null }>;
  } = {},
) {
  const ref: RefObject<HTMLDivElement | null> = createRef<HTMLDivElement>();
  return render(
    <GridView
      images={images}
      visibleIndices={[0]}
      currentIndex={0}
      cols={2}
      contentWidth={600}
      ratings={{}}
      selectedIndices={new Set<number>()}
      onPick={vi.fn((_i: number, _m: { shift: boolean; ctrl: boolean }) => {})}
      containerRef={ref}
      onViewportChange={vi.fn((_f: number, _l: number) => {})}
      {...(over as object)}
    />,
  );
}

afterEach(cleanup);

describe("the grid cell with the layer OFF", () => {
  test("draws neither a star count nor a label bar, and keeps the LrC badge", () => {
    const { container } = renderGrid({
      stars: { 1: 3 },
      labels: { 1: "red" },
      metadata: { "/a.cr3": { lrcRating: 2 } },
    });
    expect(container.querySelector(".cull-mark-count")).toBeNull();
    expect(container.querySelector(".cull-label-bar")).toBeNull();
    expect(container.querySelector(".cull-grid__lrc-badge")).not.toBeNull();
  });
});

describe("the grid cell with the layer ON", () => {
  test("puts the count in the free corner and the bar on the bottom edge", () => {
    const { container } = renderGrid({
      starsAndLabels: true,
      stars: { 1: 3 },
      labels: { 1: "blue" },
    });
    const count = container.querySelector(".cull-grid__star");
    expect(count?.textContent).toBe("3");
    expect(count?.getAttribute("aria-label")).toBe("3 of 5 stars");
    // The number is text; the star beside it is a Lucide SVG, never the ★
    // character (icons.test.ts fails on one in the chrome).
    expect(count?.querySelector("svg")).not.toBeNull();
    const bar = container.querySelector(".cull-label-bar");
    expect(bar?.className).toContain("cull-label--blue");
    expect(bar?.className).toContain("cull-grid__label-bar");
  });

  test("drops the read-only LrC badge — it is the same property, snapshotted", () => {
    const { container } = renderGrid({
      starsAndLabels: true,
      stars: { 1: 4 },
      metadata: { "/a.cr3": { lrcRating: 2 } },
    });
    expect(container.querySelector(".cull-grid__lrc-badge")).toBeNull();
    expect(container.querySelector(".cull-grid__star")?.textContent).toBe("4");
  });

  test("an unstarred, unlabelled frame draws nothing extra", () => {
    const { container } = renderGrid({ starsAndLabels: true });
    expect(container.querySelector(".cull-grid__star")).toBeNull();
    expect(container.querySelector(".cull-label-bar")).toBeNull();
  });
});

describe("the filmstrip cell", () => {
  const cell = (
    over: { starsAndLabels?: boolean; label?: LabelValue; lrcRating?: number | null } = {},
  ) =>
    render(
      <ThumbCell
        img={images[0]}
        index={0}
        isCurrent={false}
        rating={undefined}
        dimmed={false}
        onPick={vi.fn((_i: number) => {})}
        {...over}
      />,
    );

  test("draws no bar with the layer off, even when handed a label", () => {
    const { container } = cell({ label: "green" });
    expect(container.querySelector(".cull-label-bar")).toBeNull();
  });

  test("draws the bar and NOTHING else — 76x54 has no room for a third mark", () => {
    const { container } = cell({ starsAndLabels: true, label: "green" });
    const bar = container.querySelector(".cull-label-bar");
    expect(bar?.className).toContain("cull-label--green");
    expect(container.querySelector(".cull-mark-count")).toBeNull();
    expect(container.querySelector(".cull-mark-stars")).toBeNull();
    // Positive twin of the two absence checks above: this cell can never
    // render `.cull-mark-count` or `.cull-mark-stars` under ANY state (no
    // branch produces them), so those two asserts alone are vacuously true —
    // they would stay true even if the strip grew a star display under some
    // OTHER class name. Counting every mark-ish node the frame actually
    // carries (everything but the thumbnail image itself) catches that case:
    // it must be exactly the one label bar.
    const frame = container.querySelector(".cull-thumb__frame");
    const marks = [...(frame?.children ?? [])].filter(
      (el) => !el.classList.contains("cull-thumb__img"),
    );
    expect(marks).toHaveLength(1);
  });

  test("a label CULL did not write still shows, in the neutral ink", () => {
    const { container } = cell({ starsAndLabels: true, label: "custom" });
    expect(container.querySelector(".cull-label-bar")?.className).toContain("cull-label--custom");
  });

  test("keeps the read-only LrC badge with the layer off — byte-identical to today", () => {
    const { container } = cell({ lrcRating: 2 });
    expect(container.querySelector(".cull-thumb__lrc-badge")).not.toBeNull();
  });

  test("drops the stale read-only LrC badge with the layer on — same property, live now", () => {
    // `lrcRating` is an open-time snapshot; `star` is live. Drawing both once
    // starring is possible would leave the strip contradicting the rail and
    // the grid for the rest of the session (the grid already gates this the
    // same way — GridView.tsx's `marks` guard on `showLrc`).
    const { container } = cell({ starsAndLabels: true, lrcRating: 2 });
    expect(container.querySelector(".cull-thumb__lrc-badge")).toBeNull();
  });
});
