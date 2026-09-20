import { describe, expect, test } from "vitest";

const files = import.meta.glob<string>("./tokens.css", {
  query: "?raw",
  eager: true,
  import: "default",
});
const css = files["./tokens.css"];
const token = (name: string): string => {
  const m = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})\\b`).exec(css);
  if (!m) throw new Error(`token --${name} is not a plain hex`);
  return m[1];
};
const lum = (hex: string): number => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: string, b: string): number => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe("colour tokens", () => {
  test("the favourite colour is not the accent", () => {
    expect(token("fav").toLowerCase()).not.toBe(token("accent").toLowerCase());
  });
  test("verdict and text colours clear AA on both dark surfaces", () => {
    for (const fg of ["fav", "ok", "bad", "accent", "text-2"]) {
      for (const bg of ["bg", "surface", "surface-2"]) {
        expect(ratio(token(fg), token(bg)), `--${fg} on --${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
  test("ink on the danger fill clears AA", () => {
    expect(ratio(token("ink"), token("bad"))).toBeGreaterThanOrEqual(4.5);
  });
});
