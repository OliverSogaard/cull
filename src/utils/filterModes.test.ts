import { describe, expect, it } from "vitest";
import { cycleFilter, FILTER_DIGIT, filterKeyHint, topOf, type TopFilter } from "./filterModes";

describe("topOf", () => {
  it("maps base filters to themselves", () => {
    expect(topOf("all")).toBe("all");
    expect(topOf("unrated")).toBe("unrated");
    expect(topOf("keeps")).toBe("keeps");
    expect(topOf("suggested")).toBe("suggested");
  });

  it("maps keeps sub-mode back to keeps", () => {
    expect(topOf("keepsFavs")).toBe("keeps");
  });

  it("maps every smart sub-mode back to suggested", () => {
    expect(topOf("suggestedRejects")).toBe("suggested");
    expect(topOf("suggestedKeeps")).toBe("suggested");
    expect(topOf("suggestedFavs")).toBe("suggested");
  });

  it("maps rejects to itself — it has no sub-modes", () => {
    expect(topOf("rejects")).toBe("rejects");
  });
});

describe("cycleFilter", () => {
  it("activating an inactive top selects its base mode", () => {
    expect(cycleFilter("all", "keeps")).toBe("keeps");
    expect(cycleFilter("unrated", "suggested")).toBe("suggested");
    expect(cycleFilter("keepsFavs", "unrated")).toBe("unrated");
  });

  it("switching tops always lands on the base mode, never a stale sub-mode", () => {
    // Coming from a Smart sub-mode into Keeps must NOT land on keepsFavs.
    expect(cycleFilter("suggestedFavs", "keeps")).toBe("keeps");
    // Coming from Keeps·★ into Smart must NOT land on a smart sub-mode.
    expect(cycleFilter("keepsFavs", "suggested")).toBe("suggested");
  });

  it("re-activating the active top with no sub-modes is a no-op", () => {
    expect(cycleFilter("all", "all")).toBe("all");
    expect(cycleFilter("unrated", "unrated")).toBe("unrated");
  });

  it("re-activating Keeps cycles base -> favs -> wraps to base", () => {
    expect(cycleFilter("keeps", "keeps")).toBe("keepsFavs");
    expect(cycleFilter("keepsFavs", "keeps")).toBe("keeps");
  });

  it("re-activating Smart cycles base -> rejects -> keeps -> favs -> wraps to base", () => {
    expect(cycleFilter("suggested", "suggested")).toBe("suggestedRejects");
    expect(cycleFilter("suggestedRejects", "suggested")).toBe("suggestedKeeps");
    expect(cycleFilter("suggestedKeeps", "suggested")).toBe("suggestedFavs");
    expect(cycleFilter("suggestedFavs", "suggested")).toBe("suggested");
  });

  it("re-activating Rejects is a no-op, like All and Unrated", () => {
    expect(cycleFilter("rejects", "rejects")).toBe("rejects");
  });

  it("switching into and out of Rejects always lands on a base mode", () => {
    expect(cycleFilter("keepsFavs", "rejects")).toBe("rejects");
    expect(cycleFilter("rejects", "keeps")).toBe("keeps");
    expect(cycleFilter("rejects", "suggested")).toBe("suggested");
  });
});

describe("filterKeyHint", () => {
  it("names the bare digit while the stars-and-labels layer is off", () => {
    expect(filterKeyHint("all")).toBe("1");
    expect(filterKeyHint("unrated", false)).toBe("2");
    expect(filterKeyHint("keeps", false)).toBe("3");
    expect(filterKeyHint("suggested", false)).toBe("4");
    expect(filterKeyHint("rejects", false)).toBe("5");
  });

  it("moves every filter onto Shift once the digits are stars", () => {
    expect(filterKeyHint("all", true)).toBe("Shift+1");
    expect(filterKeyHint("unrated", true)).toBe("Shift+2");
    expect(filterKeyHint("keeps", true)).toBe("Shift+3");
    expect(filterKeyHint("suggested", true)).toBe("Shift+4");
    expect(filterKeyHint("rejects", true)).toBe("Shift+5");
  });

  it("agrees with the keymap about which digit selects which tab", () => {
    // The hint exists to stay honest about useCullKeymap's SHIFT_DIGIT table;
    // the five digits are 1..5 in tab order, both shapes.
    const tops: TopFilter[] = ["all", "unrated", "keeps", "suggested", "rejects"];
    expect(tops.map((t) => FILTER_DIGIT[t])).toEqual(["1", "2", "3", "4", "5"]);
  });
});
