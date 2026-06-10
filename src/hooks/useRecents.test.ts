import { describe, expect, it } from "vitest";
import {
  mergeRecent,
  parseStoredRecents,
  recentKey,
  RECENTS_CAP,
  type RecentEntry,
} from "./useRecents";

function mk(overrides: Partial<RecentEntry> & { paths: string[] }): RecentEntry {
  return {
    paths: overrides.paths,
    count: overrides.count ?? 100,
    rated: overrides.rated ?? 0,
    lastOpened: overrides.lastOpened ?? new Date("2026-05-31T12:00:00Z").toISOString(),
    done: overrides.done ?? false,
  };
}

describe("recentKey", () => {
  it("is order-insensitive — [A,B] and [B,A] share a key", () => {
    expect(recentKey(["C:\\A", "C:\\B"])).toBe(recentKey(["C:\\B", "C:\\A"]));
  });

  it("distinguishes a set from its superset", () => {
    expect(recentKey(["C:\\A"])).not.toBe(recentKey(["C:\\A", "C:\\B"]));
  });

  it("never collides across different splits of the same characters", () => {
    // A naive joiner like "," would make ["a,b"] collide with ["a", "b"].
    expect(recentKey(["a,b"])).not.toBe(recentKey(["a", "b"]));
  });
});

describe("mergeRecent", () => {
  it("prepends a new entry on an empty list", () => {
    const out = mergeRecent([], mk({ paths: ["C:\\A"] }));
    expect(out).toHaveLength(1);
    expect(out[0].paths).toEqual(["C:\\A"]);
  });

  it("dedupes by folder set, keeping the new entry at the front", () => {
    const list = [mk({ paths: ["C:\\A"], count: 5 }), mk({ paths: ["C:\\B"] })];
    const out = mergeRecent(list, mk({ paths: ["C:\\B"], count: 12 }));
    expect(out.map((e) => e.paths)).toEqual([["C:\\B"], ["C:\\A"]]);
    expect(out[0].count).toBe(12);
  });

  it("dedupes order-insensitively — [A,B] replaces [B,A]", () => {
    const list = [mk({ paths: ["C:\\B", "C:\\A"], count: 5 })];
    const out = mergeRecent(list, mk({ paths: ["C:\\A", "C:\\B"], count: 12 }));
    expect(out).toHaveLength(1);
    expect(out[0].count).toBe(12);
  });

  it("keeps [A] and [A,B] as distinct entries", () => {
    const list = [mk({ paths: ["C:\\A"] })];
    const out = mergeRecent(list, mk({ paths: ["C:\\A", "C:\\B"] }));
    expect(out).toHaveLength(2);
    expect(out[0].paths).toEqual(["C:\\A", "C:\\B"]);
    expect(out[1].paths).toEqual(["C:\\A"]);
  });

  it("replaces the stored count with the new entry's count, even 0", () => {
    // A re-scanned now-empty folder pushes count=0; that wins, so the row no
    // longer advertises a stale total for files that are gone.
    const list = [mk({ paths: ["C:\\A"], count: 372 })];
    const out = mergeRecent(list, mk({ paths: ["C:\\A"], count: 0 }));
    expect(out[0].count).toBe(0);
  });

  it("uses the new count when the new entry has a real count", () => {
    const list = [mk({ paths: ["C:\\A"], count: 100 })];
    const out = mergeRecent(list, mk({ paths: ["C:\\A"], count: 500 }));
    expect(out[0].count).toBe(500);
  });

  it("caps the list at RECENTS_CAP", () => {
    let list: RecentEntry[] = [];
    for (let i = 0; i < RECENTS_CAP + 3; i++) {
      list = mergeRecent(list, mk({ paths: [`C:\\Folder${i}`] }));
    }
    expect(list).toHaveLength(RECENTS_CAP);
    // most recent first
    expect(list[0].paths).toEqual([`C:\\Folder${RECENTS_CAP + 2}`]);
  });

  it("dedupes do NOT push out an unrelated entry", () => {
    const list = [
      mk({ paths: ["C:\\A"] }),
      mk({ paths: ["C:\\B"] }),
      mk({ paths: ["C:\\C"] }),
    ];
    const out = mergeRecent(list, mk({ paths: ["C:\\B"] }));
    expect(out).toHaveLength(3);
    expect(out.map((e) => e.paths)).toEqual([["C:\\B"], ["C:\\A"], ["C:\\C"]]);
  });
});

