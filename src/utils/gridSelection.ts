/**
 * Grid multi-selection range math, shared by shift-click and shift+arrow so
 * mouse and keyboard grow the exact same selection.
 *
 * `visible` is the filter's ordered list of ABSOLUTE image indices; `anchor`
 * and `target` are absolute indices too. Returns the inclusive range between
 * their positions in `visible`, or null when either end is no longer in the
 * filter (caller reseats the anchor, mirroring the shift-click fallback).
 */
export function extendSelection(
  visible: readonly number[],
  anchor: number,
  target: number,
): Set<number> | null {
  const a = visible.indexOf(anchor);
  const b = visible.indexOf(target);
  if (a === -1 || b === -1) return null;
  const [lo, hi] = a < b ? [a, b] : [b, a];
  const out = new Set<number>();
  for (let k = lo; k <= hi; k++) out.add(visible[k]);
  return out;
}
