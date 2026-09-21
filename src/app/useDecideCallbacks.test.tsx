// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SetStateAction } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { imageStore } from "../image/imageStore";
import { useDecideCallbacks } from "./useDecideCallbacks";
import type {
  Img,
  Label,
  LabelValue,
  MetaChange,
  NavEntry,
  Rating,
  Star,
  UndoAction,
} from "../types";

/**
 * Compile-time pins for the names the comments below cite. `makeProps` ends
 * with `satisfies Parameters<typeof useDecideCallbacks>[0]`, which already
 * follows every PROP rename; this follows the RETURNED ones even in the tests
 * that only mention them in prose.
 *
 * `resolveCompareDecide` and `DecideSpec` are deliberately absent: both are
 * module-private (a `useCallback` local and a local type), and exporting them
 * to satisfy a comment would widen the module's surface for documentation.
 * The comments that used to name them cite the BEHAVIOUR instead.
 */
type Decides = ReturnType<typeof useDecideCallbacks>;
const _PINNED: Record<keyof Decides, true> = {
  applyRating: true,
  unrateCurrent: true,
  challengerLoses: true,
  challengerKeptBoth: true,
  challengerWins: true,
  applyStar: true,
  applyLabel: true,
};
void _PINNED;

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
  gridVisible?: boolean;
  selectedIndices?: Set<number>;
  stars?: Record<number, Star>;
  labels?: Record<number, LabelValue>;
  /** Defaults to every frame; set it to pin the cursor OUTSIDE the filter. */
  visibleIndices?: number[];
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
    visibleIndices: init.visibleIndices ?? images.map((_, i) => i),
    gridVisible: init.gridVisible ?? false,
    selectedIndices: init.selectedIndices ?? new Set<number>(),
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
    stars: init.stars ?? {},
    setStars: vi.fn((_v: SetStateAction<Record<number, Star>>) => {
      note("setStars");
    }),
    labels: init.labels ?? {},
    setLabels: vi.fn((_v: SetStateAction<Record<number, LabelValue>>) => {
      note("setLabels");
    }),
    persistStar: vi.fn((_path: string, _star: Star | null) => {
      note("persistStar");
    }),
    persistLabel: vi.fn((_path: string, _label: Label | null) => {
      note("persistLabel");
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

    // The shared decide's side-effect spine: recordAction → flashFeedback →
    // persist loop → setRatings → setChallengerIndex → dropZoomFullsExcept.
    expect(calls).toEqual([
      "recordAction",
      "flashFeedback",
      "persistRating",
      "setRatings",
      "setChallengerIndex",
      "dropZoomFullsExcept",
    ]);
    expect(props.flashFeedback).toHaveBeenCalledWith("reject", 1); // the shared decide's flash, keyed to the judged frame
    expect(props.persistRating).toHaveBeenCalledTimes(1);
    expect(props.persistRating).toHaveBeenCalledWith("/s/1.cr3", "reject"); // the shared decide's persist loop
    // The shared decide's setRatings call: the whole next map, BY VALUE (not
    // an updater function) — the caller already derived it to ask
    // nearestUnrated what was left.
    expect(props.setRatings).toHaveBeenCalledWith({ 0: "keep", 1: "reject" });
    expect(props.setChallengerIndex).toHaveBeenCalledWith(2); // the shared decide's setChallengerIndex call
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
    expect(props.goBack).toHaveBeenCalledWith(0); // the shared decide's exiting-branch goBack call: land on the unchanged champion
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

    // The shared decide's recordAction call, verbatim shape.
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

    // The shared decide's side-effect spine: recordAction → flashFeedback →
    // persist loop → setRatings → setChallengerIndex → dropZoomFullsExcept — same spine as challengerLoses.
    expect(calls).toEqual([
      "recordAction",
      "flashFeedback",
      "persistRating",
      "setRatings",
      "setChallengerIndex",
      "dropZoomFullsExcept",
    ]);
    expect(props.flashFeedback).toHaveBeenCalledWith("favorite", 1); // the shared decide's flash, keyed to the judged frame
    expect(props.persistRating).toHaveBeenCalledTimes(1); // champion never written
    expect(props.persistRating).toHaveBeenCalledWith("/s/1.cr3", "favorite"); // the shared decide's persist loop
    expect(props.setRatings).toHaveBeenCalledWith({ 0: "keep", 1: "favorite" }); // the shared decide's setRatings call: the whole next map, by value
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

    // The shared decide's exiting branch (goBack) + the `if (!exiting)`
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

    // The shared decide's side-effect spine: recordAction → flashFeedback →
    // persist loop (both changes) → setRatings → setChampionIndex → setChallengerIndex → dropZoomFullsExcept.
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
    expect(props.flashFeedback).toHaveBeenCalledWith("keep", 1); // the shared decide's flash, keyed to the judged frame: flashes the WINNER
    expect(props.persistRating).toHaveBeenNthCalledWith(1, "/s/0.cr3", "reject"); // dethroned
    expect(props.persistRating).toHaveBeenNthCalledWith(2, "/s/1.cr3", "keep"); // crowned
    expect(props.setRatings).toHaveBeenCalledWith({ 0: "reject", 1: "keep" }); // challengerWins builder's next map (dethroned champion, crowned challenger)
    expect(props.setChampionIndex).toHaveBeenCalledWith(1); // the shared decide's crown-move call: newChamp === old challenger
    expect(props.setChallengerIndex).toHaveBeenCalledWith(2); // the shared decide's setChallengerIndex call
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

    // The shared decide's recordAction call: old champion first, then the challenger.
    expect(props.recordAction.mock.calls[0][0]).toStrictEqual({
      changes: [
        { imgId: 0, path: "/s/0.cr3", before: "keep", after: "reject" },
        { imgId: 1, path: "/s/1.cr3", before: undefined, after: "keep" },
      ],
      cursorBefore: {
        compareMode: true,
        championIndex: 0, // the shared decide's cursorBefore.championIndex: the OLD champion
        challengerIndex: 1,
        currentIndex: 3,
        navStack: [{ site: "loupe" }],
      },
      cursorAfter: {
        compareMode: true,
        championIndex: 1, // the shared decide's cursorAfter.championIndex: redo re-crowns newChamp, not the rejected one
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
    expect(props.goBack).toHaveBeenCalledWith(1); // the shared decide's exiting-branch goBack call: the NEW champion, not the old one
    expect(props.setChallengerIndex).not.toHaveBeenCalled();
    expect(imageStore.dropZoomFullsExcept).not.toHaveBeenCalled();
  });

  // ── Zoomed decides ────────────────────────────────────────────────────────

  it("a zoomed decide sets zoomSwapInstant on all three, and resets pan only on a win", () => {
    const zoomed = { ratings: { 0: "keep" } as Ratings, championIndex: 0, challengerIndex: 1 };

    // The shared decide's zoomed-decide handling: challenger pane swaps under the live transform; pan is kept.
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

    // The shared decide's resetPan branch: a NEW champion re-anchors both panes, so the shared pan resets.
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
    // The `&& !exiting` half of the shared decide's `if (isZoomingRef.current && !exiting)` guard.
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

/**
 * REGRESSION: `applyRating`'s grid branch and both of `unrateCurrent`'s
 * branches call `setRatings((prev) => withChanges(prev, changes))` — three of
 * the five `withChanges` call sites the "compare decides" suite above never
 * exercises (that suite only drives the three compare decides). A branch
 * review found that mutating any of those three sites to
 * `withChanges(prev, [])` still left the full test suite green: nothing
 * captured the updater `setRatings` was actually called with and looked at
 * what it does to a ratings map.
 *
 * Each test below pulls that updater out of the mock, applies it to a
 * HAND-BUILT base map, and compares the result to a HAND-BUILT expected map —
 * this file never imports `withChanges` itself, so a bug in the helper cannot
 * pass on both sides (same ruling as the helper's own unit test).
 */
describe("applyRating / unrateCurrent — the ratings map setRatings actually produces", () => {
  const calls: string[] = [];

  beforeEach(() => {
    calls.length = 0;
  });
  afterEach(cleanup);

  function setup(init: Omit<PropsInit, "calls">) {
    const props = makeProps({ ...init, calls });
    const { result } = renderHook(() => useDecideCallbacks(props));
    return { result, props };
  }

  /** `setRatings` is always called with an updater at these three sites — pull
   *  the LAST call's updater out of the mock and run it against `base`.
   *  (`Array.prototype.at` is ES2022; this repo's `lib` is ES2020 —
   *  see tsconfig.json:5 — so this indexes from the end by hand.) */
  function appliedRatings(props: ReturnType<typeof makeProps>, base: Ratings): Ratings {
    const { calls: setRatingsCalls } = props.setRatings.mock;
    const arg = setRatingsCalls[setRatingsCalls.length - 1]?.[0];
    if (typeof arg !== "function") {
      throw new Error("setRatings must have been called with an updater");
    }
    return arg(base);
  }

  it("applyRating over a grid selection rates the differing/unrated frames and skips the one already at that rating", () => {
    const base: Ratings = { 0: "keep", 2: "reject", 3: "favorite" };
    const { result, props } = setup({
      ratings: base,
      gridVisible: true,
      selectedIndices: new Set([0, 1, 2]),
    });

    act(() => {
      result.current.applyRating("reject");
    });

    // frame 0: "keep" → "reject" (differs); frame 1: unrated → "reject";
    // frame 2: already "reject" — the `before !== after` guard drops it.
    expect(appliedRatings(props, base)).toEqual({
      0: "reject",
      1: "reject",
      2: "reject",
      3: "favorite",
    });
    expect(props.persistRating).toHaveBeenCalledTimes(2);
    expect(props.persistRating).toHaveBeenCalledWith("/s/0.cr3", "reject");
    expect(props.persistRating).toHaveBeenCalledWith("/s/1.cr3", "reject");
    // The grid branch's one undo entry: frame 2 never appears (skipped above).
    expect(props.recordAction).toHaveBeenCalledWith({
      changes: [
        { imgId: 0, path: "/s/0.cr3", before: "keep", after: "reject" },
        { imgId: 1, path: "/s/1.cr3", before: undefined, after: "reject" },
      ],
    });
  });

  it("unrateCurrent over a grid selection DELETES the rated frames' keys and skips the already-unrated one", () => {
    const base: Ratings = { 0: "keep", 1: "reject", 3: "favorite" };
    const { result, props } = setup({
      ratings: base,
      gridVisible: true,
      selectedIndices: new Set([0, 1, 2]),
    });

    act(() => {
      result.current.unrateCurrent();
    });

    const after = appliedRatings(props, base);
    // Not `{ 0: undefined, 1: undefined, ... }`: the keys must be GONE, or
    // every `id in ratings` / Object.keys consumer still counts the frame rated.
    expect("0" in after).toBe(false);
    expect("1" in after).toBe(false);
    expect(Object.keys(after)).toEqual(["3"]);
    expect(after).toEqual({ 3: "favorite" });
    expect(props.persistRating).toHaveBeenCalledTimes(2);
    expect(props.persistRating).toHaveBeenCalledWith("/s/0.cr3", null);
    expect(props.persistRating).toHaveBeenCalledWith("/s/1.cr3", null);
    // frame 2 was already unrated — the `ratings[im.id] !== undefined` guard drops it.
    expect(props.recordAction).toHaveBeenCalledWith({
      changes: [
        { imgId: 0, path: "/s/0.cr3", before: "keep", after: undefined },
        { imgId: 1, path: "/s/1.cr3", before: "reject", after: undefined },
      ],
    });
  });

  it("unrateCurrent on a single frame DELETES its key", () => {
    const base: Ratings = { 0: "keep", 1: "reject" };
    const { result, props } = setup({ ratings: base, currentIndex: 0 });

    act(() => {
      result.current.unrateCurrent();
    });

    const after = appliedRatings(props, base);
    expect("0" in after).toBe(false);
    expect(after).toEqual({ 1: "reject" });
    expect(props.persistRating).toHaveBeenCalledWith("/s/0.cr3", null);
    expect(props.recordAction).toHaveBeenCalledWith({
      changes: [{ imgId: 0, path: "/s/0.cr3", before: "keep", after: undefined }],
    });
  });
});

/**
 * The star / colour-label layer beside the verdicts. What these pin is that it
 * is ORTHOGONAL: one keypress is one undo step whose `changes` list is empty,
 * the cursor does not advance, and no verdict wash is painted.
 *
 * This file's `makeProps` factory and per-suite `setup` helper are reused
 * as-is; the factory grew six props (the two maps, their setters and the two
 * persist callbacks), which changes no existing assertion because none of the
 * verdict paths touch them.
 */
describe("applyStar / applyLabel — the orthogonal layer", () => {
  const calls: string[] = [];

  beforeEach(() => {
    calls.length = 0;
  });
  afterEach(cleanup);

  function setup(init: Omit<PropsInit, "calls">) {
    const props = makeProps({ ...init, calls });
    const { result } = renderHook(() => useDecideCallbacks(props));
    return { result, props };
  }

  it("stars the current frame as ONE undo step, and does not advance", () => {
    const { result, props } = setup({});

    act(() => {
      result.current.applyStar(3);
    });

    expect(props.recordAction).toHaveBeenCalledTimes(1);
    const action = props.recordAction.mock.calls[0][0];
    expect(action.changes).toEqual([]);
    expect(action.meta).toEqual([
      { imgId: 0, path: "/s/0.cr3", field: "star", before: undefined, after: 3 },
    ]);
    expect(props.persistStar).toHaveBeenCalledWith("/s/0.cr3", 3);
    // A star is not a verdict: it finishes nothing, so the cursor stays put
    // and no verdict wash is painted.
    expect(props.setCurrentIndex).not.toHaveBeenCalled();
    expect(props.flashFeedback).not.toHaveBeenCalled();
    expect(props.setRatings).not.toHaveBeenCalled();
  });

  it("0 clears a star — one entry, `after: undefined`, and null on the wire", () => {
    const { result, props } = setup({ stars: { 0: 4 } });

    act(() => {
      result.current.applyStar(null);
    });

    expect(props.recordAction.mock.calls[0][0].meta).toEqual([
      { imgId: 0, path: "/s/0.cr3", field: "star", before: 4, after: undefined },
    ]);
    expect(props.persistStar).toHaveBeenCalledWith("/s/0.cr3", null);
  });

  it("re-pressing the star already on the frame writes nothing at all", () => {
    const { result, props } = setup({ stars: { 0: 3 } });

    act(() => {
      result.current.applyStar(3);
    });

    expect(props.recordAction).not.toHaveBeenCalled();
    expect(props.persistStar).not.toHaveBeenCalled();
    expect(props.setStars).not.toHaveBeenCalled();
  });

  it("the stars map setStars actually produces sets, and a clear DELETES the key", () => {
    // Same ruling as the ratings suite above: pull the updater out of the mock
    // and run it against a HAND-BUILT map, because a stored `undefined` would
    // still make `id in stars` true and every count wrong.
    const set = setup({});
    act(() => {
      set.result.current.applyStar(2);
    });
    const setUpdater = set.props.setStars.mock.calls[0][0];
    if (typeof setUpdater !== "function") throw new Error("setStars needs an updater");
    expect(setUpdater({ 1: 5 })).toEqual({ 0: 2, 1: 5 });

    cleanup();
    const clear = setup({ stars: { 0: 4 } });
    act(() => {
      clear.result.current.applyStar(null);
    });
    const clearUpdater = clear.props.setStars.mock.calls[0][0];
    if (typeof clearUpdater !== "function") throw new Error("setStars needs an updater");
    const after = clearUpdater({ 0: 4, 1: 5 });
    expect("0" in after).toBe(false);
    expect(after).toEqual({ 1: 5 });
  });

  it("a label toggles off when its own key is pressed again (Lightroom's rule)", () => {
    const set = setup({});
    act(() => {
      set.result.current.applyLabel("red");
    });
    expect(set.props.recordAction.mock.calls[0][0].meta).toEqual([
      { imgId: 0, path: "/s/0.cr3", field: "label", before: undefined, after: "red" },
    ]);
    expect(set.props.persistLabel).toHaveBeenCalledWith("/s/0.cr3", "red");

    cleanup();
    const clear = setup({ labels: { 0: "red" } });
    act(() => {
      clear.result.current.applyLabel("red");
    });
    expect(clear.props.recordAction.mock.calls[0][0].meta).toEqual([
      { imgId: 0, path: "/s/0.cr3", field: "label", before: "red", after: undefined },
    ]);
    expect(clear.props.persistLabel).toHaveBeenCalledWith("/s/0.cr3", null);
  });

  it("a label CULL does not recognise is never overwritten — the press is a no-op", () => {
    // "custom" is the user's own Lightroom label, and the frontend only ever
    // learns the WORD "custom" — never the string. Replacing it would be a
    // one-way door: undo could not put the user's own label back.
    const { result, props } = setup({ labels: { 0: "custom" } });

    act(() => {
      result.current.applyLabel("blue");
    });

    expect(props.recordAction).not.toHaveBeenCalled();
    expect(props.persistLabel).not.toHaveBeenCalled();
    expect(props.setLabels).not.toHaveBeenCalled();
  });

  it("a multi-select skips the custom frame and still changes the rest, in one step", () => {
    const { result, props } = setup({
      gridVisible: true,
      selectedIndices: new Set([0, 1, 2]),
      currentIndex: 0,
      labels: { 1: "custom" },
    });

    act(() => {
      result.current.applyLabel("green");
    });

    expect(props.recordAction).toHaveBeenCalledTimes(1);
    const meta = props.recordAction.mock.calls[0][0].meta as MetaChange[];
    expect(meta.map((m) => m.imgId)).toEqual([0, 2]);
    expect(props.persistLabel).toHaveBeenCalledTimes(2);
    expect(props.persistLabel).not.toHaveBeenCalledWith("/s/1.cr3", "green");
  });

  it("a custom frame cannot be the anchor that decides the toggle", () => {
    // The cursor sits on the untouchable frame, so the toggle question is
    // answered by the first frame the press can actually reach: frame 1 is
    // not green, so the press SETS green rather than clearing it.
    const { result, props } = setup({
      gridVisible: true,
      selectedIndices: new Set([0, 1]),
      currentIndex: 0,
      labels: { 0: "custom" },
    });

    act(() => {
      result.current.applyLabel("green");
    });

    const meta = props.recordAction.mock.calls[0][0].meta as MetaChange[];
    expect(meta).toEqual([
      { imgId: 1, path: "/s/1.cr3", field: "label", before: undefined, after: "green" },
    ]);
  });

  it("the ANCHOR decides a multi-select's toggle, so one press does one thing", () => {
    // The cursor frame is inside the selection and already red, so the press
    // clears the whole set rather than half-toggling it.
    const { result, props } = setup({
      gridVisible: true,
      selectedIndices: new Set([0, 1, 2]),
      currentIndex: 1,
      labels: { 1: "red", 2: "red" },
    });

    act(() => {
      result.current.applyLabel("red");
    });

    const meta = props.recordAction.mock.calls[0][0].meta as MetaChange[];
    // Frame 0 carries no label and is already at the target (`undefined`), so
    // it is dropped; the two red ones are cleared.
    expect(meta.map((m) => m.imgId)).toEqual([1, 2]);
    expect(meta.every((m) => m.after === undefined)).toBe(true);
    expect(props.persistLabel).toHaveBeenCalledTimes(2);
    expect(props.persistLabel).toHaveBeenCalledWith("/s/1.cr3", null);
  });

  it("a grid multi-select is ONE undo step, one entry per frame that changes", () => {
    const { result, props } = setup({
      gridVisible: true,
      selectedIndices: new Set([0, 1, 2]),
      stars: { 1: 5 },
    });

    act(() => {
      result.current.applyStar(5);
    });

    expect(props.recordAction).toHaveBeenCalledTimes(1);
    const meta = props.recordAction.mock.calls[0][0].meta as MetaChange[];
    // Frame 1 is already 5★ — no redundant write, no dead before===after entry.
    expect(meta.map((m) => m.imgId)).toEqual([0, 2]);
    expect(props.persistStar).toHaveBeenCalledTimes(2);
  });

  it("never grades a frame outside the active filter", () => {
    // Same guard as applyRating's `pos === -1` return: with the cursor
    // outside the filter the photo is not on screen, and grading something
    // you cannot see is never right.
    const { result, props } = setup({ visibleIndices: [1, 2] }); // currentIndex 0 is hidden

    act(() => {
      result.current.applyStar(2);
    });
    act(() => {
      result.current.applyLabel("green");
    });

    expect(props.recordAction).not.toHaveBeenCalled();
    expect(props.persistStar).not.toHaveBeenCalled();
    expect(props.persistLabel).not.toHaveBeenCalled();
  });

  it("clearing the last mark asks for the unrate that can delete an empty sidecar", () => {
    // `3` then `0` on an unrated frame wrote a CULL sidecar and then emptied
    // it. Nothing sent `clear_xmp_rating` (the unrate key returns early for a
    // frame that is already unrated), so the empty file stayed in the folder.
    const { result, props } = setup({ stars: { 0: 3 } });

    act(() => {
      result.current.applyStar(null);
    });

    expect(props.persistStar).toHaveBeenCalledWith("/s/0.cr3", null);
    expect(props.persistRating).toHaveBeenCalledWith("/s/0.cr3", null);
    // ORDER matters: the two share one per-path queue, and the delete gate
    // reads the file the star clear left behind.
    expect(props.persistStar.mock.invocationCallOrder[0]).toBeLessThan(
      props.persistRating.mock.invocationCallOrder[0],
    );
  });

  it("leaves the sidecar alone while anything at all is still in it", () => {
    const rated = setup({ stars: { 0: 3 }, ratings: { 0: "keep" } });
    act(() => {
      rated.result.current.applyStar(null);
    });
    expect(rated.props.persistRating).not.toHaveBeenCalled();

    cleanup();
    const labelled = setup({ stars: { 0: 3 }, labels: { 0: "blue" } });
    act(() => {
      labelled.result.current.applyStar(null);
    });
    expect(labelled.props.persistRating).not.toHaveBeenCalled();

    cleanup();
    // The user's own Lightroom label is content too — the one thing here most
    // worth not deleting.
    const custom = setup({ stars: { 0: 3 }, labels: { 0: "custom" } });
    act(() => {
      custom.result.current.applyStar(null);
    });
    expect(custom.props.persistRating).not.toHaveBeenCalled();
  });

  it("never asks for an unrate when the press SETS a mark", () => {
    const { result, props } = setup({});
    act(() => {
      result.current.applyStar(4);
    });
    act(() => {
      result.current.applyLabel("green");
    });
    expect(props.persistRating).not.toHaveBeenCalled();
  });

  it("asks once per frame when a multi-select's label toggles off", () => {
    const { result, props } = setup({
      gridVisible: true,
      selectedIndices: new Set([0, 1]),
      currentIndex: 0,
      labels: { 0: "red", 1: "red" },
    });

    act(() => {
      result.current.applyLabel("red");
    });

    expect(props.persistRating.mock.calls).toEqual([
      ["/s/0.cr3", null],
      ["/s/1.cr3", null],
    ]);
  });

  it("a grid selection never reaches a selected frame the filter hides", () => {
    // Mirrors applyRating's grid branch, which intersects the selection with
    // visibleIndices for the same reason.
    const { result, props } = setup({
      gridVisible: true,
      selectedIndices: new Set([0, 1, 2]),
      visibleIndices: [0, 2],
    });

    act(() => {
      result.current.applyStar(1);
    });

    const meta = props.recordAction.mock.calls[0][0].meta as MetaChange[];
    expect(meta.map((m) => m.imgId)).toEqual([0, 2]);
  });
});
