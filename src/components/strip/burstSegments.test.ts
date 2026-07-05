import { describe, expect, test } from "vitest";
import { computeBurstSegments, BURST_BREATH, BURST_BREATH_AFTER_RUN } from "./burstSegments";
import type { BurstCtx } from "../../smart/groupBursts";

const ctx = (group: number, pos: number, len: number): BurstCtx => ({
  group,
  pos,
  len,
  isWinner: false,
  marginToWinner: 0,
});

describe("computeBurstSegments", () => {
  test("no bursts → no segments, no prefix", () => {
    const r = computeBurstSegments([1, 2, 3], undefined);
    expect(r.segs).toEqual([]);
    expect(r.prefix).toBeUndefined();
  });

  test("full list: one segment per run, labeled, with breath before and after", () => {
    // ids: 1,2 free; 3,4,5 burst g0; 6 free
    const bursts = new Map<number, BurstCtx>([
      [3, ctx(0, 1, 3)],
      [4, ctx(0, 2, 3)],
      [5, ctx(0, 3, 3)],
    ]);
    const r = computeBurstSegments([1, 2, 3, 4, 5, 6], bursts);
    expect(r.segs).toEqual([{ start: 2, end: 4, group: 0, len: 3, labeled: true }]);
    // prefix: 0,0 for free; BREATH inserted before index 2; constant through
    // the run; +BREATH again after the run for index 5.
    expect(r.prefix).toEqual([0, 0, BURST_BREATH, BURST_BREATH, BURST_BREATH, 2 * BURST_BREATH, 2 * BURST_BREATH]);
  });

  test("back-to-back runs get the reduced leading breath", () => {
    const bursts = new Map<number, BurstCtx>([
      [1, ctx(0, 1, 2)],
      [2, ctx(0, 2, 2)],
      [3, ctx(1, 1, 2)],
      [4, ctx(1, 2, 2)],
    ]);
    const r = computeBurstSegments([1, 2, 3, 4], bursts);
    expect(r.segs.map((s) => [s.start, s.end])).toEqual([
      [0, 1],
      [2, 3],
    ]);
    // Run 2 starts right after run 1's end: BREATH (lead) then
    // BREATH (after run 1) + AFTER_RUN (reduced lead for run 2).
    expect(r.prefix![2]).toBe(BURST_BREATH + BURST_BREATH + BURST_BREATH_AFTER_RUN);
  });

  test("subset (compare strip): a run split by filtered frames yields one segment per contiguous stretch, only the first labeled", () => {
    // Strip shows members of group 0 at positions 0,1 then a free frame, then
    // two more members (the middle of the burst was rated away).
    const bursts = new Map<number, BurstCtx>([
      [10, ctx(0, 1, 5)],
      [11, ctx(0, 2, 5)],
      [13, ctx(0, 4, 5)],
      [14, ctx(0, 5, 5)],
    ]);
    const r = computeBurstSegments([10, 11, 99, 13, 14], bursts);
    expect(r.segs).toEqual([
      { start: 0, end: 1, group: 0, len: 5, labeled: true },
      { start: 3, end: 4, group: 0, len: 5, labeled: false },
    ]);
  });

  test("subset without the run's first frame still labels its first segment", () => {
    const bursts = new Map<number, BurstCtx>([
      [11, ctx(0, 2, 4)],
      [12, ctx(0, 3, 4)],
    ]);
    const r = computeBurstSegments([99, 11, 12], bursts);
    expect(r.segs).toEqual([{ start: 1, end: 2, group: 0, len: 4, labeled: true }]);
  });
});
