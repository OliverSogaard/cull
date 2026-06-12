/**
 * Display-adaptive tier choice (Phase 8): the hysteresis the store runs
 * against the FRESH needPx (stage rect height × devicePixelRatio). The
 * representative numbers mirror the verify line's two display cases:
 * a 4K stage at 150% scaling (~1240 CSS px of stage height × 1.5 ≈ 1860)
 * engages; a 1440p stage (~1240 × 1.0) never does.
 */
import { describe, expect, it } from "vitest";
import { MID_ENGAGE_PX, MID_RELEASE_PX, nextMidEngaged } from "./midSelect";

describe("nextMidEngaged", () => {
  it("engages above the threshold (4K-class stage)", () => {
    expect(nextMidEngaged(false, 1860)).toBe(true);
    expect(nextMidEngaged(true, 1860)).toBe(true);
  });

  it("stays released below it (1440p-class stage)", () => {
    expect(nextMidEngaged(false, 1240)).toBe(false);
    expect(nextMidEngaged(true, 1240)).toBe(false);
  });

  it("holds the previous choice inside the hysteresis band (no flapping)", () => {
    const inBand = (MID_ENGAGE_PX + MID_RELEASE_PX) / 2;
    expect(nextMidEngaged(false, inBand)).toBe(false);
    expect(nextMidEngaged(true, inBand)).toBe(true);
    // The exact bounds are part of the band (strict comparisons).
    expect(nextMidEngaged(false, MID_ENGAGE_PX)).toBe(false);
    expect(nextMidEngaged(true, MID_RELEASE_PX)).toBe(true);
  });

  it("flips both ways across the band — the drag-between-monitors case", () => {
    let engaged = false;
    engaged = nextMidEngaged(engaged, 1860); // dragged onto the 4K display
    expect(engaged).toBe(true);
    engaged = nextMidEngaged(engaged, 1700); // resize jitter inside the band
    expect(engaged).toBe(true);
    engaged = nextMidEngaged(engaged, 1240); // dragged onto the 1440p display
    expect(engaged).toBe(false);
    engaged = nextMidEngaged(engaged, 1860); // and back
    expect(engaged).toBe(true);
  });

  it("an unmeasurable stage (null/NaN) keeps the previous choice", () => {
    expect(nextMidEngaged(true, null)).toBe(true);
    expect(nextMidEngaged(false, null)).toBe(false);
    expect(nextMidEngaged(true, Number.NaN)).toBe(true);
    expect(nextMidEngaged(false, Number.NaN)).toBe(false);
  });

  it("the band is ~100 px wide around ~1700 (the plan's numbers)", () => {
    expect(MID_ENGAGE_PX - MID_RELEASE_PX).toBe(100);
    expect((MID_ENGAGE_PX + MID_RELEASE_PX) / 2).toBe(1700);
  });
});
