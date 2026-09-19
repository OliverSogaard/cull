import { describe, expect, test } from "vitest";
import { MetaBatcher } from "./metaBatcher";
import { makeSink, manualScheduler } from "./__fixtures__/metaBatching";
import { EMPTY_METADATA, type ImageMetadata } from "../types";

/** All-null template so each test only sets the fields it cares about. */
const meta = (over: Partial<ImageMetadata> = {}): ImageMetadata => ({
  ...EMPTY_METADATA,
  ...over,
});

describe("MetaBatcher", () => {
  test("coalesces many deliveries into one sink call per frame", () => {
    const { scheduler, frame } = manualScheduler();
    const sink = makeSink();
    const b = new MetaBatcher(scheduler);
    b.setSink(sink);
    b.push("/a.CR3", meta({ iso: 100 }));
    b.push("/b.CR3", meta({ iso: 200 }));
    expect(sink).not.toHaveBeenCalled();
    frame();
    expect(sink).toHaveBeenCalledTimes(1);
    expect([...sink.mock.calls[0][0].keys()]).toEqual(["/a.CR3", "/b.CR3"]);
  });

  test("two deliveries for one path in a frame keep the carry-forward fields", () => {
    const { scheduler, frame } = manualScheduler();
    const sink = makeSink();
    const b = new MetaBatcher(scheduler);
    b.setSink(sink);
    b.push("/a.CR3", meta({ phash: "abc" }));
    b.push("/a.CR3", meta({ phash: null, iso: 400 }));
    frame();
    expect(sink.mock.calls[0][0].get("/a.CR3")).toMatchObject({ phash: "abc", iso: 400 });
  });

  test("forget drops pending entries for gone paths", () => {
    const { scheduler, frame } = manualScheduler();
    const sink = makeSink();
    const b = new MetaBatcher(scheduler);
    b.setSink(sink);
    b.push("/a.CR3", meta({}));
    b.push("/b.CR3", meta({}));
    b.forget(new Set(["/a.CR3"]));
    frame();
    expect([...sink.mock.calls[0][0].keys()]).toEqual(["/b.CR3"]);
  });

  test("clear cancels the frame and delivers nothing", () => {
    const { scheduler, frame, hasFrame } = manualScheduler();
    const sink = makeSink();
    const b = new MetaBatcher(scheduler);
    b.setSink(sink);
    b.push("/a.CR3", meta({}));
    b.clear();
    expect(hasFrame()).toBe(false);
    frame();
    expect(sink).not.toHaveBeenCalled();
  });

  test("deliveries with no sink are dropped, and a new frame is requested after a flush", () => {
    const { scheduler, frame } = manualScheduler();
    const b = new MetaBatcher(scheduler);
    b.push("/a.CR3", meta({}));
    const sink = makeSink();
    b.setSink(sink);
    frame();
    expect(sink).not.toHaveBeenCalled();
    b.push("/b.CR3", meta({}));
    frame();
    b.push("/c.CR3", meta({}));
    frame();
    expect(sink).toHaveBeenCalledTimes(2);
  });

  test("a pending batch survives a sink swap and flushes to the new sink", () => {
    const { scheduler, frame, hasFrame } = manualScheduler();
    const first = makeSink();
    const b = new MetaBatcher(scheduler);
    b.setSink(first);
    b.push("/a.CR3", meta({ phash: "abc" }));

    // Unmount: the frame is cancelled, but the delivery must NOT be lost —
    // the thumb behind it already landed and is never re-fetched.
    b.setSink(undefined);
    expect(hasFrame()).toBe(false);

    // Remount re-arms the frame and the kept delivery reaches the new sink.
    const second = makeSink();
    b.setSink(second);
    expect(hasFrame()).toBe(true);
    frame();

    expect(first).not.toHaveBeenCalled();
    expect([...second.mock.calls[0][0].keys()]).toEqual(["/a.CR3"]);
    expect(second.mock.calls[0][0].get("/a.CR3")?.phash).toBe("abc");
  });
});
