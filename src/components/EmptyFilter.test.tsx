// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { EmptyFilter } from "./EmptyFilter";

/**
 * The empty screens are the one place that TELLS the user which key gets them
 * back to All, so their digits must follow the stars-and-labels setting. With
 * the layer off every hint is the bare `<kbd>` it has always been.
 *
 * The seven screens carry eight digit hints between them (seven "for all",
 * plus "to analyze" on the manual one). The Settings combo on the smart-off
 * screen is not a filter key and never moves.
 */

afterEach(cleanup);

/** The seven empty screens that carry a key hint, keyed by what selects them. */
const SCREENS: Record<string, Parameters<typeof EmptyFilter>[0]> = {
  "smart off": { filter: "suggested", smartCulling: false },
  analyzing: { filter: "suggested", smartCulling: true, analyzing: true },
  "analyzed, nothing to say": { filter: "suggested", smartCulling: true, scoredCount: 12 },
  "not analyzed, self-starting": {
    filter: "suggested",
    smartCulling: true,
    smartCullingOnOpen: true,
  },
  "not analyzed, manual": { filter: "suggested", smartCulling: true, smartCullingOnOpen: false },
  "no rejects": { filter: "rejects" },
  "no keeps": { filter: "keeps" },
};

/** Every keycap each screen draws, in DOM order. */
function capsPerScreen(starsAndLabels: boolean): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [name, props] of Object.entries(SCREENS)) {
    const { container } = render(<EmptyFilter {...props} starsAndLabels={starsAndLabels} />);
    out[name] = [...container.querySelectorAll("kbd")].map((k) => k.textContent ?? "");
    cleanup();
  }
  return out;
}

describe("the empty screens' key hints follow the stars-and-labels setting", () => {
  it("names the bare digits with the layer off", () => {
    expect(capsPerScreen(false)).toEqual({
      "smart off": ["Ctrl", ",", "1"],
      analyzing: ["1"],
      "analyzed, nothing to say": ["1"],
      "not analyzed, self-starting": ["1"],
      "not analyzed, manual": ["4", "1"],
      "no rejects": ["1"],
      "no keeps": ["1"],
    });
  });

  it("moves all eight onto Shift with the layer on, leaving Settings alone", () => {
    expect(capsPerScreen(true)).toEqual({
      "smart off": ["Ctrl", ",", "Shift", "1"],
      analyzing: ["Shift", "1"],
      "analyzed, nothing to say": ["Shift", "1"],
      "not analyzed, self-starting": ["Shift", "1"],
      "not analyzed, manual": ["Shift", "4", "Shift", "1"],
      "no rejects": ["Shift", "1"],
      "no keeps": ["Shift", "1"],
    });
  });
});
