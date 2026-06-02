import { useEffect, useSyncExternalStore } from "react";
import { imageStore } from "./imageStore";
import type { Resolved } from "./stage";

export function useImage(path: string, opts: { wantFull: boolean }): Resolved {
  const snap = useSyncExternalStore(
    (cb) => imageStore.subscribe(path, cb),
    () => imageStore.snapshot(path),
  );
  useEffect(() => {
    imageStore.requestThumbFor(path);
    if (opts.wantFull) {
      imageStore.registerWantFull(path);
      return () => imageStore.unregisterWantFull(path);
    }
    return undefined;
  }, [path, opts.wantFull]);
  return snap;
}
