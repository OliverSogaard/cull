import { describe, expect, it } from "vitest";
import { EMPTY_METADATA, type ImageMetadata } from "../types";
import { applyMetaBatch, mergeMeta, seedLrcMeta } from "./mergeMeta";

/** All-null template so each test only sets the fields it cares about. */
const meta = (over: Partial<ImageMetadata> = {}): ImageMetadata => ({
  ...EMPTY_METADATA,
  ...over,
});

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

describe("applyMetaBatch", () => {
  it("returns the same object for an empty batch", () => {
    const prev = { "/a.CR3": meta() };
    expect(applyMetaBatch(prev, new Map())).toBe(prev);
  });

  it("merges each entry against the previous map, carrying lrcRating forward", () => {
    const prev = { "/a.CR3": meta({ lrcRating: 4 }) };
    const next = applyMetaBatch(
      prev,
      new Map([
        ["/a.CR3", meta()],
        ["/b.CR3", meta()],
      ]),
    );
    expect(next).not.toBe(prev);
    expect(next["/a.CR3"].lrcRating).toBe(4);
    expect(Object.keys(next)).toEqual(["/a.CR3", "/b.CR3"]);
  });
});

describe("seedLrcMeta", () => {
  it("backfills a null star onto a full-EXIF entry without touching its other fields", () => {
    // Bundle read already landed (full EXIF) before the star arrived from the
    // sidecar pass — the re-stage case this task exists for.
    const prev = {
      "/a.CR3": meta({ camera: "Canon R5", lens: "RF 24-105mm", iso: 400, lrcRating: null }),
    };
    const seeded = { "/a.CR3": meta({ lrcRating: 4 }) };

    const next = seedLrcMeta(prev, seeded);

    expect(next["/a.CR3"].lrcRating).toBe(4);
    expect(next["/a.CR3"].camera).toBe("Canon R5");
    expect(next["/a.CR3"].lens).toBe("RF 24-105mm");
    expect(next["/a.CR3"].iso).toBe(400);
  });

  it("keeps an existing star instead of overwriting it with the seed's", () => {
    const prev = { "/a.CR3": meta({ lrcRating: 2 }) };
    const seeded = { "/a.CR3": meta({ lrcRating: 5 }) };

    const next = seedLrcMeta(prev, seeded);

    expect(next["/a.CR3"].lrcRating).toBe(2);
  });

  it("adds a seeded path that has no prev entry as-is", () => {
    const prev = {};
    const seeded = { "/a.CR3": meta({ lrcRating: 3 }) };

    const next = seedLrcMeta(prev, seeded);

    expect(next["/a.CR3"]).toEqual(seeded["/a.CR3"]);
  });

  it("leaves a prev path absent from seeded untouched", () => {
    const prev = { "/a.CR3": meta({ camera: "Canon R5", lrcRating: 3 }) };
    const seeded = {};

    const next = seedLrcMeta(prev, seeded);

    expect(next["/a.CR3"]).toEqual(prev["/a.CR3"]);
  });

  it("mutates neither input object", () => {
    const prev = { "/a.CR3": meta({ camera: "Canon R5", lrcRating: null }) };
    const seeded = { "/a.CR3": meta({ lrcRating: 4 }) };
    const prevSnapshot = JSON.parse(JSON.stringify(prev)) as unknown;
    const seededSnapshot = JSON.parse(JSON.stringify(seeded)) as unknown;

    seedLrcMeta(prev, seeded);

    expect(prev).toEqual(prevSnapshot);
    expect(seeded).toEqual(seededSnapshot);
  });
});
