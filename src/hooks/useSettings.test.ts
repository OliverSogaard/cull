import { describe, expect, it } from "vitest";
import { coerceSettings } from "./useSettings";
import { CAPTURE_OFFSET_LIMIT_MS, DEFAULT_SETTINGS } from "../types/settings";

describe("coerceSettings — smart culling fields auto-default (no key bump)", () => {
  it("fills defaults when the stored blob predates smart culling", () => {
    const s = coerceSettings({ storageMode: "network" });
    expect(s.smartCulling).toBe(true);
    expect(s.smartCullingConfidence).toBe("medium");
    expect(s.smartCullingOnOpen).toBe(true);
    expect(s.storageMode).toBe("network");
  });

  it("keeps valid stored values and rejects garbage per-field", () => {
    const s = coerceSettings({
      smartCulling: false,
      smartCullingConfidence: "high",
      smartCullingOnOpen: "yes-please", // wrong type → default
    });
    expect(s.smartCulling).toBe(false);
    expect(s.smartCullingConfidence).toBe("high");
    expect(s.smartCullingOnOpen).toBe(DEFAULT_SETTINGS.smartCullingOnOpen);
    expect(coerceSettings({ smartCullingConfidence: "extreme" }).smartCullingConfidence).toBe(
      "medium",
    );
  });
});

describe("coerceSettings — deepAnalysis (renamed from smartCullingML, default ON)", () => {
  it("defaults to true on a blob that predates the field", () => {
    expect(coerceSettings({}).deepAnalysis).toBe(true);
  });

  it("deliberately ignores the legacy smartCullingML key (rename forces the new ON default)", () => {
    expect(coerceSettings({ smartCullingML: false }).deepAnalysis).toBe(true);
  });

  it("keeps an explicit stored deepAnalysis value", () => {
    expect(coerceSettings({ deepAnalysis: false }).deepAnalysis).toBe(false);
    expect(coerceSettings({ deepAnalysis: true }).deepAnalysis).toBe(true);
  });
});

describe("coerceSettings — defaultFilter migration", () => {
  it("migrates the pre-sub-mode-rework 'favorites' value to 'keepsFavs'", () => {
    const s = coerceSettings({ defaultFilter: "favorites" });
    expect(s.defaultFilter).toBe("keepsFavs");
  });

  it("keeps a valid modern defaultFilter value as-is", () => {
    expect(coerceSettings({ defaultFilter: "keepsFavs" }).defaultFilter).toBe("keepsFavs");
    expect(coerceSettings({ defaultFilter: "keeps" }).defaultFilter).toBe("keeps");
  });

  it("falls back to the default for unknown/garbage defaultFilter values", () => {
    expect(coerceSettings({ defaultFilter: "nonsense" }).defaultFilter).toBe(
      DEFAULT_SETTINGS.defaultFilter,
    );
  });
});

describe("coerceSettings — gridSize", () => {
  it("defaults to medium on a blob that predates the field", () => {
    expect(coerceSettings({}).gridSize).toBe("medium");
    expect(DEFAULT_SETTINGS.gridSize).toBe("medium");
  });

  it("keeps a valid stored value and rejects anything else", () => {
    expect(coerceSettings({ gridSize: "large" }).gridSize).toBe("large");
    expect(coerceSettings({ gridSize: "small" }).gridSize).toBe("small");
    expect(coerceSettings({ gridSize: "huge" }).gridSize).toBe("medium");
    expect(coerceSettings({ gridSize: 256 }).gridSize).toBe("medium");
  });
});

describe("coerceSettings — capture-time sort (Phase 3C)", () => {
  it("defaults sortByCaptureTime ON for a blob that predates the field", () => {
    expect(coerceSettings({}).sortByCaptureTime).toBe(true);
  });

  it("keeps an explicit stored value and rejects a wrong-typed one", () => {
    expect(coerceSettings({ sortByCaptureTime: false }).sortByCaptureTime).toBe(false);
    expect(coerceSettings({ sortByCaptureTime: "yes" }).sortByCaptureTime).toBe(true);
  });

  it("defaults captureOffsets to an empty map", () => {
    expect(coerceSettings({}).captureOffsets).toEqual({});
  });

  it("keeps the finite numeric entries of a stored offsets map and drops the rest", () => {
    // A hand-edited or half-written blob must not reach the sort: a NaN offset
    // would poison every comparison in that folder.
    const s = coerceSettings({
      captureOffsets: {
        "C:\\shoot\\bodyB": -72000,
        "C:\\shoot\\bodyC": "300",
        "C:\\shoot\\bodyD": Number.NaN,
        "C:\\shoot\\bodyE": null,
      },
    });
    expect(s.captureOffsets).toEqual({ "C:\\shoot\\bodyB": -72000 });
  });

  it("rounds a fractional stored offset — the wire type is Rust i64", () => {
    // serde refuses to deserialize 1500.7 into i64, which would fail the whole
    // analyze_folder call rather than degrade the sort.
    expect(coerceSettings({ captureOffsets: { a: 1500.7 } }).captureOffsets).toEqual({ a: 1501 });
  });

  it("clamps a stored offset to a day and falls back on a non-object", () => {
    expect(coerceSettings({ captureOffsets: { a: 1e12 } }).captureOffsets).toEqual({
      a: CAPTURE_OFFSET_LIMIT_MS,
    });
    expect(coerceSettings({ captureOffsets: "nope" }).captureOffsets).toEqual({});
    expect(coerceSettings({ captureOffsets: [1, 2] }).captureOffsets).toEqual({});
  });
});

describe("coerceSettings — starsAndLabels (Phase 5A)", () => {
  it("defaults starsAndLabels OFF for a blob that predates the field", () => {
    // The whole feature's promise is that a user who never turns it on sees
    // no change. That starts here: an existing user's stored settings have
    // no such key, and must come back false.
    expect(coerceSettings({}).starsAndLabels).toBe(false);
    expect(DEFAULT_SETTINGS.starsAndLabels).toBe(false);
  });

  it("keeps an explicit stored value and rejects a wrong-typed one", () => {
    expect(coerceSettings({ starsAndLabels: true }).starsAndLabels).toBe(true);
    expect(coerceSettings({ starsAndLabels: "yes" }).starsAndLabels).toBe(false);
    expect(coerceSettings({ starsAndLabels: 1 }).starsAndLabels).toBe(false);
  });
});
