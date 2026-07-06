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

  // The full can land BEFORE the thumb (big scrub jump) — the store freezes it
  // with the {1,1} UNKNOWN sentinel. Resolution must recover real dims from
  // the thumb / dims cache the moment they exist, or the frame is stuck on
  // the neutral-square matte forever (and the settle-time hi-res layer,
  // whose top-left anchoring assumes matte AR == image AR, paints a
  // misaligned second copy — the "seam" bug).
  it("full ready with UNKNOWN dims + thumb -> thumb dims stand in", () => {
    const s = resolveStage({
      thumb: { url: "t", dims: { w: 3, h: 2 } },
      full: { status: "ready", url: "f", dims: { w: 1, h: 1 } },
    });
    expect(s.stage).toBe("full");
    expect(s.dims).toEqual({ w: 3, h: 2 });
  });
  it("full ready with UNKNOWN dims + dims cache -> cache stands in", () => {
    const s = resolveStage({
      thumb: undefined,
      full: { status: "ready", url: "f", dims: { w: 1, h: 1 } },
      knownDims: { w: 3, h: 2 },
    });
    expect(s.dims).toEqual({ w: 3, h: 2 });
  });
  it("full ready with UNKNOWN dims and no other source -> stays unknown", () => {
    const s = resolveStage({
      thumb: undefined,
      full: { status: "ready", url: "f", dims: { w: 1, h: 1 } },
    });
    expect(s.dims).toEqual({ w: 1, h: 1 });
  });
  it("real full dims always win over thumb dims", () => {
    const s = resolveStage({
      thumb: { url: "t", dims: { w: 3, h: 2 } },
      full: { status: "ready", url: "f", dims: { w: 6, h: 4 } },
    });
    expect(s.dims).toEqual({ w: 6, h: 4 });
  });

  // The 8-away flash (thumb-flash-report §"The 8-away flash"): thumb cells must
  // be able to keep rendering the THUMB blob when the nav preview lands for the
  // same path — `url` flips to the preview, so Resolved must carry the thumb
  // tier separately or the strip/grid <img src> swaps blobs and flashes blank
  // while WebKit decodes the 1620×1080 preview.
  it("thumbUrl exposes the thumb tier in the thumb stage", () => {
    const s = resolveStage({ ...base, thumb: { url: "t", dims: { w: 6, h: 4 } } });
    expect(s.thumbUrl).toBe("t");
  });
  it("thumbUrl STILL exposes the thumb tier when the full is ready (url flips, thumbUrl must not)", () => {
    const s = resolveStage({
      thumb: { url: "t", dims: { w: 6, h: 4 } },
      full: { status: "ready", url: "f", dims: { w: 6, h: 4 } },
    });
    expect(s.url).toBe("f");
    expect(s.thumbUrl).toBe("t");
  });
  it("thumbUrl is undefined when no thumb exists (preview-first fallback stays possible)", () => {
    const s = resolveStage({
      thumb: undefined,
      full: { status: "ready", url: "f", dims: { w: 6, h: 4 } },
    });
    expect(s.thumbUrl).toBeUndefined();
    expect(s.url).toBe("f");
  });
});
