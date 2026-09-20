// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { runAnalysis } from "./analysisDriver";
import { useSmartCulling } from "./useSmartCulling";
import { img, score } from "./__fixtures__/testScores";
import type { DriverDeps } from "./analysisDriver";
import type { Img } from "../types/image";

/**
 * The session-identity contract of the smart-culling driver: "Move rejects"
 * hands the hook a SHORTER array of the same frames (`pruneMoved`), which used
 * to read as a brand-new session — every score wiped and, with analyze-on-open,
 * the whole remaining shoot re-inferred. These tests pin the prune as a
 * non-event for the pass, while a genuinely different folder still resets.
 *
 * `runAnalysis` (the separately-tested engine) is mocked so each pass is a
 * promise the test resolves and a `deps` handle the test drives directly —
 * that is the only way to land scores at a chosen moment relative to a prune.
 */

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../image/imageStore", () => ({
  imageStore: { getGeneration: () => 1, isBusyLoading: () => false },
}));
// PARTIAL mock: the hook also imports LOCAL_CHUNK / NET_CHUNK / the idle
// constants from this module, so only `runAnalysis` may be replaced.
vi.mock("./analysisDriver", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./analysisDriver")>()),
  runAnalysis: vi.fn(),
}));

const mockRunAnalysis = vi.mocked(runAnalysis);

/** The hook's FIRST_SCREENFUL_DELAY_MS head start (module-private). */
const HEAD_START_MS = 1200;

/** One dispatched pass: the engine deps the hook injected, plus the resolver
 *  that ends the pass (the hook's `.finally` clears its running latch). */
type Pass = { deps: DriverDeps; finish: () => void };

const passes: Pass[] = [];

/** Stable across rerenders so the catch-up effect doesn't churn. */
const NO_RATINGS: ReadonlySet<number> = new Set<number>();

function renderDriver(images: readonly Img[]) {
  return renderHook(
    (props: { images: readonly Img[] }) =>
      useSmartCulling({
        enabled: true,
        autoStart: true,
        active: true,
        ml: false,
        images: props.images,
        ratedIds: NO_RATINGS,
        storageMode: "local",
      }),
    { initialProps: { images } },
  );
}

function tick(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

/** Scores for the whole dispatched list, in dispatch order. */
function scoresFor(count: number) {
  return Array.from({ length: count }, (_, index) => score({ index }));
}

describe("useSmartCulling — a prune is not a new session", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    passes.length = 0;
    mockRunAnalysis.mockReset();
    mockRunAnalysis.mockImplementation((_paths, _gen, deps) => {
      let finish = (): void => {};
      const ended = new Promise<"done" | "stale">((resolve) => {
        finish = () => {
          resolve("done");
        };
      });
      passes.push({ deps, finish });
      return ended;
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  test("keeps scores across a prune and does not re-run the pass", async () => {
    const [i0, i1, i2] = [img(0), img(1), img(2)];
    const { result, rerender } = renderDriver([i0, i1, i2]);

    tick(HEAD_START_MS);
    expect(mockRunAnalysis).toHaveBeenCalledTimes(1);

    const pass = passes[0];
    act(() => {
      pass.deps.onScores(scoresFor(3));
    });
    await act(async () => {
      pass.finish();
    });
    expect(Object.keys(result.current.scores)).toEqual(["0", "1", "2"]);

    // "Move rejects" pruned frame 1 — same Img objects, shorter array.
    rerender({ images: [i0, i2] });

    expect(Object.keys(result.current.scores)).toEqual(["0", "2"]);
    // Well past the head start AND the catch-up debounce: no second pass.
    tick(5000);
    expect(mockRunAnalysis).toHaveBeenCalledTimes(1);
  });

  test("a different folder resets the scores and re-runs", async () => {
    const { result, rerender } = renderDriver([img(0), img(1), img(2)]);

    tick(HEAD_START_MS);
    const pass = passes[0];
    act(() => {
      pass.deps.onScores(scoresFor(3));
    });
    await act(async () => {
      pass.finish();
    });
    expect(Object.keys(result.current.scores)).toEqual(["0", "1", "2"]);

    // Another folder, ids reused from 0 — nothing carries over. SHORTER than
    // the original three on purpose: a same-length array would exit
    // isPrunedSubset on the length check alone, so only a shorter one proves
    // the path compare is what rejects the new folder.
    rerender({ images: [img(0, "/shoot/b"), img(1, "/shoot/b")] });

    expect(result.current.scores).toEqual({});
    tick(HEAD_START_MS);
    expect(mockRunAnalysis).toHaveBeenCalledTimes(2);
  });

  test("scores for frames pruned mid-pass are not inserted", () => {
    const [i0, i1, i2] = [img(0), img(1), img(2)];
    const { result, rerender } = renderDriver([i0, i1, i2]);

    tick(HEAD_START_MS);
    expect(mockRunAnalysis).toHaveBeenCalledTimes(1);

    // The prune lands while the pass is still in flight.
    rerender({ images: [i0, i2] });
    act(() => {
      passes[0].deps.onScores(scoresFor(3));
    });

    expect(Object.keys(result.current.scores)).toEqual(["0", "2"]);
  });
});
