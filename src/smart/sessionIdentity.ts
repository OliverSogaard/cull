import type { Img } from "../types/image";

/**
 * True when `next` is `prev` with frames taken out — the mid-cull prune after
 * "Move rejects" — so per-id state (smart-culling scores, latches) can carry
 * over. Ids restart at 0 per folder, so the check is id AND path: another
 * folder never matches. An empty `next` is a session end, never a prune.
 */
export function isPrunedSubset(prev: readonly Img[], next: readonly Img[]): boolean {
  if (next.length === 0 || next.length >= prev.length) return false;
  const pathById = new Map<number, string>();
  for (const im of prev) pathById.set(im.id, im.path);
  return next.every((im) => pathById.get(im.id) === im.path);
}
