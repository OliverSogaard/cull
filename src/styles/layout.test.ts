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

/** The declarations of the first rule whose selector list matches `selector`.
 *  Anchored on a leading newline (optionally followed by the indentation a
 *  nested rule carries inside a `@media` block), not a bare substring search:
 *  a plain `indexOf` mis-hits when `selector` is the suffix of a longer
 *  compound selector sharing the same tail (it already forced a CSS reorder
 *  once, to dodge a false hit) — e.g. searching for
 *  `.cull-statusbar__finish-long` alone must not match the tail of
 *  `.cull-statusbar__finish.is-done .cull-statusbar__finish-long {`, since
 *  that compound selector doesn't start right after a newline+indent.  Every
 *  stylesheet this file reads opens with a comment, so no rule this helper is
 *  asked for ever sits at offset 0 and loses its leading newline. */
export const ruleBody = (css: string, selector: string): string => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\n[ \\t]*${escaped} \\{`);
  const m = re.exec(css);
  if (!m) throw new Error(`no rule \`${selector}\``);
  const start = m.index + m[0].indexOf(selector);
  return css.slice(start, css.indexOf("}", start));
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
    // The cosmetic shed sits at 1240 (fix round 4 — moved up from 1220 for
    // margin, since the sums it rests on are estimated glyph advances, not
    // the info rail's own, unrelated 1200px breakpoint in exif-rail.css).
    for (const w of [1360, 1240, 1120]) {
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
    // 1200 otherwise). Pin it INSIDE 1360 and explicitly NOT inside 1240,
    // so a future move-back can't slip past this guard silently.
    expect(block(1360)).toContain(".cull-statusbar__keyhint");
    expect(block(1360)).toContain(".cull-statusbar__unsaved-tail");
    // Fix round 4: the extension sheds alongside the tail at 1360 now —
    // every file in a cull is a .CR3, and the cosmetic tier below no longer
    // has to price it in (that omission is what let ~1220–1245px overflow).
    expect(block(1360), ".cull-statusbar__filename-ext").toContain(".cull-statusbar__filename-ext");
    expect(
      block(1240),
      "the extension sheds at 1360, not here — it must not still be in this tier",
    ).not.toContain(".cull-statusbar__filename-ext");
    // Fix round 3 moved the cosmetic words from 1200 to 1220; fix round 4
    // moved them again, from 1220 to 1240.
    for (const cls of [
      ".cull-statusbar__chip-label",
      ".cull-statusbar__scrub-label",
      ".cull-statusbar__verdict-label",
    ]) {
      expect(block(1240), cls).toContain(cls);
    }
    expect(block(1240), "the tail moved to 1360 and must not still be here").not.toContain(
      ".cull-statusbar__unsaved-tail",
    );
    expect(block(1120)).toContain(".cull-statusbar__finish-long");
  });

  test("only the ALL-RATED finish label sheds at 1360 — the ordinary one waits for 1120", () => {
    // Fix round 2: the all-rated form ("All N rated · Ctrl+E finish", the
    // biggest thing on the right) sheds to "Finish" at 1360, scoped to
    // `.is-done` so the ordinary form ("Ctrl+E · N keeps", far smaller)
    // keeps shedding at 1120, unchanged. ruleBody's exact "selector {"
    // match is used (not the block()/toContain() substring pair above) so
    // a comment merely mentioning these classes can't fake a pass — the
    // fix-round-1 report found exactly that kind of false positive once.
    const tier = statusbar.slice(
      statusbar.indexOf("@media (width < 1360px) {"),
      statusbar.indexOf("@media (width < 1240px) {"),
    );
    expect(ruleBody(tier, ".cull-statusbar__finish.is-done .cull-statusbar__finish-long")).toMatch(
      /display:\s*none/,
    );
    expect(ruleBody(tier, ".cull-statusbar__finish.is-done .cull-statusbar__finish-short")).toMatch(
      /display:\s*inline/,
    );

    // The plain (unscoped) finish-long shed must still live ONLY at 1120 —
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
      statusbar.indexOf("@media (width < 1240px) {"),
    );
    const tail = block.slice(block.indexOf(".cull-statusbar__unsaved-tail {"));
    expect(tail).toMatch(/clip-path:\s*inset\(50%\)/);
    expect(tail.slice(0, tail.indexOf("}"))).not.toMatch(/display:\s*none/);
  });

  test("the fifth tab is paid for inside the 1360 tier, not with a new breakpoint", () => {
    // Both rules use ruleBody (a line-anchored `selector {` match), not
    // toContain, so a comment naming the class cannot fake a pass.
    const tier = statusbar.slice(
      statusbar.indexOf("@media (width < 1360px) {"),
      statusbar.indexOf("@media (width < 1240px) {"),
    );
    // Smart's count is CLIPPED, never `display: none` — the button's
    // accessible name is "Smart · 4194" at every width.
    const count = ruleBody(tier, ".cull-statusbar__smart-count");
    expect(count).toMatch(/clip-path:\s*inset\(50%\)/);
    expect(count).not.toMatch(/display:\s*none/);
    // The padding override must out-specify chrome.css's own
    // `.cull-filter-tabs button` rule (index.css imports statusbar.css FIRST,
    // and a media query adds no specificity) WITHOUT reaching the sub-mode
    // tooltip's buttons, whose own padding rule is only (0,1,1). Hence the
    // two-member child-combinator list; ruleBody can only be asked for its
    // last member, so the first is pinned by a line-anchored regex.
    expect(tier).toMatch(/^ *\.cull-statusbar \.cull-filter-tabs > button,$/m);
    expect(ruleBody(tier, ".cull-statusbar .cull-filter-tab-group > button")).toMatch(
      /padding:\s*4px 8px/,
    );
    expect(tier, "the sub-mode chips keep their own 3px 7px").not.toMatch(
      /\.cull-filter-tab-tooltip/,
    );
    // No fourth breakpoint: layout.test's tier slices are keyed to exactly
    // these three widths. Matched on a LINE START so a width merely named in
    // the arithmetic comment above cannot add a phantom entry.
    const widths = [...statusbar.matchAll(/^@media \(width < (\d+)px\)/gm)].map((m) => m[1]);
    expect([...new Set(widths)]).toEqual(["1360", "1240", "1120"]);
  });

  test("the hover tip still right-aligns at the tab strip's edge, now that Rejects is last", () => {
    const chrome = sheet("./chrome.css");
    // `.cull-filter-tab-group:last-child` stopped matching Smart the moment a
    // bare <button> became the last child of .cull-filter-tabs.
    expect(chrome, "the stale :last-child rule must be gone").not.toContain(
      ".cull-filter-tab-group:last-child",
    );
    // ruleBody matches a selector that sits directly before ` {`, so it can
    // only be asked for the LAST member of a selector list; the first member
    // is pinned by its own line-anchored match instead.
    expect(chrome, "Smart's group is right-aligned at its new position").toMatch(
      /^\.cull-filter-tabs \.cull-filter-tab-group:nth-last-child\(2\) button\[data-tip\]:hover::after,$/m,
    );
    const tip = ruleBody(chrome, ".cull-filter-tabs > button[data-tip]:last-child:hover::after");
    expect(tip).toMatch(/right:\s*0/);
    expect(tip).toMatch(/left:\s*auto/);
    expect(tip).toMatch(/transform:\s*none/);
  });
});

