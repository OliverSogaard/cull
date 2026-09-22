// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import App from "./App";
import { imageStore } from "./image/imageStore";
import { DEFAULT_SETTINGS, SETTINGS_STORAGE_KEY } from "./types/settings";
import {
  dialogOpen,
  frame,
  installDomStubs,
  invoke,
  restoreDomStubs,
  setInvokeRouter,
} from "./test/tauriMocks";

/**
 * TWO paths, one per keymap shape: start -> staged -> culling -> a key -> the
 * sidecar write. The second only exists because `settings.starsAndLabels`
 * chooses between two meanings for the bare digit row, and which one App
 * selects is not something a hook harness can see.
 *
 * What only this test can prove: that the props App hands `useCullKeymap` are
 * wired to the right callbacks. The hook harness (useCullKeymap.test.tsx)
 * proves the keymap's behaviour against a props object the TEST builds;
 * nothing else checks that App's object matches.
 *
 * Deliberately not a suite beyond that. Everything else duplicates the hook
 * harness at several times the flakiness — and if these prove flaky in three
 * consecutive local runs, they are deleted rather than nursed (spec §3).
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
          labels: [null, null],
          unreadableDirs: [],
          restoreErrors: [],
          restoreErrorCount: 0,
        };
      // The two Phase 5A sidecar writes. Routed explicitly rather than left to
      // `default:` so this table says which commands the path may reach — the
      // kit's own router still throws on anything unrouted.
      case "write_xmp_star":
      case "write_xmp_label":
        return undefined;
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
  restoreDomStubs();
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

    // The off-proof, end to end: with `starsAndLabels` off (the default), the
    // bare digit row is still the FILTER row — `3` selects Keeps and writes
    // nothing. This is the one assertion that covers App's own wiring of the
    // two keymap shapes, rather than the hook harness's props object.
    fireEvent.keyDown(window, { key: "3", code: "Digit3", bubbles: true, cancelable: true });
    // `findByRole` alone only proves the tab EXISTS — StatusBar renders it in
    // every filter state, so a `3` that did nothing at all would leave this
    // green too. `is-active` is the actual claim: the press selected it.
    const keepsTab = await screen.findByRole("button", { name: "Keeps" });
    await waitFor(() => expect(keepsTab.className).toContain("is-active"));
    expect(invoke).not.toHaveBeenCalledWith("write_xmp_star", expect.anything());
  });

  it("with the setting on, undoing a star never clears a kept frame's verdict", async () => {
    // App.tsx:347's `marksRef` is the only thing the undo replay's
    // empty-sidecar sweep has to answer "is this frame empty now?" — nothing
    // else in the suite exercises it through a real undo. Dropping `ratings`
    // from that ref would make this sweep see no verdict either, and clear
    // one on a frame that is still a keep.
    localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ ...DEFAULT_SETTINGS, starsAndLabels: true }),
    );
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Open folders/ }));
    await waitFor(() => expect(dialogOpen).toHaveBeenCalledTimes(1));
    fireEvent.click(await screen.findByRole("button", { name: "Begin culling →" }));
    await screen.findByRole("button", { name: "Rejects" });

    fireEvent.keyDown(window, { key: "Enter", bubbles: true, cancelable: true });
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("write_xmp_rating", { path: PATHS[0], rating: "keep" }),
    );

    // A keep advances the cursor to the next frame — jump back to the one
    // that was just kept, so the star and the undo below land on the SAME
    // frame the verdict is on (Home is a synchronous jump, not the held-arrow
    // scrub, so no fake timers are needed).
    fireEvent.keyDown(window, { key: "Home", bubbles: true, cancelable: true });

    fireEvent.keyDown(window, { key: "3", code: "Digit3", bubbles: true, cancelable: true });
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("write_xmp_star", { path: PATHS[0], star: 3 }),
    );

    fireEvent.keyDown(window, { key: "z", ctrlKey: true, bubbles: true, cancelable: true });
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("write_xmp_star", { path: PATHS[0], star: null }),
    );

    expect(invoke).not.toHaveBeenCalledWith("clear_xmp_rating", expect.anything());
  });

  it("with the setting on, 3 stars the frame and 6 labels it red", async () => {
    // The stored settings are what App boots from, so the ON keymap is
    // selected before the first render — no mid-test toggle, no dialog.
    localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ ...DEFAULT_SETTINGS, starsAndLabels: true }),
    );
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Open folders/ }));
    await waitFor(() => expect(dialogOpen).toHaveBeenCalledTimes(1));
    fireEvent.click(await screen.findByRole("button", { name: "Begin culling →" }));
    await screen.findByRole("button", { name: "Rejects" });

    fireEvent.keyDown(window, { key: "3", code: "Digit3", bubbles: true, cancelable: true });
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("write_xmp_star", { path: PATHS[0], star: 3 }),
    );

    fireEvent.keyDown(window, { key: "6", code: "Digit6", bubbles: true, cancelable: true });
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("write_xmp_label", { path: PATHS[0], label: "red" }),
    );
  });
});
