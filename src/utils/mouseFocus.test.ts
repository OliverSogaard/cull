// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { mousePressMovesFocus } from "./mouseFocus";

/**
 * A mouse click on a chrome button must not park keyboard focus there: the
 * next key press would light the focus ring on it and nothing the keys do
 * ever moves it away. Dialog controls and text fields keep the default.
 */

afterEach(() => {
  document.body.innerHTML = "";
});

function mount(html: string): Element {
  document.body.innerHTML = html;
  const el = document.body.querySelector("[data-hit]");
  if (!el) throw new Error("no [data-hit] in fixture");
  return el;
}

describe("mousePressMovesFocus", () => {
  it("refuses a chrome button, including a press on its inner glyph", () => {
    expect(mousePressMovesFocus(mount('<button data-hit type="button">i</button>'))).toBe(false);
    expect(mousePressMovesFocus(mount('<button type="button"><svg data-hit></svg></button>'))).toBe(
      false,
    );
  });

  it("lets a button inside a dialog take focus (focus trap, armed confirms)", () => {
    expect(
      mousePressMovesFocus(
        mount('<div role="dialog"><button data-hit type="button">Reset</button></div>'),
      ),
    ).toBe(true);
    expect(
      mousePressMovesFocus(
        mount('<div class="dialog"><button data-hit type="button">Leave</button></div>'),
      ),
    ).toBe(true);
  });

  it("never interferes with text fields or with anything that is not a button", () => {
    expect(mousePressMovesFocus(mount('<input data-hit type="text" />'))).toBe(true);
    expect(mousePressMovesFocus(mount('<div data-hit class="cull-image-area"></div>'))).toBe(true);
    expect(mousePressMovesFocus(null)).toBe(true);
  });
});
