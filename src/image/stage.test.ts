import { describe, expect, it } from "vitest";
import { resolveStage, type ImageState } from "./stage";

const base: ImageState = { thumb: undefined, full: undefined };

describe("resolveStage", () => {
  it("nothing -> shimmer", () => expect(resolveStage(base).stage).toBe("shimmer"));
  it("thumb only -> thumb", () => {
    const s = resolveStage({ ...base, thumb: { url: "t", dims: { w: 6, h: 4 } } });
    expect(s.stage).toBe("thumb"); expect(s.url).toBe("t"); expect(s.dims).toEqual({ w: 6, h: 4 });
  });
  it("full wins over thumb regardless of order", () => {
    const s = resolveStage({ thumb: { url: "t", dims: { w: 6, h: 4 } }, full: { status: "ready", url: "f", dims: { w: 6, h: 4 } } });
    expect(s.stage).toBe("full"); expect(s.url).toBe("f");
  });
  it("evicted full -> thumb, not shimmer", () => {
    expect(resolveStage({ thumb: { url: "t", dims: { w: 6, h: 4 } }, full: undefined }).stage).toBe("thumb");
  });
  it("full error with thumb -> thumb", () => {
    const s = resolveStage({ thumb: { url: "t", dims: { w: 6, h: 4 } }, full: { status: "error", error: "boom" } });
    expect(s.stage).toBe("thumb"); expect(s.error).toBe("boom");
  });
  it("full error no thumb -> shimmer + error", () => {
    const s = resolveStage({ thumb: undefined, full: { status: "error", error: "boom" } });
    expect(s.stage).toBe("shimmer"); expect(s.error).toBe("boom");
  });
  it("dims from thumb when full not ready", () => {
    expect(resolveStage({ thumb: { url: "t", dims: { w: 3, h: 2 } }, full: { status: "loading" } }).dims).toEqual({ w: 3, h: 2 });
  });
});
