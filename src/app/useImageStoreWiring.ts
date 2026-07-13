import { useCallback, useEffect, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { ImageMetadata, Phase } from "../types";
import { PERFORMANCE_PROFILES, type StorageMode } from "../types/settings";
import { imageStore } from "../image/imageStore";
import { mergeMeta } from "../utils/mergeMeta";

/**
 * Image loading via imageStore — the App-side wiring, verbatim from App
 * (grand cleanup Phase 6). All pixel loading (thumbs + full-res previews),
 * the bounded-concurrency NAS read pool, the windowed full-res cache, and
 * blob-URL lifecycle live in `imageStore` (driven here + consumed by
 * `useImage` in each view). App only feeds it the storage profile, the
 * cursor, the grid viewport, and a metadata sink — and tells it when the
 * folder / session changes.
 *
 * Read concurrency, previewKeep, hi-res zoom warm-up, background-fill rate,
 * and concurrent XMP restore all live in PERFORMANCE_PROFILES, switched by
 * the storage-mode setting and pushed into the imageStore via `setProfile`.
 * Memory bounds for 10k-folder sessions are owned by the imageStore:
 * full-res blobs (~5–6 MB each) are kept only within `previewKeep` of the
 * cursor and revoked outside it, while thumbnails persist for the session
 * under a 15k-entry safety LRU. See src/image/imageStore.ts and
 * ARCHITECTURE.md "Read pipeline".
 */
export function useImageStoreWiring({
  storageMode,
  phase,
  compareMode,
  gridVisible,
  currentIndex,
  challengerIndex,
  scrubbing,
  stageRef,
  setMetadata,
}: {
  storageMode: StorageMode;
  phase: Phase;
  compareMode: boolean;
  gridVisible: boolean;
  currentIndex: number;
  challengerIndex: number;
  scrubbing: boolean;
  stageRef: RefObject<HTMLDivElement | null>;
  setMetadata: Dispatch<SetStateAction<Record<string, ImageMetadata>>>;
}) {
  // `?? local` is belt-and-suspenders: useSettings now validates storageMode, but
  // a future bug or out-of-range value must never make this undefined (the store
  // would then read .previewKeep/.previewConcurrency off undefined and crash).
  const profile = PERFORMANCE_PROFILES[storageMode] ?? PERFORMANCE_PROFILES.local;

  // Storage-mode profile → store concurrency caps + keep-window sizes.
  useEffect(() => {
    imageStore.setProfile(profile);
  }, [profile]);

  // Display-adaptive mid tier (Phase 8). The store owns the tier choice; App
  // supplies the measurement and the re-evaluation triggers:
  // 1) the FRESH needPx provider — stage rect height × devicePixelRatio,
  //    measured at CALL time, never cached at mount. (The stage div itself is
  //    never transformed — zoom scales the layers inside it — so measuring it
  //    is safe even while zoomed, unlike the img-rect measure below.)
  useEffect(() => {
    imageStore.setNeedPxProvider(() => {
      const el = stageRef.current;
      if (!el) return null;
      const h = el.getBoundingClientRect().height;
      return h >= 1 ? h * window.devicePixelRatio : null;
    });
    return () => imageStore.setNeedPxProvider(undefined);
  }, [stageRef]);
  // 2) stage resizes (strip/rail toggles, window resize) re-run the choice.
  //    Deps re-attach when the loupe stage (re)mounts — compare/grid render
  //    different bodies, so stageRef points elsewhere or nowhere there.
  useEffect(() => {
    if (phase !== "culling" || compareMode || gridVisible) return;
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => imageStore.reevaluateMid());
    ro.observe(el);
    return () => ro.disconnect();
  }, [phase, compareMode, gridVisible, stageRef]);
  // 3) DPR flips (window dragged 4K ↔ 1440p) — tier choice flips without a
  //    restart. matchMedia('(resolution: Xdppx)') fires ONCE when the DPR
  //    leaves the armed value, so the handler re-arms at the new DPR.
  useEffect(() => {
    let mql: MediaQueryList | null = null;
    const onChange = () => {
      imageStore.reevaluateMid();
      arm();
    };
    const arm = () => {
      mql?.removeEventListener("change", onChange);
      mql = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      mql.addEventListener("change", onChange);
    };
    arm();
    return () => mql?.removeEventListener("change", onChange);
  }, []);

  // EXIF metadata sink: ImageMetadata rides three wire paths (thumb decode,
  // preview read, full-res bundle read). Each delivery replaces the per-path
  // entry (a pre-seeded lrc-only entry must still gain its EXIF), EXCEPT two
  // fields that must be carried forward from the previous entry whenever the
  // incoming delivery lacks them — see mergeMeta for why (lrcRating: the
  // bundle no longer reads the sidecar per navigation; phash: only the thumb
  // path ever computes it, so a later preview/full read with phash: null
  // must not wipe the standing near-duplicate signal Similar groups chain on).
  useEffect(() => {
    imageStore.setMetaSink((path, meta) => {
      setMetadata((m) => ({ ...m, [path]: mergeMeta(m[path], meta) }));
    });
    return () => imageStore.setMetaSink(undefined);
  }, [setMetadata]);

  // Cursor → drives the store's full-res keep-window + thumb/bg prioritisation
  // (nearest-first). Follows the challenger in compare, the cursor otherwise.
  useEffect(() => {
    imageStore.setCursor(compareMode ? challengerIndex : currentIndex, scrubbing);
  }, [currentIndex, compareMode, challengerIndex, scrubbing]);

  // Grid viewport range → store background-fill prioritisation (visible cells
  // first). Wired to GridView's onViewportChange.
  const handleGridViewport = useCallback((first: number, last: number) => {
    imageStore.setGridRange(first, last);
  }, []);

  return { profile, handleGridViewport };
}
