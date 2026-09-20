// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
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

function gridElement(ref: RefObject<HTMLDivElement | null>) {
  return (
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
    />
  );
}

function renderGrid() {
  const ref = createRef<HTMLDivElement>();
  return render(gridElement(ref));
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

  test("the sharp layer gains is-on only from ITS OWN load, not the THMB's", () => {
    thumb.value = { ...thumb.value, url: "blob:thmb", gridUrl: "blob:grid" };
    const { container } = renderGrid();
    const imgs = [...container.querySelectorAll("img")];
    expect(container.querySelector(".cull-grid__img--hi")?.className).not.toContain("is-on");

    // The THMB's own load must not turn the sharp layer on — it has no
    // error state to guard against, but the two layers' load events are
    // independent and must stay that way.
    fireEvent.load(imgs[0]);
    expect(container.querySelector(".cull-grid__img--hi")?.className).not.toContain("is-on");

    fireEvent.load(imgs[1]);
    expect(container.querySelector(".cull-grid__img--hi")?.className).toContain("is-on");
  });

  test("the THMB node survives the sharp layer's arrival and departure", () => {
    thumb.value = { ...thumb.value, url: "blob:thmb", gridUrl: undefined };
    const ref = createRef<HTMLDivElement>();
    const { container, rerender } = render(gridElement(ref));
    const thmbNode = container.querySelectorAll("img")[0];
    expect(thmbNode).toBeTruthy();

    thumb.value = { ...thumb.value, gridUrl: "blob:grid" };
    rerender(gridElement(ref));
    const withHi = [...container.querySelectorAll("img")];
    expect(withHi[0]).toBe(thmbNode);
    expect(withHi.length).toBe(2);
    expect(withHi[1].getAttribute("decoding")).toBe("async");

    thumb.value = { ...thumb.value, gridUrl: undefined };
    rerender(gridElement(ref));
    const afterHiGone = [...container.querySelectorAll("img")];
    expect(afterHiGone.length).toBe(1);
    expect(afterHiGone[0]).toBe(thmbNode);
  });
});
