// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import type { Dispatch, SetStateAction } from "react";
import { useSessionLifecycle } from "./useSessionLifecycle";
import { DEFAULT_SETTINGS } from "../types/settings";
import type { AnalyzeResult, Img, LabelValue, Star } from "../types";

/**
 * The star / colour-label layer across the SESSION boundaries — the three
 * places `ratings` is filled or emptied, which the two new maps have to
 * follow exactly:
 *
 *  - `beginCulling` restores them from the sidecar pass (a star IS
 *    `xmp:Rating`, so it rides `lrcRatings`; labels have their own field),
 *    validating at the boundary instead of casting;
 *  - `pruneMoved` takes a moved frame's marks out with the frame;
 *  - `resetSession` drops them with the session.
 *
 * The image store and the overlay service are mocked: this is about which
 * setters the hook calls with what, and the real store would pull thumbnails
 * through `invoke` for every frame.
 */

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("../image/imageStore", () => ({
  imageStore: { reset: vi.fn(), hardReset: vi.fn(), forget: vi.fn() },
}));
vi.mock("../overlays/overlayService", () => ({
  overlayService: { reset: vi.fn(), forget: vi.fn() },
}));

const mockInvoke = vi.mocked(invoke);

const img = (id: number): Img => ({
  id,
  path: `/s/${id}.cr3`,
  filename: `${id}.cr3`,
  srcFolder: "/s",
});
const THREE: Img[] = [0, 1, 2].map(img);

/** An analyze result in input order, with only the fields a restore reads. */
function analyzed(over: Partial<AnalyzeResult> = {}): AnalyzeResult {
  return {
    order: [0, 1, 2],
    ratings: [null, null, null],
    lrcRatings: [null, null, null],
    labels: [null, null, null],
    unreadableDirs: [],
    restoreErrors: [],
    restoreErrorCount: 0,
    ...over,
  };
}

/** A typed `vi.fn()` state setter that also remembers what it was handed. */
function setter<T>() {
  return vi.fn((_next: SetStateAction<T>): void => {}) as unknown as Dispatch<SetStateAction<T>> & {
    mock: { calls: [SetStateAction<T>][] };
  };
}

/** Run a setter's argument — a whole value or an updater — against `prev`. */
function applied<T>(next: SetStateAction<T>, prev: T): T {
  return typeof next === "function" ? (next as (p: T) => T)(prev) : next;
}

function makeProps(images: Img[] = THREE) {
  const setStars = setter<Record<number, Star>>();
  const setLabels = setter<Record<number, LabelValue>>();
  const props = {
    images,
    imagesRef: { current: images },
    ratings: {},
    settings: DEFAULT_SETTINGS,
    phase: "staged" as const,
    pickerBusy: false,
    profile: { concurrentRestore: 4 } as never,
    recentFolders: [],
    pushRecent: vi.fn((): void => {}),
    removeEntry: vi.fn((): void => {}),
    undoStack: { current: [] },
    redoStack: { current: [] },
    resetZoom: vi.fn((): void => {}),
    setFeedback: setter<never>(),
    setImages: setter<Img[]>(),
    setRatings: setter<Record<number, never>>(),
    setStars,
    setLabels,
    setMetadata: setter<Record<string, never>>(),
    setCurrentIndex: setter<number>(),
    setFilter: setter<never>(),
    setPhase: setter<never>(),
    setPendingFolder: setter<string | null>(),
    setPickerBusy: setter<boolean>(),
    setScanFailures: setter<never>(),
    setAnalyzeError: setter<string | null>(),
    setAnalyzeWarning: setter<never>(),
    setLastAdded: setter<number>(),
    setLastIgnored: setter<number>(),
    setLastBatchFolders: setter<string[]>(),
    setFolder: setter<string | null>(),
    setProgress: setter<never>(),
    setThumbsVisible: setter<boolean>(),
    setExifVisible: setter<boolean>(),
    setClippingVisible: setter<boolean>(),
    setPeakingVisible: setter<boolean>(),
    setCompositionVisible: setter<boolean>(),
    setCompareMode: setter<boolean>(),
    setGridVisible: setter<boolean>(),
    setNavStack: setter<never>(),
    setSelectedIndices: setter<Set<number>>(),
    setSelectionAnchor: setter<number | null>(),
    setConfirmHome: setter<boolean>(),
    setChampionIndex: setter<number>(),
    setChallengerIndex: setter<number>(),
  };
  return props as typeof props & Parameters<typeof useSessionLifecycle>[0];
}

