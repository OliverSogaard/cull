import { describe, expect, it } from "vitest";
import {
  formatExposureBias,
  formatFolderSet,
  formatRelativeTime,
  formatShutter,
  formatWhiteBalance,
  middleTruncate,
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
    expect(formatShutter(NaN)).toBeNull();
    expect(formatShutter(Infinity)).toBeNull();
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

describe("formatRelativeTime", () => {
  const now = new Date("2026-05-31T12:00:00Z");

  it("returns 'just now' under a minute", () => {
    expect(formatRelativeTime(new Date(now.getTime() - 10_000).toISOString(), now)).toBe("just now");
    expect(formatRelativeTime(new Date(now.getTime() - 59_000).toISOString(), now)).toBe("just now");
  });

  it("returns minutes ago under an hour", () => {
    expect(formatRelativeTime(new Date(now.getTime() - 60_000).toISOString(), now)).toBe(
      "1 minute ago",
    );
    expect(formatRelativeTime(new Date(now.getTime() - 30 * 60_000).toISOString(), now)).toBe(
      "30 minutes ago",
    );
  });

  it("returns hours ago under a day", () => {
    expect(
      formatRelativeTime(new Date(now.getTime() - 2 * 60 * 60_000).toISOString(), now),
    ).toBe("2 hours ago");
    expect(formatRelativeTime(new Date(now.getTime() - 60 * 60_000).toISOString(), now)).toBe(
      "1 hour ago",
    );
  });

  it("returns 'yesterday' between 24 and 48 hours", () => {
    expect(formatRelativeTime(new Date(now.getTime() - 25 * 3600_000).toISOString(), now)).toBe(
      "yesterday",
    );
  });

  it("returns days ago under a week", () => {
    expect(formatRelativeTime(new Date(now.getTime() - 3 * 86400_000).toISOString(), now)).toBe(
      "3 days ago",
    );
  });

  it("returns 'last week' at 1w and weeks ago up to 4w", () => {
    expect(formatRelativeTime(new Date(now.getTime() - 7 * 86400_000).toISOString(), now)).toBe(
      "last week",
    );
    expect(formatRelativeTime(new Date(now.getTime() - 21 * 86400_000).toISOString(), now)).toBe(
      "3 weeks ago",
    );
  });

  it("falls back to localized date past five weeks", () => {
    const long = new Date(now.getTime() - 365 * 86400_000).toISOString();
    const out = formatRelativeTime(long, now);
    expect(out).not.toBeNull();
    // localized form is locale-specific; we just check it's not one of the
    // relative buckets above.
    expect(out).not.toMatch(/(ago|yesterday|just now|last week)/i);
  });

  it("clamps future timestamps (clock skew) to 'just now'", () => {
    expect(formatRelativeTime(new Date(now.getTime() + 60_000).toISOString(), now)).toBe(
      "just now",
    );
  });

  it("returns null for unparseable input", () => {
    expect(formatRelativeTime("not-a-date", now)).toBeNull();
    expect(formatRelativeTime("", now)).toBeNull();
  });
});

describe("middleTruncate", () => {
  it("returns short inputs verbatim", () => {
    expect(middleTruncate("short", 20)).toBe("short");
    expect(middleTruncate("exactly20chars-aaaaa", 20)).toBe("exactly20chars-aaaaa");
  });

  it("places an ellipsis in the middle", () => {
    const out = middleTruncate("abcdefghijklmnopqrstuvwxyz", 10);
    expect(out).toContain("…");
    expect(out.length).toBe(10);
    expect(out.startsWith("a")).toBe(true);
    expect(out.endsWith("z")).toBe(true);
  });

  it("keeps both ends visible in a path-like string", () => {
    const path = "C:\\Shoots\\2026-05-28 Greg & Lou\\Day 2 Reception";
    const out = middleTruncate(path, 30);
    expect(out.length).toBe(30);
    expect(out.startsWith("C:\\")).toBe(true);
    // the tail must contain the final word — middle-truncation keeps
    // ceil((max-1)/2) head + floor((max-1)/2) tail chars.
    expect(out).toContain("Reception");
    expect(out).toContain("…");
  });
});

describe("formatFolderSet", () => {
  it("shows a single folder as its bare name", () => {
    expect(formatFolderSet(["C:\\Shoots\\wedding-d1"])).toBe("wedding-d1");
    expect(formatFolderSet(["/home/o/shoots/wedding-d1"])).toBe("wedding-d1");
  });

  it("middle-truncates a single name that alone overflows", () => {
    const long = "C:\\Shoots\\" + "a".repeat(80);
    const out = formatFolderSet([long], 20);
    expect(out.length).toBeLessThanOrEqual(20);
    expect(out).toContain("…");
  });

  it("joins two names with ' + '", () => {
    expect(formatFolderSet(["C:\\S\\wedding-d1", "C:\\S\\wedding-d2"])).toBe(
      "wedding-d1 + wedding-d2",
    );
  });

  it("overflows to '+N more' instead of exceeding the budget", () => {
    const paths = ["C:\\S\\wedding-d1", "C:\\S\\wedding-d2", "C:\\S\\wedding-d3"];
    const out = formatFolderSet(paths, 24);
    expect(out.length).toBeLessThanOrEqual(24);
    expect(out).toBe("wedding-d1 +2 more");
  });

  it("always shows at least the first name, even on a tiny budget", () => {
    const out = formatFolderSet(["C:\\S\\wedding-d1", "C:\\S\\wedding-d2"], 8);
    expect(out).toContain("+1 more");
    expect(out.startsWith("w")).toBe(true);
  });

  it("fits as many names as the budget allows before counting the rest", () => {
    const paths = ["C:\\S\\aa", "C:\\S\\bb", "C:\\S\\cc", "C:\\S\\dd"];
    // "aa + bb + cc + dd" = 17 chars — fits in 17.
    expect(formatFolderSet(paths, 17)).toBe("aa + bb + cc + dd");
    // 16 can't fit all four, but "aa + bb + cc +1 more" needs 20 > 16,
    // so it backs off to "aa + bb +2 more" (15).
    expect(formatFolderSet(paths, 16)).toBe("aa + bb +2 more");
  });

  it("keeps duplicate basenames as-is", () => {
    expect(formatFolderSet(["C:\\D1\\RAW", "C:\\D2\\RAW"])).toBe("RAW + RAW");
  });

  it("middle-truncates an overlong FIRST name in the multi-folder branch", () => {
    const long = "C:\\Shoots\\" + "a".repeat(60);
    const out = formatFolderSet([long, "C:\\Shoots\\bb"], 30);
    expect(out.length).toBeLessThanOrEqual(30);
    expect(out).toContain("…");
    expect(out).toContain("+1 more");
  });

  it("returns empty string for an empty set", () => {
    expect(formatFolderSet([])).toBe("");
  });
});
