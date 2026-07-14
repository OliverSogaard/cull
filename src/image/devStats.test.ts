import { describe, expect, test } from "vitest";
import { DevStats } from "./devStats";

describe("DevStats", () => {
  test("nav timing names survive mixed-separator paths", () => {
    // The old inline double-slice applied an index computed on the ORIGINAL
    // path to the already-sliced string, mangling "C:/a\\b.CR3" into "CR3".
    const s = new DevStats();
    s.noteNavTiming("C:/shoots\\IMG_0001.CR3", 42);
    s.noteNavTiming("C:\\shoots\\IMG_0002.CR3", 10);
    s.noteNavTiming("/mnt/nas/IMG_0003.CR3", 7);
    expect(s.navTimings.map((t) => t.name)).toEqual([
      "IMG_0003.CR3",
      "IMG_0002.CR3",
      "IMG_0001.CR3",
    ]);
  });

  test("timing rings cap at 20, newest first, rounded ms", () => {
    const s = new DevStats();
    for (let i = 1; i <= 25; i++) s.noteNavTiming(`/x/img_${i}.CR3`, i + 0.4);
    expect(s.navTimings).toHaveLength(20);
    expect(s.navTimings[0]).toEqual({ name: "img_25.CR3", ms: 25 });
    expect(s.navTimings[19]).toEqual({ name: "img_6.CR3", ms: 6 });
    // navLoads counts every note, not just the retained ring entries.
    expect(s.counts.navLoads).toBe(25);
  });

  test("zoom timings ring independently and do not touch navLoads", () => {
    const s = new DevStats();
    s.noteZoomTiming("/x/a.CR3", 99.6);
    expect(s.zoomTimings).toEqual([{ name: "a.CR3", ms: 100 }]);
    expect(s.counts.navLoads).toBe(0);
  });

  test("navMsAvg averages the ring and clearTimings keeps counts", () => {
    const s = new DevStats();
    expect(s.navMsAvg()).toBe(0);
    s.noteNavTiming("/x/a.CR3", 10);
    s.noteNavTiming("/x/b.CR3", 21);
    expect(s.navMsAvg()).toBe(16); // round((10+21)/2)
    s.clearTimings();
    expect(s.navTimings).toHaveLength(0);
    expect(s.zoomTimings).toHaveLength(0);
    expect(s.counts.navLoads).toBe(2);
    expect(s.navMsAvg()).toBe(0);
  });
});
