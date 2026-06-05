/**
 * Shared skeleton-shimmer clock. Every shimmer on screen (grid cells, filmstrip
 * cells, the loupe + compare matte fills) animates the same `cull-shimmer-sweep`
 * keyframes, but CSS animations start at each element's own mount — so without a
 * shared phase they drift out of sync. We snap them all to ONE module-load epoch
 * via a negative `animation-delay` (exposed as the `--shimmer-delay` CSS var):
 * delay = -(elapsed % duration) places a just-mounted element exactly where an
 * element that mounted at the epoch would be right now. Pin the value at mount
 * (useMemo([...])) so re-renders don't restart the animation.
 */

/** Module-load epoch (ms). All shimmers measure their phase from here. */
const SHIMMER_EPOCH_MS = Date.now();

/** Sweep duration — MUST match the `cull-shimmer-sweep` animation in App.css. */
const SHIMMER_DURATION_MS = 1400;

/** Current phase offset (ms) into the shared sweep cycle. Pin at mount and pass
 *  as `--shimmer-delay: -<value>ms`. */
export function shimmerPhaseMs(): number {
  return (Date.now() - SHIMMER_EPOCH_MS) % SHIMMER_DURATION_MS;
}
