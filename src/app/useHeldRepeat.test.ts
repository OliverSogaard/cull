import { describe, expect, test } from "vitest";
import { SCRUB_STAGE2_AT_MS, SCRUB_STAGE3_AT_MS, type ScrubSpeed } from "../utils/scrubAccel";
import { createHeldRepeat } from "./useHeldRepeat";

/**
 * Pins the hold-delay → rAF-paced repeat engine shared by the loupe/compare
 * horizontal hold and the grid's vertical hold (cleanup 9.1). The invariants
 * under test are the ones documented at the old App.tsx call sites:
 *  - immediate first step on start (no OS initial-repeat delay), result
 *    deliberately NOT fed into the scrub state — a plain tap must make ZERO
 *    scrub-state calls (the pickFromStrip "extra setState per click" stutter);
 *  - first repeat waits holdDelayMs, then one step per repeatMs;
 *  - ONE onStep call per due tick with step=speed (the "50× hold that
 *    scrubbed at 1×" bug — see scrubAccel.ts);
 *  - scrub state flips only when the moved-state or speed actually changes,
 *    and speed keeps escalating even while parked at a boundary;
 *  - stop cancels the pending frame and settles state back to (false, 1).
 */

/** Fake rAF + clock: frames fire only when the test says so, at a chosen dt. */
function makeClock() {
  let t = 0;
  let nextId = 1;
  const pending = new Map<number, (ts: number) => void>();
  return {
    raf: (cb: (ts: number) => void): number => {
      const id = nextId++;
      pending.set(id, cb);
      return id;
    },
    caf: (id: number): void => {
      pending.delete(id);
    },
    now: (): number => t,
    /** Advance the clock by dt and deliver one animation frame. */
    frame(dt: number): void {
      t += dt;
      const cbs = [...pending.values()];
      pending.clear();
      for (const cb of cbs) cb(t);
    },
    pendingFrames: (): number => pending.size,
  };
}

const HOLD_DELAY = 280;
const REPEAT = 33;

function makeHeld(clock = makeClock()) {
  const steps: Array<{ dir: 1 | -1; speed: number }> = [];
  const scrubCalls: Array<{ active: boolean; speed: ScrubSpeed }> = [];
  const moved = { value: true };
  const held = createHeldRepeat({
    onStep: (dir, speed) => {
      steps.push({ dir, speed });
      return moved.value;
    },
    holdDelayMs: HOLD_DELAY,
    repeatMs: REPEAT,
    onScrubChange: (active, speed) => {
      scrubCalls.push({ active, speed });
    },
    raf: clock.raf,
    caf: clock.caf,
    now: clock.now,
  });
  return { held, clock, steps, scrubCalls, moved };
}

