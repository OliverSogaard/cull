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
