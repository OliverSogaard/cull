// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SetStateAction } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { imageStore } from "../image/imageStore";
import { useDecideCallbacks } from "./useDecideCallbacks";
import type { Img, NavEntry, Rating, UndoAction } from "../types";

/**
 * CHARACTERISATION of the three compare decides (`challengerLoses`,
 * `challengerKeptBoth`, `challengerWins`). The three bodies are near-identical
 * 60-line sequences whose ORDER of side effects is load-bearing — the file's
 * own comments cite the 2026-07-07 compare-strip crash, caused by the store's
 * `dropZoomFullsExcept` forcing a SYNC React flush between two setStates.
 *
 * These tests pin the CURRENT order and arguments so the upcoming
 * de-duplication into a single helper is provably behaviour-preserving. Every
 * expectation below is derived from the code as it stands (symbols cited
 * per test), not from any intended design: if a test fails after a refactor,
 * the refactor changed observable behaviour.
 *
 * Ordering is captured by having every injected callback append its own name
 * to a shared `calls` array, then asserting the whole array with `toEqual` —
 * so a swap of any two steps fails, not just a missing call.
 */

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../image/imageStore", () => ({ imageStore: { dropZoomFullsExcept: vi.fn() } }));

type Ratings = Record<number, Rating>;

const img = (id: number): Img => ({
  id,
  path: `/s/${id}.cr3`,
  filename: `${id}.cr3`,
  srcFolder: "/s",
});
/** Five frames whose id === index, so `images[i].id === i` keeps the maths readable. */
const FIVE: Img[] = [0, 1, 2, 3, 4].map(img);

/**
 * Faithful port of App.tsx's `nearestUnrated` helper: scan forward
 * from `from`, then backward; skip `skip` and anything already rated; never
 * wraps; `-1` when nothing is left. It is a PURE QUERY the hook consults, not
 * a side effect, so it deliberately does NOT append to `calls`.
 */
function makeNearestUnrated(images: Img[]) {
  const findUnrated = (from: number, dir: 1 | -1, ratingsMap: Ratings, skip: number): number => {
    for (let i = from + dir; i >= 0 && i < images.length; i += dir) {
      if (i !== skip && !ratingsMap[images[i].id]) return i;
    }
    return -1;
  };
  return (from: number, ratingsMap: Ratings, skip: number): number => {
    const fwd = findUnrated(from, 1, ratingsMap, skip);
    return fwd !== -1 ? fwd : findUnrated(from, -1, ratingsMap, skip);
  };
}

type PropsInit = {
  calls: string[];
  images?: Img[];
  ratings?: Ratings;
  championIndex?: number;
  challengerIndex?: number;
  currentIndex?: number;
  navStack?: NavEntry[];
  isZooming?: boolean;
};

/**
 * One field per hook parameter. Every injected function is a `vi.fn()` that
 * records its own name in `calls` before doing nothing else — the hook's
 * decides never read a setter's result, so inert mocks are faithful.
 * `*Ref` params are plain `{ current }` boxes (React 19's mutable RefObject).
 */
function makeProps(init: PropsInit) {
  const { calls } = init;
  const images = init.images ?? FIVE;
  const note = (name: string): void => {
    calls.push(name);
  };

  const props = {
    images,
    ratings: init.ratings ?? {},
    setRatings: vi.fn((_next: SetStateAction<Ratings>) => {
      note("setRatings");
    }),
    currentIndex: init.currentIndex ?? 0,
    setCurrentIndex: vi.fn((_n: SetStateAction<number>) => {
      note("setCurrentIndex");
    }),
    championIndex: init.championIndex ?? 0,
    setChampionIndex: vi.fn((_n: SetStateAction<number>) => {
      note("setChampionIndex");
    }),
    challengerIndex: init.challengerIndex ?? 1,
    setChallengerIndex: vi.fn((_n: SetStateAction<number>) => {
      note("setChallengerIndex");
    }),
    visibleIndices: images.map((_, i) => i),
    gridVisible: false,
    selectedIndices: new Set<number>(),
    navStackRef: { current: init.navStack ?? [] },
    isZoomingRef: { current: init.isZooming ?? false },
    keepZoomOnAdvanceRef: { current: false },
    setZoomSwapInstant: vi.fn((_v: SetStateAction<boolean>) => {
      note("setZoomSwapInstant");
    }),
    setPanOffset: vi.fn((_v: SetStateAction<{ x: number; y: number }>) => {
      note("setPanOffset");
    }),
    flashFeedback: vi.fn((_rating: Rating, _imageId: number) => {
      note("flashFeedback");
    }),
    persistRating: vi.fn((_path: string, _rating: Rating | null) => {
      note("persistRating");
    }),
    recordAction: vi.fn((_action: UndoAction) => {
      note("recordAction");
    }),
    nearestUnrated: vi.fn(makeNearestUnrated(images)),
    goBack: vi.fn((_landIndex?: number) => {
      note("goBack");
    }),
  };
  // Compile-time proof that makeProps covers the hook's parameter object exactly.
  return props satisfies Parameters<typeof useDecideCallbacks>[0];
}

