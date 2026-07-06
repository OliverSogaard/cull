import { describe, expect, it } from "vitest";
import type { ImageMetadata } from "../types";
import { mergeMeta } from "./mergeMeta";

/** All-null template so each test only sets the fields it cares about. */
const meta = (over: Partial<ImageMetadata> = {}): ImageMetadata =>
  ({
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
  }) as ImageMetadata;

describe("mergeMeta", () => {
  it("carries the previous phash forward when the incoming delivery has none", () => {
    // Thumb delivery lands first and produces the standing phash.
    const prev = meta({ phash: "abcd1234abcd1234" });
    // A later preview/full bundle read has no phash of its own (source CR3s
    // are immutable; only the thumb path computes phash) — it must not wipe it.
    const incoming = meta({ phash: null, camera: "Canon R5" });

    const merged = mergeMeta(prev, incoming);

    expect(merged.phash).toBe("abcd1234abcd1234");
    expect(merged.camera).toBe("Canon R5");
  });

  it("still carries lrcRating forward when the incoming delivery lacks it", () => {
    const prev = meta({ lrcRating: 4 });
    const incoming = meta({ lrcRating: null, camera: "Canon R5" });

    const merged = mergeMeta(prev, incoming);

    expect(merged.lrcRating).toBe(4);
    expect(merged.camera).toBe("Canon R5");
  });

  it("carries both phash and lrcRating forward together", () => {
    const prev = meta({ phash: "abcd1234abcd1234", lrcRating: 5 });
    const incoming = meta({ phash: null, lrcRating: null, camera: "Canon R5" });

    const merged = mergeMeta(prev, incoming);

    expect(merged.phash).toBe("abcd1234abcd1234");
    expect(merged.lrcRating).toBe(5);
  });

  it("takes the incoming phash when the incoming delivery actually has one", () => {
    const prev = meta({ phash: "abcd1234abcd1234" });
    const incoming = meta({ phash: "ffff0000ffff0000" });

    const merged = mergeMeta(prev, incoming);

    expect(merged.phash).toBe("ffff0000ffff0000");
  });

  it("leaves phash null when neither prev nor incoming has one", () => {
    const prev = meta({ phash: null });
    const incoming = meta({ phash: null });

    const merged = mergeMeta(prev, incoming);

    expect(merged.phash).toBeNull();
  });

  it("returns the incoming meta as-is when there is no previous entry", () => {
    const incoming = meta({ phash: null, lrcRating: null, camera: "Canon R5" });

    const merged = mergeMeta(undefined, incoming);

    expect(merged).toEqual(incoming);
  });
});
