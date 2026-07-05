import { describe, expect, test } from "vitest";
import {
  RECOVERED_HOLD_MS,
  runFolderRetry,
  STILL_HOLD_MS,
  type TroubleState,
} from "./folderRetry";

/** Tiny harness mirroring React's functional setState over a plain variable,
 *  recording every state the chip would render. */
function makeStateRecorder(initial: TroubleState) {
  let state = initial;
  const seen: TroubleState[] = [];
  return {
    setState: (update: TroubleState | ((prev: TroubleState) => TroubleState)) => {
      state = typeof update === "function" ? update(state) : update;
      seen.push(state);
    },
    get: () => state,
    force: (s: TroubleState) => {
      state = s;
    },
    seen,
  };
}

describe("runFolderRetry", () => {
  test("all folders reachable: checking → rearm → recovered → hidden", async () => {
    const rec = makeStateRecorder("latched");
    const probed: string[] = [];
    const slept: number[] = [];
    let rearmed = 0;

    await runFolderRetry({
      folders: ["/a", "/b"],
      probe: (f) => {
        probed.push(f);
        return Promise.resolve();
      },
      setState: rec.setState,
      rearm: () => {
        rearmed++;
      },
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
    });

    expect(probed).toEqual(["/a", "/b"]);
    expect(rearmed).toBe(1);
    expect(rec.seen).toEqual(["checking", "recovered", "hidden"]);
    expect(slept).toEqual([RECOVERED_HOLD_MS]);
  });

  test("unreachable folder: checking → still → latched, rearm never runs", async () => {
    const rec = makeStateRecorder("latched");
    const slept: number[] = [];
    let rearmed = 0;

    await runFolderRetry({
      folders: ["/a", "/b"],
      probe: (f) => (f === "/b" ? Promise.reject(new Error("nope")) : Promise.resolve()),
      setState: rec.setState,
      rearm: () => {
        rearmed++;
      },
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
    });

    expect(rearmed).toBe(0);
    expect(rec.seen).toEqual(["checking", "still", "latched"]);
    expect(slept).toEqual([STILL_HOLD_MS]);
  });

  test("re-latch during the recovered hold wins: hold timer must not hide real trouble", async () => {
    const rec = makeStateRecorder("latched");

    await runFolderRetry({
      folders: ["/a"],
      probe: () => Promise.resolve(),
      setState: rec.setState,
      rearm: () => {},
      sleep: () => {
        // Store sink re-latched (reads failed again) while "reconnected" showed.
        rec.force("latched");
        return Promise.resolve();
      },
    });

    expect(rec.get()).toBe("latched");
  });

  test("external state change during the still hold is left alone", async () => {
    const rec = makeStateRecorder("latched");

    await runFolderRetry({
      folders: ["/a"],
      probe: () => Promise.reject(new Error("nope")),
      setState: rec.setState,
      rearm: () => {},
      sleep: () => {
        rec.force("hidden");
        return Promise.resolve();
      },
    });

    expect(rec.get()).toBe("hidden");
  });

  test("no folders (empty session) resolves to hidden without probing", async () => {
    const rec = makeStateRecorder("latched");
    let rearmed = 0;

    await runFolderRetry({
      folders: [],
      probe: () => Promise.reject(new Error("must not probe")),
      setState: rec.setState,
      rearm: () => {
        rearmed++;
      },
      sleep: () => Promise.resolve(),
    });

    // Vacuously reachable — nothing to re-arm against is still "no trouble".
    expect(rearmed).toBe(1);
    expect(rec.get()).toBe("hidden");
  });
});
