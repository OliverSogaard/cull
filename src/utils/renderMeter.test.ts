import { describe, expect, test } from "vitest";
import { createRenderMeter } from "./renderMeter";

describe("createRenderMeter", () => {
  test("accumulates commits, total and max duration, and derives", () => {
    let t = 1000;
    const meter = createRenderMeter(() => t);
    meter.record(2.5);
    meter.record(7.25);
    meter.bumpDerive();
    t = 4000;
    expect(meter.snapshot()).toEqual({
      commits: 2,
      totalMs: 9.8,
      maxMs: 7.3,
      derives: 1,
      elapsedS: 3,
    });
  });

  test("reset zeroes the counters and restarts the clock", () => {
    let t = 0;
    const meter = createRenderMeter(() => t);
    meter.record(5);
    meter.bumpDerive();
    t = 9000;
    meter.reset();
    t = 10000;
    expect(meter.snapshot()).toEqual({ commits: 0, totalMs: 0, maxMs: 0, derives: 0, elapsedS: 1 });
  });
});
