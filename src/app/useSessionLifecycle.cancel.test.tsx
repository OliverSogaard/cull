// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import type { Dispatch, SetStateAction } from "react";
import { useSessionLifecycle } from "./useSessionLifecycle";
import { DEFAULT_SETTINGS } from "../types/settings";
import type { AnalyzeResult, Img, LabelValue, Phase, Star } from "../types";

/**
 * Cancel during "analyzing" (Phase 5B item 1): Begin culling's analyze pass
 * can run long on a big shoot with no way out. Cancelling must drop straight
 * back to staged, discard the in-flight result (or error) when it eventually
 * lands — the backend's own generation guard already stops its EXIF
 * sub-phase, but listing and sidecar restore run to completion regardless and
 * their answer must be a no-op here — and leave a second Begin culling free
 * to run (not wedged behind the double-click guard of the pass we walked
 * away from).
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

/** The last value a setState spy was called with — `.at(-1)` needs ES2022 lib
 *  and this project's tsconfig targets ES2020. */
function lastCall<T>(spy: { mock: { calls: [SetStateAction<T>][] } }): SetStateAction<T> {
  const { calls } = spy.mock;
  return calls[calls.length - 1][0];
}

function setter<T>() {
  return vi.fn((_next: SetStateAction<T>): void => {}) as unknown as Dispatch<SetStateAction<T>> & {
    mock: { calls: [SetStateAction<T>][] };
  };
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
    setPhase: setter<Phase>(),
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

describe("cancelling the analyze pass", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });
  afterEach(cleanup);

  it("returns to staged immediately and discards the late result when it lands", async () => {
    const props = makeProps();
    let resolveAnalyze!: (r: AnalyzeResult) => void;
    mockInvoke.mockImplementation(
      () =>
        new Promise<AnalyzeResult>((resolve) => {
          resolveAnalyze = resolve;
        }),
    );
    const { result } = renderHook(() => useSessionLifecycle(props));

    let beginPromise!: Promise<void>;
    await act(async () => {
      beginPromise = result.current.beginCulling();
      // Let beginCulling run up to (and start) the in-flight invoke.
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(lastCall(props.setPhase)).toBe("analyzing");

    act(() => {
      result.current.cancelAnalyze();
    });
    // Back on staged the instant Cancel is pressed — not waiting on the pass.
    expect(lastCall(props.setPhase)).toBe("staged");

    // The stale pass now resolves. Its result must be a no-op: no images
    // committed, and the phase must not flip to "culling" behind the user.
    await act(async () => {
      resolveAnalyze(analyzed());
      await beginPromise;
    });
    expect(props.setImages.mock.calls).toHaveLength(0);
    expect(lastCall(props.setPhase)).toBe("staged");
  });

  it("re-arms Begin culling immediately — before the cancelled pass's own promise ever settles", async () => {
    const props = makeProps();
    let resolveFirst!: (r: AnalyzeResult) => void;
    mockInvoke.mockImplementationOnce(
      () =>
        new Promise<AnalyzeResult>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const { result } = renderHook(() => useSessionLifecycle(props));

    let firstPromise!: Promise<void>;
    await act(async () => {
      firstPromise = result.current.beginCulling();
      await Promise.resolve();
      await Promise.resolve();
    });

    act(() => {
      result.current.cancelAnalyze();
    });

    // Retry while the FIRST pass's own promise is still pending — beginCulling's
    // finally block hasn't run yet to clear the double-click guard on its own,
    // so this only works if cancelAnalyze released it itself.
    mockInvoke.mockResolvedValueOnce(analyzed());
    await act(async () => {
      await result.current.beginCulling();
    });
    expect(mockInvoke).toHaveBeenCalledTimes(2);
    expect(props.setImages.mock.calls).toHaveLength(1);
    expect(lastCall(props.setPhase)).toBe("culling");

    // The stale first pass, resolved last, must still be a no-op.
    await act(async () => {
      resolveFirst(analyzed());
      await firstPromise;
    });
    expect(props.setImages.mock.calls).toHaveLength(1); // unchanged
    expect(lastCall(props.setPhase)).toBe("culling"); // unchanged
  });

  it("also discards a late FAILURE from a cancelled pass — no error surfaces on the staged screen", async () => {
    const props = makeProps();
    let rejectAnalyze!: (e: unknown) => void;
    mockInvoke.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectAnalyze = reject;
        }),
    );
    const { result } = renderHook(() => useSessionLifecycle(props));

    let beginPromise!: Promise<void>;
    await act(async () => {
      beginPromise = result.current.beginCulling();
      await Promise.resolve();
      await Promise.resolve();
    });

    act(() => {
      result.current.cancelAnalyze();
    });

    await act(async () => {
      rejectAnalyze(new Error("cancelled"));
      await beginPromise;
    });
    // beginCulling's own start-of-pass `setAnalyzeError(null)` still fires —
    // only the catch block's error message must be skipped.
    expect(props.setAnalyzeError.mock.calls).toHaveLength(1);
    expect(props.setAnalyzeError.mock.calls[0][0]).toBeNull();
    expect(lastCall(props.setPhase)).toBe("staged");
  });
});
