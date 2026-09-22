// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useUpdateCheck } from "./useUpdateCheck";

type ProgressEvent =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

const mocks = vi.hoisted(() => ({
  check: vi.fn(async (): Promise<null | { version: string; downloadAndInstall: unknown }> => null),
  relaunch: vi.fn(async () => {}),
  download: vi.fn(async (_on: (ev: ProgressEvent) => void) => {}),
}));

vi.mock("@tauri-apps/plugin-updater", () => ({ check: mocks.check }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: mocks.relaunch }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useUpdateCheck", () => {
  it("never checks when disabled — the dev exe and the tests stay offline", () => {
    renderHook(() => useUpdateCheck(false));
    expect(mocks.check).not.toHaveBeenCalled();
  });

  it("stays idle when there is nothing newer, and when the check fails", async () => {
    mocks.check.mockResolvedValueOnce(null);
    const a = renderHook(() => useUpdateCheck(true));
    await waitFor(() => expect(mocks.check).toHaveBeenCalledTimes(1));
    expect(a.result.current.state.status).toBe("idle");

    mocks.check.mockRejectedValueOnce(new Error("offline"));
    const b = renderHook(() => useUpdateCheck(true));
    await waitFor(() => expect(mocks.check).toHaveBeenCalledTimes(2));
    expect(b.result.current.state.status).toBe("idle");
  });

  it("offers a found release, reports download progress, then relaunches", async () => {
    mocks.download.mockImplementationOnce(async (on) => {
      on({ event: "Started", data: { contentLength: 200 } });
      on({ event: "Progress", data: { chunkLength: 50 } });
      on({ event: "Progress", data: { chunkLength: 150 } });
      on({ event: "Finished" });
    });
    mocks.check.mockResolvedValueOnce({ version: "1.1.0", downloadAndInstall: mocks.download });
    const { result } = renderHook(() => useUpdateCheck(true));
    await waitFor(() =>
      expect(result.current.state).toEqual({ status: "available", version: "1.1.0" }),
    );

    await act(async () => {
      await result.current.install();
    });
    expect(mocks.download).toHaveBeenCalledTimes(1);
    expect(result.current.state).toEqual({ status: "ready", version: "1.1.0" });
    expect(mocks.relaunch).toHaveBeenCalledTimes(1);
  });

  it("a failed download is reported, not swallowed, and can be retried", async () => {
    mocks.download.mockRejectedValueOnce(new Error("disk full"));
    mocks.check.mockResolvedValueOnce({ version: "1.1.0", downloadAndInstall: mocks.download });
    const { result } = renderHook(() => useUpdateCheck(true));
    await waitFor(() => expect(result.current.state.status).toBe("available"));

    await act(async () => {
      await result.current.install();
    });
    expect(result.current.state).toEqual({ status: "failed", version: "1.1.0" });
    expect(mocks.relaunch).not.toHaveBeenCalled();
  });
});