describe("createHeldRepeat", () => {
  test("steps once immediately on start, at speed 1, with no scrub-state call", () => {
    const { held, steps, scrubCalls } = makeHeld();
    held.start(1);
    expect(steps).toEqual([{ dir: 1, speed: 1 }]);
    expect(scrubCalls).toEqual([]);
    expect(held.heldDirRef.current).toBe(1);
  });

  test("waits holdDelayMs before the first repeat", () => {
    const { held, clock, steps } = makeHeld();
    held.start(1);
    clock.frame(100); // t=100 — not due
    clock.frame(100); // t=200 — not due
    expect(steps).toHaveLength(1);
    clock.frame(100); // t=300 ≥ 280 — first repeat
    expect(steps).toHaveLength(2);
    expect(steps[1]).toEqual({ dir: 1, speed: 1 });
  });

  test("paces repeats by repeatMs — a too-early frame steps nothing", () => {
    const { held, clock, steps } = makeHeld();
    held.start(1);
    clock.frame(HOLD_DELAY); // first repeat
    expect(steps).toHaveLength(2);
    clock.frame(16); // 16 < 33 since last step — not due
    expect(steps).toHaveLength(2);
    clock.frame(17); // 33 since last step — due
    expect(steps).toHaveLength(3);
  });

  test("escalates speed by held time and makes ONE call per tick with step=speed", () => {
    const { held, clock, steps } = makeHeld();
    held.start(1);
    clock.frame(HOLD_DELAY); // repeat at 1×
    expect(steps[steps.length - 1]).toEqual({ dir: 1, speed: 1 });

    const countBefore2 = steps.length;
    clock.frame(SCRUB_STAGE2_AT_MS); // held ≥ stage 2 — 3×
    expect(steps).toHaveLength(countBefore2 + 1); // exactly ONE onStep call this tick
    expect(steps[steps.length - 1]).toEqual({ dir: 1, speed: 3 });

    const countBefore3 = steps.length;
    clock.frame(SCRUB_STAGE3_AT_MS); // held ≥ stage 3 — 10×
    expect(steps).toHaveLength(countBefore3 + 1);
    expect(steps[steps.length - 1]).toEqual({ dir: 1, speed: 10 });
  });

  test("signals scrubbing=true on the first moving repeat, and only on change", () => {
    const { held, clock, scrubCalls } = makeHeld();
    held.start(1);
    clock.frame(HOLD_DELAY);
    expect(scrubCalls).toEqual([{ active: true, speed: 1 }]);
    expect(held.scrubbingRef.current).toBe(true);
    clock.frame(REPEAT); // still moving, same speed — no new call
    expect(scrubCalls).toHaveLength(1);
  });

  test("keeps scrubbing=false at a boundary while speed still escalates", () => {
    const { held, clock, scrubCalls, moved } = makeHeld();
    moved.value = false; // parked at an edge: onStep never moves
    held.start(1);
    clock.frame(HOLD_DELAY);
    // Nothing moved and speed is still 1× — no scrub-state call at all.
    expect(scrubCalls).toEqual([]);
    expect(held.scrubbingRef.current).toBe(false);
    clock.frame(SCRUB_STAGE2_AT_MS); // speed escalates even though parked
    expect(scrubCalls).toEqual([{ active: false, speed: 3 }]);
  });

  test("flips scrubbing back off when a moving hold parks at a boundary", () => {
    const { held, clock, scrubCalls, moved } = makeHeld();
    held.start(1);
    clock.frame(HOLD_DELAY); // moving → (true, 1)
    moved.value = false; // boundary reached
    clock.frame(REPEAT);
    expect(scrubCalls).toEqual([
      { active: true, speed: 1 },
      { active: false, speed: 1 },
    ]);
  });

  test("stop cancels the pending frame and settles scrub state exactly once", () => {
    const { held, clock, steps, scrubCalls } = makeHeld();
    held.start(1);
    clock.frame(HOLD_DELAY);
    clock.frame(SCRUB_STAGE2_AT_MS); // moving at 3×
    const stepsBefore = steps.length;
    const callsBefore = scrubCalls.length;

    held.stop();
    expect(held.heldDirRef.current).toBe(0);
    expect(held.scrubbingRef.current).toBe(false);
    expect(scrubCalls).toHaveLength(callsBefore + 1);
    expect(scrubCalls[scrubCalls.length - 1]).toEqual({ active: false, speed: 1 });
    expect(clock.pendingFrames()).toBe(0); // rAF cancelled

    clock.frame(1000); // nothing left to fire
    expect(steps).toHaveLength(stepsBefore);
    held.stop(); // idempotent — no second settle call
    expect(scrubCalls).toHaveLength(callsBefore + 1);
  });

  test("a tap (start then stop before the delay) = one step, zero scrub-state calls", () => {
    const { held, clock, steps, scrubCalls } = makeHeld();
    held.start(1);
    clock.frame(50);
    held.stop();
    expect(steps).toHaveLength(1);
    expect(scrubCalls).toEqual([]); // the no-extra-setState-per-click invariant
  });

  test("restarting the same direction mid-hold is a no-op", () => {
    const { held, clock, steps } = makeHeld();
    held.start(1);
    clock.frame(100);
    held.start(1); // key auto-repeat / duplicate keydown — ignored
    expect(steps).toHaveLength(1);
    clock.frame(HOLD_DELAY - 100); // original timing intact: due at t=280
    expect(steps).toHaveLength(2);
  });

  test("direction change cancels the old loop and restarts delay + speed", () => {
    const { held, clock, steps } = makeHeld();
    held.start(1);
    clock.frame(HOLD_DELAY); // repeating rightward
    clock.frame(SCRUB_STAGE2_AT_MS); // at 3×
    held.start(-1);
    // Immediate step in the new direction, back at speed 1.
    expect(steps[steps.length - 1]).toEqual({ dir: -1, speed: 1 });
    expect(held.heldDirRef.current).toBe(-1);

    const before = steps.length;
    clock.frame(100); // new hold-delay restarted — not due yet
    expect(steps).toHaveLength(before);
    clock.frame(HOLD_DELAY - 100); // due — and only ONE loop is alive
    expect(steps).toHaveLength(before + 1);
    expect(steps[steps.length - 1]).toEqual({ dir: -1, speed: 1 });
  });

  test("speed and timing reset between holds", () => {
    const { held, clock, steps, scrubCalls } = makeHeld();
    held.start(1);
    clock.frame(HOLD_DELAY);
    clock.frame(SCRUB_STAGE2_AT_MS); // 3× and scrubbing
    held.stop();

    held.start(1);
    expect(steps[steps.length - 1]).toEqual({ dir: 1, speed: 1 }); // fresh immediate step
    clock.frame(HOLD_DELAY);
    expect(steps[steps.length - 1]).toEqual({ dir: 1, speed: 1 }); // fresh 1× repeat
    expect(scrubCalls[scrubCalls.length - 1]).toEqual({ active: true, speed: 1 });
  });
});
