// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { cleanup, renderHook } from "@testing-library/react";
import type { Filter, Img, NavSite, Rating } from "../types";
import { DEFAULT_SETTINGS } from "../types/settings";
import { cycleFilter } from "../utils/filterModes";
import { useCullKeymap } from "./useCullKeymap";

/**
 * The cull keymap, exercised as shipped: all three of its `window` listeners
 * (the phase-agnostic chrome effect, the big cull keymap behind `cullKeyRef`,
 * and the capture-phase Escape swallow) under `renderHook`, with a typed
 * props factory derived from the hook's OWN props type.
 *
 * Three mechanics that make such tests lie if you get them wrong:
 *  1. A KeyboardEvent must be `cancelable: true`, or `preventDefault()` is a
 *     silent no-op and EVERY `defaultPrevented` assertion passes vacuously.
 *  2. Escape's `defaultPrevented` is ALWAYS true — a capture-phase listener
 *     (useCullKeymap.ts:839-845) preventDefaults it in every phase — so it
 *     proves nothing except in the one test that pins that listener.
 *  3. `afterEach(cleanup)` is load-bearing. Vitest runs without `globals`,
 *     so RTL's auto-cleanup never registers; an un-unmounted hook leaves its
 *     window listeners attached and the NEXT test's keypress fires this
 *     test's spies too.
 */

/** The hook's real props object — a 64th prop, or a rename, breaks this file
 *  at compile time instead of leaving it testing yesterday's shape. */
type KeymapProps = Parameters<typeof useCullKeymap>[0];

/** A `Dispatch<SetStateAction<T>>` spy. Typed explicitly because test files
 *  are linted type-aware and a bare `vi.fn()` is an implicit any here. */
function setter<T>(): Dispatch<SetStateAction<T>> {
  return vi.fn((_v: SetStateAction<T>) => {});
}

/** A ref stand-in: the hook only ever reads `.current`. */
function ref<T>(current: T): RefObject<T> {
  return { current };
}

const IMAGES: Img[] = [0, 1, 2].map((id) => ({
  id,
  path: `/s/${id}.cr3`,
  filename: `${id}.cr3`,
  srcFolder: "/s",
}));

function props(over: Partial<KeymapProps> = {}): KeymapProps {
  return {
    phase: "culling",
    images: IMAGES,
    settings: DEFAULT_SETTINGS,
    settingsOpen: false,
    setSettingsOpen: setter<boolean>(),
    pickFolder: vi.fn(() => Promise.resolve()),
    beginCulling: vi.fn(() => Promise.resolve()),
    resetSession: vi.fn(() => {}),
    quitGuard: false,
    setQuitGuard: setter<boolean>(),
    confirmHome: false,
    setConfirmHome: setter<boolean>(),
    leaveToHome: vi.fn(() => {}),
    actionsOpen: false,
    setActionsOpen: setter<boolean>(),
    openActions: vi.fn(() => {}),
    helpVisible: false,
    setHelpVisible: setter<boolean>(),
    setHelpIntro: setter<boolean>(),
    undo: vi.fn(() => {}),
    redo: vi.fn(() => {}),
    gridVisible: false,
    gridCols: 6,
    stepGridSizeBy: vi.fn((_dir: 1 | -1) => {}),
    resetGridSize: vi.fn(() => {}),
    advance: vi.fn((_dir: 1 | -1, _step?: number) => true),
    pageStep: vi.fn(() => 24),
    selectAllInGrid: vi.fn(() => {}),
    growGridSelection: vi.fn((_deltaCells: number) => {}),
    clearMultiSelection: vi.fn(() => {}),
    hasGridSelection: false,
    heldDirRef: ref<0 | 1 | -1>(0),
    startHold: vi.fn((_dir: 1 | -1) => {}),
    stopHold: vi.fn(() => {}),
    heldGridVertDirRef: ref<0 | 1 | -1>(0),
    startGridVertHold: vi.fn((_dir: 1 | -1) => {}),
    stopGridVertHold: vi.fn(() => {}),
    isZooming: false,
    isZoomingRef: ref(false),
    setIsZooming: setter<boolean>(),
    setZoomLevel: setter<1 | 2>(),
    setPanOffset: setter<{ x: number; y: number }>(),
    mouseZooming: false,
    resetZoom: vi.fn(() => {}),
    pan: vi.fn((_dx: number, _dy: number) => {}),
    compareMode: false,
    championIndex: 0,
    goToSite: vi.fn((_target: NavSite) => {}),
    goBack: vi.fn((_landIndex?: number) => {}),
    cycleChallenger: vi.fn((_dir: 1 | -1, _step?: number) => true),
    challengerWins: vi.fn(() => {}),
    challengerLoses: vi.fn(() => {}),
    challengerKeptBoth: vi.fn((_asFavorite: boolean) => {}),
    applyRating: vi.fn((_rating: Rating) => {}),
    unrateCurrent: vi.fn(() => {}),
    setFilter: setter<Filter>(),
    chipsTooltip: { pulse: vi.fn(() => {}) },
    startAnalysis: vi.fn(() => {}),
    setExifVisible: setter<boolean>(),
    setClippingVisible: setter<boolean>(),
    setPeakingVisible: setter<boolean>(),
    setThumbsVisible: setter<boolean>(),
    setCompositionVisible: setter<boolean>(),
    ...over,
  };
}

