// Defined-vs-referenced census of `cull-*` classes. Output is a STARTING LIST, not a
// verdict: template-literal class builders (VerdictDot, PhotoPane, ThumbCell, ExifRail,
// App's feedback pop) produce names this grep cannot see — reconcile by hand.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
function walk(dir, out = []) { for (const n of readdirSync(dir)) { const p = join(dir, n); (statSync(p).isDirectory() ? walk(p, out) : out.push(p)); } return out; }
const files = walk("src");
const css = files.filter((f) => f.endsWith(".css")).map((f) => readFileSync(f, "utf8")).join("\n");
const code = files.filter((f) => /\.(tsx?|jsx?)$/.test(f) && !/\.test\./.test(f)).map((f) => readFileSync(f, "utf8")).join("\n");
const defined = new Set([...css.matchAll(/\.(cull-[a-z0-9_-]+)/g)].map((m) => m[1]));
const used = new Set([...code.matchAll(/\b(cull-[a-z0-9_-]+)/g)].map((m) => m[1]));
const unref = [...defined].filter((c) => !used.has(c)).sort();
const undef = [...used].filter((c) => !defined.has(c)).sort();
console.log(`defined ${defined.size} · referenced ${used.size}`);
console.log(`unreferenced in code (${unref.length}):\n  ${unref.join("\n  ")}`);
console.log(`undefined in css (${undef.length}):\n  ${undef.join("\n  ")}`);
