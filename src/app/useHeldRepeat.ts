import { useEffect, useRef, useState } from "react";
import { scrubSpeedForHeldMs, type ScrubSpeed } from "../utils/scrubAccel";

/**
 * Hold-delay → rAF-paced repeat, shared by the two hold-to-navigate systems:
 * the loupe/compare horizontal arrow-hold and the grid's vertical arrow-hold
 * (which are mutually exclusive by mode, but each gets its OWN instance so
 * one loop's cleanup can never stomp the other's).
 *
 * The OS key-repeat is uneven and starts with a ~0.4s delay, which made the
 * first second of a hold feel jumpy. Instead we step once on the initial
 * press and then drive a steady rAF loop while the key is held: the first
 * repeat waits `holdDelayMs` after hold-start (so a tap = 1 step); once
 * repeating, each subsequent step waits `repeatMs`.
 *
 * Staged acceleration (1× → 3× → 10× by hold time, scrubSpeedForHeldMs):
 * each due tick makes ONE onStep call with step=speed. The step function
 * reads this render's position, so calling it repeatedly within a tick would
 * recompute the same target `speed` times and move a single frame (the "50×
 * that scrubbed at 1×" bug). Step functions walk `step` frames internally.
 *
 * Scrub state (`onScrubChange`) is signalled only on actual change:
 *  - `active` flips true only while repeat steps actually move — at a
 *    boundary (nothing to move to) the frame stays full-res, no point
 *    blurring when we aren't going anywhere; and the immediate first step
 *    NEVER engages it, so a plain tap makes zero scrub-state calls (an
 *    unconditional setState per click churned the photo-frame's
 *    mount/unmount in the same render pass as the new index — a stutter).
 *  - `speed` keeps escalating by held time even while parked, and settles
 *    back to (false, 1) on stop so the indicators clear together.
 */

type HeldDir = 0 | 1 | -1;

export type HeldRepeatOpts = {
  /** Perform one nav tick: walk `speed` frames/rows in `dir`. Returns whether
   *  the cursor actually moved (false when parked at a boundary). */
  onStep: (dir: 1 | -1, speed: ScrubSpeed) => boolean;
  /** Delay before the first repeat — a shorter hold is a tap (one step). */
  holdDelayMs: number;
  /** Pacing between repeat steps once repeating. */
  repeatMs: number;
  /** Scrub-state sink, called only when (active, speed) actually changes. */
  onScrubChange: (active: boolean, speed: ScrubSpeed) => void;
  /** Clock seams — tests inject fakes; defaults are the real browser ones. */
  raf?: (cb: (ts: number) => void) => number;
  caf?: (id: number) => void;
  now?: () => number;
};

export type HeldRepeat = {
  start: (dir: 1 | -1) => void;
  stop: () => void;
  /** Current held direction, 0 when idle — the keymap's arm/disarm guard. */
  heldDirRef: { current: HeldDir };
  /** Last-signalled scrub-active state — the strip-click interrupt guard. */
  scrubbingRef: { current: boolean };
};

/** The pure engine behind useHeldRepeat — exported for the unit tests. */
export function createHeldRepeat(opts: HeldRepeatOpts): HeldRepeat {
  const raf = opts.raf ?? ((cb: (ts: number) => void) => requestAnimationFrame(cb));
  const caf = opts.caf ?? ((id: number) => cancelAnimationFrame(id));
  const now = opts.now ?? (() => performance.now());

  const heldDirRef: { current: HeldDir } = { current: 0 };
  const scrubbingRef = { current: false };
  let rafId: number | null = null;
  let holdStartTs = 0;
  let lastStepTs = 0;
  let sentSpeed: ScrubSpeed = 1;

  const signal = (active: boolean, speed: ScrubSpeed) => {
    if (active === scrubbingRef.current && speed === sentSpeed) return;
    scrubbingRef.current = active;
    sentSpeed = speed;
    opts.onScrubChange(active, speed);
  };

  const stop = () => {
    heldDirRef.current = 0;
    if (rafId != null) {
      caf(rafId);
      rafId = null;
    }
    // Settle → full-res snaps back for the landed frame; indicators clear.
    signal(false, 1);
  };

  const start = (dir: 1 | -1) => {
    if (heldDirRef.current === dir) return; // already scrubbing this way
    if (rafId != null) caf(rafId);
    heldDirRef.current = dir;
    opts.onStep(dir, 1); // immediate first step — no OS initial-repeat delay
    holdStartTs = now();
    lastStepTs = holdStartTs;
    let repeating = false; // false until the initial hold delay elapses
    const loop = (ts: number) => {
      if (heldDirRef.current === 0) return;
      const due = repeating
        ? ts - lastStepTs >= opts.repeatMs
        : ts - holdStartTs >= opts.holdDelayMs;
      if (due) {
        repeating = true;
        lastStepTs = ts;
        const speed = scrubSpeedForHeldMs(ts - holdStartTs);
        signal(scrubbingRef.current, speed); // escalation shows even while parked
        const moved = opts.onStep(heldDirRef.current, speed);
        signal(moved, speed);
      }
      rafId = raf(loop);
    };
    rafId = raf(loop);
  };

  return { start, stop, heldDirRef, scrubbingRef };
}

/**
 * React shell: one stable engine per instance, with the step/scrub callbacks
 * read through per-render refs so the loop always calls the LATEST closure
 * (fresh currentIndex / challenger / gridCols each tick) — the same mirror
 * discipline the old App.tsx navStepRef/advanceRef kept by hand.
 * `holdDelayMs`/`repeatMs` are captured at mount (they're module constants).
 */
export function useHeldRepeat(
  opts: Pick<HeldRepeatOpts, "onStep" | "holdDelayMs" | "repeatMs" | "onScrubChange">,
): HeldRepeat {
  const onStepRef = useRef(opts.onStep);
  const onScrubChangeRef = useRef(opts.onScrubChange);
  useEffect(() => {
    onStepRef.current = opts.onStep;
    onScrubChangeRef.current = opts.onScrubChange;
  });
  const [engine] = useState(() =>
    createHeldRepeat({
      onStep: (dir, speed) => onStepRef.current(dir, speed),
      holdDelayMs: opts.holdDelayMs,
      repeatMs: opts.repeatMs,
      onScrubChange: (active, speed) => onScrubChangeRef.current(active, speed),
    }),
  );
  // Unmount safety: kill the pending frame (App's blur/unmount effect also
  // stops both instances — this keeps the hook self-contained regardless).
  useEffect(() => () => engine.stop(), [engine]);
  return engine;
}
