import { describe, expect, it } from "vitest";
import {
  formatCaptureClock,
  formatSignedDuration,
  groupStagedFolders,
  OFFSET_STEP_MS,
  OFFSET_STEP_SHIFT_MS,
  stepOffset,
} from "./stagedFolders";
import { CAPTURE_OFFSET_LIMIT_MS } from "../types/settings";
import type { Img } from "../types";

const img = (id: number, srcFolder: string, name: string): Img => ({
  id,
  path: `${srcFolder}\\${name}`,
  filename: name,
  srcFolder,
});

describe("groupStagedFolders", () => {
  it("groups by srcFolder in FIRST-STAGED order, counting and naming each", () => {
    const groups = groupStagedFolders([
      img(0, "C:\\shoot\\bodyA", "A1.CR3"),
      img(1, "C:\\shoot\\bodyA", "A2.CR3"),
      img(2, "C:\\shoot\\bodyB", "B1.CR3"),
    ]);
    expect(groups.map((g) => g.path)).toEqual(["C:\\shoot\\bodyA", "C:\\shoot\\bodyB"]);
    expect(groups.map((g) => g.name)).toEqual(["bodyA", "bodyB"]);
    expect(groups.map((g) => g.count)).toEqual([2, 1]);
  });

  it("remembers each folder's FIRST staged frame — the row's capture-time probe", () => {
    const groups = groupStagedFolders([
      img(0, "C:\\shoot\\bodyA", "A1.CR3"),
      img(1, "C:\\shoot\\bodyA", "A2.CR3"),
    ]);
    expect(groups[0].firstPath).toBe("C:\\shoot\\bodyA\\A1.CR3");
  });

  it("is empty for an empty set", () => {
    expect(groupStagedFolders([])).toEqual([]);
  });
});

describe("formatCaptureClock", () => {
  it("prints the CAMERA's wall clock, never the machine's", () => {
    // captured_at_ms encodes the TZ-less EXIF string as UTC (analyze.rs), so
    // reading it back in local time would shift every row by the machine's
    // offset. This assertion has to hold in every timezone.
    expect(formatCaptureClock(Date.UTC(2026, 8, 20, 14, 2, 11))).toBe("14:02:11");
    expect(formatCaptureClock(Date.UTC(2026, 8, 20, 0, 0, 0, 470))).toBe("00:00:00");
  });
});

describe("formatSignedDuration", () => {
  it("always carries a sign, and a real minus, never a hyphen", () => {
    expect(formatSignedDuration(0)).toBe("+0 s");
    expect(formatSignedDuration(1000)).toBe("+1 s");
    expect(formatSignedDuration(-72_000)).toBe("\u22121 min 12 s");
    expect(formatSignedDuration(-72_000).startsWith("\u2212")).toBe(true);
  });

  it("drops the empty units and keeps the biggest one that fits", () => {
    expect(formatSignedDuration(60_000)).toBe("+1 min");
    expect(formatSignedDuration(3_600_000)).toBe("+1 h");
    expect(formatSignedDuration(3_912_000)).toBe("+1 h 5 min 12 s");
    expect(formatSignedDuration(3_660_000)).toBe("+1 h 1 min");
  });

  it("rounds to whole seconds — sub-second clock skew is noise", () => {
    expect(formatSignedDuration(1_400)).toBe("+1 s");
    expect(formatSignedDuration(-1_600)).toBe("\u22122 s");
    expect(formatSignedDuration(400)).toBe("+0 s");
  });
});

describe("stepOffset", () => {
  it("steps a second, a minute with Shift, and resets with Ctrl", () => {
    expect(stepOffset(0, 1, { shift: false, reset: false })).toBe(OFFSET_STEP_MS);
    expect(stepOffset(0, -1, { shift: true, reset: false })).toBe(-OFFSET_STEP_SHIFT_MS);
    expect(stepOffset(123_456, 1, { shift: false, reset: true })).toBe(0);
    // Reset wins over the direction and over Shift — one click, one meaning.
    expect(stepOffset(123_456, -1, { shift: true, reset: true })).toBe(0);
  });

  it("clamps at a day in each direction", () => {
    expect(stepOffset(CAPTURE_OFFSET_LIMIT_MS, 1, { shift: true, reset: false })).toBe(
      CAPTURE_OFFSET_LIMIT_MS,
    );
    expect(stepOffset(-CAPTURE_OFFSET_LIMIT_MS, -1, { shift: true, reset: false })).toBe(
      -CAPTURE_OFFSET_LIMIT_MS,
    );
  });
});
