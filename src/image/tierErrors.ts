/**
 * Tier error model (grand cleanup Phase 8, split from imageStore — pure
 * logic, verbatim semantics). Per-path per-tier transient-failure state with
 * capped exponential backoff. attempts 1..MAX retry automatically (1s, 2s,
 * 4s… capped); at MAX the tier is TERMINAL: no auto-retry until the folder
 * is revisited (reset clears these) or the user hits the error panel's retry
 * affordance (retry()).
 */

/** Per-tier failure record. */
export type TierError = { attempts: number; lastError: string; nextRetryAt: number };

/** First-retry delay; doubles per attempt. */
const RETRY_BASE_MS = 1000;
/** Backoff ceiling. */
const RETRY_CAP_MS = 30_000;
/** Failed attempts before a tier goes terminal. */
export const MAX_TIER_ATTEMPTS = 4;
/** Distinct terminal-failed paths that trip the folder-unreachable affordance
 *  (NAS unmounted / sleep-wake) — past this the store stops hammering and App
 *  surfaces a non-blocking "folder unreachable — retry" chip. */
export const FOLDER_TROUBLE_THRESHOLD = 4;

export const backoffMs = (attempts: number): number =>
  Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** (attempts - 1));

/** True while the tier must NOT be auto-requested (cooling down or terminal). */
export const inCooldown = (te: TierError | undefined, now: number): boolean =>
  te !== undefined && (te.attempts >= MAX_TIER_ATTEMPTS || now < te.nextRetryAt);

/** Record a failed read for one tier: bump the attempt count and stamp the
 *  next-retry time. The caller owns the side effects (error counter, the
 *  folder-trouble latch below). */
export function recordTierError(map: Map<string, TierError>, path: string, msg: string): TierError {
  const attempts = (map.get(path)?.attempts ?? 0) + 1;
  const te: TierError = {
    attempts,
    lastError: msg,
    nextRetryAt: Date.now() + backoffMs(attempts),
  };
  map.set(path, te);
  return te;
}

/**
 * The folder-trouble latch: tracks paths whose thumb or full reached
 * MAX_TIER_ATTEMPTS this session, and latches once the distinct count crosses
 * the threshold — the folder itself is almost certainly unreachable (NAS
 * unmount / sleep-wake). While latched the store stops all auto-retries + the
 * bg sweep until the user retries (App re-runs the scan → reset()) or
 * retry()/rearm() clears state.
 */
export class FolderTroubleLatch {
  private terminalPaths = new Set<string>();
  private troubled = false;

  constructor(private readonly threshold = FOLDER_TROUBLE_THRESHOLD) {}

  get isTroubled(): boolean {
    return this.troubled;
  }

  /** Note a path that just went terminal. Returns true exactly when this
   *  call LATCHES the trouble state (the caller fires the one-shot sink). */
  noteTerminal(path: string): boolean {
    this.terminalPaths.add(path);
    if (!this.troubled && this.terminalPaths.size >= this.threshold) {
      this.troubled = true;
      return true;
    }
    return false;
  }

  /** Manual per-path retry: the path gets a clean slate. Deliberately does
   *  NOT unlatch trouble — one path retrying says nothing about the folder. */
  clearPath(path: string): void {
    this.terminalPaths.delete(path);
  }

  /** Folder revisit / reachability confirmed (reset/rearm): clean slate. */
  reset(): void {
    this.terminalPaths.clear();
    this.troubled = false;
  }
}
