import { describe, expect, test } from "vitest";

/**
 * The keycap reads as written, everywhere.
 *
 * `.kbd` used to set neither `text-transform` nor `letter-spacing`, so a cap
 * inherited both from whatever it sat in — and the settings footer is an
 * `.eyebrow`, which is uppercase at `--track-eyebrow`. The same markup that
 * said "esc" in a dialog hint said "ESC" down there, and "Ctrl" said "CTRL".
 * The keycap now owns both properties, so its text is the text it was given
 * and its tracking is the same in every surface.
 */
const sheets = import.meta.glob<string>("./**/*.css", {
  query: "?raw",
  eager: true,
  import: "default",
});

const kbdCss = sheets["./primitives/kbd.css"] ?? "";

/** The `.kbd` base rule — the block that owns the keycap's typography. */
const base = (): string => {
  const at = kbdCss.indexOf(".kbd {");
  if (at < 0) throw new Error("no `.kbd` rule in primitives/kbd.css");
  return kbdCss.slice(at, kbdCss.indexOf("}", at));
};

/**
 * Every rule elsewhere that reaches a keycap — `.kbd`, `.kbd--tint`, a
 * `… kbd` descendant selector or a `--…-kbd`/`--…-key` class — paired with
 * its body, so a re-declared typography property can be found.
 */
const capRules = Object.entries(sheets)
  .filter(([file]) => file !== "./primitives/kbd.css")
  .flatMap(([file, css]) =>
    [...css.matchAll(/^([^\r\n{}]*(?:\bkbd\b|-key)[^\r\n{}]*)\{([^}]*)\}/gm)].map(
      ([, selector, body]): [string, string] => [`${file}  ${selector.trim()}`, body],
    ),
  );

describe("the keycap", () => {
  test("the stylesheets arrive as readable text, not empty stubs", () => {
    // Guards the mechanism: a bundler handing back "" for a `?raw` import
    // would make every assertion below pass on nothing at all.
    expect(Object.keys(sheets).length).toBeGreaterThan(10);
    expect(kbdCss).toContain(".kbd {");
    expect(capRules.length).toBeGreaterThan(0);
  });

  test("owns its casing, so an uppercase surface cannot rewrite its label", () => {
    expect(base()).toMatch(/text-transform:\s*none\b/);
  });

  test("owns its tracking, so every cap is spaced the same", () => {
    expect(base()).toMatch(/letter-spacing:\s*0\.04em\b/);
  });

  test("no surface re-states the casing the keycap now owns", () => {
    // A second `text-transform` on a cap is either a no-op repeating the base
    // or a surface quietly shouting its keys — neither is wanted.
    const restated = capRules
      .filter(([, body]) => /text-transform:/.test(body))
      .map(([where]) => where);
    expect(restated).toEqual([]);
  });

  test("the only surface tracking left is one that differs from the base", () => {
    // The hero CTA sets `letter-spacing: normal` on itself and wants its cap a
    // shade wider than the base; anything matching the base would be noise.
    const restated = capRules
      .filter(([, body]) => /letter-spacing:\s*0\.04em\b/.test(body))
      .map(([where]) => where);
    expect(restated).toEqual([]);
  });
});
