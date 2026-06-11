import { useEffect, useSyncExternalStore } from "react";
import { imageStore } from "./imageStore";
import type { Resolved } from "./stage";

export function useImage(path: string, opts: { wantFull: boolean }): Resolved {
  const snap = useSyncExternalStore(
    (cb) => imageStore.subscribe(path, cb),
    () => imageStore.snapshot(path),
  );
  // Thumb request keys on path only — a wantFull toggle shouldn't re-fire it
  // (it's idempotent, but keeping it off the wantFull dep is clearer). The
  // display ref registered alongside protects this path's thumb blob from
  // LRU revocation while this consumer is mounted (it may be the very <img>
  // showing that blob via the scrub/compare thumbUrl fallbacks).
  useEffect(() => {
    if (!path) return undefined;
    imageStore.requestThumbFor(path);
    imageStore.registerDisplay(path);
    return () => imageStore.unregisterDisplay(path);
  }, [path]);
  useEffect(() => {
    if (!opts.wantFull) return undefined;
    imageStore.registerWantFull(path);
    return () => imageStore.unregisterWantFull(path);
  }, [path, opts.wantFull]);
  return snap;
}
