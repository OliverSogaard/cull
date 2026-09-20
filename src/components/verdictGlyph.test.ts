import { describe, expect, it } from "vitest";
import { ghostTitle } from "./verdictGlyph";
import type { Suggestion } from "../smart/deriveVerdict";

const sug = (over: Partial<Suggestion>): Suggestion => ({
  verdict: "reject",
  confidence: 0.82,
  reasons: ["soft focus"],
  ...over,
});

describe("ghostTitle — hover explanation for a ghost suggestion dot", () => {
  it("names the verdict, rounds the confidence, joins the reasons", () => {
    expect(ghostTitle(sug({}))).toBe("Suggested reject · 82% · soft focus");
    expect(
      ghostTitle(sug({ verdict: "keep", confidence: 0.651, reasons: ["sharp, well exposed"] })),
    ).toBe("Suggested keep · 65% · sharp, well exposed");
    expect(
      ghostTitle(
        sug({ verdict: "favorite", confidence: 0.9, reasons: ["standout aesthetic", "sharp"] }),
      ),
    ).toBe("Suggested favorite · 90% · standout aesthetic, sharp");
  });

  it("drops the reasons segment when there are none", () => {
    expect(ghostTitle(sug({ reasons: [] }))).toBe("Suggested reject · 82%");
  });
});
