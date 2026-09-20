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
