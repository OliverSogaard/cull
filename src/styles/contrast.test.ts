import { describe, expect, test } from "vitest";

const files = import.meta.glob<string>("./**/*.css", {
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

/** The champagne accent, as it is written when a rule spells it out by hand. */
const ACCENT_RGB = "212, 175, 106";

/**
 * One rule body, looked up by the selector that opens it. `lastIndexOf` on
 * purpose: the three flash selectors first appear together in the grouped
 * rule that gives them their geometry (the last of the group, `--flash-fav`,
 * is even followed by ` {` there), then each again on its own colour rule
 * below it, which is the one under test.
 */
const ruleBody = (sheet: string, selector: string): string => {
  const at = sheet.lastIndexOf(`${selector} {`);
  if (at < 0) throw new Error(`no rule for \`${selector}\``);
  return sheet.slice(at, sheet.indexOf("}", at));
};

describe("colour tokens", () => {
  test("the favourite colour is not the accent", () => {
    expect(token("fav").toLowerCase()).not.toBe(token("accent").toLowerCase());
  });
  test("the favourite colour is the lilac the design board picked", () => {
    // Decision 1 of docs/superpowers/specs/2026-09-19-phase-3a-see-and-feel-design.md.
    // "Not the accent" alone would pass for any colour at all; this is the one.
    expect(token("fav").toLowerCase()).toBe("#b9a2dc");
  });
  test("the favourite verdict flash is drawn in --fav, not the accent", () => {
    // The flash is the loudest favourite in the app — a full-frame wash over
    // the photo. It sat on the champagne literal long after `--fav` existed,
    // which made a favourite and a keep-with-accent-chrome the same colour.
    const flash = ruleBody(files["./stage.css"], ".cull-photo-frame--flash-fav::after");
    expect(flash).toContain("var(--fav)");
    expect(flash).not.toContain(ACCENT_RGB);
  });
  test("the three verdict flashes agree on their two alphas", () => {
    // Keep / reject / fav are one gesture in three colours: the same 45% wash
    // and the same 70% inset ring. A flash that drifts off them reads as a
    // different event rather than the same one about a different verdict.
    const stage = files["./stage.css"];
    for (const verdict of ["keep", "reject", "fav"]) {
      const body = ruleBody(stage, `.cull-photo-frame--flash-${verdict}::after`);
      expect(body, verdict).toMatch(/background:[^;]*(?:\b0\.45\b|\b45%)/);
      expect(body, verdict).toMatch(/box-shadow: inset 0 0 0 3px[^;]*(?:\b0\.7\b|\b70%)/);
    }
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
