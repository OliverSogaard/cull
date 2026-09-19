// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useChipsTooltipVisibility } from "./useChipsTooltipVisibility";

/**
 * The hook's IDENTITY contract, which is the whole reason both of its returns
 * are memoized. `StatusBar` is `memo`-wrapped and this hook's return value
 * rides into it whole, inside App's `statusFilter` group — so a fresh wrapper
 * (or a fresh `hoverProps`) on an unrelated App render re-renders the status
 * bar no matter how stable everything else in that group is.
 *
 * The transition table itself is tested in `utils/tooltipVisibility.test.ts`;
 * these tests only pin what the memoization guarantees: nothing but a real
 * `visible` change may hand out a new wrapper, and the callbacks inside it
 * never churn at all.
 */
describe("useChipsTooltipVisibility", () => {
  afterEach(cleanup);

  it("hands back the same wrapper and the same hoverProps across a rerender", () => {
    const { result, rerender } = renderHook(() => useChipsTooltipVisibility());
    const before = result.current;

    rerender();

    expect(result.current).toBe(before);
    expect(result.current.hoverProps).toBe(before.hoverProps);
    expect(result.current.pulse).toBe(before.pulse);
  });

  it("a pulse replaces only the wrapper — hoverProps and pulse keep their identity", () => {
    const { result } = renderHook(() => useChipsTooltipVisibility());
    const before = result.current;
    expect(before.visible).toBe(false);

    act(() => {
      before.pulse();
    });

    // `visible` is a memo dep, so the wrapper MUST change — that's the update
    // StatusBar has to see.
    expect(result.current.visible).toBe(true);
    expect(result.current).not.toBe(before);
    // ...and nothing else may ride along with it.
    expect(result.current.hoverProps).toBe(before.hoverProps);
    expect(result.current.pulse).toBe(before.pulse);
  });
});
