import type { SharpInput } from "./groupBursts";

/** prob_open at or above this counts as "eyes open" for the winner tiebreak. */
export const EYES_OPEN_MIN = 0.5;

/** Strict "a beats b" for winner selection (ties fall through → earliest wins). */
function beats(a: SharpInput, b: SharpInput): boolean {
  // Phase 3b: eyes first — when BOTH frames know their eye state and they
  // fall on opposite sides of the open/closed line, the open-eyed frame wins
  // outright (a portrait burst's keeper is never the blink). Same-side pairs
  // fall through to sharpness.
  if (a.eyesOpen != null && b.eyesOpen != null) {
    const aOpen = a.eyesOpen >= EYES_OPEN_MIN;
    const bOpen = b.eyesOpen >= EYES_OPEN_MIN;
    if (aOpen !== bOpen) return aOpen;
  }
  // Tier-2: when BOTH frames carry a face, the sharper face wins outright —
  // a portrait burst's keeper is the one where the SUBJECT is sharp.
  if (a.faceSharpness != null && b.faceSharpness != null && a.faceSharpness !== b.faceSharpness) {
    return a.faceSharpness > b.faceSharpness;
  }
  if (a.afSharpness !== b.afSharpness) return a.afSharpness > b.afSharpness;
  if (a.globalSharpness !== b.globalSharpness) return a.globalSharpness > b.globalSharpness;
  return a.clipSum < b.clipSum;
}

/**
 * The ONE winner ladder for every group kind (bursts, similar sets) — extracted
 * so the two structurally cannot drift. Winner requires EVERY member scored
 * (a half-scored group has no winner yet) and at least one eligible member
 * (nobody clears the keep bar → no winner: winners are smart culling's call).
 */
export function pickWinner(
  ids: readonly number[],
  sharp: Readonly<Record<number, SharpInput>> | undefined,
  eligible: Readonly<Record<number, boolean>> | undefined,
): { winnerIdx: number; winnerAf: number } {
  const sharps = ids.map((id) => sharp?.[id]);
  if (!sharps.every((s) => s != null)) return { winnerIdx: -1, winnerAf: 0 };
  let w = -1;
  for (let i = 0; i < ids.length; i++) {
    if (eligible && !eligible[ids[i]]) continue;
    if (w === -1 || beats(sharps[i]!, sharps[w]!)) w = i;
  }
  return { winnerIdx: w, winnerAf: w >= 0 ? sharps[w]!.afSharpness : 0 };
}
