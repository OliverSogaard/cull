// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { WindowControls } from "./WindowControls";

/**
 * WindowControls is the reason nothing has ever mounted <App/>. It called
 * `getCurrentWindow()` in its RENDER BODY into a local the render never used
 * (the effect below calls it again), so the component threw without
 * `__TAURI_INTERNALS__`. Deleting that local is NOT enough: the effect's own
 * `const w = getCurrentWindow()` sits OUTSIDE its try/catch, and under jsdom
 * `isMac` is false, so the effect runs and its throw propagates out of
 * render() all the same. Both calls have to go.
 *
 * Deliberately NO Tauri mock in this file: mocking it would prove nothing.
 */
afterEach(cleanup);

describe("WindowControls", () => {
  it("renders every caption button without the Tauri global, and without throwing", () => {
    // jsdom's UA is win32, so `isMac` is false and all four render: the
    // settings gear plus minimize / maximize / close.
    const { container } = render(<WindowControls onSettings={() => {}} />);
    expect(container.querySelector(".cull-wincontrols")).not.toBeNull();
    expect(container.querySelectorAll("button")).toHaveLength(4);
  });

  it("omits the settings gear when no handler is supplied", () => {
    const { container } = render(<WindowControls />);
    expect(container.querySelectorAll("button")).toHaveLength(3);
  });
});
