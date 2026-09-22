// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { HelpOverlay } from "./HelpOverlay";
import { modLabel } from "../utils/platform";

afterEach(cleanup);

const caps = (root: HTMLElement): string[] =>
  [...root.querySelectorAll("kbd")].map((k) => k.textContent ?? "");

const rowFor = (container: HTMLElement, desc: string): HTMLElement => {
  const row = [...container.querySelectorAll<HTMLElement>(".cull-help__row")].find((r) =>
    r.querySelector(".cull-help__desc")?.textContent?.startsWith(desc),
  );
  if (!row) throw new Error(`no help row described "${desc}"`);
  return row;
};

describe("the help sheet draws keycaps", () => {
  test("every shortcut is a keycap — no plain-text key column left", () => {
    const { container } = render(<HelpOverlay mode="loupe" />);
    for (const row of container.querySelectorAll<HTMLElement>(".cull-help__row")) {
      expect(row.querySelector("kbd"), row.textContent ?? "").not.toBeNull();
    }
  });

  test("the modifier is spelled for the platform, one cap per key", () => {
    const { container } = render(<HelpOverlay mode="loupe" />);
    expect(caps(rowFor(container, "Undo"))).toEqual([modLabel, "Z"]);
    expect(caps(rowFor(container, "Redo"))).toEqual([modLabel, "Shift", "Z"]);
  });

  test('"hold" is a muted word beside the caps, never inside one', () => {
    const { container } = render(<HelpOverlay mode="loupe" />);
    const row = rowFor(container, "This help");
    expect(caps(row)).toEqual(["Tab"]);
    expect(row.querySelector(".cull-help__hold")?.textContent).toBe("hold");
  });

  test("a range is two caps with a muted en dash between them", () => {
    const { container } = render(<HelpOverlay mode="loupe" />);
    const row = rowFor(container, "Filter:");
    expect(caps(row)).toEqual(["1", "5"]);
    expect(row.querySelector(".cull-help__range")?.textContent).toBe("–");
  });

  test("the grid group teaches the new size keys", () => {
    const { container } = render(<HelpOverlay mode="grid" />);
    expect(caps(rowFor(container, "Bigger / smaller cells"))).toEqual(["+", "−"]);
    expect(caps(rowFor(container, "Medium cells"))).toEqual([modLabel, "0"]);
  });

  test("the five-cap row still shows all five, in order, across two combos", () => {
    // Split so the 132px key column can wrap (one nowrap combo would bleed
    // into the description) — the caps and their order must not change.
    const { container } = render(<HelpOverlay mode="grid" />);
    const row = rowFor(container, "Grow selection");
    expect(caps(row)).toEqual(["Shift", "←", "→", "↑", "↓"]);
    expect(row.querySelectorAll(".keycombo")).toHaveLength(2);
  });

  test("the loupe teaches the new jump keys", () => {
    const { container } = render(<HelpOverlay mode="loupe" />);
    expect(caps(rowFor(container, "First / last"))).toEqual(["Home", "End"]);
    expect(caps(rowFor(container, "Jump one strip"))).toEqual(["PgUp", "PgDn"]);
  });

  test("the grid teaches the screenful and both extend forms", () => {
    const { container } = render(<HelpOverlay mode="grid" />);
    expect(caps(rowFor(container, "First / last"))).toEqual(["Home", "End"]);
    expect(caps(rowFor(container, "One screen"))).toEqual(["PgUp", "PgDn"]);
    expect(caps(rowFor(container, "Extend selection to edge"))).toEqual(["Shift", "Home", "End"]);
    expect(caps(rowFor(container, "Extend selection one screen"))).toEqual([
      "Shift",
      "PgUp",
      "PgDn",
    ]);
  });

  test("compare gets the page keys only — Home / End are loupe and grid", () => {
    const { container } = render(<HelpOverlay mode="compare" />);
    expect(caps(rowFor(container, "Jump one strip"))).toEqual(["PgUp", "PgDn"]);
    expect(() => rowFor(container, "First / last")).toThrow();
  });
});

/**
 * The help sheet is the reference for the keymap, so it has to show the shape
 * the setting actually selects. With the layer off every row is byte-identical
 * to what it has always been (the suite above is that proof).
 */
describe("the help sheet follows the stars-and-labels setting", () => {
  test("the filter row moves onto Shift, both caps carrying the modifier", () => {
    const { container } = render(<HelpOverlay mode="loupe" starsAndLabels />);
    const row = rowFor(container, "Filter:");
    expect(caps(row)).toEqual(["Shift", "1", "Shift", "5"]);
    expect(row.querySelector(".cull-help__range")?.textContent).toBe("–");
  });

  test("the grid's filter row moves too", () => {
    const { container } = render(<HelpOverlay mode="grid" starsAndLabels />);
    expect(caps(rowFor(container, "Filter:"))).toEqual(["Shift", "1", "Shift", "5"]);
  });

  test("loupe and grid gain the star and label rows", () => {
    for (const mode of ["loupe", "grid"] as const) {
      const { container } = render(<HelpOverlay mode={mode} starsAndLabels />);
      expect(caps(rowFor(container, "Stars"))).toEqual(["1", "5"]);
      expect(caps(rowFor(container, "Clear the stars"))).toEqual(["0"]);
      expect(caps(rowFor(container, "Colour label"))).toEqual(["6", "9"]);
      expect(caps(rowFor(container, "Purple label"))).toEqual(["Shift", "6"]);
      cleanup();
    }
  });

  test("both label rows say a re-press clears them, like the README does", () => {
    const { container } = render(<HelpOverlay mode="loupe" starsAndLabels />);
    expect(rowFor(container, "Colour label").querySelector(".cull-help__desc")?.textContent).toBe(
      "Colour label: red / yellow / green / blue (re-press clears)",
    );
    expect(rowFor(container, "Purple label").querySelector(".cull-help__desc")?.textContent).toBe(
      "Purple label (re-press clears)",
    );
  });

  test("compare gains nothing — the digits are unbound there", () => {
    const { container } = render(<HelpOverlay mode="compare" starsAndLabels />);
    expect(() => rowFor(container, "Stars")).toThrow();
    expect(() => rowFor(container, "Colour label")).toThrow();
  });

  test("with the layer off there is no mark group at all", () => {
    const { container } = render(<HelpOverlay mode="loupe" />);
    expect(() => rowFor(container, "Stars")).toThrow();
    expect(() => rowFor(container, "Clear the stars")).toThrow();
  });
});