/** The star map the hook produced, run against an empty starting map. */
const starsFrom = (p: ReturnType<typeof makeProps>): Record<number, Star> =>
  applied(p.setStars.mock.calls[0][0], {});
const labelsFrom = (p: ReturnType<typeof makeProps>): Record<number, LabelValue> =>
  applied(p.setLabels.mock.calls[0][0], {});

describe("the star and colour-label maps follow the session", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    localStorage.clear();
  });
  afterEach(cleanup);

  it("restores a star and a colour label from the sidecar pass, keyed by image id", async () => {
    const props = makeProps();
    mockInvoke.mockResolvedValue(
      analyzed({ lrcRatings: [3, null, 5], labels: ["red", "custom", null] }),
    );
    const { result } = renderHook(() => useSessionLifecycle(props));

    await act(async () => {
      await result.current.beginCulling();
    });

    expect(starsFrom(props)).toEqual({ 0: 3, 2: 5 });
    expect(labelsFrom(props)).toEqual({ 0: "red", 1: "custom" });
  });

  it("drops anything outside the two unions instead of casting it", async () => {
    // The wire is `(number | null)[]` and `(string | null)[]`: a 0, a
    // negative, a 7, a localised label string and an empty string all have to
    // be dropped, or a cast would put them straight into the maps.
    const props = makeProps();
    mockInvoke.mockResolvedValue(analyzed({ lrcRatings: [0, -1, 7], labels: ["Rot", "", "RED"] }));
    const { result } = renderHook(() => useSessionLifecycle(props));

    await act(async () => {
      await result.current.beginCulling();
    });

    // `toEqual({})` alone is satisfied by an object carrying its own
    // undefined-valued keys (vitest ignores them) — it would stay green even
    // if a dropped entry were written in as `id: undefined` instead of never
    // being set at all. `Object.keys` sees that own key either way.
    const stars = starsFrom(props);
    expect(stars).toEqual({});
    expect(Object.keys(stars)).toHaveLength(0);
    const labels = labelsFrom(props);
    expect(labels).toEqual({});
    expect(Object.keys(labels)).toHaveLength(0);
  });

  it("takes a moved frame's star and label out with the frame", () => {
    const props = makeProps();
    const { result } = renderHook(() => useSessionLifecycle(props));

    act(() => {
      result.current.pruneMoved(["/s/1.cr3"]);
    });

    expect(applied(props.setStars.mock.calls[0][0], { 0: 4, 1: 2, 2: 1 })).toEqual({ 0: 4, 2: 1 });
    expect(applied(props.setLabels.mock.calls[0][0], { 0: "red", 1: "blue", 2: "custom" })).toEqual(
      { 0: "red", 2: "custom" },
    );
  });

  it("drops both maps with the session", () => {
    const props = makeProps();
    const { result } = renderHook(() => useSessionLifecycle(props));

    act(() => {
      result.current.resetSession();
    });

    // Same loophole as the union-drop test above: an own undefined-valued
    // key would still satisfy `toEqual({})`.
    const stars = starsFrom(props);
    expect(stars).toEqual({});
    expect(Object.keys(stars)).toHaveLength(0);
    const labels = labelsFrom(props);
    expect(labels).toEqual({});
    expect(Object.keys(labels)).toHaveLength(0);
  });
});
