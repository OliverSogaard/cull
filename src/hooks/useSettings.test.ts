import { describe, expect, it } from "vitest";
import { coerceSettings } from "./useSettings";
import { DEFAULT_SETTINGS } from "../types/settings";

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