describe("compare decides — side-effect order (characterisation)", () => {
  const calls: string[] = [];

  beforeEach(() => {
    calls.length = 0;
    vi.mocked(imageStore.dropZoomFullsExcept).mockReset();
    vi.mocked(imageStore.dropZoomFullsExcept).mockImplementation(() => {
      calls.push("dropZoomFullsExcept");
    });
  });
  afterEach(cleanup);

  function setup(init: Omit<PropsInit, "calls">) {
    const props = makeProps({ ...init, calls });
    const { result } = renderHook(() => useDecideCallbacks(props));
    return { result, props };
  }

  // ── challengerLoses ──────────────────────────────────────────────────────

  it("challengerLoses: recordAction → flash → persist → setRatings → setChallengerIndex → drop", () => {
    // ratings {0:"keep"}, champion 0, challenger 1 → nearestUnrated picks 2.
    const { result, props } = setup({
      ratings: { 0: "keep" },
      championIndex: 0,
      challengerIndex: 1,
    });

    act(() => {
      result.current.challengerLoses();
    });

    // resolveCompareDecide: recordAction → flashFeedback → persist loop →
    // setRatings → setChallengerIndex → dropZoomFullsExcept.
    expect(calls).toEqual([
      "recordAction",
      "flashFeedback",
      "persistRating",
      "setRatings",
      "setChallengerIndex",
      "dropZoomFullsExcept",
    ]);
    expect(props.flashFeedback).toHaveBeenCalledWith("reject", 1); // resolveCompareDecide's flashFeedback call
    expect(props.persistRating).toHaveBeenCalledTimes(1);
    expect(props.persistRating).toHaveBeenCalledWith("/s/1.cr3", "reject"); // resolveCompareDecide's persist loop
    // resolveCompareDecide's setRatings(next) call: the whole next map, by value (not an updater function).
    expect(props.setRatings).toHaveBeenCalledWith({ 0: "keep", 1: "reject" });
    expect(props.setChallengerIndex).toHaveBeenCalledWith(2); // resolveCompareDecide's setChallengerIndex call
    // the `keep` pair passed to dropZoomFullsExcept: champion + the NEW challenger.
    expect(imageStore.dropZoomFullsExcept).toHaveBeenCalledWith(["/s/0.cr3", "/s/2.cr3"]);
    // Champion is untouched (see the `nextChampion !== championIndex` guard's comment).
    expect(props.setChampionIndex).not.toHaveBeenCalled();
    expect(props.goBack).not.toHaveBeenCalled();
  });

  it("challengerLoses on the last unrated frame exits via goBack(champion) and drops nothing", () => {
    // Only frame 1 is unrated; rejecting it leaves nothing for challengerLoses's nearestUnrated call (→ -1).
    const { result, props } = setup({
      ratings: { 0: "keep", 2: "keep", 3: "reject", 4: "keep" },
      championIndex: 0,
      challengerIndex: 1,
    });

    act(() => {
      result.current.challengerLoses();
    });

    // The exiting branch's goBack call replaces setChallengerIndex, and the
    // `if (!exiting)` guard skips the drop.
    expect(calls).toEqual([
      "recordAction",
      "flashFeedback",
      "persistRating",
      "setRatings",
      "goBack",
    ]);
    expect(props.goBack).toHaveBeenCalledWith(0); // resolveCompareDecide's exiting-branch goBack call: land on the unchanged champion
    expect(props.setChallengerIndex).not.toHaveBeenCalled();
    expect(imageStore.dropZoomFullsExcept).not.toHaveBeenCalled();
  });

  it("challengerLoses records the undo action's changes and both cursor snapshots", () => {
    const navStack: NavEntry[] = [{ site: "grid" }, { site: "compare", champ: 0, chall: 1 }];
    const { result, props } = setup({
      ratings: { 0: "keep" },
      championIndex: 0,
      challengerIndex: 1,
      currentIndex: 3, // deliberately diverged: compare never moves the cursor (see the
      // "currentIndex deliberately omitted" dependency-array comment)
      navStack,
    });

    act(() => {
      result.current.challengerLoses();
    });

    // resolveCompareDecide's recordAction call, verbatim shape.
    const action = props.recordAction.mock.calls[0][0];
    expect(action).toStrictEqual({
      changes: [{ imgId: 1, path: "/s/1.cr3", before: undefined, after: "reject" }],
      cursorBefore: {
        compareMode: true,
        championIndex: 0,
        challengerIndex: 1,
        currentIndex: 3,
        navStack: [{ site: "grid" }, { site: "compare", champ: 0, chall: 1 }],
      },
      cursorAfter: {
        compareMode: true,
        championIndex: 0,
        challengerIndex: 2,
        currentIndex: 3,
      },
    });
    // the `navStack: [...navStackRef.current]` spread: the snapshot must not alias the live ref.
    expect(action.cursorBefore?.navStack).not.toBe(navStack);
  });

  // ── challengerKeptBoth ───────────────────────────────────────────────────

  it("challengerKeptBoth(true) persists favorite for the challenger and leaves the champion alone", () => {
    const { result, props } = setup({
      ratings: { 0: "keep" },
      championIndex: 0,
      challengerIndex: 1,
    });

    act(() => {
      result.current.challengerKeptBoth(true);
    });

    // resolveCompareDecide: recordAction → flashFeedback → persist loop →
    // setRatings → setChallengerIndex → dropZoomFullsExcept — same spine as challengerLoses.
    expect(calls).toEqual([
      "recordAction",
      "flashFeedback",
      "persistRating",
      "setRatings",
      "setChallengerIndex",
      "dropZoomFullsExcept",
    ]);
    expect(props.flashFeedback).toHaveBeenCalledWith("favorite", 1); // resolveCompareDecide's flashFeedback call
    expect(props.persistRating).toHaveBeenCalledTimes(1); // champion never written
    expect(props.persistRating).toHaveBeenCalledWith("/s/1.cr3", "favorite"); // resolveCompareDecide's persist loop
    expect(props.setRatings).toHaveBeenCalledWith({ 0: "keep", 1: "favorite" }); // resolveCompareDecide's setRatings(next) call
    expect(props.setChampionIndex).not.toHaveBeenCalled(); // champion stays champion
    expect(props.setChallengerIndex).toHaveBeenCalledWith(2);
    expect(imageStore.dropZoomFullsExcept).toHaveBeenCalledWith(["/s/0.cr3", "/s/2.cr3"]);
    // challengerKeptBoth builder's changes array: carries the verdict, not a hardcoded "keep".
    expect(props.recordAction.mock.calls[0][0].changes).toStrictEqual([
      { imgId: 1, path: "/s/1.cr3", before: undefined, after: "favorite" },
    ]);
  });

  it("challengerKeptBoth(false) persists keep for the challenger", () => {
    const { result, props } = setup({
      ratings: { 0: "keep" },
      championIndex: 0,
      challengerIndex: 1,
    });

    act(() => {
      result.current.challengerKeptBoth(false);
    });

    expect(calls).toEqual([
      "recordAction",
      "flashFeedback",
      "persistRating",
      "setRatings",
      "setChallengerIndex",
      "dropZoomFullsExcept",
    ]);
    expect(props.flashFeedback).toHaveBeenCalledWith("keep", 1); // challengerKeptBoth builder's verdict variable
    expect(props.persistRating).toHaveBeenCalledWith("/s/1.cr3", "keep");
    expect(props.setRatings).toHaveBeenCalledWith({ 0: "keep", 1: "keep" });
  });

  it("challengerKeptBoth on the last unrated frame exits via goBack(champion)", () => {
    const { result, props } = setup({
      ratings: { 0: "keep", 2: "keep", 3: "reject", 4: "keep" },
      championIndex: 0,
      challengerIndex: 1,
    });

    act(() => {
      result.current.challengerKeptBoth(false);
    });

    // resolveCompareDecide's exiting branch (goBack) + the `if (!exiting)`
    // drop guard, mirroring challengerLoses' exit.
    expect(calls).toEqual([
      "recordAction",
      "flashFeedback",
      "persistRating",
      "setRatings",
      "goBack",
    ]);
    expect(props.goBack).toHaveBeenCalledWith(0);
    expect(imageStore.dropZoomFullsExcept).not.toHaveBeenCalled();
  });

  // ── challengerWins ───────────────────────────────────────────────────────

  it("challengerWins: two changes, persist reject then keep, setChampionIndex before setChallengerIndex", () => {
    const { result, props } = setup({
      ratings: { 0: "keep" },
      championIndex: 0,
      challengerIndex: 1,
    });

    act(() => {
      result.current.challengerWins();
    });

    // resolveCompareDecide: recordAction → flashFeedback → persist loop (both
    // changes) → setRatings → setChampionIndex → setChallengerIndex → dropZoomFullsExcept.
    expect(calls).toEqual([
      "recordAction",
      "flashFeedback",
      "persistRating",
      "persistRating",
      "setRatings",
      "setChampionIndex",
      "setChallengerIndex",
      "dropZoomFullsExcept",
    ]);
    expect(props.flashFeedback).toHaveBeenCalledWith("keep", 1); // resolveCompareDecide's flashFeedback call: flashes the WINNER
    expect(props.persistRating).toHaveBeenNthCalledWith(1, "/s/0.cr3", "reject"); // dethroned
    expect(props.persistRating).toHaveBeenNthCalledWith(2, "/s/1.cr3", "keep"); // crowned
    expect(props.setRatings).toHaveBeenCalledWith({ 0: "reject", 1: "keep" }); // challengerWins builder's next map (dethroned champion, crowned challenger)
    expect(props.setChampionIndex).toHaveBeenCalledWith(1); // resolveCompareDecide's setChampionIndex call: newChamp === old challenger
    expect(props.setChallengerIndex).toHaveBeenCalledWith(2); // resolveCompareDecide's setChallengerIndex call
    // the `keep` pair passed to dropZoomFullsExcept: the NEW champion + the new challenger.
    expect(imageStore.dropZoomFullsExcept).toHaveBeenCalledWith(["/s/1.cr3", "/s/2.cr3"]);
  });

  it("challengerWins records both changes and a cursorAfter that re-crowns the new champion", () => {
    const { result, props } = setup({
      ratings: { 0: "keep" },
      championIndex: 0,
      challengerIndex: 1,
      currentIndex: 3,
      navStack: [{ site: "loupe" }],
    });

    act(() => {
      result.current.challengerWins();
    });

    // resolveCompareDecide's recordAction call: old champion first, then the challenger.
    expect(props.recordAction.mock.calls[0][0]).toStrictEqual({
      changes: [
        { imgId: 0, path: "/s/0.cr3", before: "keep", after: "reject" },
        { imgId: 1, path: "/s/1.cr3", before: undefined, after: "keep" },
      ],
      cursorBefore: {
        compareMode: true,
        championIndex: 0, // resolveCompareDecide's cursorBefore.championIndex: the OLD champion
        challengerIndex: 1,
        currentIndex: 3,
        navStack: [{ site: "loupe" }],
      },
      cursorAfter: {
        compareMode: true,
        championIndex: 1, // resolveCompareDecide's cursorAfter.championIndex: redo re-crowns newChamp, not the rejected one
        challengerIndex: 2,
        currentIndex: 3,
      },
    });
  });

  it("challengerWins on the last unrated frame still crowns, then goBack(newChamp), and drops nothing", () => {
    // Champion 0, challenger 1, everything else rated → nearestUnrated(1, …, 1) === -1.
    const { result, props } = setup({
      ratings: { 2: "keep", 3: "reject", 4: "keep" },
      championIndex: 0,
      challengerIndex: 1,
    });

    act(() => {
      result.current.challengerWins();
    });

    // The `nextChampion !== championIndex` guard runs unconditionally — the
    // crown lands even on the auto-exit — and only then the exiting branch's
    // goBack call; the `if (!exiting)` guard skips the drop.
    expect(calls).toEqual([
      "recordAction",
      "flashFeedback",
      "persistRating",
      "persistRating",
      "setRatings",
      "setChampionIndex",
      "goBack",
    ]);
    expect(props.setChampionIndex).toHaveBeenCalledWith(1);
    expect(props.goBack).toHaveBeenCalledWith(1); // resolveCompareDecide's exiting-branch goBack call: the NEW champion, not the old one
    expect(props.setChallengerIndex).not.toHaveBeenCalled();
    expect(imageStore.dropZoomFullsExcept).not.toHaveBeenCalled();
  });

  // ── Zoomed decides ────────────────────────────────────────────────────────

  it("a zoomed decide sets zoomSwapInstant on all three, and resets pan only on a win", () => {
    const zoomed = { ratings: { 0: "keep" } as Ratings, championIndex: 0, challengerIndex: 1 };

    // resolveCompareDecide's zoomed-decide comment: challenger pane swaps under the live transform; pan is kept.
    const loses = setup({ ...zoomed, isZooming: true });
    act(() => {
      loses.result.current.challengerLoses();
    });
    expect(calls).toEqual([
      "recordAction",
      "flashFeedback",
      "persistRating",
      "setRatings",
      "setZoomSwapInstant",
      "setChallengerIndex",
      "dropZoomFullsExcept",
    ]);
    expect(loses.props.setZoomSwapInstant).toHaveBeenCalledWith(true);
    expect(loses.props.setPanOffset).not.toHaveBeenCalled();

    // Same zoomed-decide handling as challengerLoses, champion untouched.
    calls.length = 0;
    const kept = setup({ ...zoomed, isZooming: true });
    act(() => {
      kept.result.current.challengerKeptBoth(false);
    });
    expect(calls).toEqual([
      "recordAction",
      "flashFeedback",
      "persistRating",
      "setRatings",
      "setZoomSwapInstant",
      "setChallengerIndex",
      "dropZoomFullsExcept",
    ]);
    expect(kept.props.setPanOffset).not.toHaveBeenCalled();

    // resolveCompareDecide's resetPan branch: a NEW champion re-anchors both panes, so the shared pan resets.
    calls.length = 0;
    const wins = setup({ ...zoomed, isZooming: true });
    act(() => {
      wins.result.current.challengerWins();
    });
    expect(calls).toEqual([
      "recordAction",
      "flashFeedback",
      "persistRating",
      "persistRating",
      "setRatings",
      "setZoomSwapInstant",
      "setPanOffset",
      "setChampionIndex",
      "setChallengerIndex",
      "dropZoomFullsExcept",
    ]);
    expect(wins.props.setZoomSwapInstant).toHaveBeenCalledWith(true);
    expect(wins.props.setPanOffset).toHaveBeenCalledWith({ x: 0, y: 0 });
  });

  it("a zoomed decide that exits compare does NOT set zoomSwapInstant", () => {
    // The `&& !exiting` half of resolveCompareDecide's `if (isZoomingRef.current && !exiting)` guard.
    const { result, props } = setup({
      ratings: { 0: "keep", 2: "keep", 3: "reject", 4: "keep" },
      championIndex: 0,
      challengerIndex: 1,
      isZooming: true,
    });

    act(() => {
      result.current.challengerLoses();
    });

    expect(calls).toEqual([
      "recordAction",
      "flashFeedback",
      "persistRating",
      "setRatings",
      "goBack",
    ]);
    expect(props.setZoomSwapInstant).not.toHaveBeenCalled();
    expect(props.setPanOffset).not.toHaveBeenCalled();
  });

  // ── Guards ────────────────────────────────────────────────────────────────

  it("all three decides no-op when the pair indices are out of range", () => {
    // Each builder's missing-Img guard (challengerLoses/KeptBoth's
    // `if (!challImg) return`, challengerWins's `if (!champImg || !challImg) return`)
    // aborts before any side effect.
    const offEnd = setup({ championIndex: 0, challengerIndex: 99 });
    act(() => {
      offEnd.result.current.challengerLoses();
      offEnd.result.current.challengerKeptBoth(true);
      offEnd.result.current.challengerWins();
    });
    expect(calls).toEqual([]);

    // challengerWins's guard also checks the CHAMPION (challengerLoses/KeptBoth do not).
    const noChamp = setup({ championIndex: 99, challengerIndex: 1 });
    act(() => {
      noChamp.result.current.challengerWins();
    });
    expect(calls).toEqual([]);
  });
});
