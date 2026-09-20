// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { KeyCombo } from "./KeyCombo";

afterEach(cleanup);

describe("KeyCombo", () => {
  test("renders each key as its own keycap, the modifier spelled for the platform", () => {
    const { container } = render(<KeyCombo keys={["mod", "O"]} mod="Ctrl" />);
    const caps = [...container.querySelectorAll("kbd")].map((k) => k.textContent);
    expect(caps).toEqual(["Ctrl", "O"]);
  });
  test("passes a class to every keycap and keeps the combo on one line", () => {
    const { container } = render(<KeyCombo keys={["mod", ","]} mod="⌘" className="kbd--tint" />);
    expect(container.querySelectorAll("kbd.kbd.kbd--tint")).toHaveLength(2);
    expect(container.firstElementChild?.className).toContain("keycombo");
  });
});
