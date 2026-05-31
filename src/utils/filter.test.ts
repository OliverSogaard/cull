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

  it("favorites only admits favorite (strict subset of keeps)", () => {
    expect(passesFilter("favorite", "favorites")).toBe(true);
    expect(passesFilter("keep", "favorites")).toBe(false);
    expect(passesFilter("reject", "favorites")).toBe(false);
    expect(passesFilter(undefined, "favorites")).toBe(false);
  });
});
