import { describe, expect, it } from "vitest";
import { pickSmartEmptyState } from "./smartEmptyState";

describe("pickSmartEmptyState", () => {
  it("is disabled whenever the master switch is off, regardless of other state", () => {
    expect(
      pickSmartEmptyState({ smartCulling: false, autoStart: true, analyzing: false, scoredCount: 0 }),
    ).toBe("disabled");
    expect(
      pickSmartEmptyState({ smartCulling: false, autoStart: false, analyzing: false, scoredCount: 0 }),
    ).toBe("disabled");
  });

  it("disabled wins even if a pass is mid-flight or already scored frames", () => {
    // Defensive: shouldn't happen in practice (turning the setting off should
    // stop a running pass), but "off" must never show stale/active state.
    expect(
      pickSmartEmptyState({ smartCulling: false, autoStart: true, analyzing: true, scoredCount: 12 }),
    ).toBe("disabled");
  });

  it("is analyzing while a pass is in flight and enabled", () => {
    expect(
      pickSmartEmptyState({ smartCulling: true, autoStart: true, analyzing: true, scoredCount: 0 }),
    ).toBe("analyzing");
    expect(
      pickSmartEmptyState({ smartCulling: true, autoStart: false, analyzing: true, scoredCount: 40 }),
    ).toBe("analyzing");
  });

  it("is analyzedNoSuggestions once scores exist and nothing is analyzing", () => {
    expect(
      pickSmartEmptyState({ smartCulling: true, autoStart: true, analyzing: false, scoredCount: 1 }),
    ).toBe("analyzedNoSuggestions");
    // Also covers "every suggested frame got rated away" — scoredCount alone
    // (not live suggestion count) drives this branch.
    expect(
      pickSmartEmptyState({ smartCulling: true, autoStart: false, analyzing: false, scoredCount: 500 }),
    ).toBe("analyzedNoSuggestions");
  });

  it("is notAnalyzedAutoStart when nothing has been scored and the pass self-starts", () => {
    expect(
      pickSmartEmptyState({ smartCulling: true, autoStart: true, analyzing: false, scoredCount: 0 }),
    ).toBe("notAnalyzedAutoStart");
  });

  it("is notAnalyzedManual when nothing has been scored and auto-start is off", () => {
    expect(
      pickSmartEmptyState({ smartCulling: true, autoStart: false, analyzing: false, scoredCount: 0 }),
    ).toBe("notAnalyzedManual");
  });
});
