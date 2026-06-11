/**
 * DecodePool unit tests (pipeline Phase 5): injected fake images — priority
 * order + caps, no re-decode for warm entries, release on band exit, url
 * change re-decodes, rejected decode frees the slot, clear releases all.
 */
import { describe, expect, it } from "vitest";
import { DecodePool } from "./decodePool";
import type { PoolImage } from "./decodePool";

type FakeImage = PoolImage & {
  srcSets: string[];
  resolveDecode: () => void;
  rejectDecode: () => void;
};

function harness() {
  const images: FakeImage[] = [];
  const createImage = (): PoolImage => {
    let src = "";
    let settle: { resolve: () => void; reject: (e: Error) => void } | null = null;
    const img: FakeImage = {
      srcSets: [],
      get src() {
        return src;
      },
      set src(v: string) {
        src = v;
        img.srcSets.push(v);
      },
      decode: () =>
        new Promise<void>((resolve, reject) => {
          settle = { resolve, reject };
        }),
      resolveDecode: () => settle?.resolve(),
      rejectDecode: () => settle?.reject(new Error("decode failed")),
    };
    images.push(img);
    return img;
  };
  return { pool: new DecodePool(createImage), images };
}

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("DecodePool", () => {
  it("decodes retained entries in priority order, up to the cap", () => {
    const h = harness();
    h.pool.retain(
      "preview",
      [
        { path: "/a", url: "blob:a" },
        { path: "/b", url: "blob:b" },
        { path: "/c", url: "blob:c" },
        { path: "/d", url: "blob:d" },
      ],
      2,
    );
    expect(h.images.map((i) => i.src)).toEqual(["blob:a", "blob:b"]);
    expect(h.pool.counts()).toEqual({ previews: 2, fulls: 0 });
  });

  it("keeps a warm path+url across re-retains without re-decoding", () => {
    const h = harness();
    const entries = [{ path: "/a", url: "blob:a" }];
    h.pool.retain("preview", entries, 5);
    h.pool.retain("preview", entries, 5);
    expect(h.images).toHaveLength(1);
    expect(h.images[0].srcSets).toEqual(["blob:a"]);
  });

  it("releases paths that leave the retained band", () => {
    const h = harness();
    h.pool.retain(
      "preview",
      [
        { path: "/a", url: "blob:a" },
        { path: "/b", url: "blob:b" },
      ],
      5,
    );
    h.pool.retain(
      "preview",
      [
        { path: "/b", url: "blob:b" },
        { path: "/c", url: "blob:c" },
      ],
      5,
    );
    // /a released (src cleared), /b kept warm, /c newly decoded.
    expect(h.images[0].src).toBe("");
    expect(h.images).toHaveLength(3);
    expect(h.pool.counts().previews).toBe(2);
  });

  it("re-decodes when a retained path's url changes", () => {
    const h = harness();
    h.pool.retain("preview", [{ path: "/a", url: "blob:a1" }], 5);
    h.pool.retain("preview", [{ path: "/a", url: "blob:a2" }], 5);
    expect(h.images[0].src).toBe(""); // old blob's ref dropped
    expect(h.images[1].src).toBe("blob:a2");
    expect(h.pool.counts().previews).toBe(1);
  });

  it("a cap shrink releases the lowest-priority slots", () => {
    const h = harness();
    const entries = [
      { path: "/a", url: "blob:a" },
      { path: "/b", url: "blob:b" },
      { path: "/c", url: "blob:c" },
    ];
    h.pool.retain("preview", entries, 3);
    h.pool.retain("preview", entries, 1);
    expect(h.pool.counts().previews).toBe(1);
    expect(h.images[0].src).toBe("blob:a"); // highest priority survives
    expect(h.images[1].src).toBe("");
    expect(h.images[2].src).toBe("");
  });

  it("a rejected decode releases the slot and is never retried for the SAME url", async () => {
    const h = harness();
    h.pool.retain("preview", [{ path: "/a", url: "blob:a" }], 5);
    h.images[0].rejectDecode();
    await flush();
    expect(h.pool.counts().previews).toBe(0);
    expect(h.images[0].src).toBe(""); // released on failure
    // Same url re-offered (the band re-aims every cursor move): no churn.
    h.pool.retain("preview", [{ path: "/a", url: "blob:a" }], 5);
    expect(h.images).toHaveLength(1);
    // A refetch mints a NEW blob url — that one gets its chance.
    h.pool.retain("preview", [{ path: "/a", url: "blob:a2" }], 5);
    expect(h.images).toHaveLength(2);
    expect(h.images[1].src).toBe("blob:a2");
  });

  it("tiers are independent: a full slot never counts against previews", () => {
    const h = harness();
    h.pool.retain("preview", [{ path: "/a", url: "blob:p" }], 1);
    h.pool.retain("full", [{ path: "/a", url: "blob:f" }], 1);
    expect(h.pool.counts()).toEqual({ previews: 1, fulls: 1 });
    // Releasing the preview band leaves the full slot warm.
    h.pool.retain("preview", [], 1);
    expect(h.pool.counts()).toEqual({ previews: 0, fulls: 1 });
  });

  it("clear releases every slot in every tier", () => {
    const h = harness();
    h.pool.retain("preview", [{ path: "/a", url: "blob:a" }], 5);
    h.pool.retain("full", [{ path: "/b", url: "blob:b" }], 5);
    h.pool.clear();
    expect(h.pool.counts()).toEqual({ previews: 0, fulls: 0 });
    expect(h.images.every((i) => i.src === "")).toBe(true);
  });
});
