import { afterEach, describe, expect, it, vi } from "vitest";
import { writeLocalStorage } from "./storage";

afterEach(() => vi.unstubAllGlobals());

describe("writeLocalStorage", () => {
  it("writes and reports true", () => {
    const setItem = vi.fn();
    vi.stubGlobal("localStorage", { setItem });
    expect(writeLocalStorage("cull:lastDir", "D:\\shoot")).toBe(true);
    expect(setItem).toHaveBeenCalledWith("cull:lastDir", "D:\\shoot");
  });
  it("swallows a quota / private-mode failure and reports false", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("localStorage", {
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    });
    expect(writeLocalStorage("cull:lastDir", "x")).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
  it("reports false where localStorage does not exist (vitest default env)", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(writeLocalStorage("k", "v")).toBe(false);
  });
});
