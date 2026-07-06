import { describe, expect, it } from "vitest";
import { passesFilter } from "./filter";

describe("passesFilter", () => {
  it("all admits everything", () => {
    expect(passesFilter(undefined, "all")).toBe(true);
    expect(passesFilter("keep", "all")).toBe(true);
    expect(passesFilter("reject", "all")).toBe(true);
    expect(passesFilter("favorite", "all")).toBe(true);
  });

  it("unrated only admits no rating", () => {
    expect(passesFilter(undefined, "unrated")).toBe(true);
    expect(passesFilter("keep", "unrated")).toBe(false);
    expect(passesFilter("favorite", "unrated")).toBe(false);
    expect(passesFilter("reject", "unrated")).toBe(false);
  });

  it("keeps admits keep AND favorite (favorites are also keeps)", () => {
    expect(passesFilter("keep", "keeps")).toBe(true);
    expect(passesFilter("favorite", "keeps")).toBe(true);
    expect(passesFilter("reject", "keeps")).toBe(false);
    expect(passesFilter(undefined, "keeps")).toBe(false);
  });

  it("keepsFavs only admits favorite (strict subset of keeps)", () => {
    expect(passesFilter("favorite", "keepsFavs")).toBe(true);
    expect(passesFilter("keep", "keepsFavs")).toBe(false);
    expect(passesFilter("reject", "keepsFavs")).toBe(false);
    expect(passesFilter(undefined, "keepsFavs")).toBe(false);
  });
});

describe("suggested filter family fallback", () => {
  // App.tsx special-cases every "suggested*" value BEFORE passesFilter (it
  // needs the live suggestions map); the pure fallback mirrors "unrated" so a
  // stray call can never hide rated frames' state or crash the switch.
  it("treats suggested as unrated-only at the pure level", () => {
    expect(passesFilter(undefined, "suggested")).toBe(true);
    expect(passesFilter("keep", "suggested")).toBe(false);
    expect(passesFilter("reject", "suggested")).toBe(false);
  });

  it("treats every smart sub-mode as unrated-only at the pure level", () => {
    for (const f of ["suggestedRejects", "suggestedKeeps", "suggestedFavs"] as const) {
      expect(passesFilter(undefined, f)).toBe(true);
      expect(passesFilter("keep", f)).toBe(false);
      expect(passesFilter("reject", f)).toBe(false);
      expect(passesFilter("favorite", f)).toBe(false);
    }
  });
});
