// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { createRef } from "react";

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
import type { Img } from "../types";

// jsdom has no ResizeObserver; GridView's height/width-tracking effects only
// need observe/disconnect to exist, not to ever fire, for this fixed-size fixture.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverStub);

const images: Img[] = [{ id: 1, path: "/a.cr3", filename: "IMG_0001.CR3", srcFolder: "/" }];

function renderGrid() {
  const ref = createRef<HTMLDivElement>();
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
    />,
  );
}

afterEach(cleanup);

describe("the grid cell layers the sharp tier over the THMB", () => {
  test("with no grid thumb it paints exactly one image — the THMB", () => {
    thumb.value = { ...thumb.value, url: "blob:thmb", gridUrl: undefined };
    const { container } = renderGrid();
    const imgs = [...container.querySelectorAll("img")];
    expect(imgs.map((i) => i.getAttribute("src"))).toEqual(["blob:thmb"]);
  });

  test("with a grid thumb it paints BOTH, the sharp one on top, decoded async", () => {
    thumb.value = { ...thumb.value, url: "blob:thmb", gridUrl: "blob:grid" };
    const { container } = renderGrid();
    const imgs = [...container.querySelectorAll("img")];
    expect(imgs.map((i) => i.getAttribute("src"))).toEqual(["blob:thmb", "blob:grid"]);
    // The THMB keeps its synchronous decode; the overlay must not block paint.
    expect(imgs[0].getAttribute("decoding")).toBe("sync");
    expect(imgs[1].getAttribute("decoding")).toBe("async");
    // It fades in only once it has decoded — an undecoded layer would flash.
    expect(imgs[1].className).not.toContain("is-on");
    fireEvent.load(imgs[1]);
    expect(container.querySelector(".cull-grid__img--hi")?.className).toContain("is-on");
  });

  test("a grid thumb that never loads leaves the THMB untouched — cells have no error state", () => {
    thumb.value = { ...thumb.value, url: "blob:thmb", gridUrl: "blob:broken" };
    const { container } = renderGrid();
    const imgs = [...container.querySelectorAll("img")];
    fireEvent.error(imgs[1]);
    expect(imgs[0].getAttribute("src")).toBe("blob:thmb");
    expect(container.querySelector(".cull-grid__img--hi")?.className).not.toContain("is-on");
  });
});
