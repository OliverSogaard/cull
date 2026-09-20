import { describe, expect, test } from "vitest";

/**
 * The reduced-motion review gate.
 *
 * Every `@keyframes` under `src/styles` must be named in a `reviewed:` comment
 * in `motion.css`, beside the rule that decides what it does when the OS asks
 * for less motion. A keyframe added later therefore fails this test until
 * someone has ruled on it — which is the whole point: the gap this closes was
 * thirteen animations and no policy at all.
 */
const sheets = import.meta.glob<string>("./**/*.css", {
  query: "?raw",
  eager: true,
  import: "default",
});

const motionCss = sheets["./motion.css"] ?? "";

const sorted = (names: string[]): string[] => [...new Set(names)].sort();

/** Every keyframe the stylesheets define. */
const declared = sorted(
  Object.values(sheets).flatMap((css) =>
    [...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]),
  ),
);

/**
 * Every keyframe motion.css has ruled on. After `reviewed:` a comment carries
 * comma-separated keyframe names and nothing else, to the end of the line.
 */
const reviewed = sorted(
  [...motionCss.matchAll(/reviewed:([^\r\n*]*)/g)]
    .flatMap((m) => m[1].split(","))
    .map((name) => name.trim())
    .filter((name) => name.length > 0),
);

describe("reduced motion", () => {
  test("the stylesheets arrive as readable text, not empty stubs", () => {
    // Guards the mechanism itself: a bundler that hands back "" for a CSS
    // `?raw` import would make every assertion below pass on nothing.
    expect(Object.keys(sheets).length).toBeGreaterThan(10);
    expect(declared.length).toBeGreaterThan(0);
  });

  test("motion.css scopes its overrides to a reduce-only media query", () => {
    expect(motionCss).toContain("@media (prefers-reduced-motion: reduce)");
  });

  test("every keyframe in src/styles has a reviewed reduced-motion behaviour", () => {
    expect(reviewed).toEqual(declared);
  });
});
