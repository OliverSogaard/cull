import { describe, expect, it } from "vitest";
import { clampProfileForPressure, type PressureLevel } from "./pressureProfile";
import { PERFORMANCE_PROFILES } from "../types/settings";

const base = PERFORMANCE_PROFILES.local;

describe("clampProfileForPressure — memory-pressure shedding", () => {
  it("normal returns the base profile untouched (same reference)", () => {
    expect(clampProfileForPressure(base, "normal")).toBe(base);
  });

  it("warn halves the memory-heavy windows and disables prefetch-ahead excess", () => {
    const p = clampProfileForPressure(base, "warn");
    expect(p.previewKeep).toBeLessThan(base.previewKeep);
    expect(p.decodedPoolPreviews).toBeLessThan(base.decodedPoolPreviews);
    expect(p.decodedPoolFulls).toBeLessThanOrEqual(1);
    expect(p.backgroundFillConcurrency).toBeLessThanOrEqual(
      base.backgroundFillConcurrency,
    );
    // Read concurrency is I/O, not memory: untouched.
    expect(p.previewConcurrency).toBe(base.previewConcurrency);
  });

  it("critical cuts to survival numbers: no decoded fulls, minimal windows, no prefetch", () => {
    const p = clampProfileForPressure(base, "critical");
    expect(p.decodedPoolFulls).toBe(0);
    expect(p.fullKeep).toBe(0);
    expect(p.previewPrefetchAhead).toBe(0);
    expect(p.previewPrefetchBehind).toBe(0);
    expect(p.backgroundFillConcurrency).toBe(0);
    expect(p.previewKeep).toBeGreaterThanOrEqual(4); // the working set survives
  });

  it("never raises any value above the base", () => {
    for (const level of ["warn", "critical"] as PressureLevel[]) {
      const p = clampProfileForPressure(base, level);
      for (const k of Object.keys(base) as (keyof typeof base)[]) {
        if (typeof base[k] === "number") {
          expect(p[k] as number).toBeLessThanOrEqual(base[k] as number);
        }
      }
    }
  });
});
