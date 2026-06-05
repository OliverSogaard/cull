import type { Rating } from "./rating";

/** Phases of the chrome flow before the cull view mounts. */
export type Phase = "start" | "loading" | "staged" | "analyzing" | "culling";

/**
 * Transient rating feedback — a brief overlay flash so the user sees the
 * verdict register before the cursor advances. `ts` lets the timeout race
 * be settled without staring at a stale rating.
 */
export type Feedback = { rating: Rating; imageId: number; ts: number };
