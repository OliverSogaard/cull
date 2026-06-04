import { useEffect, useSyncExternalStore } from "react";
import { imageStore } from "./imageStore";
import type { Resolved } from "./stage";

export function useImage(path: string, opts: { wantFull: boolean }): Resolved {
  const snap = useSyncExternalStore(
    (cb) => imageStore.subscribe(path, cb),
    () => imageStore.snapshot(path),
  );
  // Thumb request keys on path only — a wantFull toggle shouldn't re-fire it
  // (it's idempotent, but keeping it off the wantFull dep is clearer).
  useEffect(() => {
    imageStore.requestThumbFor(path);
  }, [path]);
  useEffect(() => {
    if (!opts.wantFull) return undefined;
    imageStore.registerWantFull(path);
    return () => imageStore.unregisterWantFull(path);
  }, [path, opts.wantFull]);
  return snap;
}