/** `rerender(next)` flips a state prop mid-test the way App's re-render does. */
function renderKeymap(initial: KeymapProps) {
  return renderHook(
    (p: KeymapProps) => {
      useCullKeymap(p);
    },
    { initialProps: initial },
  );
}

/** Dispatch a keydown on `window` — where all three listeners live — and hand
 *  back the event so a test can read `defaultPrevented`. */
function press(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  window.dispatchEvent(e);
  return e;
}

function release(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true, ...init });
  window.dispatchEvent(e);
  return e;
}

afterEach(cleanup);

describe("the harness itself", () => {
  it("dispatches cancelable events, so defaultPrevented means something", () => {
    renderKeymap(props());
    // Tab preventDefaults unconditionally (useCullKeymap.ts:693).
    expect(press("Tab").defaultPrevented).toBe(true);
    // Ctrl+S deliberately does NOT (the Ctrl drop at :722 returns without
    // preventDefault) — so a `true` here would mean the events are not
    // cancelable, and both being `false` would mean nothing is listening.
    expect(press("s", { ctrlKey: true }).defaultPrevented).toBe(false);
  });

  it("unmounts between tests, so one keypress reaches exactly one hook", () => {
    const first = props();
    const { unmount } = renderKeymap(first);
    unmount();
    const second = props();
    renderKeymap(second);
    press("Enter");
    expect(first.applyRating).not.toHaveBeenCalled();
    expect(second.applyRating).toHaveBeenCalledTimes(1);
  });
});

describe("modal gates", () => {
  it("the settings modal owns the keyboard: Escape closes it, nothing else acts", () => {
    const p = props({ settingsOpen: true });
    renderKeymap(p);
    press("Enter");
    press("f");
    expect(p.applyRating).not.toHaveBeenCalled();
    press("Escape");
    expect(p.setSettingsOpen).toHaveBeenCalledWith(false);
  });

  it("the quit guard owns the keyboard: Escape dismisses it, nothing else acts", () => {
    const p = props({ quitGuard: true });
    renderKeymap(p);
    press("Backspace");
    expect(p.applyRating).not.toHaveBeenCalled();
    press("Escape");
    expect(p.setQuitGuard).toHaveBeenCalledWith(false);
  });

  it("the leave confirm takes Enter to leave and Escape to stay", () => {
    const p = props({ confirmHome: true });
    renderKeymap(p);
    press("Enter");
    expect(p.leaveToHome).toHaveBeenCalledTimes(1);
    expect(p.applyRating).not.toHaveBeenCalled();
    press("Escape");
    expect(p.setConfirmHome).toHaveBeenCalledWith(false);
  });

  it("the act-on-cull dialog swallows everything but Escape", () => {
    const p = props({ actionsOpen: true });
    renderKeymap(p);
    press("f");
    expect(p.applyRating).not.toHaveBeenCalled();
    press("Escape");
    expect(p.setActionsOpen).toHaveBeenCalledWith(false);
  });

  it("Enter on the staged screen begins the cull — but not with nothing staged", () => {
    const withImages = props({ phase: "staged" });
    const { unmount } = renderKeymap(withImages);
    expect(press("Enter").defaultPrevented).toBe(true);
    expect(withImages.beginCulling).toHaveBeenCalledTimes(1);
    unmount();

    const empty = props({ phase: "staged", images: [] });
    renderKeymap(empty);
    press("Enter");
    expect(empty.beginCulling).not.toHaveBeenCalled();
  });

  it("Escape on the staged screen discards the staged set", () => {
    const p = props({ phase: "staged" });
    renderKeymap(p);
    press("Escape");
    expect(p.resetSession).toHaveBeenCalledTimes(1);
  });

  // The table the spec asks for: no overlay may ever let a rating through, in
  // either mode. Five overlays x three rating keys = fifteen cases.
  const OVERLAYS = [
    "settingsOpen",
    "quitGuard",
    "confirmHome",
    "actionsOpen",
    "helpVisible",
  ] as const;
  for (const overlay of OVERLAYS) {
    for (const key of ["Enter", "Backspace", "f"]) {
      it(`${key} never rates behind ${overlay}`, () => {
        const single = props({ [overlay]: true });
        const { unmount } = renderKeymap(single);
        press(key);
        expect(single.applyRating).not.toHaveBeenCalled();
        expect(single.unrateCurrent).not.toHaveBeenCalled();
        unmount();

        const compare = props({ [overlay]: true, compareMode: true });
        renderKeymap(compare);
        press(key);
        expect(compare.challengerWins).not.toHaveBeenCalled();
        expect(compare.challengerLoses).not.toHaveBeenCalled();
        expect(compare.challengerKeptBoth).not.toHaveBeenCalled();
      });
    }
  }
});

