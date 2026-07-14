import { describe, expect, test } from "vitest";
import {
  backoffMs,
  FolderTroubleLatch,
  inCooldown,
  MAX_TIER_ATTEMPTS,
  recordTierError,
  type TierError,
} from "./tierErrors";

describe("backoffMs", () => {
  test("doubles from 1s and caps at 30s", () => {
    expect(backoffMs(1)).toBe(1000);
    expect(backoffMs(2)).toBe(2000);
    expect(backoffMs(3)).toBe(4000);
    expect(backoffMs(5)).toBe(16_000);
    expect(backoffMs(6)).toBe(30_000); // 32s capped
    expect(backoffMs(20)).toBe(30_000);
  });
});

describe("inCooldown", () => {
  test("no record → not cooling", () => {
    expect(inCooldown(undefined, Date.now())).toBe(false);
  });

  test("cooling until nextRetryAt, then eligible again", () => {
    const te: TierError = { attempts: 1, lastError: "io", nextRetryAt: 1000 };
    expect(inCooldown(te, 999)).toBe(true);
    expect(inCooldown(te, 1000)).toBe(false);
  });

  test("terminal at MAX_TIER_ATTEMPTS regardless of clock", () => {
    const te: TierError = {
      attempts: MAX_TIER_ATTEMPTS,
      lastError: "io",
      nextRetryAt: 0,
    };
    expect(inCooldown(te, Number.MAX_SAFE_INTEGER)).toBe(true);
  });
});

describe("recordTierError", () => {
  test("bumps attempts per path and stamps a growing backoff", () => {
    const map = new Map<string, TierError>();
    const before = Date.now();
    const first = recordTierError(map, "/a.CR3", "io");
    expect(first.attempts).toBe(1);
    expect(first.nextRetryAt).toBeGreaterThanOrEqual(before + 1000);
    const second = recordTierError(map, "/a.CR3", "io again");
    expect(second.attempts).toBe(2);
    expect(second.lastError).toBe("io again");
    expect(map.get("/a.CR3")).toBe(second);
    // Other paths keep independent counters.
    expect(recordTierError(map, "/b.CR3", "io").attempts).toBe(1);
  });
});

describe("FolderTroubleLatch", () => {
  test("latches exactly once at the distinct-path threshold", () => {
    const latch = new FolderTroubleLatch(3);
    expect(latch.noteTerminal("/a")).toBe(false);
    expect(latch.noteTerminal("/b")).toBe(false);
    expect(latch.noteTerminal("/a")).toBe(false); // duplicate — still 2 distinct
    expect(latch.isTroubled).toBe(false);
    expect(latch.noteTerminal("/c")).toBe(true); // crossing latches, returns true ONCE
    expect(latch.isTroubled).toBe(true);
    expect(latch.noteTerminal("/d")).toBe(false); // already latched — sink not re-fired
  });

  test("clearPath forgives one path without unlatching the folder verdict", () => {
    const latch = new FolderTroubleLatch(2);
    latch.noteTerminal("/a");
    latch.noteTerminal("/b");
    expect(latch.isTroubled).toBe(true);
    latch.clearPath("/a");
    expect(latch.isTroubled).toBe(true);
  });

  test("reset gives a clean slate and can latch again", () => {
    const latch = new FolderTroubleLatch(1);
    expect(latch.noteTerminal("/a")).toBe(true);
    latch.reset();
    expect(latch.isTroubled).toBe(false);
    expect(latch.noteTerminal("/b")).toBe(true); // fresh latch fires the sink again
  });
});
