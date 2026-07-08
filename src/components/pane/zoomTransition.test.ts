import { describe, expect, test } from "vitest";
import { zoomTransition } from "./zoomTransition";

describe("zoomTransition", () => {
  test("engaging uses the longer slow-start curve (departure stays visible)", () => {
    expect(zoomTransition(true)).toBe("transform 300ms cubic-bezier(0.4, 0, 0.2, 1)");
  });

  test("releasing decelerates into the fit view with the ease-out curve", () => {
    expect(zoomTransition(false)).toBe("transform 200ms ease-out");
  });

  test("the two directions never share a curve (layers can't tear apart)", () => {
    expect(zoomTransition(true)).not.toBe(zoomTransition(false));
  });
});
