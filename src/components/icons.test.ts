import { describe, expect, test } from "vitest";
import { ICON, ICON_DISPLAY_STROKE } from "./icons";

/**
 * The Unicode-glyph guard.
 *
 * CULL's chrome draws its marks with Lucide SVGs, not characters: a character
 * is rendered by whatever font the OS picks for it, so its size, weight and
 * baseline drift from the icon beside it (Segoe UI's star rides high, its
 * check is thin). Every glyph below therefore has a Lucide replacement, and
 * this test fails on any that comes back.
 *
 * Characters that are TEXT rather than chrome — an accessible name a screen
 * reader reads aloud, the name of a keyboard key, prose — are listed in
 * ALLOWLIST with a reason. The list is checked back against the source, so an
 * entry that stops matching a real line fails too rather than rotting.
 */
const CHROME_GLYPHS = ["✓", "✕", "★", "⚠", "↓", "⟶"];

/**
 * `.ts` as well as `.tsx`: copy that reaches the chrome does not only live in
 * components — utils/saveStatusCopy.ts writes the save-status wording, and a
 * glyph smuggled in there would render exactly like one written in JSX.
 */
const modules = import.meta.glob<string>("../**/*.{ts,tsx}", {
  query: "?raw",
  eager: true,
  import: "default",
});

/**
 * Glob keys are relative to THIS file, so a sibling arrives as
 * `./StatusBar.tsx` and the app root as `../App.tsx`. Both become the repo
 * path an editor can jump to.
 */
const repoPath = (key: string): string =>
  key.startsWith("../") ? key.replace(/^\.\.\//, "src/") : key.replace(/^\.\//, "src/components/");

/**
 * Blanks out comments so a glyph NAMED in prose doesn't read as a leak, while
 * leaving every line number intact.
 *
 * Block comments (including the JSX `{ slash-star … star-slash }` form) keep
 * their newlines and lose everything else; whole-line `//` comments are
 * emptied. A TRAILING `//` comment is deliberately left alone: telling one
 * apart from a `//` inside a string literal needs a parser, and guessing wrong
 * would hide a real leak. A flagged comment is the safe way to be wrong.
 */
const stripComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/^[ \t]*\/\/.*$/gm, "");

/** A character that stays a character, and why. `line` is the trimmed source line. */
type AllowedGlyph = { file: string; line: string; reason: string };

const ALLOWLIST: AllowedGlyph[] = [
  {
    file: "src/components/GridView.tsx",
    line: '<div className="cull-grid__lrc-badge" aria-label={`LrC ${lrcRating}★`}>',
    reason: "Accessible name — the star is spoken, so it must be a character, not an SVG.",
  },
  {
    file: "src/components/ThumbCell.tsx",
    line: '<div className="cull-thumb__lrc-badge" aria-label={`LrC ${lrcRating}★`}>',
    reason: "Accessible name — the star is spoken, so it must be a character, not an SVG.",
  },
  {
    file: "src/components/ExifRail.tsx",
    line: 'a: showLrcA && lrcA != null ? `${lrcA}★` : "—",',
    reason: "Compare-rail cell VALUE built as a string in a row data object, not markup.",
  },
  {
    file: "src/components/ExifRail.tsx",
    line: 'b: showLrcB && lrcB != null ? `${lrcB}★` : "—",',
    reason: "Compare-rail cell VALUE built as a string in a row data object, not markup.",
  },
  {
    file: "src/components/HelpOverlay.tsx",
    line: '["space (hold)", "1:1 zoom · ←↑↓→ pan · rating carries zoom to the next frame"],',
    reason: "Names the arrow KEYS being pressed — key names, like the ← → on the row above.",
  },
  {
    file: "src/components/HelpOverlay.tsx",
    line: '["space (hold)", "1:1 zoom · ←↑↓→ pan · deciding carries zoom"],',
    reason: "Names the arrow KEYS being pressed — key names, like the ← → on the row above.",
  },
  {
    file: "src/components/HelpOverlay.tsx",
    line: '["↑ ↓", "Row up / down"],',
    reason: "The key cap itself — this row IS the up/down arrow keys.",
  },
  {
    file: "src/components/HelpOverlay.tsx",
    line: '["⇧+← → ↑ ↓", "Grow selection"],',
    reason: "The key cap itself — this row IS the shifted arrow keys.",
  },
  {
    file: "src/components/HelpOverlay.tsx",
    line: '["f", "Keep both · challenger ★"],',
    reason: "Prose describing what the f key does; the help table is text, not chrome.",
  },
];

const sources = Object.entries(modules)
  .filter(([key]) => !key.includes(".test."))
  .map(([key, source]): [string, string] => [repoPath(key), source]);

const isAllowed = (file: string, line: string): boolean =>
  ALLOWLIST.some((entry) => entry.file === file && entry.line === line);

const leaks = sources.flatMap(([file, source]) => {
  return stripComments(source)
    .split(/\r?\n/)
    .flatMap((text, index) => {
      const found = CHROME_GLYPHS.filter((glyph) => text.includes(glyph));
      const trimmed = text.trim();
      if (found.length === 0 || isAllowed(file, trimmed)) return [];
      return [`${file}:${index + 1}  ${found.join(" ")}  ${trimmed}`];
    });
});

describe("the icon scale", () => {
  /**
   * Decision 7 of docs/superpowers/specs/2026-09-19-phase-3a-see-and-feel-design.md:
   * 12 / 14 px at stroke 1.75, 16 px at stroke 1.5, and the two display glyphs
   * keeping their size at stroke 1.5. Three steps is the whole point — the
   * stroke lightening as the icon grows is what makes unrelated icons read as
   * one set, and a step nudged by a later eyeball would undo that silently.
   */
  test("has the three steps the design board picked, strokes included", () => {
    expect(ICON.sm).toEqual({ size: 12, strokeWidth: 1.75 });
    expect(ICON.md).toEqual({ size: 14, strokeWidth: 1.75 });
    expect(ICON.lg).toEqual({ size: 16, strokeWidth: 1.5 });
  });

  test("gives the two display glyphs the same weight as the largest step", () => {
    expect(ICON_DISPLAY_STROKE).toBe(1.5);
    expect(ICON_DISPLAY_STROKE).toBe(ICON.lg.strokeWidth);
  });
});

describe("no Unicode glyphs in the chrome", () => {
  test("the components arrive as readable text, not empty stubs", () => {
    // Guards the mechanism: a bundler handing back "" for a `?raw` import would
    // make the assertion below pass on nothing at all.
    expect(sources.length).toBeGreaterThan(10);
    expect(sources.some(([, source]) => source.includes("lucide-react"))).toBe(true);
    // Both extensions really arrive — a glob narrowed back to `.tsx` would
    // stop guarding the copy modules without failing anything else here.
    expect(sources.some(([file]) => file.endsWith(".tsx"))).toBe(true);
    expect(sources.some(([file]) => file.endsWith(".ts"))).toBe(true);
  });

  test("every chrome glyph is drawn by a Lucide icon", () => {
    expect(leaks).toEqual([]);
  });

  test("every allowlisted character still matches a line that is there", () => {
    const byPath = new Map(sources);
    const stale = ALLOWLIST.filter((entry) => {
      const source = byPath.get(entry.file);
      return (
        source === undefined || !source.split(/\r?\n/).some((text) => text.trim() === entry.line)
      );
    }).map((entry) => `${entry.file}  ${entry.line}`);
    expect(stale).toEqual([]);
  });

  test("every allowlisted character says why it stays a character", () => {
    expect(ALLOWLIST.filter((entry) => entry.reason.trim().length === 0)).toEqual([]);
  });
});
