/**
 * State machine for the "folder unreachable" chip's retry flow. The chip used
 * to be a bare boolean — a click hid it, probed, and silently re-showed it on
 * failure, which read as "the button does nothing". Now every click walks
 * through visible states so the user always sees an outcome:
 *
 *   latched ── click ──▶ checking ──▶ recovered ──(hold)──▶ hidden
 *                            └──────▶ still ──────(hold)──▶ latched
 *
 * The store's trouble sink may re-latch at any time; the hold timers therefore
 * only complete their own transition (functional updates guarded on the state
 * they set) so a concurrent re-latch is never overwritten by a stale timer.
 */

export type TroubleState = "hidden" | "latched" | "checking" | "still" | "recovered";

export type SetTroubleState = (
  update: TroubleState | ((prev: TroubleState) => TroubleState),
) => void;

/** How long "still unreachable" stays up before offering retry again. */
export const STILL_HOLD_MS = 2200;
/** How long "reconnected" stays up before the chip disappears. */
export const RECOVERED_HOLD_MS = 1600;

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Probe every source folder; on full success re-arm the store and show
 * "reconnected" briefly, on the first failure show "still unreachable" and
 * fall back to the retry affordance. Never throws — a probe rejection IS the
 * still-unreachable outcome.
 */
export async function runFolderRetry(opts: {
  folders: readonly string[];
  probe: (folder: string) => Promise<unknown>;
  setState: SetTroubleState;
  rearm: () => void;
  sleep?: (ms: number) => Promise<void>;
}): Promise<void> {
  const sleep = opts.sleep ?? defaultSleep;
  opts.setState("checking");
  for (const folder of opts.folders) {
    try {
      await opts.probe(folder);
    } catch {
      opts.setState("still");
      await sleep(STILL_HOLD_MS);
      opts.setState((s) => (s === "still" ? "latched" : s));
      return;
    }
  }
  opts.rearm();
  opts.setState("recovered");
  await sleep(RECOVERED_HOLD_MS);
  opts.setState((s) => (s === "recovered" ? "hidden" : s));
}
