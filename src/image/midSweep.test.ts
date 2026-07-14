import { afterEach, describe, expect, test, vi } from "vitest";
import { MidSweep, MID_SWEEP_QUIET_MS, type MidSweepDeps } from "./midSweep";

/** Controllable deps: every gate open, generation 0, generate resolves true
 *  immediately unless a manual resolver queue is installed. */
function makeDeps(overrides: Partial<MidSweepDeps> = {}) {
  const generated: string[] = [];
  const attempts: string[] = [];
  const state = {
    gen: 0,
    idle: true,
    can: true,
    concurrency: 1,
    paths: [] as string[],
    cursor: 0,
    ready: new Set<string>(),
  };
  const deps: MidSweepDeps = {
    canSweep: () => state.can,
    onDemandIdle: () => state.idle,
    concurrency: () => state.concurrency,
    paths: () => state.paths,
    cursor: () => state.cursor,
    isMidReady: (p) => state.ready.has(p),
    hintFor: () => ({ fullOffset: null, fullLen: null, orientation: null }),
    generation: () => state.gen,
    generate: (path) => {
      attempts.push(path);
      return Promise.resolve(true);
    },
    onGenerated: () => {
      generated.push(attempts[attempts.length - 1]);
    },
    ...overrides,
  };
  return { deps, state, attempts, generated };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

afterEach(() => {
  vi.useRealTimers();
});

describe("MidSweep", () => {
  test("sweeps nearest-to-cursor first, skipping ready mids, one attempt each", async () => {
    const { deps, state, attempts } = makeDeps();
    state.paths = ["a", "b", "c", "d", "e"];
    state.cursor = 2;
    state.ready.add("d"); // already cached — never attempted
    const sweep = new MidSweep(deps);
    sweep.pump();
    await vi.waitUntil(() => attempts.length === 4);
    // c (d=0), then b (d=1, scan order beats the skipped d), a (d=2), e (d=2 tie → earlier index).
    expect(attempts).toEqual(["c", "b", "a", "e"]);
  });

  test("pauses while on-demand lanes are busy and while gates are closed", () => {
    const { deps, state, attempts } = makeDeps();
    state.paths = ["a"];
    const sweep = new MidSweep(deps);
    state.idle = false;
    sweep.pump();
    expect(attempts).toHaveLength(0);
    state.idle = true;
    state.can = false; // network profile / not engaged / trouble
    sweep.pump();
    expect(attempts).toHaveLength(0);
  });

  test("budget stops the sweep; reset() re-opens it", async () => {
    const { deps, state, attempts } = makeDeps();
    state.paths = ["a", "b", "c"];
    const sweep = new MidSweep(deps, 2); // test-only small budget
    sweep.pump();
    await vi.waitUntil(() => attempts.length === 2);
    await tick();
    expect(attempts).toEqual(["a", "b"]); // third pick blocked by budget
    sweep.reset();
    sweep.pump();
    await vi.waitUntil(() => attempts.length > 2);
    expect(attempts[2]).toBe("a"); // fresh session: everything re-attemptable
  });

  test("waits out the cursor-quiet window via ONE armed timer", () => {
    vi.useFakeTimers();
    const { deps, state, attempts } = makeDeps();
    state.paths = ["a"];
    const sweep = new MidSweep(deps);
    sweep.noteCursorMove(); // cursor active NOW
    sweep.pump();
    sweep.pump(); // second pump must not stack a second timer
    expect(attempts).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(MID_SWEEP_QUIET_MS);
    expect(attempts).toEqual(["a"]); // quiet window elapsed → sweep started
    vi.useRealTimers();
  });

  test("a completion for a superseded generation neither counts nor re-pumps", async () => {
    let release!: (ok: boolean) => void;
    const { deps, state, attempts, generated } = makeDeps({
      generate: (path) => {
        attempts.push(path);
        return new Promise<boolean>((r) => {
          release = r;
        });
      },
    });
    state.paths = ["a", "b"];
    const sweep = new MidSweep(deps);
    sweep.pump();
    expect(attempts).toEqual(["a"]);
    state.gen = 1; // session changed while the generate was in flight
    release(true);
    await tick();
    expect(generated).toHaveLength(0); // stale gen: not counted
    expect(attempts).toEqual(["a"]); // and no self-re-pump into the new session
  });

  test("a same-generation completion counts and chains to the next pick", async () => {
    const { deps, state, attempts, generated } = makeDeps();
    state.paths = ["a", "b"];
    const sweep = new MidSweep(deps);
    sweep.pump();
    await vi.waitUntil(() => attempts.length === 2);
    expect(generated).toEqual(["a", "b"]);
  });

  test("a rejected generate is best-effort quiet: one attempt, sweep continues", async () => {
    const { deps, state, attempts, generated } = makeDeps({
      generate: (path) => {
        attempts.push(path);
        return path === "a" ? Promise.reject(new Error("io")) : Promise.resolve(true);
      },
    });
    state.paths = ["a", "b"];
    state.cursor = 0;
    const sweep = new MidSweep(deps);
    sweep.pump();
    await vi.waitUntil(() => attempts.length === 2);
    expect(attempts).toEqual(["a", "b"]); // a not retried, b still swept
    expect(generated).toEqual(["b"]);
  });
});
