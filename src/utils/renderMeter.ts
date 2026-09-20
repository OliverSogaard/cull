/**
 * Dev-only render cost meter behind the dev HUD: how many React commits the
 * App tree made since the session began, what they cost, and how often the
 * burst/similar derivation chain re-ran. Fed by the <Profiler> in main.tsx
 * (dev builds only — React strips Profiler timing from production bundles,
 * where these stay at zero). Every Phase 2 claim cites these numbers.
 */
export type RenderMeterSnapshot = {
  commits: number;
  totalMs: number;
  maxMs: number;
  derives: number;
  elapsedS: number;
};

export type RenderMeter = {
  record: (actualMs: number) => void;
  bumpDerive: () => void;
  reset: () => void;
  snapshot: () => RenderMeterSnapshot;
};

const round1 = (n: number) => Math.round(n * 10) / 10;

export function createRenderMeter(now: () => number): RenderMeter {
  let commits = 0;
  let totalMs = 0;
  let maxMs = 0;
  let derives = 0;
  let since = now();
  return {
    record: (actualMs) => {
      commits++;
      totalMs += actualMs;
      if (actualMs > maxMs) maxMs = actualMs;
    },
    bumpDerive: () => {
      derives++;
    },
    reset: () => {
      commits = 0;
      totalMs = 0;
      maxMs = 0;
      derives = 0;
      since = now();
    },
    snapshot: () => ({
      commits,
      totalMs: round1(totalMs),
      maxMs: round1(maxMs),
      derives,
      elapsedS: Math.round((now() - since) / 1000),
    }),
  };
}

export const renderMeter = createRenderMeter(() => performance.now());
