// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MouseEvent as ReactMouseEvent } from "react";
import { usePaneZoom } from "./usePaneZoom";
import type { Img, ImageMetadata } from "../types";

/**
 * The cursor-anchored mouse zoom (1.0.1): the origin lands under the press,
 * FOLLOWS the cursor while the button is held (no grab arithmetic, no scale
 * factor — steering the origin can't fight the scale glide), and is KEPT on
 * release so the exit glide shrinks around what the user was looking at
 * instead of hopping back to the AF point first.
 */

vi.mock("../image/imageStore", () => ({
  imageStore: { pendingMetaFor: () => undefined },
}));

afterEach(() => {
  cleanup();
});

const IMG: Img = { id: 1, path: "/s/1.cr3", filename: "1.cr3", srcFolder: "/s" };
// A 1000×500 image sitting 100px in from a stage at the viewport origin.
const RECT = { left: 100, top: 100, width: 1000, height: 500 };
const AF: ImageMetadata = { afXPct: 30, afYPct: 40 } as ImageMetadata;

function setup(metadata: Record<string, ImageMetadata> = { [IMG.path]: AF }) {
  const stage = document.createElement("div");
  stage.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 1400, height: 800, right: 1400, bottom: 800 }) as DOMRect;
  document.body.appendChild(stage);
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
  return { hook, press, move, release };
}

describe("usePaneZoom — mouse zoom", () => {
  it("anchors the origin under the press: pan = cursor − AF", () => {
    const { hook, press } = setup();
    press(100 + 500, 100 + 250); // image centre → 50%, 50%
    expect(hook.result.current.isZooming).toBe(true);
    expect(hook.result.current.mouseZooming).toBe(true);
    expect(hook.result.current.panOffset).toEqual({ x: 20, y: 10 });
  });

  it("follows the cursor while held, clamped to the image", () => {
    const { hook, press, move } = setup();
    press(100 + 500, 100 + 250);
    move(100 + 1000, 100 + 0); // top-right corner → 100%, 0%
    expect(hook.result.current.panOffset).toEqual({ x: 70, y: -40 });
    move(100 + 1300, 100 - 50); // off the frame → holds at the edge
    expect(hook.result.current.panOffset).toEqual({ x: 70, y: -40 });
    move(100 + 250, 100 + 250); // 25%, 50%
    expect(hook.result.current.panOffset).toEqual({ x: -5, y: 10 });
  });

  it("keeps the last origin on release, so the exit glide shrinks around it", () => {
    const { hook, press, move, release } = setup();
    press(100 + 500, 100 + 250);
    move(100 + 250, 100 + 250);
    release();
    expect(hook.result.current.isZooming).toBe(false);
    expect(hook.result.current.mouseZooming).toBe(false);
    expect(hook.result.current.panOffset).toEqual({ x: -5, y: 10 });
  });

  it("a fresh press sets its own pan — a kept pan never leaks forward", () => {
    const { hook, press, move, release } = setup();
    press(100 + 500, 100 + 250);
    move(100 + 1000, 100 + 500);
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
