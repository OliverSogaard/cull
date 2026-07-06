import { describe, expect, it } from "vitest";
import { SCRUB_STAGE2_AT_MS, SCRUB_STAGE3_AT_MS, scrubSpeedForHeldMs } from "./scrubAccel";

describe("scrubSpeedForHeldMs", () => {
  it("returns 1x for a fresh hold", () => {
    expect(scrubSpeedForHeldMs(0)).toBe(1);
    expect(scrubSpeedForHeldMs(500)).toBe(1);
  });

  it("stays at 1x right up to (but not including) the stage-2 boundary", () => {
    expect(scrubSpeedForHeldMs(SCRUB_STAGE2_AT_MS - 1)).toBe(1);
  });

  it("steps up to 3x exactly at the stage-2 boundary", () => {
    expect(scrubSpeedForHeldMs(SCRUB_STAGE2_AT_MS)).toBe(3);
    expect(scrubSpeedForHeldMs(SCRUB_STAGE2_AT_MS + 1)).toBe(3);
  });

  it("stays at 3x right up to (but not including) the stage-3 boundary", () => {
    expect(scrubSpeedForHeldMs(SCRUB_STAGE3_AT_MS - 1)).toBe(3);
  });

  it("steps up to 10x exactly at the stage-3 boundary and beyond", () => {
    expect(scrubSpeedForHeldMs(SCRUB_STAGE3_AT_MS)).toBe(10);
    expect(scrubSpeedForHeldMs(SCRUB_STAGE3_AT_MS + 1)).toBe(10);
    expect(scrubSpeedForHeldMs(100_000)).toBe(10);
  });
});
