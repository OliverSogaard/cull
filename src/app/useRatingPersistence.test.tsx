// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { useRatingPersistence } from "./useRatingPersistence";

/**
 * Rating-write durability, from the outside: what the chrome is allowed to say
 * about a write that didn't land.
 *
 * The distinction under test is the RETRY SCHEDULE, not whether a retry may
 * happen at all. The backend refuses to write a sidecar for a photo that is not
 * at its path (`source missing:`), and hammering that refusal on a timer only
 * delays the honest "didn't save" — so such a write is counted in
 * `missingCount` as well as `failedCount` and gets ONE attempt, no schedule.
 * Every other failure keeps the 400/1500/4000 ms schedule.
 *
 * A deliberate `retryFailed()` is a different thing: the drive or NAS the photo
 * lives on may have come back since, so it re-attempts every failure including
 * the missing ones — once each, fail fast.
 *
 * Fake timers drive that schedule; `settleWrites` advances past all three
 * slots and drains the promise chain the per-path write queue is built from.
 */

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const mockInvoke = vi.mocked(invoke);

/** The hook's WRITE_RETRY_DELAYS (module-private) — 400 + 1500 + 4000. */
const RETRY_SCHEDULE_MS = 5900;

/** The backend's missing-source refusal (`xmp.rs` MISSING_SOURCE). */
const MISSING = "source missing: C:\\shoot\\gone.cr3 is not a file";
/** A transient failure — the kind the retry schedule exists for. */
const TRANSIENT = "rename xmp: EACCES";

const GONE = "C:\\shoot\\gone.cr3";
const FLAKY = "C:\\shoot\\flaky.cr3";
/** A frame whose UNRATE (clear) is the write that got stuck. */
const STUCK = "C:\\shoot\\stuck.cr3";

/** Run every pending retry timer and let the write queue's promises settle. */
async function settleWrites(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(RETRY_SCHEDULE_MS);
  });
}

/** Let the per-path write queue advance one link without running a timer — the
 *  queue chains through `.then`, so the first write is issued in a microtask,
 *  not synchronously inside `act`. */
async function drainMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** The `path` argument of each invoke call, narrowed without a cast. */
function writtenPaths(): string[] {
  return mockInvoke.mock.calls.map(([, args]) =>
    typeof args === "object" && args !== null && "path" in args && typeof args.path === "string"
      ? args.path
      : "",
  );
}