describe("parseStoredRecents", () => {
  const T = "2026-05-31T12:00:00.000Z";

  it("round-trips a v2 list", () => {
    const stored = [mk({ paths: ["C:\\A", "C:\\B"], count: 10, rated: 4 })];
    const out = parseStoredRecents(JSON.stringify(stored), null);
    expect(out).toEqual(stored);
  });

  it("migrates v1 entries by wrapping path into paths", () => {
    const v1 = [
      { path: "C:\\A", count: 372, rated: 327, lastOpened: T, done: false },
      { path: "C:\\B", count: 50, rated: 50, lastOpened: T, done: true },
    ];
    const out = parseStoredRecents(null, JSON.stringify(v1));
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ paths: ["C:\\A"], count: 372, rated: 327, lastOpened: T, done: false });
    expect(out[1]).toEqual({ paths: ["C:\\B"], count: 50, rated: 50, lastOpened: T, done: true });
  });

  it("prefers v2 over v1 when both exist", () => {
    const v2 = [mk({ paths: ["C:\\New"] })];
    const v1 = [{ path: "C:\\Old", count: 1, rated: 0, lastOpened: T, done: false }];
    const out = parseStoredRecents(JSON.stringify(v2), JSON.stringify(v1));
    expect(out.map((e) => e.paths)).toEqual([["C:\\New"]]);
  });

  it("drops malformed entries (missing paths, wrong types, empty paths)", () => {
    const stored = [
      mk({ paths: ["C:\\OK"] }),
      { count: 5, rated: 0, lastOpened: T, done: false }, // no paths
      { paths: "C:\\NotArray", count: 5, rated: 0, lastOpened: T, done: false },
      { paths: [], count: 5, rated: 0, lastOpened: T, done: false }, // empty set
      { paths: ["C:\\X", 7], count: 5, rated: 0, lastOpened: T, done: false }, // non-string member
      { paths: [""], count: 5, rated: 0, lastOpened: T, done: false }, // empty-string path
      { paths: ["C:\\Y", ""], count: 5, rated: 0, lastOpened: T, done: false }, // mixed empty
      { paths: ["C:\\NoTime"], count: 5, rated: 0, done: false }, // no lastOpened
      null,
      "garbage",
    ];
    const out = parseStoredRecents(JSON.stringify(stored), null);
    expect(out.map((e) => e.paths)).toEqual([["C:\\OK"]]);
  });

  it("returns [] for unparseable or non-array JSON", () => {
    expect(parseStoredRecents("not json", null)).toEqual([]);
    expect(parseStoredRecents('{"a":1}', null)).toEqual([]);
    expect(parseStoredRecents(null, "not json")).toEqual([]);
    expect(parseStoredRecents(null, null)).toEqual([]);
  });

  it("dedupes paths within an entry", () => {
    const stored = [mk({ paths: ["C:\\A", "C:\\A", "C:\\B"] })];
    const out = parseStoredRecents(JSON.stringify(stored), null);
    expect(out[0].paths).toEqual(["C:\\A", "C:\\B"]);
  });

  it("clamps rated to count and gates done on fully-rated", () => {
    const stored = [
      { paths: ["C:\\A"], count: 100, rated: 500, lastOpened: T, done: true },
      { paths: ["C:\\B"], count: 0, rated: 0, lastOpened: T, done: true },
      { paths: ["C:\\C"], count: -5, rated: -3, lastOpened: T, done: false },
    ];
    const out = parseStoredRecents(JSON.stringify(stored), null);
    expect(out[0]).toMatchObject({ count: 100, rated: 100, done: true });
    expect(out[1]).toMatchObject({ count: 0, rated: 0, done: false });
    expect(out[2]).toMatchObject({ count: 0, rated: 0, done: false });
  });

  it("caps the loaded list at RECENTS_CAP", () => {
    const stored = Array.from({ length: RECENTS_CAP + 4 }, (_, i) =>
      mk({ paths: [`C:\\F${i}`] }),
    );
    const out = parseStoredRecents(JSON.stringify(stored), null);
    expect(out).toHaveLength(RECENTS_CAP);
  });
});
