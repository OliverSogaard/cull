import type { AnalyzeResult } from "../types";

/** Status-bar chip text for the analyze pass's non-fatal failures. */
export type AnalyzeWarning = { label: string; detail: string };

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/**
 * Turn the analyze pass's failure lists into one chip: a short label
 * ("1 folder not listed · 3 ratings not restored") and a multi-line detail
 * for the tooltip. `null` when the pass was clean.
 */
export function summarizeAnalyzeWarnings(
  r: Pick<AnalyzeResult, "unreadableDirs" | "restoreErrors" | "restoreErrorCount">,
): AnalyzeWarning | null {
  const dirs = r.unreadableDirs ?? [];
  const errs = r.restoreErrors ?? [];
  const errCount = r.restoreErrorCount ?? errs.length;
  if (dirs.length === 0 && errCount === 0) return null;
  const parts: string[] = [];
  const lines: string[] = [];
  if (dirs.length > 0) {
    parts.push(`${count(dirs.length, "folder")} not listed`);
    lines.push(
      "Folders that couldn't be listed (their frames sort last, ratings not restored):",
      ...dirs,
    );
  }
  if (errCount > 0) {
    parts.push(`${count(errCount, "rating")} not restored`);
    lines.push("Sidecars that couldn't be read:", ...errs);
    if (errCount > errs.length) lines.push(`…and ${errCount - errs.length} more`);
  }
  lines.push("click to dismiss");
  return { label: parts.join(" · "), detail: lines.join("\n") };
}