describe("useRatingPersistence — a missing photo is a permanent failure", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockInvoke.mockReset();
    // The hook logs every exhausted write; the suite asserts the counts, not
    // the log, and a pristine test output is worth more than the noise.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("counts a missing-source refusal in both failedCount and missingCount, without retrying", async () => {
    mockInvoke.mockRejectedValue(new Error(MISSING));
    const { result } = renderHook(() => useRatingPersistence());

    act(() => {
      result.current.persistRating(GONE, "keep");
    });
    await settleWrites();

    expect(result.current.failedCount).toBe(1);
    expect(result.current.missingCount).toBe(1);
    expect(result.current.savingCount).toBe(0);
    // isPermanentWriteError short-circuits the schedule: one attempt, no retries.
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it("leaves a retryable failure out of missingCount after the whole schedule", async () => {
    mockInvoke.mockRejectedValue(new Error(TRANSIENT));
    const { result } = renderHook(() => useRatingPersistence());

    act(() => {
      result.current.persistRating(FLAKY, "reject");
    });
    await settleWrites();

    expect(result.current.failedCount).toBe(1);
    expect(result.current.missingCount).toBe(0);
    // First attempt + the three WRITE_RETRY_DELAYS slots.
    expect(mockInvoke).toHaveBeenCalledTimes(4);
  });

  it("retryFailed re-attempts the retryable path and re-checks the missing one", async () => {
    const { result } = renderHook(() => useRatingPersistence());

    mockInvoke.mockRejectedValue(new Error(MISSING));
    act(() => {
      result.current.persistRating(GONE, "keep");
    });
    await settleWrites();

    mockInvoke.mockRejectedValue(new Error(TRANSIENT));
    act(() => {
      result.current.persistRating(FLAKY, "reject");
    });
    await settleWrites();

    expect(result.current.failedCount).toBe(2);
    expect(result.current.missingCount).toBe(1);

    mockInvoke.mockClear();
    mockInvoke.mockImplementation((_cmd, args) =>
      typeof args === "object" && args !== null && "path" in args && args.path === GONE
        ? Promise.reject(new Error(MISSING))
        : Promise.reject(new Error(TRANSIENT)),
    );
    act(() => {
      result.current.retryFailed();
    });
    await settleWrites();

    // BOTH paths are written again: a missing photo is missing because a drive
    // or folder went away, and the user clicking "check again" is saying it may
    // be back. The missing one still gets no SCHEDULE — exactly one attempt,
    // against the flaky one's fresh attempt plus its three retry slots.
    const retried = writtenPaths();
    expect(retried.filter((path) => path === GONE)).toHaveLength(1);
    expect(retried.filter((path) => path === FLAKY)).toHaveLength(4);
    expect(result.current.failedCount).toBe(2);
    expect(result.current.missingCount).toBe(1);
  });

  it("retryFailed saves a missing photo whose drive came back, clearing both counts", async () => {
    mockInvoke.mockRejectedValue(new Error(MISSING));
    const { result } = renderHook(() => useRatingPersistence());

    act(() => {
      result.current.persistRating(GONE, "favorite");
    });
    await settleWrites();
    expect(result.current.failedCount).toBe(1);
    expect(result.current.missingCount).toBe(1);

    // The NAS is awake again, so the same write the outage refused now lands.
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(undefined);
    act(() => {
      result.current.retryFailed();
    });
    await settleWrites();

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith("write_xmp_rating", { path: GONE, rating: "favorite" });
    expect(result.current.failedCount).toBe(0);
    expect(result.current.missingCount).toBe(0);
  });

  it("retryFailed re-submits the rating each failed write carried", async () => {
    mockInvoke.mockRejectedValue(new Error(TRANSIENT));
    const { result } = renderHook(() => useRatingPersistence());

    act(() => {
      result.current.persistRating(FLAKY, "favorite");
    });
    await settleWrites();
    act(() => {
      result.current.persistRating(STUCK, null); // an unrate that didn't land
    });
    await settleWrites();
    expect(result.current.failedCount).toBe(2);

    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(undefined);
    act(() => {
      result.current.retryFailed();
    });
    await settleWrites();

    // The verdict is replayed, not re-derived: a favorite retries as a favorite
    // (not a plain keep), and a stuck unrate retries as an unrate.
    expect(mockInvoke).toHaveBeenCalledTimes(2);
    expect(mockInvoke).toHaveBeenCalledWith("write_xmp_rating", {
      path: FLAKY,
      rating: "favorite",
    });
    expect(mockInvoke).toHaveBeenCalledWith("clear_xmp_rating", { path: STUCK });
    expect(result.current.failedCount).toBe(0);
  });

  it("a later successful write to the same path clears it from both counts", async () => {
    mockInvoke.mockRejectedValue(new Error(MISSING));
    const { result } = renderHook(() => useRatingPersistence());

    act(() => {
      result.current.persistRating(GONE, "keep");
    });
    await settleWrites();
    expect(result.current.failedCount).toBe(1);
    expect(result.current.missingCount).toBe(1);

    // The photo is back (or the user re-rated it) and the write lands.
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(undefined);
    act(() => {
      result.current.persistRating(GONE, "reject");
    });
    await settleWrites();

    expect(result.current.failedCount).toBe(0);
    expect(result.current.missingCount).toBe(0);
    expect(result.current.savingCount).toBe(0);
  });

  it("a resolving unrate clears a path that was counted missing", async () => {
    mockInvoke.mockRejectedValue(new Error(MISSING));
    const { result } = renderHook(() => useRatingPersistence());

    act(() => {
      result.current.persistRating(GONE, "keep");
    });
    await settleWrites();
    expect(result.current.missingCount).toBe(1);

    // Undo on a frame whose file has gone: the backend's clear is a no-op it
    // accepts, so the path leaves both counts rather than sitting there
    // permanently flagged for a rating the user has since taken back.
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(undefined);
    act(() => {
      result.current.persistRating(GONE, null);
    });
    await settleWrites();

    expect(mockInvoke).toHaveBeenCalledWith("clear_xmp_rating", { path: GONE });
    expect(result.current.failedCount).toBe(0);
    expect(result.current.missingCount).toBe(0);
  });

  it("a superseded missing-source refusal never reaches the counts", async () => {
    const { result } = renderHook(() => useRatingPersistence());

    // The refusal takes its time coming back — long enough for the user to
    // re-rate the same frame before it lands. Promise<never>: it only rejects.
    mockInvoke.mockImplementationOnce(
      () =>
        new Promise<never>((_resolve, reject) => {
          window.setTimeout(() => {
            reject(new Error(MISSING));
          }, 3000);
        }),
    );
    mockInvoke.mockResolvedValue(undefined);

    act(() => {
      result.current.persistRating(GONE, "keep");
    });
    act(() => {
      result.current.persistRating(GONE, "reject"); // supersedes the write above
    });
    await settleWrites();

    // Only the LATEST write to a path owns its verdict (the hook's writeSeq
    // guard). An older refusal arriving after a newer write succeeded must not
    // stamp a phantom failure — least of all a permanent one, which would
    // block the finish dialog for a photo that is provably still there.
    expect(result.current.failedCount).toBe(0);
    expect(result.current.missingCount).toBe(0);
    expect(result.current.savingCount).toBe(0);
  });

  it("a successful retry of the retryable half leaves only the still-missing one", async () => {
    const { result } = renderHook(() => useRatingPersistence());

    mockInvoke.mockRejectedValue(new Error(MISSING));
    act(() => {
      result.current.persistRating(GONE, "keep");
    });
    await settleWrites();

    mockInvoke.mockRejectedValue(new Error(TRANSIENT));
    act(() => {
      result.current.persistRating(FLAKY, "reject");
    });
    await settleWrites();

    // The flaky write lands this time; the photo is still not where it was.
    mockInvoke.mockReset();
    mockInvoke.mockImplementation((_cmd, args) =>
      typeof args === "object" && args !== null && "path" in args && args.path === GONE
        ? Promise.reject(new Error(MISSING))
        : Promise.resolve(undefined),
    );
    act(() => {
      result.current.retryFailed();
    });
    await settleWrites();

    // failedCount never drops below the permanent failure, so the quit guard
    // still refuses to lose it silently.
    expect(result.current.failedCount).toBe(1);
    expect(result.current.missingCount).toBe(1);
  });
});

