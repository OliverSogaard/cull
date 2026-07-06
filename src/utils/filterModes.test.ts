import { describe, expect, it } from "vitest";
import { cycleFilter, topOf } from "./filterModes";

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
});