describe("the filmstrip's scrub-speed chip", () => {
  test("its offset is expressed in --cell-h, not a literal that only fits one step", () => {
    // Fix round 4: at the strip's real 83/103px box the chip used to sit ON
    // the thumbnails' lower edge (a literal `bottom: 7px` measured from a bar
    // anchored near the strip's bottom). A literal fits one cell step only —
    // pinning `--cell-h` in the expression is what keeps it 2px clear of the
    // cells' top edge at both the small (54px) and large (74px) step. See the
    // derivation comment in strip.css above this rule.
    const strip = sheet("./strip.css");
    expect(ruleBody(strip, ".cull-scrubbar__speed")).toContain("bottom: calc(var(--cell-h) + 7px)");
    expect(
      ruleBody(strip, ".cull-scrubbar__speed"),
      "no literal px fallback for bottom",
    ).not.toMatch(/bottom:\s*\d/);
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

describe("the backdrops", () => {
  const rules = [
    [sheet("./chrome.css"), ".cull-chrome::before"],
    [sheet("./empty-state.css"), ".cull-empty-state--desert::before"],
  ] as const;

  test("the tone is baked, so neither rule dims or desaturates at runtime", () => {
    for (const [css, selector] of rules) {
      const body = ruleBody(css, selector);
      expect(body, `${selector} filter`).not.toMatch(/\bfilter:/);
      expect(body, `${selector} opacity`).not.toMatch(/\bopacity:/);
    }
  });

  test("the vignette stays in CSS, identical in both", () => {
    const mask = "radial-gradient(115% 90% at 50% 42%, #000 30%, transparent 78%)";
    for (const [css, selector] of rules) {
      const body = ruleBody(css, selector);
      expect(body, `${selector} mask`).toContain(`mask-image: ${mask}`);
      expect(body, `${selector} -webkit-mask`).toContain(`-webkit-mask-image: ${mask}`);
    }
  });
});

describe("the staged-folder offset stepper", () => {
  test("− / value / + read as one tight group, not spread across the row", () => {
    const css = sheet("./staged-sort.css");
    // --sp-2 is 6px (tokens.css) — the tightest of the two small steps, and
    // the ceiling the brief picked for "a few px gap".
    const stepper = ruleBody(css, ".cull-staged-sort__stepper");
    expect(stepper).toMatch(/gap:\s*var\(--sp-2\)/);
    expect(stepper, "would push the value away from one button").not.toMatch(
      /justify-content:\s*space-between/,
    );
    // The value itself used to hug the right edge of its 84px box (inherited
    // `text-align: right` from the shared count/time/delta/offset list rule
    // above), which read as "far from the −" even though the flex gap on
    // both sides was already tight — centring it is what actually closes the
    // visual gap to the − button. `.cull-staged-sort__offset` is also the
    // LAST selector of that shared comma list, so it line-anchors identically
    // to its own standalone override rule below — slice past the shared
    // rule's close brace first so `ruleBody` can only find the override.
    const sharedListEnd = css.indexOf("}", css.indexOf(".cull-staged-sort__offset {"));
    expect(ruleBody(css.slice(sharedListEnd), ".cull-staged-sort__offset")).toMatch(
      /text-align:\s*center/,
    );
  });
});

describe("the grid's colour-label bar", () => {
  test("out-specifies marks.css's inset with a compound selector, not import order", () => {
    // marks.css's `.cull-label-bar` and grid.css's inset rule are both a
    // single class (0,1,0) — whichever file happens to import LAST would win
    // on source order alone, and index.css imports marks.css after grid.css,
    // so the bar used to land in the 9px inter-image corridor instead of on
    // the frame. Raising this rule to a compound selector (0,2,0) makes it
    // win regardless of import order. ruleBody's line-anchored `selector {`
    // match means a comment merely mentioning the compound selector cannot
    // fake a pass, and it throws outright if the bare, lower-specificity
    // selector is what's actually there.
    const body = ruleBody(sheet("./grid.css"), ".cull-label-bar.cull-grid__label-bar");
    expect(body).toContain("left: 9px");
    expect(body).toContain("right: 9px");
    expect(body).toContain("bottom: 9px");
  });
});