describe("the help sheet", () => {
  it("Tab opens it, swallows the key, and clears the intro flag", () => {
    const p = props();
    renderKeymap(p);
    expect(press("Tab").defaultPrevented).toBe(true);
    expect(p.setHelpVisible).toHaveBeenCalledWith(true);
    expect(p.setHelpIntro).toHaveBeenCalledWith(false);
  });

  it("a held Tab opens it once, not once per OS repeat", () => {
    const p = props();
    renderKeymap(p);
    press("Tab");
    press("Tab", { repeat: true });
    press("Tab", { repeat: true });
    expect(p.setHelpVisible).toHaveBeenCalledTimes(1);
  });

  it("any other key dismisses it AND is swallowed", () => {
    const p = props({ helpVisible: true });
    renderKeymap(p);
    const e = press("Enter");
    expect(e.defaultPrevented).toBe(true);
    expect(p.setHelpVisible).toHaveBeenCalledWith(false);
    expect(p.applyRating).not.toHaveBeenCalled();
  });

  it("releasing Tab hides it", () => {
    const p = props({ helpVisible: true });
    renderKeymap(p);
    expect(release("Tab").defaultPrevented).toBe(true);
    expect(p.setHelpVisible).toHaveBeenCalledWith(false);
  });
});

describe("Ctrl combinations", () => {
  it("Ctrl+Z undoes, Ctrl+Shift+Z and Ctrl+Y redo", () => {
    const p = props();
    renderKeymap(p);
    press("z", { ctrlKey: true });
    expect(p.undo).toHaveBeenCalledTimes(1);
    press("z", { ctrlKey: true, shiftKey: true });
    press("y", { ctrlKey: true });
    expect(p.redo).toHaveBeenCalledTimes(2);
  });

  it("Ctrl+E opens the act-on-cull dialog", () => {
    const p = props();
    renderKeymap(p);
    press("e", { ctrlKey: true });
    expect(p.openActions).toHaveBeenCalledTimes(1);
  });

  it("Ctrl+A selects the grid, and is swallowed everywhere so the webview never does", () => {
    const grid = props({ gridVisible: true });
    const { unmount } = renderKeymap(grid);
    expect(press("a", { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(grid.selectAllInGrid).toHaveBeenCalledTimes(1);
    unmount();

    const loupe = props();
    renderKeymap(loupe);
    expect(press("a", { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(loupe.selectAllInGrid).not.toHaveBeenCalled();
  });

  it("Ctrl+0 resets the grid size, from the number row and the numpad", () => {
    const p = props({ gridVisible: true });
    renderKeymap(p);
    press("0", { ctrlKey: true });
    press("Unidentified", { ctrlKey: true, code: "Numpad0" });
    expect(p.resetGridSize).toHaveBeenCalledTimes(2);
  });

  it("an unbound Ctrl or Alt combo does nothing AND is left to the platform", () => {
    const p = props();
    renderKeymap(p);
    // :718-721 deliberately does not preventDefault here, so Ctrl+Home and
    // friends still reach whatever the platform does with them.
    expect(press("s", { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(press("f", { altKey: true }).defaultPrevented).toBe(false);
    expect(p.applyRating).not.toHaveBeenCalled();
  });
});

describe("ratings", () => {
  it("the loupe rates keep / reject / favorite and unrates", () => {
    const p = props();
    renderKeymap(p);
    expect(press("Enter").defaultPrevented).toBe(true);
    expect(press("Backspace").defaultPrevented).toBe(true);
    press("F");
    press("u");
    expect(p.applyRating).toHaveBeenNthCalledWith(1, "keep");
    expect(p.applyRating).toHaveBeenNthCalledWith(2, "reject");
    expect(p.applyRating).toHaveBeenNthCalledWith(3, "favorite");
    expect(p.unrateCurrent).toHaveBeenCalledTimes(1);
  });

  it("compare decides: Enter wins, Backspace loses, k keeps both, f stars the challenger", () => {
    const p = props({ compareMode: true });
    renderKeymap(p);
    press("Enter");
    press("Backspace");
    press("K");
    press("f");
    expect(p.challengerWins).toHaveBeenCalledTimes(1);
    expect(p.challengerLoses).toHaveBeenCalledTimes(1);
    expect(p.challengerKeptBoth).toHaveBeenNthCalledWith(1, false);
    expect(p.challengerKeptBoth).toHaveBeenNthCalledWith(2, true);
    expect(p.applyRating).not.toHaveBeenCalled();
  });
});

describe("Escape", () => {
  it("clears a grid selection first, and only then offers to leave", () => {
    const selected = props({ gridVisible: true, hasGridSelection: true });
    const { unmount } = renderKeymap(selected);
    press("Escape");
    expect(selected.clearMultiSelection).toHaveBeenCalledTimes(1);
    expect(selected.setConfirmHome).not.toHaveBeenCalled();
    unmount();

    const empty = props({ gridVisible: true });
    renderKeymap(empty);
    press("Escape");
    expect(empty.setConfirmHome).toHaveBeenCalledWith(true);
  });

  it("from the loupe it opens the leave confirm rather than stepping back a site", () => {
    const p = props();
    renderKeymap(p);
    press("Escape");
    expect(p.setConfirmHome).toHaveBeenCalledWith(true);
    expect(p.goBack).not.toHaveBeenCalled();
  });

  it("is swallowed in EVERY phase, home included — the macOS fullscreen listener", () => {
    // The one test allowed to assert Escape's defaultPrevented: it is pinning
    // the capture-phase listener at :839-845 that makes it always true.
    const p = props({ phase: "start" });
    renderKeymap(p);
    expect(press("Escape").defaultPrevented).toBe(true);
    expect(p.setConfirmHome).not.toHaveBeenCalled();
  });
});

describe("a held key acts once (fix A)", () => {
  it("a held rating key in the loupe rates once, not at the OS repeat rate", () => {
    const p = props();
    renderKeymap(p);
    press("Enter");
    press("Enter", { repeat: true });
    press("Enter", { repeat: true });
    expect(p.applyRating).toHaveBeenCalledTimes(1);
    expect(p.applyRating).toHaveBeenCalledWith("keep");
  });

  it("the same for Backspace, f and u", () => {
    const p = props();
    renderKeymap(p);
    for (const key of ["Backspace", "f", "u"]) {
      press(key);
      press(key, { repeat: true });
    }
    expect(p.applyRating).toHaveBeenCalledTimes(2); // reject, favorite
    expect(p.unrateCurrent).toHaveBeenCalledTimes(1);
  });

  it("a held filter digit cycles its sub-modes once per press", () => {
    const p = props();
    renderKeymap(p);
    press("3");
    press("3", { repeat: true });
    press("3", { repeat: true });
    expect(p.setFilter).toHaveBeenCalledTimes(1);
    expect(p.chipsTooltip.pulse).toHaveBeenCalledTimes(1);
  });

  it("compare's decide keys already guarded it — the two modes now agree", () => {
    const p = props({ compareMode: true });
    renderKeymap(p);
    press("Enter");
    press("Enter", { repeat: true });
    expect(p.challengerWins).toHaveBeenCalledTimes(1);
  });
});

describe("nothing acts behind the help sheet (fix B)", () => {
  it("Ctrl+Z does not undo under the sheet", () => {
    const p = props({ helpVisible: true });
    renderKeymap(p);
    const e = press("z", { ctrlKey: true });
    expect(p.undo).not.toHaveBeenCalled();
    expect(p.setHelpVisible).toHaveBeenCalledWith(false);
    expect(e.defaultPrevented).toBe(true);
  });

  it("Ctrl+E does not open the finish dialog under the sheet", () => {
    const p = props({ helpVisible: true });
    renderKeymap(p);
    press("e", { ctrlKey: true });
    expect(p.openActions).not.toHaveBeenCalled();
    expect(p.setHelpVisible).toHaveBeenCalledWith(false);
  });

  it("Ctrl+A and Ctrl+0 are dismissals too, not grid commands", () => {
    const p = props({ helpVisible: true, gridVisible: true });
    renderKeymap(p);
    press("a", { ctrlKey: true });
    press("0", { ctrlKey: true });
    expect(p.selectAllInGrid).not.toHaveBeenCalled();
    expect(p.resetGridSize).not.toHaveBeenCalled();
  });

  it("a held Tab does not dismiss the sheet it is holding open", () => {
    // The regression guard for the move: Tab must stay ABOVE the swallow.
    const p = props({ helpVisible: true });
    renderKeymap(p);
    press("Tab", { repeat: true });
    expect(p.setHelpVisible).not.toHaveBeenCalledWith(false);
  });

  it("Ctrl+, still opens Settings — that is a different listener, by design", () => {
    // The chrome effect (useCullKeymap.ts:160-208) is its own window listener
    // and neither handler stops propagation, so the help swallow cannot reach
    // it. Settings is itself a modal that then owns the keyboard, so this is
    // harmless — pinned so it reads as considered rather than missed.
    const p = props({ helpVisible: true });
    renderKeymap(p);
    press(",", { ctrlKey: true, code: "Comma" });
    expect(p.setSettingsOpen).toHaveBeenCalledWith(true);
  });

  it("Ctrl+Tab does not open the help sheet (fix E)", () => {
    const p = props();
    renderKeymap(p);
    const e = press("Tab", { ctrlKey: true });
    expect(p.setHelpVisible).not.toHaveBeenCalled();
    // Falls through to the Ctrl drop, which deliberately does not swallow.
    expect(e.defaultPrevented).toBe(false);
  });
});

describe("a held scrub is interrupted behind every overlay (fix C)", () => {
  for (const overlay of ["settingsOpen", "quitGuard", "confirmHome", "actionsOpen"] as const) {
    it(`a non-arrow key stops the horizontal scrub behind ${overlay}`, () => {
      const p = props({ [overlay]: true, heldDirRef: ref<0 | 1 | -1>(1) });
      renderKeymap(p);
      press("f");
      expect(p.stopHold).toHaveBeenCalledTimes(1);
    });

    it(`a non-arrow key stops the grid row-jump behind ${overlay}`, () => {
      const p = props({
        [overlay]: true,
        gridVisible: true,
        heldGridVertDirRef: ref<0 | 1 | -1>(1),
      });
      renderKeymap(p);
      press("Escape");
      expect(p.stopGridVertHold).toHaveBeenCalledTimes(1);
    });
  }

  it("a bare modifier still never interrupts a hold", () => {
    // The regression guard for the reorder: :236-237 exists so tapping Shift
    // mid-scrub does not abort the flow.
    const p = props({ heldDirRef: ref<0 | 1 | -1>(1) });
    renderKeymap(p);
    press("Shift");
    press("Control");
    press("Alt");
    press("Meta");
    expect(p.stopHold).not.toHaveBeenCalled();
  });

  it("the held arrow itself still sustains the scrub", () => {
    const p = props({ heldDirRef: ref<0 | 1 | -1>(1) });
    renderKeymap(p);
    press("ArrowRight");
    expect(p.stopHold).not.toHaveBeenCalled();
  });
});

describe("compare swallows its decide keys (fix D)", () => {
  it("k and f preventDefault like Enter and Backspace beside them", () => {
    const p = props({ compareMode: true });
    renderKeymap(p);
    expect(press("k").defaultPrevented).toBe(true);
    expect(press("F").defaultPrevented).toBe(true);
  });
});

describe("page keys", () => {
  it("Home and End cross the whole filter; PgUp and PgDn move one screenful", () => {
    const p = props();
    renderKeymap(p);
    press("End");
    press("Home");
    press("PageDown");
    press("PageUp");
    expect(p.advance).toHaveBeenNthCalledWith(1, 1, IMAGES.length);
    expect(p.advance).toHaveBeenNthCalledWith(2, -1, IMAGES.length);
    expect(p.advance).toHaveBeenNthCalledWith(3, 1, 24); // props().pageStep() === 24
    expect(p.advance).toHaveBeenNthCalledWith(4, -1, 24);
  });

  it("all four are swallowed — an unhandled PageDown would scroll the grid", () => {
    renderKeymap(props({ gridVisible: true }));
    for (const key of ["Home", "End", "PageUp", "PageDown"]) {
      expect(press(key).defaultPrevented).toBe(true);
    }
  });

  it("they act once per press and rest while zoomed", () => {
    const held = props();
    const { unmount } = renderKeymap(held);
    press("End");
    press("End", { repeat: true });
    expect(held.advance).toHaveBeenCalledTimes(1);
    unmount();

    const zoomed = props({ isZooming: true });
    renderKeymap(zoomed);
    press("PageDown");
    press("End");
    expect(zoomed.advance).not.toHaveBeenCalled();
  });

  it("in the grid a plain page key clears the selection BEFORE it moves", () => {
    const p = props({ gridVisible: true });
    renderKeymap(p);
    press("End");
    expect(p.clearMultiSelection).toHaveBeenCalledTimes(1);
    expect(vi.mocked(p.clearMultiSelection).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(p.advance).mock.invocationCallOrder[0],
    );
  });

  it("in the grid Shift extends the selection instead of moving the cursor", () => {
    const p = props({ gridVisible: true });
    renderKeymap(p);
    press("End", { shiftKey: true });
    press("PageDown", { shiftKey: true });
    expect(p.growGridSelection).toHaveBeenNthCalledWith(1, IMAGES.length);
    expect(p.growGridSelection).toHaveBeenNthCalledWith(2, 24);
    expect(p.advance).not.toHaveBeenCalled();
    expect(p.clearMultiSelection).not.toHaveBeenCalled();
  });

  it("compare gets the page keys only — Home and End are swallowed there, not bound", () => {
    const p = props({ compareMode: true });
    renderKeymap(p);
    expect(press("Home").defaultPrevented).toBe(true);
    expect(press("End").defaultPrevented).toBe(true);
    expect(p.cycleChallenger).not.toHaveBeenCalled();
    press("PageDown");
    expect(p.cycleChallenger).toHaveBeenCalledWith(1, 24);
  });

  it("compare's page keys also act once per press and rest while zoomed", () => {
    const held = props({ compareMode: true });
    const { unmount } = renderKeymap(held);
    press("PageDown");
    press("PageDown", { repeat: true });
    expect(held.cycleChallenger).toHaveBeenCalledTimes(1);
    unmount();

    const zoomed = props({ compareMode: true, isZooming: true });
    renderKeymap(zoomed);
    press("PageDown");
    expect(zoomed.cycleChallenger).not.toHaveBeenCalled();
  });
});

describe("grid size", () => {
  it("+ / = grow and − shrinks, grid only", () => {
    const p = props({ gridVisible: true });
    renderKeymap(p);
    press("+");
    press("=");
    press("-");
    expect(p.stepGridSizeBy).toHaveBeenNthCalledWith(1, 1);
    expect(p.stepGridSizeBy).toHaveBeenNthCalledWith(2, 1);
    expect(p.stepGridSizeBy).toHaveBeenNthCalledWith(3, -1);
  });

  it("a held + steps once, but is still swallowed", () => {
    const p = props({ gridVisible: true });
    renderKeymap(p);
    press("+");
    expect(press("+", { repeat: true }).defaultPrevented).toBe(true);
    expect(p.stepGridSizeBy).toHaveBeenCalledTimes(1);
  });

  it("outside the grid it is neither bound nor swallowed", () => {
    const p = props();
    renderKeymap(p);
    expect(press("+").defaultPrevented).toBe(false);
    expect(p.stepGridSizeBy).not.toHaveBeenCalled();
  });
});

describe("filter digits", () => {
  /** `setFilter` takes an UPDATER, so read it back and apply it. */
  function applyUpdater(setFilter: KeymapProps["setFilter"], from: Filter): Filter {
    const calls = vi.mocked(setFilter).mock.calls;
    expect(calls).toHaveLength(1);
    const updater = calls[0][0];
    if (typeof updater !== "function") throw new Error("setFilter was called with a value");
    return updater(from);
  }

  // Asserted THROUGH cycleFilter, so renaming a Filter value or reordering a
  // CYCLES entry (utils/filterModes.ts:13-19) breaks this test. A hard-coded
  // "keepsFavs" would sail straight past both.
  const CASES: [string, Parameters<typeof cycleFilter>[1]][] = [
    ["1", "all"],
    ["2", "unrated"],
    ["3", "keeps"],
    ["4", "suggested"],
    ["5", "rejects"],
  ];
  for (const [key, top] of CASES) {
    it(`${key} selects the ${top} tab, and re-pressing it cycles the sub-modes`, () => {
      const p = props();
      renderKeymap(p);
      press(key);
      expect(applyUpdater(p.setFilter, "all")).toBe(cycleFilter("all", top));
      expect(applyUpdater(p.setFilter, "keepsFavs")).toBe(cycleFilter("keepsFavs", top));
    });
  }

  it("only the two tabs with sub-modes pulse the chip tooltip", () => {
    for (const key of ["1", "2", "5"]) {
      const p = props();
      const { unmount } = renderKeymap(p);
      press(key);
      expect(p.chipsTooltip.pulse).not.toHaveBeenCalled();
      unmount();
    }
    for (const key of ["3", "4"]) {
      const p = props();
      const { unmount } = renderKeymap(p);
      press(key);
      expect(p.chipsTooltip.pulse).toHaveBeenCalledTimes(1);
      unmount();
    }
  });

  it("4 kicks off analysis only when smart culling is on", () => {
    const on = props();
    const { unmount } = renderKeymap(on);
    press("4");
    expect(on.startAnalysis).toHaveBeenCalledTimes(1);
    unmount();

    const off = props({ settings: { ...DEFAULT_SETTINGS, smartCulling: false } });
    renderKeymap(off);
    press("4");
    expect(off.startAnalysis).not.toHaveBeenCalled();
  });
});

describe("holds", () => {
  it("an arrow starts a scrub; its OS repeat does not restart it", () => {
    const p = props();
    renderKeymap(p);
    press("ArrowRight");
    press("ArrowRight", { repeat: true });
    expect(p.startHold).toHaveBeenCalledTimes(1);
    expect(p.startHold).toHaveBeenCalledWith(1);
  });

  it("the OPPOSITE arrow mid-scrub is ignored entirely", () => {
    const p = props({ heldDirRef: ref<0 | 1 | -1>(1) });
    renderKeymap(p);
    press("ArrowLeft");
    expect(p.startHold).not.toHaveBeenCalled();
    expect(p.stopHold).not.toHaveBeenCalled();
  });

  it("a rating key mid-scrub stops the hold BEFORE it rates", () => {
    const p = props({ heldDirRef: ref<0 | 1 | -1>(1) });
    renderKeymap(p);
    press("f");
    expect(p.stopHold).toHaveBeenCalledTimes(1);
    expect(vi.mocked(p.stopHold).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(p.applyRating).mock.invocationCallOrder[0],
    );
  });

  it("only the HELD arrow's release stops the scrub", () => {
    const p = props({ heldDirRef: ref<0 | 1 | -1>(1) });
    renderKeymap(p);
    release("ArrowLeft");
    expect(p.stopHold).not.toHaveBeenCalled();
    release("ArrowRight");
    expect(p.stopHold).toHaveBeenCalledTimes(1);
  });

  it("a mangled key on release still stops it, via e.code", () => {
    // The fallback that fixed the forever-scrub: a modifier still held at
    // release can blank e.key (useCullKeymap.ts:764-770).
    const p = props({ heldDirRef: ref<0 | 1 | -1>(1) });
    renderKeymap(p);
    release("", { code: "ArrowRight" });
    expect(p.stopHold).toHaveBeenCalledTimes(1);
  });

  it("the grid's row-jump starts on a bare down-arrow and drops the selection", () => {
    const p = props({ gridVisible: true });
    renderKeymap(p);
    press("ArrowDown");
    expect(p.clearMultiSelection).toHaveBeenCalledTimes(1);
    expect(p.startGridVertHold).toHaveBeenCalledWith(1);
  });

  it("Shift added mid row-jump kills the loop before it grows the selection", () => {
    const p = props({ gridVisible: true, heldGridVertDirRef: ref<0 | 1 | -1>(1) });
    renderKeymap(p);
    press("ArrowDown", { shiftKey: true });
    expect(p.stopGridVertHold).toHaveBeenCalledTimes(1);
    expect(p.growGridSelection).toHaveBeenCalledWith(6); // props().gridCols
    expect(vi.mocked(p.stopGridVertHold).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(p.growGridSelection).mock.invocationCallOrder[0],
    );
  });
});

describe("zoom", () => {
  it("Space arms 1:1, Shift+Space 2:1, and both re-centre the pan", () => {
    const plain = props();
    const { unmount } = renderKeymap(plain);
    expect(press(" ", { code: "Space" }).defaultPrevented).toBe(true);
    expect(plain.setIsZooming).toHaveBeenCalledWith(true);
    expect(plain.setZoomLevel).toHaveBeenCalledWith(1);
    expect(plain.setPanOffset).toHaveBeenCalledWith({ x: 0, y: 0 });
    unmount();

    const shifted = props();
    renderKeymap(shifted);
    press(" ", { code: "Space", shiftKey: true });
    expect(shifted.setZoomLevel).toHaveBeenCalledWith(2);
  });

  it("an already-zoomed Space changes nothing — the macOS phantom-repeat pin", () => {
    // 7bf33e8: after a rating keypress macOS resumes the still-held Space's
    // auto-repeat as a NON-repeat keydown. With zoom carried, it must be inert.
    const p = props({ isZoomingRef: ref(true) });
    renderKeymap(p);
    press(" ", { code: "Space" });
    expect(p.setIsZooming).not.toHaveBeenCalled();
  });

  it("Space in the grid is swallowed but does nothing", () => {
    const p = props({ gridVisible: true });
    renderKeymap(p);
    expect(press(" ", { code: "Space" }).defaultPrevented).toBe(true);
    expect(p.setIsZooming).not.toHaveBeenCalled();
  });

  it("releasing Space exits zoom — unless the MOUSE owns it", () => {
    const keyboard = props();
    const { unmount } = renderKeymap(keyboard);
    release(" ", { code: "Space" });
    expect(keyboard.resetZoom).toHaveBeenCalledTimes(1);
    unmount();

    const mouse = props({ mouseZooming: true });
    renderKeymap(mouse);
    release(" ", { code: "Space" });
    expect(mouse.resetZoom).not.toHaveBeenCalled();
  });

  it("arrows pan while zoomed instead of moving the cursor", () => {
    const p = props({ isZooming: true });
    renderKeymap(p);
    press("ArrowRight");
    press("ArrowDown");
    expect(p.pan).toHaveBeenNthCalledWith(1, 2, 0); // PAN_STEP
    expect(p.pan).toHaveBeenNthCalledWith(2, 0, 2);
    expect(p.advance).not.toHaveBeenCalled();
    expect(p.startHold).not.toHaveBeenCalled();
  });
});

describe("a state flip between renders", () => {
  it("opening the help sheet mid-session starts swallowing immediately", () => {
    const p = props();
    const { rerender } = renderKeymap(p);
    press("Enter");
    expect(p.applyRating).toHaveBeenCalledTimes(1);
    // Same spy, new props object: the effect rebuilds cullKeyRef's closures.
    rerender(props({ helpVisible: true, applyRating: p.applyRating }));
    press("Enter");
    expect(p.applyRating).toHaveBeenCalledTimes(1); // still one
  });
});
