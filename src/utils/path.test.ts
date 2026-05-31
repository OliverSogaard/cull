import { describe, expect, it } from "vitest";
import { basename, stripExt } from "./path";

describe("basename", () => {
  it("handles forward-slash paths", () => {
    expect(basename("/home/o/photo.cr3")).toBe("photo.cr3");
    expect(basename("./relative/path.txt")).toBe("path.txt");
  });

  it("handles backslash paths (Windows)", () => {
    expect(basename("C:\\Users\\Olive\\photo.cr3")).toBe("photo.cr3");
    expect(basename("D:\\nested\\dir\\file.xmp")).toBe("file.xmp");
  });

  it("handles mixed separators", () => {
    expect(basename("C:\\Users/Olive\\photo.cr3")).toBe("photo.cr3");
  });

  it("returns the input when there is no separator", () => {
    expect(basename("just-a-name.cr3")).toBe("just-a-name.cr3");
  });
});

describe("stripExt", () => {
  it("drops the trailing extension", () => {
    expect(stripExt("photo.cr3")).toBe("photo");
    expect(stripExt("file.xmp")).toBe("file");
  });

  it("drops only the last extension when there are multiple", () => {
    expect(stripExt("photo.cr3.xmp")).toBe("photo.cr3");
  });

  it("leaves a name with no extension untouched", () => {
    expect(stripExt("noext")).toBe("noext");
  });
});
