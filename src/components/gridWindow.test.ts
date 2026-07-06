// src/components/gridWindow.test.ts
import { describe, expect, it } from "vitest";
import { computeGridAutoScrollTop, computeGridWindow } from "./gridWindow";

describe("computeGridWindow", () => {
  // Geometry mirroring a real grid: ~168px square cells, ~5 visible rows.
  const rowH = 168;
  const viewportH = 800;
  const buffer = 2;

  it("covers the visible rows plus buffer at scroll 0 (firstRow clamps to 0)", () => {
    const r = computeGridWindow({ scrollTop: 0, viewportH, rowH, totalRows: 100, buffer });
    expect(r.firstRow).toBe(0);
    // ceil(800/168) = 5 visible rows + 2 buffer
    expect(r.lastRow).toBe(7);
  });

  it("slides the window with scroll position", () => {
    const r = computeGridWindow({ scrollTop: 1680, viewportH, rowH, totalRows: 100, buffer });
    // floor(1680/168) = 10 − 2 buffer
    expect(r.firstRow).toBe(8);
    // ceil((1680+800)/168) = 15 + 2 buffer
    expect(r.lastRow).toBe(17);
  });

  it("clamps lastRow to totalRows near the end", () => {
    const r = computeGridWindow({ scrollTop: 16000, viewportH, rowH, totalRows: 100, buffer });
    expect(r.lastRow).toBe(100);
  });

  it("handles an empty grid", () => {
    expect(
      computeGridWindow({ scrollTop: 0, viewportH, rowH, totalRows: 0, buffer }),
    ).toEqual({ firstRow: 0, lastRow: 0 });
  });

  it("REGRESSION (scrub flash): window computed from the just-written scrollTop covers every visible row after a multi-row jump", () => {
    // 10× grid scrub jumps the auto-scroll 10 rows per tick — far past the
    // 2-row buffer. The fix recomputes the window from the NEW scrollTop in
    // the same commit (before paint); this pins the covering contract that
    // makes that recompute sufficient.
    const before = 1680; // rows 10..15 visible
    const jumped = before + 10 * rowH; // rows 20..25 visible
    const r = computeGridWindow({ scrollTop: jumped, viewportH, rowH, totalRows: 100, buffer });
    const firstVisible = Math.floor(jumped / rowH);
    const lastVisible = Math.ceil((jumped + viewportH) / rowH);
    expect(r.firstRow).toBeLessThanOrEqual(firstVisible);
    expect(r.lastRow).toBeGreaterThanOrEqual(lastVisible);
  });
});

describe("computeGridAutoScrollTop", () => {
  const rowH = 168;
  const cols = 6;
  const viewportH = 800;

  it("returns 0 when the current frame is not in the filtered set (pos -1)", () => {
    expect(
      computeGridAutoScrollTop({ pos: -1, cols, rowH, scrollTop: 500, viewportH }),
    ).toBe(0);
  });

  it("returns null when the cell is already fully in view (no scroll write)", () => {
    // pos 12 → row 2 → cellTop 336, cellBottom 504, viewport [200, 1000].
    expect(
      computeGridAutoScrollTop({ pos: 12, cols, rowH, scrollTop: 200, viewportH }),
    ).toBeNull();
  });

  it("scrolls up so the cell's top edge lands at the viewport top", () => {
    // pos 6 → row 1 → cellTop 168 < scrollTop 500.
    expect(
      computeGridAutoScrollTop({ pos: 6, cols, rowH, scrollTop: 500, viewportH }),
    ).toBe(168);
  });

  it("scrolls down so the cell's bottom edge lands at the viewport bottom", () => {
    // pos 60 → row 10 → cellBottom 1848 > 0 + 800.
    expect(
      computeGridAutoScrollTop({ pos: 60, cols, rowH, scrollTop: 0, viewportH }),
    ).toBe(1848 - viewportH);
  });

  it("jumps whole multiples of rowH under a held scrub (row-aligned target)", () => {
    // Scrub tick advanced pos by 10 rows: the target tracks the cell exactly.
    const pos = 20 * cols; // row 20
    const t = computeGridAutoScrollTop({ pos, cols, rowH, scrollTop: 1680, viewportH });
    expect(t).toBe(21 * rowH - viewportH);
  });
});
