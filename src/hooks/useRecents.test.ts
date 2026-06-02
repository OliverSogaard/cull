import { describe, expect, it } from "vitest";
import { mergeRecent, RECENTS_CAP, type RecentEntry } from "./useRecents";

function mk(overrides: Partial<RecentEntry> & { path: string }): RecentEntry {
  return {
    path: overrides.path,
    count: overrides.count ?? 100,
    rated: overrides.rated ?? 0,
    lastOpened: overrides.lastOpened ?? new Date("2026-05-31T12:00:00Z").toISOString(),
    done: overrides.done ?? false,
  };
}

describe("mergeRecent", () => {
  it("prepends a new entry on an empty list", () => {
    const out = mergeRecent([], mk({ path: "C:\\A" }));
    expect(out).toHaveLength(1);
    expect(out[0].path).toBe("C:\\A");
  });

  it("dedupes by path, keeping the new entry at the front", () => {
    const list = [mk({ path: "C:\\A", count: 5 }), mk({ path: "C:\\B" })];
    const out = mergeRecent(list, mk({ path: "C:\\B", count: 12 }));
    expect(out.map((e) => e.path)).toEqual(["C:\\B", "C:\\A"]);
    expect(out[0].count).toBe(12);
  });

  it("preserves the larger known count when the new entry has count=0", () => {
    // mid-scan re-open: caller may push a stub before scan_folder resolves.
    const list = [mk({ path: "C:\\A", count: 372 })];
    const out = mergeRecent(list, mk({ path: "C:\\A", count: 0 }));
    expect(out[0].count).toBe(372);
  });

  it("uses the new count when the new entry has a real count", () => {
    const list = [mk({ path: "C:\\A", count: 100 })];
    const out = mergeRecent(list, mk({ path: "C:\\A", count: 500 }));
    expect(out[0].count).toBe(500);
  });

  it("caps the list at RECENTS_CAP", () => {
    let list: RecentEntry[] = [];
    for (let i = 0; i < RECENTS_CAP + 3; i++) {
      list = mergeRecent(list, mk({ path: `C:\\Folder${i}` }));
    }
    expect(list).toHaveLength(RECENTS_CAP);
    // most recent first
    expect(list[0].path).toBe(`C:\\Folder${RECENTS_CAP + 2}`);
  });

  it("dedupes do NOT push out an unrelated entry", () => {
    const list = [
      mk({ path: "C:\\A" }),
      mk({ path: "C:\\B" }),
      mk({ path: "C:\\C" }),
    ];
    const out = mergeRecent(list, mk({ path: "C:\\B" }));
    expect(out).toHaveLength(3);
    expect(out.map((e) => e.path)).toEqual(["C:\\B", "C:\\A", "C:\\C"]);
  });
});
