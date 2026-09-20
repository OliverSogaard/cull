import { describe, expect, test } from "vitest";

const sheets = import.meta.glob<string>("./**/*.css", {
  query: "?raw",
  eager: true,
  import: "default",
});
const sheet = (name: string): string => {
  const css = sheets[name];
  if (css === undefined) throw new Error(`no stylesheet ${name}`);
  return css;
};

/** The declarations of the first rule whose selector list matches `selector`. */
export const ruleBody = (css: string, selector: string): string => {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`no rule \`${selector}\``);
  return css.slice(at, css.indexOf("}", at));
};

describe("layout tokens are wired, not decorative", () => {
  test("the stylesheets arrive as readable text", () => {
    expect(Object.keys(sheets).length).toBeGreaterThan(10);
    expect(sheet("./tokens.css")).toContain(":root {");
  });

  test("the title bar reserves the real width of the four caption buttons", () => {
    expect(sheet("./tokens.css")).toMatch(/--winbtn-w:\s*44px/);
    expect(sheet("./tokens.css")).toMatch(/--winbtn-reserve:\s*calc\(var\(--winbtn-w\) \* 4\)/);
    expect(ruleBody(sheet("./statusbar.css"), ".cull-statusbar--top")).toContain(
      "padding: 0 var(--winbtn-reserve) 0 14px",
    );
  });

  test("the 36px chrome bar is one token, referenced everywhere it is used", () => {
    for (const [file, selector] of [
      ["./statusbar.css", ".cull-statusbar--top"],
      ["./chrome.css", ".cull-wincontrols"],
      ["./chrome.css", ".cull-winbtn"],
    ] as const) {
      expect(ruleBody(sheet(file), selector), `${file} ${selector}`).toContain("var(--bar-h)");
    }
    expect(ruleBody(sheet("./help.css"), ".cull-help")).toContain("inset: var(--bar-h) 0 0");
    expect(ruleBody(sheet("./chrome.css"), ".cull-winbtn")).toContain("width: var(--winbtn-w)");
  });
});

