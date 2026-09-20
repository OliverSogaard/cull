// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useArmedConfirm } from "./useArmedConfirm";
import { useFocusTrap } from "./useFocusTrap";

/**
 * Two-stage confirm harness mirroring the real markup in FinishDialog's
 * MoveRejectsRow / SettingsDialog's ResetRow: stage 1 is a trigger button,
 * stage 2 (armed) is a "Yes" + "Cancel" pair. `confirmRef` is wired to BOTH
 * the trigger and the "Yes" button, since whichever one mounts next (arming
 * or disarming) is the one that should take focus.
 */
function Harness({ disarmMs = 4000 }: { disarmMs?: number }) {
  const [armed, setArmed, confirmRef] = useArmedConfirm(disarmMs);
  return armed ? (
    <div>
      <button ref={confirmRef} onClick={() => setArmed(false)}>
        Yes, move
      </button>
      <button onClick={() => setArmed(false)}>Cancel</button>
    </div>
  ) : (
    <button ref={confirmRef} onClick={() => setArmed(true)}>
      Move rejects
    </button>
  );
}

/** Same harness, but rendered inside a real focus-trap root — proves our
 *  focus move wins over the trap's focusout re-home-to-root handler. */
function TrappedHarness({ disarmMs = 4000 }: { disarmMs?: number }) {
  const trapRef = useFocusTrap<HTMLDivElement>();
  const [armed, setArmed, confirmRef] = useArmedConfirm(disarmMs);
  return (
    <div ref={trapRef} tabIndex={-1}>
      {armed ? (
        <div>
          <button ref={confirmRef} onClick={() => setArmed(false)}>
            Yes, move
          </button>
          <button onClick={() => setArmed(false)}>Cancel</button>
        </div>
      ) : (
        <button ref={confirmRef} onClick={() => setArmed(true)}>
          Move rejects
        </button>
      )}
    </div>
  );
}

describe("useArmedConfirm", () => {
  afterEach(cleanup);

  it("focuses the Yes button when armed flips true", () => {
    render(<Harness />);
    const stage1 = screen.getByRole("button", { name: "Move rejects" });

    fireEvent.click(stage1);

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Yes, move" }));
  });

  it("returns focus to the stage-1 button after auto-disarm", () => {
    vi.useFakeTimers();
    try {
      render(<Harness disarmMs={4000} />);
      fireEvent.click(screen.getByRole("button", { name: "Move rejects" }));

      act(() => {
        vi.advanceTimersByTime(4000);
      });

      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Move rejects" }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns focus to the stage-1 button after cancel", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Move rejects" }));

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Move rejects" }));
  });

  it("keeps focus off the dialog root when disarming inside a real focus trap", () => {
    vi.useFakeTimers();
    try {
      render(<TrappedHarness disarmMs={4000} />);
      fireEvent.click(screen.getByRole("button", { name: "Move rejects" }));
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Yes, move" }));

      act(() => {
        vi.advanceTimersByTime(4000);
      });
      // The focus trap's focusout handler re-homes via requestAnimationFrame;
      // flush it so we assert the settled state, not a mid-flight one.
      act(() => {
        vi.runOnlyPendingTimers();
      });

      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Move rejects" }));
    } finally {
      vi.useRealTimers();
    }
  });
});