describe("useRatingPersistence — stars and labels share the photo, not the verdict", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockInvoke.mockReset();
    // Same reason as the suite above: the hook logs every exhausted write, and
    // these tests assert the counts rather than the log.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("sends each kind to its own command, with null meaning clear", async () => {
    mockInvoke.mockResolvedValue(undefined);
    const { result } = renderHook(() => useRatingPersistence());
    act(() => {
      result.current.persistStar(FLAKY, 3);
      result.current.persistLabel(FLAKY, "red");
      result.current.persistStar(FLAKY, null);
      result.current.persistLabel(FLAKY, null);
    });
    await settleWrites();
    expect(mockInvoke.mock.calls.map(([cmd]) => cmd)).toEqual([
      "write_xmp_star",
      "write_xmp_label",
      "write_xmp_star",
      "write_xmp_label",
    ]);
    expect(mockInvoke.mock.calls.map(([, args]) => args)).toEqual([
      { path: FLAKY, star: 3 },
      { path: FLAKY, label: "red" },
      { path: FLAKY, star: null },
      { path: FLAKY, label: null },
    ]);
  });

  it("serialises all three kinds for ONE photo — they edit one file", async () => {
    // The sidecar write is read-modify-write. Two of these overlapping would
    // lose whichever read first, which is why the queue is keyed by PATH and
    // not by kind.
    const releases: (() => void)[] = [];
    mockInvoke.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releases.push(resolve);
        }),
    );
    const { result } = renderHook(() => useRatingPersistence());
    act(() => {
      result.current.persistRating(FLAKY, "keep");
      result.current.persistStar(FLAKY, 3);
      result.current.persistLabel(FLAKY, "blue");
    });
    await drainMicrotasks();
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke.mock.calls[0][0]).toBe("write_xmp_rating");
    await act(async () => {
      releases[releases.length - 1]?.();
    });
    expect(mockInvoke).toHaveBeenCalledTimes(2);
    expect(mockInvoke.mock.calls[1][0]).toBe("write_xmp_star");
  });

  it("a star write never clears a rating's unsaved flag for the same photo", async () => {
    // Keyed by path alone, the star's issue-time "this path has a fresh
    // write" sweep would have deleted the rating's failure — and the rating
    // still would not be on disk.
    mockInvoke.mockRejectedValue(new Error(TRANSIENT));
    const { result } = renderHook(() => useRatingPersistence());
    act(() => {
      result.current.persistRating(STUCK, "reject");
    });
    await settleWrites();
    expect(result.current.failedCount).toBe(1);

    mockInvoke.mockResolvedValue(undefined);
    act(() => {
      result.current.persistStar(STUCK, 2);
    });
    await settleWrites();
    expect(result.current.failedCount, "the rating is still unsaved").toBe(1);

    // …and a fresh RATING write to the same path still clears it.
    act(() => {
      result.current.persistRating(STUCK, "reject");
    });
    await settleWrites();
    expect(result.current.failedCount).toBe(0);
  });

  it("retryFailed re-issues each stuck write with its own command and value", async () => {
    mockInvoke.mockRejectedValue(new Error(TRANSIENT));
    const { result } = renderHook(() => useRatingPersistence());
    act(() => {
      result.current.persistStar(FLAKY, 5);
      result.current.persistLabel(GONE, "yellow");
    });
    await settleWrites();
    expect(result.current.failedCount).toBe(2);

    mockInvoke.mockClear();
    mockInvoke.mockResolvedValue(undefined);
    act(() => {
      result.current.retryFailed();
    });
    await settleWrites();
    // Sorted by command so the two retries' order in the queue does not decide
    // whether the test passes. Objects rather than tuples: `invoke`'s args
    // parameter is optional, so a tuple's members type as possibly-undefined
    // and the comparator would not typecheck.
    const reissued = mockInvoke.mock.calls
      .map(([cmd, args]) => ({ cmd, args }))
      .sort((a, b) => (a.cmd < b.cmd ? -1 : 1));
    expect(reissued).toEqual([
      { cmd: "write_xmp_label", args: { path: GONE, label: "yellow" } },
      { cmd: "write_xmp_star", args: { path: FLAKY, star: 5 } },
    ]);
    expect(result.current.failedCount).toBe(0);
  });

  it("a missing-source refusal is permanent for a star too — one attempt, no schedule", async () => {
    // The `source missing:` no-retry rule is not a property of the RATING
    // command: it is a property of the sidecar write, so it has to cover the
    // two new kinds as well, or a star aimed at a moved photo would hammer a
    // refusal on a timer.
    mockInvoke.mockRejectedValue(new Error(MISSING));
    const { result } = renderHook(() => useRatingPersistence());
    act(() => {
      result.current.persistLabel(GONE, "green");
    });
    await settleWrites();
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(result.current.failedCount).toBe(1);
    expect(result.current.missingCount).toBe(1);

    // A transient star failure keeps the 400/1500/4000 ms schedule.
    mockInvoke.mockReset();
    mockInvoke.mockRejectedValue(new Error(TRANSIENT));
    act(() => {
      result.current.persistStar(FLAKY, 4);
    });
    await settleWrites();
    expect(mockInvoke).toHaveBeenCalledTimes(4);
    expect(result.current.missingCount).toBe(1);
  });
});
