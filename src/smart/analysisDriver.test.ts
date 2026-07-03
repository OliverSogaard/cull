import { describe, expect, test, vi } from "vitest";
import { runAnalysis, type DriverDeps } from "./analysisDriver";
import { ImageStore } from "../image/imageStore";
import { score } from "./testScores";
import type { ImageScore } from "../types/ipc";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

function deps(over: Partial<DriverDeps> = {}): DriverDeps & {
  calls: { paths: string[]; chunkStart: number; gen: number }[];
  scored: ImageScore[][];
  progress: [number, number][];
  sleeps: number[];
} {
  const calls: { paths: string[]; chunkStart: number; gen: number }[] = [];
  const scored: ImageScore[][] = [];
  const progress: [number, number][] = [];
  const sleeps: number[] = [];
  return {
    calls,
    scored,
    progress,
    sleeps,
    invokeChunk: async (paths, chunkStart, gen) => {
      calls.push({ paths, chunkStart, gen });
      return paths.map((_, i) => score({ index: chunkStart + i }));
    },
    getGeneration: () => 7,
    isBusyLoading: () => false,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    onScores: (s) => scored.push(s),
    onProgress: (d, t) => progress.push([d, t]),
    chunkLen: 3,
    idleWaitMs: 100,
    ...over,
  };
}

const paths = (n: number) => Array.from({ length: n }, (_, i) => `/a/p${i}.CR3`);

describe("runAnalysis", () => {
  test("chunks sequentially with absolute starts and reports progress", async () => {
    const d = deps();
    const end = await runAnalysis(paths(8), 7, d);
    expect(end).toBe("done");
    expect(d.calls.map((c) => c.chunkStart)).toEqual([0, 3, 6]);
    expect(d.calls[2].paths).toHaveLength(2);
    expect(d.calls.every((c) => c.gen === 7)).toBe(true);
    expect(d.progress).toEqual([
      [3, 8],
      [6, 8],
      [8, 8],
    ]);
    expect(d.scored).toHaveLength(3);
  });

  test("a generation move between chunks drops that chunk's results (THE gen-guard)", async () => {
    let gen = 7;
    const d = deps({
      getGeneration: () => gen,
      invokeChunk: async (p, start, g) => {
        d.calls.push({ paths: p, chunkStart: start, gen: g });
        if (start === 3) gen = 8; // folder switched while this chunk was in flight
        return p.map((_, i) => score({ index: start + i }));
      },
    });
    const end = await runAnalysis(paths(9), 7, d);
    expect(end).toBe("stale");
    expect(d.scored).toHaveLength(1); // chunk 0 only — chunk 1 arrived stale
    expect(d.calls.map((c) => c.chunkStart)).toEqual([0, 3]); // chunk 2 never dispatched
  });

  test("waits out interactive loading between chunks, then proceeds", async () => {
    let busyPolls = 0;
    const d = deps({
      isBusyLoading: () => {
        busyPolls += 1;
        return busyPolls <= 2; // busy for the first two polls
      },
    });
    const end = await runAnalysis(paths(3), 7, d);
    expect(end).toBe("done");
    expect(d.sleeps).toEqual([100, 100]);
  });

  test("a failing chunk retries once, then is skipped — the pass survives", async () => {
    let attempts = 0;
    const d = deps({
      invokeChunk: async (p, start, g) => {
        d.calls.push({ paths: p, chunkStart: start, gen: g });
        if (start === 0) {
          attempts += 1;
          throw new Error("read timed out after 45s");
        }
        return p.map((_, i) => score({ index: start + i }));
      },
    });
    const end = await runAnalysis(paths(6), 7, d);
    expect(end).toBe("done");
    expect(attempts).toBe(2);
    expect(d.scored).toHaveLength(1); // only chunk 1 scored
    expect(d.progress.at(-1)).toEqual([6, 6]); // skipped chunk still counts as done
  });

  test("a cancelled chunk ends the pass as stale immediately", async () => {
    const d = deps({
      invokeChunk: async () => {
        throw new Error("cancelled");
      },
    });
    expect(await runAnalysis(paths(6), 7, d)).toBe("stale");
    expect(d.scored).toHaveLength(0);
  });
});

describe("imageStore.isBusyLoading", () => {
  test("a fresh store is not busy", () => {
    expect(new ImageStore().isBusyLoading()).toBe(false);
  });
});
