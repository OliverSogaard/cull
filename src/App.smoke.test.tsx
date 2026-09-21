// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import App from "./App";
import { imageStore } from "./image/imageStore";
import { dialogOpen, frame, installDomStubs, invoke, setInvokeRouter } from "./test/tauriMocks";

/**
 * ONE path: start -> staged -> culling -> Enter -> the sidecar write.
 *
 * What only this test can prove: that the 63 props App hands `useCullKeymap`
 * are wired to the right callbacks. The hook harness
 * (useCullKeymap.test.tsx) proves the keymap's behaviour against a props
 * object the TEST builds; nothing else checks that App's object matches.
 *
 * Deliberately not a suite. Everything beyond this path duplicates the hook
 * harness at several times the flakiness — and if this one proves flaky in
 * three consecutive local runs, it is deleted rather than nursed (spec §3).
 *
 * De-flaking rules, all of them load-bearing:
 *  - `findBy*` / `waitFor` only. No sleeps, no fake timers: the phase
 *    transitions are promise chains, not clocks.
 *  - Every read frame is REAL, so no tier error is logged and no retry timer
 *    is armed. `meta: null` keeps the 100 ms MetaBatcher window unarmed, so
 *    nothing can update state after the test ends.
 *  - `cull:helpSeen` is seeded: the first cull ever auto-shows the help
 *    overlay (App.tsx:174-184), which would swallow the Enter.
 */

vi.mock("@tauri-apps/api/core", async () => (await import("./test/tauriMocks")).coreMock());
vi.mock("@tauri-apps/api/event", async () => (await import("./test/tauriMocks")).eventMock());
vi.mock("@tauri-apps/api/window", async () => (await import("./test/tauriMocks")).windowMock());
vi.mock("@tauri-apps/plugin-dialog", async () => (await import("./test/tauriMocks")).dialogMock());

const FOLDER = "/shoot";
const PATHS = [`${FOLDER}/a.CR3`, `${FOLDER}/b.CR3`];

const origCreate = globalThis.URL.createObjectURL;
const origRevoke = globalThis.URL.revokeObjectURL;
// jsdom never defined this one, so the saved value is `undefined` — putting it
// back is still the honest restore, and it keeps the kit's stub from leaking.
const origDecode = HTMLImageElement.prototype.decode;

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("cull:helpSeen", "1");
  installDomStubs();
  invoke.mockClear();
  dialogOpen.mockClear();
  dialogOpen.mockResolvedValue([FOLDER]);
  setInvokeRouter((cmd) => {
    switch (cmd) {
      case "scan_folder":
        return { paths: PATHS, ignored: 0 };
      case "analyze_folder":
        return {
          order: [0, 1],
          ratings: [null, null],
          lrcRatings: [null, null],
          unreadableDirs: [],
          restoreErrors: [],
          restoreErrorCount: 0,
        };
      case "extract_thumbnail":
        return frame({ width: 60, height: 40, jpegLen: 2, meta: null }, 2);
      case "read_preview":
        return frame({ meta: null, previewLen: 2 }, 2);
      case "read_grid_thumb":
        return frame({ gridLen: 2, width: 60, height: 40 }, 2);
      case "read_mid":
        return frame({ midLen: 2, width: 60, height: 40 }, 2);
      case "read_fullres":
        return frame({ fullLen: 2 }, 2);
      case "analyze_quality":
        // NOT `undefined`. DEFAULT_SETTINGS has smartCulling AND
        // smartCullingOnOpen true, so reaching "culling" auto-starts the
        // analysis driver, whose chunk call is typed Promise<ImageScore[]>;
        // an undefined chunk fails and the driver re-arms a REAL 120 ms idle
        // retry (analysisDriver.ts) that would fire after the test ends.
        return [];
      default:
        // begin_session and set_io_profile (imageStore.ts:589 — pushBackend
        // sends them through a variable, and its `typeof window === "undefined"`
        // guard does NOT skip under jsdom), write_xmp_rating,
        // clear_xmp_rating, read_capture_times, generate_mid, path_exists…
        return undefined;
    }
  });
});

afterEach(() => {
  cleanup();
  imageStore.hardReset();
  vi.unstubAllGlobals();
  globalThis.URL.createObjectURL = origCreate;
  globalThis.URL.revokeObjectURL = origRevoke;
  HTMLImageElement.prototype.decode = origDecode;
});

describe("App, end to end on one path", () => {
  it("stages a folder, begins the cull, and Enter writes a keep sidecar", async () => {
    render(<App />);

    // Start screen. The button's accessible name includes its KeyCombo caps
    // ("Open foldersCtrlO"), so match loosely.
    fireEvent.click(await screen.findByRole("button", { name: /Open folders/ }));
    await waitFor(() => expect(dialogOpen).toHaveBeenCalledTimes(1));

    // Staged screen.
    const begin = await screen.findByRole("button", { name: "Begin culling →" });
    expect(invoke).toHaveBeenCalledWith("scan_folder", expect.objectContaining({ path: FOLDER }));
    fireEvent.click(begin);

    // Culling. The Rejects filter tab lives in the footer StatusBar, which
    // renders only past App.tsx:1517's `phase !== "culling"` return.
    await screen.findByRole("button", { name: "Rejects" });

    fireEvent.keyDown(window, { key: "Enter", bubbles: true, cancelable: true });
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("write_xmp_rating", {
        path: PATHS[0],
        rating: "keep",
      }),
    );
  });
});
