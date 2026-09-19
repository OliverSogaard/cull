import { describe, expect, test, vi } from "vitest";
import { MetaBatcher, type FrameScheduler, type MetaBatch } from "./metaBatcher";
import type { ImageMetadata } from "../types";

function manualScheduler() {
  let queued: (() => void) | null = null;
  const scheduler: FrameScheduler = {
    request: (cb) => {
      queued = cb;
      return 1;
    },
    cancel: () => {
      queued = null;
    },
  };
  return { scheduler, frame: () => queued?.(), hasFrame: () => queued !== null };
}

/** All-null template so each test only sets the fields it cares about
 *  (mirrors the helper in src/utils/mergeMeta.test.ts — EMPTY_METADATA is a
 *  private const of useSessionLifecycle, not importable). */
const meta = (over: Partial<ImageMetadata> = {}): ImageMetadata => ({
  capturedAt: null,
  subSecMs: null,
  camera: null,
  lens: null,
  focalLengthMm: null,
  aperture: null,
  shutterSeconds: null,
  iso: null,
  gpsLat: null,
  gpsLon: null,
  afXPct: null,
  afYPct: null,
  exposureBias: null,
  whiteBalance: null,
  driveMode: null,
  pixelWidth: null,
  pixelHeight: null,
  fileSize: null,
  lrcRating: null,
  phash: null,
  ...over,
});

// Typed spy: a bare vi.fn() types mock.calls as any[][] and fails the
// no-unsafe-* lint rules that stay on for test files.
const makeSink = () => vi.fn((_batch: MetaBatch) => {});

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
});
