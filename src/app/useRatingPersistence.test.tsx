// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { useRatingPersistence } from "./useRatingPersistence";

/**
 * Rating-write durability, from the outside: what the chrome is allowed to say
 * about a write that didn't land.
 *
 * The distinction under test is PERMANENCE. The backend refuses to write a
 * sidecar for a photo that is no longer at its path (`source missing:`), and no
 * amount of retrying can bring it back — so such a write is counted in
 * `missingCount` as well as `failedCount`, and `retryFailed()` leaves it alone.
 * Every other failure keeps the 400/1500/4000 ms retry schedule and stays
 * retryable.
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

  it("retryFailed re-attempts the retryable path and skips the missing one", async () => {
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
    act(() => {
      result.current.retryFailed();
    });
    await settleWrites();

    // Only the flaky path is written again — retrying the gone one would just
    // re-collect the same refusal. The count says so explicitly: one fresh
    // attempt plus its three retry slots, and not a single call for GONE.
    expect(new Set(writtenPaths())).toEqual(new Set([FLAKY]));
    expect(mockInvoke).toHaveBeenCalledTimes(4);
    expect(result.current.failedCount).toBe(2);
    expect(result.current.missingCount).toBe(1);
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

  it("a successful retry of the retryable half leaves only the missing one", async () => {
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

    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(undefined);
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
