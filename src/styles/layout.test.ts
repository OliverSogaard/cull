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
    for (const w of [1360, 1200, 1100]) {
      expect(statusbar, `${w}px breakpoint`).toContain(`@media (width < ${w}px)`);
    }
    expect(statusbar, "range notation only").not.toMatch(/@media\s*\(max-width/);
  });

  test("every shed label is hidden at the width the spec picked", () => {
    const block = (w: number): string => {
      const at = statusbar.indexOf(`@media (width < ${w}px) {`);
      return statusbar.slice(at, statusbar.indexOf("\n}", at));
    };
    expect(block(1360)).toContain(".cull-statusbar__keyhint");
    for (const cls of [
      ".cull-statusbar__filename-ext",
      ".cull-statusbar__chip-label",
      ".cull-statusbar__scrub-label",
      ".cull-statusbar__verdict-label",
      ".cull-statusbar__unsaved-tail",
    ]) {
      expect(block(1200), cls).toContain(cls);
    }
    expect(block(1100)).toContain(".cull-statusbar__finish-long");
  });

  test("only the filename may shrink, so nothing else can be squeezed into a clip", () => {
    expect(ruleBody(sheet("./chrome.css"), ".cull-statusbar__left")).toMatch(/flex-shrink:\s*1/);
    expect(ruleBody(sheet("./chrome.css"), ".cull-statusbar__filename-name")).toMatch(
      /text-overflow:\s*ellipsis/,
    );
  });

  test("the save chip's tail is hidden visually, never removed from the name", () => {
    // `display: none` would shorten the button's accessible name; the tail is
    // clipped instead, with the same declarations base.css's utility uses.
    const block = statusbar.slice(
      statusbar.indexOf("@media (width < 1200px) {"),
      statusbar.indexOf("@media (width < 1100px) {"),
    );
    const tail = block.slice(block.indexOf(".cull-statusbar__unsaved-tail {"));
    expect(tail).toMatch(/clip-path:\s*inset\(50%\)/);
    expect(tail.slice(0, tail.indexOf("}"))).not.toMatch(/display:\s*none/);
    expect(ruleBody(sheet("./base.css"), ".visually-hidden")).toMatch(/clip-path:\s*inset\(50%\)/);
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
