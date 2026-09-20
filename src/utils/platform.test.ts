import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `isMac` (and everything derived from it) is computed once, at module
 * load, from `navigator.userAgent` — so exercising both platforms means
 * stubbing the global before a fresh dynamic import each time.
 */
async function loadPlatform(userAgent: string) {
  vi.stubGlobal("navigator", { userAgent });
  vi.resetModules();
  return import("./platform");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("modLabel", () => {
  it("is the command glyph on macOS", async () => {
    const { modLabel } = await loadPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)");
    expect(modLabel).toBe("⌘");
  });
  it("is spelled Ctrl elsewhere", async () => {
    const { modLabel } = await loadPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
    expect(modLabel).toBe("Ctrl");
  });
});

describe("modCombo", () => {
  it("joins the glyph directly to the key on macOS", async () => {
    const { modCombo } = await loadPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)");
    expect(modCombo("E")).toBe("⌘E");
  });
  it("joins Ctrl to the key with a plus elsewhere", async () => {
    const { modCombo } = await loadPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
    expect(modCombo("E")).toBe("Ctrl+E");
  });
});
