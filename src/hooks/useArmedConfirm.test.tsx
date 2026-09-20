// @vitest-environment jsdom
import { useState } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useArmedConfirm } from "./useArmedConfirm";
import { useFocusTrap } from "./useFocusTrap";

// jsdom never computes real layout, so every element's getClientRects() comes
// back empty — which makes useFocusTrap's "visible focusables only" filter
// exclude every real button and fall back to focusing the trap root itself.
// Stubbing a non-empty rect here lets the trap find real buttons in this
// file's tests, matching what an actually laid-out browser does.
const realGetClientRects = Element.prototype.getClientRects;
beforeAll(() => {
  Element.prototype.getClientRects = function () {
    return [{}] as unknown as DOMRectList;
  };
});
afterAll(() => {
  Element.prototype.getClientRects = realGetClientRects;
});

/**
 * Two-stage confirm harness mirroring the real markup in FinishDialog's
 * MoveRejectsRow / SettingsDialog's ResetRow: stage 1 is a trigger button,
 * stage 2 (armed) is a "Yes" + "Cancel" pair. `confirmRef` is wired to BOTH
 * the trigger and the "Yes" button, since whichever one mounts next (arming
 * or disarming) is the one that should take focus.
 */
function Harness({
  disarmMs = 4000,
  onConfirm,
}: {
  disarmMs?: number;
  onConfirm?: () => void;
}) {
  const [armed, setArmed, confirmRef] = useArmedConfirm(disarmMs);
  return armed ? (
    <div>
      <button
        ref={confirmRef}
        onClick={() => {
          setArmed(false);
          onConfirm?.();
        }}
      >
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

/**
 * Chromium's activation behaviour for a focused button, as much of it as this
 * test needs: Enter fires on KEYDOWN (not keyup), and the click is synthesized
 * only if nothing called `preventDefault` on that keydown. `repeat: true` is
 * the auto-repeat of a key that is still held down — the real bug was that the
 * Enter which armed the confirm was still down when the confirm button took
 * focus, so its next repeat activated it.
 */
function pressEnter(node: HTMLElement, repeat = false): void {
  const activates = fireEvent.keyDown(node, { key: "Enter", repeat });
  if (activates) fireEvent.click(node);
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

/** Harness with a sibling control OUTSIDE the armed subtree, to prove a
 *  disarm never steals focus back from something the user deliberately
 *  tabbed to in the meantime. */
function HarnessWithSibling({ disarmMs = 4000 }: { disarmMs?: number }) {
  const [armed, setArmed, confirmRef] = useArmedConfirm(disarmMs);
  return (
    <div>
      <button type="button">Sibling control</button>
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

/** Mirrors FinishDialog's MoveRejectsRow three-branch shape: stage 1 → armed
 *  → a "busy" progress branch with NO ref-bearing node (confirming fires the
 *  real action and flips busy on) → back to stage 1 once the op resolves. */
function BusyHarness({ disarmMs = 4000 }: { disarmMs?: number }) {
  const [armed, setArmed, confirmRef] = useArmedConfirm(disarmMs);
  const [busy, setBusy] = useState(false);
  return busy ? (
    <div>
      <span>Moving…</span>
      <button onClick={() => setBusy(false)}>Finish op</button>
    </div>
  ) : armed ? (
    <div>
      <button
        ref={confirmRef}
        onClick={() => {
          setArmed(false);
          setBusy(true);
        }}
      >
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

describe("useArmedConfirm", () => {
  afterEach(cleanup);

  it("focuses the Yes button when armed flips true", () => {
    render(<Harness />);
    const stage1 = screen.getByRole("button", { name: "Move rejects" });

    fireEvent.click(stage1);

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Yes, move" }));
  });

  it("a held Enter cannot arm and confirm in one keypress", () => {
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} />);
    const stage1 = screen.getByRole("button", { name: "Move rejects" });
    stage1.focus();

    pressEnter(stage1); // arms — focus lands on the confirm button
    const yes = screen.getByRole("button", { name: "Yes, move" });
    expect(document.activeElement).toBe(yes);

    // Still the same keypress, ~300ms in: the OS starts repeating it.
    pressEnter(yes, true);
    pressEnter(yes, true);

    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Yes, move" })).toBeTruthy();
  });

  it("confirms on a fresh Enter, which is the press the user meant", () => {
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole("button", { name: "Move rejects" }));

    pressEnter(screen.getByRole("button", { name: "Yes, move" }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("confirms on a click, which the guard never sees", () => {
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole("button", { name: "Move rejects" }));

    fireEvent.click(screen.getByRole("button", { name: "Yes, move" }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
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

  it("does not steal focus back from a control the user tabbed to before auto-disarm", () => {
    vi.useFakeTimers();
    try {
      render(<HarnessWithSibling disarmMs={4000} />);
      fireEvent.click(screen.getByRole("button", { name: "Move rejects" }));
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Yes, move" }));

      const sibling = screen.getByRole("button", { name: "Sibling control" });
      sibling.focus();
      expect(document.activeElement).toBe(sibling);

      act(() => {
        vi.advanceTimersByTime(4000);
      });

      // The user moved focus deliberately — the auto-disarm remounting
      // "Move rejects" must not yank it back.
      expect(document.activeElement).toBe(sibling);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not steal focus for a later stage-1 mount when the disarming commit had no ref-bearing node", () => {
    render(<BusyHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Move rejects" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Yes, move" }));

    // Confirms and moves into the busy branch in the same commit — no button
    // in that branch is wired to the hook's ref at all.
    fireEvent.click(screen.getByRole("button", { name: "Yes, move" }));
    expect(screen.queryByRole("button", { name: "Move rejects" })).toBeNull();

    // Something else takes focus while the op is in flight.
    const finishButton = screen.getByRole("button", { name: "Finish op" });
    finishButton.focus();
    expect(document.activeElement).toBe(finishButton);

    // The op resolves — `armed` never changed on this transition, but
    // "Move rejects" remounts. It must not have inherited a stale claim.
    fireEvent.click(finishButton);
    expect(document.activeElement).not.toBe(screen.getByRole("button", { name: "Move rejects" }));
  });
});
