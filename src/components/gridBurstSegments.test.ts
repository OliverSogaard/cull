import { describe, expect, it } from "vitest";
import { computeGridBurstSegments, type GridCell, type GridGroupHit } from "./gridBurstSegments";
import type { BurstCtx } from "../smart/groupBursts";

const ctx = (group: number, pos: number, len: number): BurstCtx => ({
  group,
  pos,
  len,
  isWinner: false,
  marginToWinner: 0,
});
/** Cells of one row, left to right — what GridView generates. */
const row = (r: number, n: number, from = 0): GridCell[] =>
  Array.from({ length: n }, (_, i) => ({ idx: from + i, row: r, col: i }));
/** Look a cell's group up from a plain idx -> hit map. */
const hits =
  (m: Record<number, GridGroupHit>) =>
  (idx: number): GridGroupHit | undefined =>
    m[idx];

describe("computeGridBurstSegments", () => {
  it("draws ONE box for a contiguous run — today's output, unchanged", () => {
    const segs = computeGridBurstSegments(
      row(0, 4),
      hits({
        1: { c: ctx(0, 1, 3), kind: "burst" },
        2: { c: ctx(0, 2, 3), kind: "burst" },
        3: { c: ctx(0, 3, 3), kind: "burst" },
      }),
    );
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({
      row: 0,
      c0: 1,
      c1: 3,
      label: 3,
      openLeft: false,
      openRight: false,
      kind: "burst",
    });
  });

  it("splits two interleaved bodies into one box per contiguous stretch", () => {
    // A,B,A,B in one row: neither group may span the other's cell.
    const segs = computeGridBurstSegments(
      row(0, 4),
      hits({
        0: { c: ctx(0, 1, 2), kind: "burst" },
        1: { c: ctx(1, 1, 2), kind: "burst" },
        2: { c: ctx(0, 2, 2), kind: "burst" },
        3: { c: ctx(1, 2, 2), kind: "burst" },
      }),
    );
    expect(segs).toHaveLength(4);
    for (const s of segs) expect(s.c0).toBe(s.c1);
    expect(segs.map((s) => s.c0)).toEqual([0, 1, 2, 3]);
    // No two boxes overlap, and each group's ends are open where its run
    // continues elsewhere.
    expect(segs[0]).toMatchObject({ label: 2, openLeft: false, openRight: true });
    expect(segs[2]).toMatchObject({ label: null, openLeft: true, openRight: false });
    // Keys stay unique, or React renders one box and drops the rest.
    expect(new Set(segs.map((s) => s.key)).size).toBe(4);
  });

  it("keeps a run that wraps a row as one box per row, each open at the seam", () => {
    const cells = [...row(0, 2, 0), ...row(1, 2, 2)];
    const segs = computeGridBurstSegments(
      cells,
      hits({
        0: { c: ctx(0, 1, 4), kind: "burst" },
        1: { c: ctx(0, 2, 4), kind: "burst" },
        2: { c: ctx(0, 3, 4), kind: "burst" },
        3: { c: ctx(0, 4, 4), kind: "burst" },
      }),
    );
    expect(segs).toHaveLength(2);
    expect(segs[0]).toMatchObject({ row: 0, c0: 0, c1: 1, openLeft: false, openRight: true });
    expect(segs[1]).toMatchObject({ row: 1, c0: 0, c1: 1, openLeft: true, openRight: false });
  });

  it("separates a burst from a similar set that happen to share a group number", () => {
    const segs = computeGridBurstSegments(
      row(0, 2),
      hits({
        0: { c: ctx(0, 1, 1), kind: "burst" },
        1: { c: ctx(0, 1, 1), kind: "similar" },
      }),
    );
    expect(segs.map((s) => s.kind)).toEqual(["burst", "similar"]);
    expect(new Set(segs.map((s) => s.key)).size).toBe(2);
  });

  it("is empty when nothing is grouped", () => {
    expect(computeGridBurstSegments(row(0, 3), hits({}))).toEqual([]);
  });
});
