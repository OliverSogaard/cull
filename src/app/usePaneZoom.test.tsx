// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MouseEvent as ReactMouseEvent } from "react";
import { usePaneZoom } from "./usePaneZoom";
import type { Img, ImageMetadata } from "../types";

/**
 * The cursor-anchored mouse zoom: the origin lands under the press, a drag
 * moves the photo WITH the pointer (grab) using the scale the layer is
 * painted at this instant — not the target zoom, which made a drag during
 * the engage glide crawl and then lurch — and the pan is KEPT on release so
 * the exit glide shrinks around what the user dragged to instead of hopping
 * back to the AF point first.
 */

vi.mock("../image/imageStore", () => ({
  imageStore: { pendingMetaFor: () => undefined },
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const IMG: Img = { id: 1, path: "/s/1.cr3", filename: "1.cr3", srcFolder: "/s" };
// A 1000×500 image sitting 100px in from a stage at the viewport origin.
const RECT = { left: 100, top: 100, width: 1000, height: 500 };
const AF: ImageMetadata = { afXPct: 30, afYPct: 40 } as ImageMetadata;

function setup(metadata: Record<string, ImageMetadata> = { [IMG.path]: AF }) {
  const stage = document.createElement("div");
  stage.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 1400, height: 800, right: 1400, bottom: 800 }) as DOMRect;
  const layer = document.createElement("img");
  layer.className = "cull-image";
  stage.appendChild(layer);
  document.body.appendChild(stage);
  // The scale the presenter layer is PAINTED at, as getComputedStyle reports
  // it mid-transition. Tests set it per step.
  let painted = "none";
  vi.spyOn(window, "getComputedStyle").mockImplementation(
    () => ({ transform: painted }) as CSSStyleDeclaration,
  );
  const paintAt = (z: number) => {
    painted = z === 1 ? "none" : `matrix(${z}, 0, 0, ${z}, 0, 0)`;
  };
  const stageRef = { current: stage };
  const hook = renderHook(() =>
    usePaneZoom({
      images: [IMG],
      currentIndex: 0,
      metadata,
      imgRect: RECT,
      stageRef,
      positionInFilter: 0,
    }),
  );
  const press = (clientX: number, clientY: number, extra: Partial<ReactMouseEvent> = {}) =>
    act(() => {
      hook.result.current.handleStageMouseDown({
        button: 0,
        clientX,
        clientY,
        shiftKey: false,
        target: stage,
        preventDefault: () => {},
        ...extra,
      } as unknown as ReactMouseEvent);
    });
  const move = (clientX: number, clientY: number) =>
    act(() => {
      window.dispatchEvent(new MouseEvent("mousemove", { clientX, clientY }));
    });
  const release = () =>
    act(() => {
      window.dispatchEvent(new MouseEvent("mouseup"));
    });
  return { hook, press, move, release, paintAt };
}

describe("usePaneZoom — mouse zoom", () => {
  it("anchors the origin under the press: pan = cursor − AF", () => {
    const { hook, press } = setup();
    press(100 + 500, 100 + 250); // image centre → 50%, 50%
    expect(hook.result.current.isZooming).toBe(true);
    expect(hook.result.current.mouseZooming).toBe(true);
    expect(hook.result.current.panOffset).toEqual({ x: 20, y: 10 });
  });

  it("drags the photo with the pointer at 1:1 against the PAINTED scale", () => {
    const { hook, press, move, paintAt } = setup();
    press(100 + 500, 100 + 250);
    // Landed at 3×: 100px right over a 1000px-wide rect is 10% of the
    // width; the origin moves 10 / (3 − 1) = 5% the other way.
    paintAt(3);
    move(100 + 600, 100 + 250);
    expect(hook.result.current.panOffset).toEqual({ x: 15, y: 10 });
    // Mid-glide at 1.5× the same 100px must move the origin 20%, not 5%:
    // dividing by the target zoom is what made the drag crawl.
    paintAt(1.5);
    move(100 + 700, 100 + 250);
    expect(hook.result.current.panOffset).toEqual({ x: -5, y: 10 });
    // 50px down over a 500px-tall rect at 3× → 10 / 2 = 5%.
    paintAt(3);
    move(100 + 700, 100 + 300);
    expect(hook.result.current.panOffset).toEqual({ x: -5, y: 5 });
  });

  it("ignores movement before the glide has begun (nothing to drag at 1×)", () => {
    const { hook, press, move, paintAt } = setup();
    press(100 + 500, 100 + 250);
    paintAt(1);
    move(100 + 900, 100 + 450);
    expect(hook.result.current.panOffset).toEqual({ x: 20, y: 10 });
  });

  it("clamps the origin to the image, not to the keyboard's ±40%", () => {
    const { hook, press, move, paintAt } = setup();
    press(100 + 500, 100 + 250);
    paintAt(2);
    move(100 + 500 + 2000, 100 + 250 + 2000); // a huge drag up-left of the content
    // origin = AF + pan ≤ 100 → pan.x ≤ 70; drag pushed it negative → −30/−40.
    expect(hook.result.current.panOffset).toEqual({ x: -30, y: -40 });
    move(100 + 500 - 4000, 100 + 250 - 4000);
    expect(hook.result.current.panOffset).toEqual({ x: 70, y: 60 });
  });

  it("keeps the last origin on release, so the exit glide shrinks around it", () => {
    const { hook, press, move, release, paintAt } = setup();
    press(100 + 500, 100 + 250);
    paintAt(3);
    move(100 + 600, 100 + 250);
    release();
    expect(hook.result.current.isZooming).toBe(false);
    expect(hook.result.current.mouseZooming).toBe(false);
    expect(hook.result.current.panOffset).toEqual({ x: 15, y: 10 });
  });

  it("a fresh press sets its own pan — a kept pan never leaks forward", () => {
    const { hook, press, move, release, paintAt } = setup();
    press(100 + 500, 100 + 250);
    paintAt(3);
    move(100 + 900, 100 + 450);
    release();
    press(100 + 300, 100 + 200); // 30%, 40% = exactly the AF point
    expect(hook.result.current.panOffset).toEqual({ x: 0, y: 0 });
  });

  it("ignores a press outside the photo and one on a button inside the stage", () => {
    const { hook, press } = setup();
    press(50, 50); // in the stage, off the image
    expect(hook.result.current.isZooming).toBe(false);
    const btn = document.createElement("button");
    document.body.appendChild(btn);
    press(100 + 500, 100 + 250, { target: btn });
    expect(hook.result.current.isZooming).toBe(false);
  });
});
