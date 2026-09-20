import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { MetaBatcher } from "./metaBatcher";
import { makeSink, manualScheduler } from "./__fixtures__/metaBatching";
import { EMPTY_METADATA, type ImageMetadata } from "../types";

/** All-null template so each test only sets the fields it cares about. */
const meta = (over: Partial<ImageMetadata> = {}): ImageMetadata => ({
  ...EMPTY_METADATA,
  ...over,
});

describe("MetaBatcher", () => {
  test("coalesces many deliveries into one sink call per flush window", () => {
    const { scheduler, flushWindow } = manualScheduler();
    const sink = makeSink();
    const b = new MetaBatcher(scheduler);
    b.setSink(sink);
    b.push("/a.CR3", meta({ iso: 100 }));
    b.push("/b.CR3", meta({ iso: 200 }));
    expect(sink).not.toHaveBeenCalled();
    flushWindow();
    expect(sink).toHaveBeenCalledTimes(1);
    expect([...sink.mock.calls[0][0].keys()]).toEqual(["/a.CR3", "/b.CR3"]);
  });

  test("two deliveries for one path in a window keep the carry-forward fields", () => {
    const { scheduler, flushWindow } = manualScheduler();
    const sink = makeSink();
    const b = new MetaBatcher(scheduler);
    b.setSink(sink);
    b.push("/a.CR3", meta({ phash: "abc" }));
    b.push("/a.CR3", meta({ phash: null, iso: 400 }));
    flushWindow();
    expect(sink.mock.calls[0][0].get("/a.CR3")).toMatchObject({ phash: "abc", iso: 400 });
  });

  test("peek returns the pending entry before a flush, and undefined once the flush delivered it", () => {
    const { scheduler, flushWindow } = manualScheduler();
    const sink = makeSink();
    const b = new MetaBatcher(scheduler);
    b.setSink(sink);
    b.push("/a.CR3", meta({ afXPct: 30 }));
    expect(b.peek("/a.CR3")).toMatchObject({ afXPct: 30 });
    flushWindow();
    expect(b.peek("/a.CR3")).toBeUndefined();
  });

  test("peek returns undefined for a path forget() dropped", () => {
    const { scheduler } = manualScheduler();
    const sink = makeSink();
    const b = new MetaBatcher(scheduler);
    b.setSink(sink);
    b.push("/a.CR3", meta({ afXPct: 30 }));
    b.forget(new Set(["/a.CR3"]));
    expect(b.peek("/a.CR3")).toBeUndefined();
  });

  test("peek returns undefined after clear (hardReset)", () => {
    const { scheduler } = manualScheduler();
    const sink = makeSink();
    const b = new MetaBatcher(scheduler);
    b.setSink(sink);
    b.push("/a.CR3", meta({ afXPct: 30 }));
    b.clear();
    expect(b.peek("/a.CR3")).toBeUndefined();
  });

  // imageStore.reset() deliberately never calls forget()/clear() on the
  // batcher (thumbs survive reset()) — that reset-survival property is
  // covered at the imageStore level by imageStore.test.ts's "pendingMetaFor
  // still sees the entry after reset() — reset deliberately keeps the
  // queue". This test only covers the batcher's own contract: peek is keyed
  // per path, so an unrelated delivery cannot disturb it.
  test("an unrelated delivery does not disturb a pending entry", () => {
    const { scheduler } = manualScheduler();
    const sink = makeSink();
    const b = new MetaBatcher(scheduler);
    b.setSink(sink);
    b.push("/a.CR3", meta({ afXPct: 30 }));
    b.push("/b.CR3", meta({ afXPct: 70 })); // an unrelated delivery must not disturb it
    expect(b.peek("/a.CR3")).toMatchObject({ afXPct: 30 });
  });

  test("forget drops pending entries for gone paths", () => {
    const { scheduler, flushWindow } = manualScheduler();
    const sink = makeSink();
    const b = new MetaBatcher(scheduler);
    b.setSink(sink);
    b.push("/a.CR3", meta({}));
    b.push("/b.CR3", meta({}));
    b.forget(new Set(["/a.CR3"]));
    flushWindow();
    expect([...sink.mock.calls[0][0].keys()]).toEqual(["/b.CR3"]);
  });

  test("clear cancels the pending flush and delivers nothing", () => {
    const { scheduler, flushWindow, hasPendingFlush } = manualScheduler();
    const sink = makeSink();
    const b = new MetaBatcher(scheduler);
    b.setSink(sink);
    b.push("/a.CR3", meta({}));
    b.clear();
    expect(hasPendingFlush()).toBe(false);
    flushWindow();
    expect(sink).not.toHaveBeenCalled();
  });

  test("deliveries with no sink are dropped, and a new window is armed after a flush", () => {
    const { scheduler, flushWindow } = manualScheduler();
    const b = new MetaBatcher(scheduler);
    b.push("/a.CR3", meta({}));
    const sink = makeSink();
    b.setSink(sink);
    flushWindow();
    expect(sink).not.toHaveBeenCalled();
    b.push("/b.CR3", meta({}));
    flushWindow();
    b.push("/c.CR3", meta({}));
    flushWindow();
    expect(sink).toHaveBeenCalledTimes(2);
  });

  test("a pending batch survives a sink swap and flushes to the new sink", () => {
    const { scheduler, flushWindow, hasPendingFlush } = manualScheduler();
    const first = makeSink();
    const b = new MetaBatcher(scheduler);
    b.setSink(first);
    b.push("/a.CR3", meta({ phash: "abc" }));

    // Unmount: the pending flush is cancelled, but the delivery must NOT be lost
    // the thumb behind it already landed and is never re-fetched.
    b.setSink(undefined);
    expect(hasPendingFlush()).toBe(false);

    // Remount re-arms the window and the kept delivery reaches the new sink.
    const second = makeSink();
    b.setSink(second);
    expect(hasPendingFlush()).toBe(true);
    flushWindow();

    expect(first).not.toHaveBeenCalled();
    expect([...second.mock.calls[0][0].keys()]).toEqual(["/a.CR3"]);
    expect(second.mock.calls[0][0].get("/a.CR3")?.phash).toBe("abc");
  });
});

// The default scheduler is the one that actually ships, so its clock is pinned
// here rather than left to the manual scheduler the tests above inject. 100 ms,
// not a frame: on a 240 Hz panel rAF fires every 4.2 ms, which coalesced only
// ~2 of the ~480 deliveries/s the thumb sweep produces (measured, 2 726-frame
// shoot).
describe("MetaBatcher — default flush window", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("withholds deliveries until 100 ms have passed, then sends one batch", () => {
    const sink = makeSink();
    const b = new MetaBatcher();
    b.setSink(sink);
    b.push("/a.CR3", meta({ iso: 100 }));
    b.push("/b.CR3", meta({ iso: 200 }));

    vi.advanceTimersByTime(99);
    expect(sink).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(sink).toHaveBeenCalledTimes(1);
    expect([...sink.mock.calls[0][0].keys()]).toEqual(["/a.CR3", "/b.CR3"]);
  });

  test("a push after a flush arms a fresh 100 ms window", () => {
    const sink = makeSink();
    const b = new MetaBatcher();
    b.setSink(sink);
    b.push("/a.CR3", meta({}));
    vi.advanceTimersByTime(100);
    expect(sink).toHaveBeenCalledTimes(1);

    b.push("/b.CR3", meta({}));
    vi.advanceTimersByTime(99);
    expect(sink).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    expect(sink).toHaveBeenCalledTimes(2);
    expect([...sink.mock.calls[1][0].keys()]).toEqual(["/b.CR3"]);
  });
});
