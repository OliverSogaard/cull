import { describe, expect, it } from "vitest";
import {
  basename,
  isReservedFolderName,
  joinPath,
  truncatePathDisplay,
  sanitizeFolderName,
  stripExt,
} from "./path";

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

describe("joinPath", () => {
  it("uses backslash when the root is a Windows path", () => {
    expect(joinPath("C:\\Exports", "Reception-keeps")).toBe("C:\\Exports\\Reception-keeps");
  });

  it("uses forward slash for POSIX roots", () => {
    expect(joinPath("/home/u/exports", "shoot")).toBe("/home/u/exports/shoot");
  });

  it("strips a trailing separator on the root", () => {
    expect(joinPath("C:\\Exports\\", "x")).toBe("C:\\Exports\\x");
    expect(joinPath("/exports/", "x")).toBe("/exports/x");
  });
});

describe("sanitizeFolderName", () => {
  it("strips Windows-illegal characters", () => {
    expect(sanitizeFolderName("a<b>c:d\"e/f\\g|h?i*j")).toBe("abcdefghij");
  });

  it("caps the result at 32 chars", () => {
    expect(sanitizeFolderName("x".repeat(40))).toBe("x".repeat(32));
  });

  it("leaves a clean name untouched", () => {
    expect(sanitizeFolderName("Reception-keeps")).toBe("Reception-keeps");
  });

  it("strips trailing dots/spaces and leading spaces (Windows coerces these away)", () => {
    // A trailing dot would create a dir named "rejects" on disk while the
    // scan-ignore string kept "rejects.", re-importing the moved rejects.
    expect(sanitizeFolderName("rejects.")).toBe("rejects");
    expect(sanitizeFolderName("rejects   ")).toBe("rejects");
    expect(sanitizeFolderName("  rejects")).toBe("rejects");
    expect(sanitizeFolderName("v2..")).toBe("v2");
  });

  it("does NOT itself drop reserved names (per-keystroke would wipe a valid name)", () => {
    // "CON" is reserved, but sanitize must allow it through so typing "CONcert"
    // works; the reserved guard is applied at commit via isReservedFolderName.
    expect(sanitizeFolderName("CON")).toBe("CON");
    expect(sanitizeFolderName("CONcert-keeps")).toBe("CONcert-keeps");
  });
});

describe("isReservedFolderName", () => {
  it("flags Windows reserved device names (case-insensitive, incl. with extension)", () => {
    for (const n of ["CON", "con", "NUL", "PRN", "AUX", "COM1", "LPT9", "CON.foo"]) {
      expect(isReservedFolderName(n)).toBe(true);
    }
  });

  it("does not flag ordinary names that merely contain a reserved prefix", () => {
    for (const n of ["CONcert-keeps", "rejects", "_rejected", "COM10", "console", "Reception"]) {
      expect(isReservedFolderName(n)).toBe(false);
    }
  });
});

describe("truncatePathDisplay — leading truncation, path end preserved", () => {
  it("returns short paths untouched", () => {
    expect(truncatePathDisplay("/Users/o/Pics/", 34)).toBe("/Users/o/Pics/");
  });

  it("keeps the tail and starts at a separator when one is in range", () => {
    const long = "/Users/oliversogaard/Downloads/exports/weddings/";
    const out = truncatePathDisplay(long, 30);
    expect(out.length).toBeLessThanOrEqual(30);
    expect(out.startsWith("…/")).toBe(true);
    expect(out.endsWith("/weddings/")).toBe(true);
  });

  it("falls back to a raw tail when no separator is in range", () => {
    const out = truncatePathDisplay("x".repeat(80), 10);
    expect(out).toBe("…" + "x".repeat(9));
  });

  it("handles Windows separators", () => {
    const out = truncatePathDisplay("C:\\Users\\oliver\\Pictures\\exports\\", 20);
    expect(out.startsWith("…\\")).toBe(true);
    expect(out.endsWith("\\exports\\")).toBe(true);
  });
});
