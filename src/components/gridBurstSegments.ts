import type { BurstCtx } from "../smart/groupBursts";

/**
 * Where the grid draws its burst / similar brackets — the vertical sibling of
 * `strip/burstSegments.ts` (same contract: pure, no DOM, unit-tested).
 *
 * ONE BOX PER CONTIGUOUS STRETCH, never min-to-max. A group's members used to
 * be contiguous in session order, so a row's leftmost and rightmost member
 * bounded a solid block; since the per-folder walk in `groupBursts` /
 * `groupSimilar` two bodies interleaved by capture time put another body's
 * frames between them, and a min-to-max box would enclose frames that are not
 * in the group.
 *
 * The LEGEND rule is the grid's own and deliberately differs from the strip's:
 * the strip labels a group's first segment in display order, the grid labels
 * the stretch containing the run's FIRST FRAME (`pos === 1`), so a run whose
 * opening frame the filter hides draws no ×N at all. Unchanged here — the
 * point of this module is the span, not the label.
 */

/** One rendered cell, as GridView generates them: row-major, columns 0..n-1
 *  with no gaps within a row. */
export type GridCell = { idx: number; row: number; col: number };

/** A cell's group membership, already resolved by kind (bursts win). */
export type GridGroupHit = { c: BurstCtx; kind: "burst" | "similar" };

export type GridBurstSegment = {
  /** React key. Carries `c0` because one (kind, group, row) can now yield
   *  several stretches — without it React renders one box and drops the rest. */
  key: string;
  row: number;
  /** Inclusive column span of ONE contiguous stretch. */
  c0: number;
  c1: number;
  /** The run's total length, on the stretch holding its first frame; else null. */
  label: number | null;
  /** The run continues before / after this stretch (another row, another
   *  stretch, or off-screen): that edge renders OPEN. */
  openLeft: boolean;
  openRight: boolean;
  kind: "burst" | "similar";
};

export function computeGridBurstSegments(
  cells: readonly GridCell[],
  hitFor: (idx: number) => GridGroupHit | undefined,
): GridBurstSegment[] {
  const out: GridBurstSegment[] = [];
  let open: (GridBurstSegment & { firstPos: number; lastPos: number; len: number }) | null = null;
  let openKey: string | null = null;

  const close = () => {
    if (!open) return;
    out.push({
      key: open.key,
      row: open.row,
      c0: open.c0,
      c1: open.c1,
      label: open.label,
      openLeft: open.firstPos > 1,
      openRight: open.lastPos < open.len,
      kind: open.kind,
    });
    open = null;
    openKey = null;
  };

  for (const cell of cells) {
    const hit = hitFor(cell.idx);
    if (!hit) {
      close();
      continue;
    }
    const key = `${hit.kind}:${hit.c.group}`;
    // Contiguous means: same row, same group, and the very next column. Cells
    // arrive row-major with no gaps inside a row, so the column test is what
    // catches a foreign frame sitting between two members.
    const extends_ = open !== null && openKey === key && open.row === cell.row && cell.col === open.c1 + 1;
    if (!extends_) close();
    if (open === null) {
      open = {
        key: `${key}:${cell.row}:${cell.col}`,
        row: cell.row,
        c0: cell.col,
        c1: cell.col,
        label: hit.c.pos === 1 ? hit.c.len : null,
        firstPos: hit.c.pos,
        lastPos: hit.c.pos,
        len: hit.c.len,
        openLeft: false,
        openRight: false,
        kind: hit.kind,
      };
      openKey = key;
    } else {
      open.c1 = cell.col;
      if (hit.c.pos === 1) open.label = hit.c.len;
      open.firstPos = Math.min(open.firstPos, hit.c.pos);
      open.lastPos = Math.max(open.lastPos, hit.c.pos);
    }
  }
  close();
  return out;
}
