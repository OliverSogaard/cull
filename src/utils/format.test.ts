import { describe, expect, it } from "vitest";
import {
  formatDimensions,
  formatDrive,
  formatExposureBias,
  formatFileSize,
  formatShutter,
  formatWhiteBalance,
} from "./format";

describe("formatShutter", () => {
  it("formats fast shutters as 1/X", () => {
    expect(formatShutter(1 / 250)).toBe("1/250s");
    expect(formatShutter(1 / 8000)).toBe("1/8000s");
  });

  it("formats long exposures with one decimal", () => {
    expect(formatShutter(1)).toBe("1.0s");
    expect(formatShutter(1.6)).toBe("1.6s");
    expect(formatShutter(30)).toBe("30.0s");
  });

  it("returns null for missing or invalid", () => {
    expect(formatShutter(null)).toBeNull();
    expect(formatShutter(0)).toBeNull();
    expect(formatShutter(-0.001)).toBeNull();
  });
});

describe("formatExposureBias", () => {
  it("shows ±0 EV near zero", () => {
    expect(formatExposureBias(0)).toBe("±0 EV");
    expect(formatExposureBias(0.03)).toBe("±0 EV");
    expect(formatExposureBias(-0.04)).toBe("±0 EV");
  });

  it("signs non-zero values", () => {
    expect(formatExposureBias(0.7)).toBe("+0.7 EV");
    expect(formatExposureBias(-1.3)).toBe("-1.3 EV");
  });

  it("returns null when missing", () => {
    expect(formatExposureBias(null)).toBeNull();
  });
});

describe("formatWhiteBalance", () => {
  it("maps Canon WB enum", () => {
    expect(formatWhiteBalance(0)).toBe("AWB");
    expect(formatWhiteBalance(1)).toBe("WB manual");
  });

  it("returns null for unknown enum values and missing", () => {
    expect(formatWhiteBalance(2)).toBeNull();
    expect(formatWhiteBalance(null)).toBeNull();
  });
});

describe("formatDrive", () => {
  it("maps Canon single-shot enum values", () => {
    for (const v of [0, 6, 9]) expect(formatDrive(v)).toBe("single");
  });

  it("maps Canon continuous-shot enum values", () => {
    for (const v of [1, 3, 4, 5, 8, 10]) expect(formatDrive(v)).toBe("continuous");
  });

  it("returns null for unknown enum values and missing", () => {
    expect(formatDrive(2)).toBeNull();
    expect(formatDrive(99)).toBeNull();
    expect(formatDrive(null)).toBeNull();
  });
});

describe("formatDimensions", () => {
  it("formats WxH and megapixels", () => {
    expect(formatDimensions(6000, 4000)).toBe("6000 × 4000 · 24 MP");
    expect(formatDimensions(1620, 1080)).toBe("1620 × 1080 · 2 MP");
  });

  it("returns null when either is missing or zero", () => {
    expect(formatDimensions(null, 1000)).toBeNull();
    expect(formatDimensions(1000, null)).toBeNull();
    expect(formatDimensions(0, 1000)).toBeNull();
  });
});

describe("formatFileSize", () => {
  it("shows one decimal under 100 MB", () => {
    expect(formatFileSize(12 * 1048576)).toBe("12.0 MB");
    expect(formatFileSize(99 * 1048576)).toBe("99.0 MB");
  });

  it("drops the decimal at 100 MB and above", () => {
    expect(formatFileSize(100 * 1048576)).toBe("100 MB");
    expect(formatFileSize(134 * 1048576)).toBe("134 MB");
  });

  it("returns null for null, zero, or negative bytes", () => {
    expect(formatFileSize(null)).toBeNull();
    expect(formatFileSize(0)).toBeNull();
    expect(formatFileSize(-1)).toBeNull();
  });
});
