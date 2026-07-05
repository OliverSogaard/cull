import { describe, expect, test } from "vitest";
import { scanFailureTag } from "./ScanFailureCard";

describe("scanFailureTag", () => {
  test("backend 'folder not found: <path>' becomes a clean 'not found' tag with no detail", () => {
    expect(scanFailureTag("folder not found: /Volumes/home/Canon Photos/USA")).toEqual({
      tag: "not found",
      detail: null,
    });
  });

  test("'not a directory' becomes 'not a folder' with no detail", () => {
    expect(scanFailureTag("path is not a directory: /Volumes/x")).toEqual({
      tag: "not a folder",
      detail: null,
    });
  });

  test("unrecognised errors keep the raw message as detail under a generic tag", () => {
    expect(scanFailureTag("io error: permission denied (os error 13)")).toEqual({
      tag: "failed",
      detail: "io error: permission denied (os error 13)",
    });
  });
});
