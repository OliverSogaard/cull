import { describe, expect, it } from "vitest";
import {
  initialTooltipVisibility,
  reduceTooltipVisibility,
  type TooltipVisibilityState,
} from "./tooltipVisibility";

describe("reduceTooltipVisibility", () => {
  it("starts hidden and not hovering", () => {
    expect(initialTooltipVisibility).toEqual({ visible: false, hovering: false });
  });

  it("pulse shows the tooltip without touching hover", () => {
    const out = reduceTooltipVisibility(initialTooltipVisibility, { type: "pulse" });
    expect(out).toEqual({ visible: true, hovering: false });
  });

  it("pulse is a no-op (same reference) when already visible", () => {
    const visible: TooltipVisibilityState = { visible: true, hovering: false };
    expect(reduceTooltipVisibility(visible, { type: "pulse" })).toBe(visible);
  });

  it("hoverEnter shows the tooltip and marks hovering", () => {
    const out = reduceTooltipVisibility(initialTooltipVisibility, { type: "hoverEnter" });
    expect(out).toEqual({ visible: true, hovering: true });
  });

  it("hoverEnter is a no-op (same reference) when already visible+hovering", () => {
    const state: TooltipVisibilityState = { visible: true, hovering: true };
    expect(reduceTooltipVisibility(state, { type: "hoverEnter" })).toBe(state);
  });

  it("hoverLeave clears hovering but keeps visible", () => {
    const state: TooltipVisibilityState = { visible: true, hovering: true };
    const out = reduceTooltipVisibility(state, { type: "hoverLeave" });
    expect(out).toEqual({ visible: true, hovering: false });
  });

  it("hoverLeave is a no-op (same reference) when not hovering", () => {
    const state: TooltipVisibilityState = { visible: true, hovering: false };
    expect(reduceTooltipVisibility(state, { type: "hoverLeave" })).toBe(state);
  });

  it("idleElapsed hides the tooltip when visible and not hovering", () => {
    const state: TooltipVisibilityState = { visible: true, hovering: false };
    const out = reduceTooltipVisibility(state, { type: "idleElapsed" });
    expect(out).toEqual({ visible: false, hovering: false });
  });

  it("idleElapsed is ignored while hovering — hover always wins", () => {
    const state: TooltipVisibilityState = { visible: true, hovering: true };
    expect(reduceTooltipVisibility(state, { type: "idleElapsed" })).toBe(state);
  });

  it("idleElapsed is a no-op (same reference) when already hidden", () => {
    expect(reduceTooltipVisibility(initialTooltipVisibility, { type: "idleElapsed" })).toBe(
      initialTooltipVisibility,
    );
  });

  it("a realistic sequence: pulse, hover in, hover out, idle", () => {
    let state = initialTooltipVisibility;
    state = reduceTooltipVisibility(state, { type: "pulse" });
    expect(state.visible).toBe(true);
    state = reduceTooltipVisibility(state, { type: "hoverEnter" });
    expect(state.hovering).toBe(true);
    state = reduceTooltipVisibility(state, { type: "idleElapsed" }); // races hover — ignored
    expect(state.visible).toBe(true);
    state = reduceTooltipVisibility(state, { type: "hoverLeave" });
    expect(state.hovering).toBe(false);
    state = reduceTooltipVisibility(state, { type: "idleElapsed" });
    expect(state).toEqual({ visible: false, hovering: false });
  });
});