describe("the footer's breakpoints", () => {
  const statusbar = sheet("./statusbar.css");

  test("the three picked widths are there, in range notation", () => {
    // The cosmetic shed sits at 1220 (fix round 3 — closes the ~17px band
    // that survived at the plain 1200), not the info rail's own, unrelated
    // 1200px breakpoint in exif-rail.css.
    for (const w of [1360, 1220, 1100]) {
      expect(statusbar, `${w}px breakpoint`).toContain(`@media (width < ${w}px)`);
    }
    expect(statusbar, "range notation only").not.toMatch(/@media\s*\(max-width/);
  });

  test("every shed label is hidden at the width the spec picked", () => {
    const block = (w: number): string => {
      const at = statusbar.indexOf(`@media (width < ${w}px) {`);
      return statusbar.slice(at, statusbar.indexOf("\n}", at));
    };
    // The save chip's tail sheds a breakpoint earlier than the rest — fix
    // round 1 moved it from 1200 to 1360 (a clip band survived just above
    // 1200 otherwise). Pin it INSIDE 1360 and explicitly NOT inside 1220,
    // so a future move-back can't slip past this guard silently.
    expect(block(1360)).toContain(".cull-statusbar__keyhint");
    expect(block(1360)).toContain(".cull-statusbar__unsaved-tail");
    // Fix round 3: the cosmetic words moved from 1200 to 1220.
    for (const cls of [
      ".cull-statusbar__filename-ext",
      ".cull-statusbar__chip-label",
      ".cull-statusbar__scrub-label",
      ".cull-statusbar__verdict-label",
    ]) {
      expect(block(1220), cls).toContain(cls);
    }
    expect(block(1220), "the tail moved to 1360 and must not still be here").not.toContain(
      ".cull-statusbar__unsaved-tail",
    );
    expect(block(1100)).toContain(".cull-statusbar__finish-long");
  });

  test("only the ALL-RATED finish label sheds at 1360 — the ordinary one waits for 1100", () => {
    // Fix round 2: the all-rated form ("All N rated · Ctrl+E finish", the
    // biggest thing on the right) sheds to "Finish" at 1360, scoped to
    // `.is-done` so the ordinary form ("Ctrl+E · N keeps", far smaller)
    // keeps shedding at 1100, unchanged. ruleBody's exact "selector {"
    // match is used (not the block()/toContain() substring pair above) so
    // a comment merely mentioning these classes can't fake a pass — the
    // fix-round-1 report found exactly that kind of false positive once.
    const tier = statusbar.slice(
      statusbar.indexOf("@media (width < 1360px) {"),
      statusbar.indexOf("@media (width < 1220px) {"),
    );
    expect(ruleBody(tier, ".cull-statusbar__finish.is-done .cull-statusbar__finish-long")).toMatch(
      /display:\s*none/,
    );
    expect(ruleBody(tier, ".cull-statusbar__finish.is-done .cull-statusbar__finish-short")).toMatch(
      /display:\s*inline/,
    );

    // The plain (unscoped) finish-long shed must still live ONLY at 1100 —
    // exactly one occurrence of its selector in the 1360 tier, and that one
    // occurrence must be the `.is-done`-scoped pair above, not a bare copy.
    const needle = ".cull-statusbar__finish-long {";
    const occurrences = tier.split(needle).length - 1;
    expect(occurrences, "exactly the one is-done-scoped rule, no bare duplicate").toBe(1);
    const at = tier.indexOf(needle);
    expect(tier.slice(at - 9, at), "must be the .is-done-scoped rule").toBe(".is-done ");
  });

  test("only the filename may shrink, so nothing else can be squeezed into a clip", () => {
    const chrome = sheet("./chrome.css");
    // The guarantee rests on THREE things staying min-width: 0 (so the flex
    // algorithm is even allowed to shrink them below content size)...
    for (const selector of [
      ".cull-statusbar__left",
      ".cull-statusbar__filename",
      ".cull-statusbar__filename-name",
    ]) {
      expect(ruleBody(chrome, selector), selector).toMatch(/min-width:\s*0/);
    }
    // ...and on every OTHER left-cluster child refusing to shrink at all, so
    // the filename stem is the only thing that ever gives.
    for (const [file, selector] of [
      ["./chrome.css", ".cull-statusbar__verdict"],
      ["./chrome.css", ".cull-statusbar__scrub"],
      ["./chrome.css", ".cull-statusbar__overlay-cluster"],
      ["./statusbar.css", ".cull-statusbar__chip"],
      ["./statusbar.css", ".cull-statusbar__multi"],
      ["./chrome.css", ".cull-statusbar__unsaved"],
    ] as const) {
      expect(ruleBody(sheet(file), selector), `${file} ${selector}`).toMatch(/flex-shrink:\s*0/);
    }
    expect(ruleBody(chrome, ".cull-statusbar__filename-name")).toMatch(/text-overflow:\s*ellipsis/);
  });

  test("the save chip's tail is hidden visually, never removed from the name", () => {
    // `display: none` would shorten the button's accessible name; the tail is
    // clipped instead. Lives in the 1360 block now (fix round 1), alongside
    // the keyhint rule.
    const block = statusbar.slice(
      statusbar.indexOf("@media (width < 1360px) {"),
      statusbar.indexOf("@media (width < 1220px) {"),
    );
    const tail = block.slice(block.indexOf(".cull-statusbar__unsaved-tail {"));
    expect(tail).toMatch(/clip-path:\s*inset\(50%\)/);
    expect(tail.slice(0, tail.indexOf("}"))).not.toMatch(/display:\s*none/);
  });
});

describe("the info rail", () => {
  const rail = sheet("./exif-rail.css");

  test("its widths come from the tokens, not literals", () => {
    expect(ruleBody(rail, ".cull-exif-rail")).toContain("flex: 0 0 var(--rail-w)");
    expect(ruleBody(rail, ".cull-exif-rail")).toContain("width: var(--rail-w)");
    expect(ruleBody(rail, ".cull-exif-rail--compare")).toContain("var(--rail-w-compare)");
    expect(ruleBody(rail, ".cull-cr-rail__row")).toContain(
      "grid-template-columns: var(--rail-col-k) 1fr 1fr",
    );
    expect(ruleBody(rail, ".cull-cr-rail__head")).toContain(
      "grid-template-columns: var(--rail-col-k) 1fr 1fr",
    );
  });

  test("below 1200 the tokens step down to the picked numbers", () => {
    const at = rail.indexOf("@media (width < 1200px) {");
    expect(at, "no 1200px breakpoint in exif-rail.css").toBeGreaterThan(-1);
    const block = rail.slice(at);
    expect(block).toMatch(/--rail-w:\s*232px/);
    expect(block).toMatch(/--rail-w-compare:\s*288px/);
    expect(block).toMatch(/--rail-col-k:\s*76px/);
    expect(block).toMatch(/padding:\s*28px 20px/);
    expect(block).toMatch(/gap:\s*28px/);
  });
});

describe("the home screen at 2000px and wider", () => {
  const home = sheet("./home.css");

  test("its sizes come from tokens", () => {
    expect(ruleBody(home, ".cull-hero")).toContain("max-width: var(--home-col)");
    expect(ruleBody(home, ".cull-recent")).toContain("max-width: var(--home-col)");
    expect(ruleBody(home, ".cull-hero__sub")).toContain("font-size: var(--home-sub)");
    expect(ruleBody(home, ".cull-hero__sub")).toContain("max-width: var(--home-measure)");
    expect(ruleBody(home, ".cull-hero__how")).toContain("max-width: var(--home-measure)");
    expect(ruleBody(home, ".cull-recent__path")).toContain("font-size: var(--home-path)");
    expect(ruleBody(home, ".cull-recent__item")).toContain("padding: var(--home-row-pad) 0");
  });

  test("the step is the one the board picked", () => {
    const at = home.indexOf("@media (width >= 2000px) {");
    expect(at, "no 2000px breakpoint in home.css").toBeGreaterThan(-1);
    const block = home.slice(at);
    expect(block).toMatch(/--home-col:\s*780px/);
    expect(block).toMatch(/--fs-hero:\s*72px/);
    expect(block).toMatch(/--home-sub:\s*19px/);
    expect(block).toMatch(/--home-measure:\s*620px/);
    expect(block).toMatch(/--home-path:\s*15px/);
    expect(block).toMatch(/--home-row-pad:\s*16px/);
  });
});
