import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  AnalyzeProgress,
  AnalyzeResult,
  Feedback,
  Filter,
  Img,
  ImageMetadata,
  NavEntry,
  Phase,
  Rating,
  ScanResult,
  Settings,
  UndoAction,
} from "../types";
import type { ScanFailure } from "../components/ScanFailureCard";
import { recentKey, type RecentEntry } from "../hooks/useRecents";
import { normalizeRejectedSubfolder, type PerformanceProfile } from "../types/settings";
import { basename } from "../utils/path";
import { imageStore } from "../image/imageStore";
import { overlayService } from "../overlays/overlayService";

/**
 * All-null ImageMetadata template. Seeds a grid badge from a known LrC star
 * before the per-image bundle read fills in real EXIF — kept centralized (and
 * frozen) so adding a metadata field only touches one place, not every seed.
 */
const EMPTY_METADATA: ImageMetadata = Object.freeze({
  capturedAt: null,
  subSecMs: null,
  camera: null,
  lens: null,
  focalLengthMm: null,
  aperture: null,
  shutterSeconds: null,
  iso: null,
  gpsLat: null,
  gpsLon: null,
  afXPct: null,
  afYPct: null,
  exposureBias: null,
  whiteBalance: null,
  driveMode: null,
  pixelWidth: null,
  pixelHeight: null,
  fileSize: null,
  lrcRating: null,
  phash: null,
});

/**
 * Session lifecycle, verbatim from App (grand cleanup Phase 6): staging
 * folders (picker / drag-drop / recents / launch auto-open), entering the
 * cull (analyze + sort + rating restore), the session's recents entry
 * write-back, and tearing the session down (reset / leave-to-home).
 */
export function useSessionLifecycle({
  images,
  imagesRef,
  ratings,
  settings,
  phase,
  pickerBusy,
  profile,
  recentFolders,
  pushRecent,
  removeEntry,
  undoStack,
  redoStack,
  resetZoom,
  setFeedback,
  setImages,
  setRatings,
  setMetadata,
  setCurrentIndex,
  setFilter,
  setPhase,
  setPendingFolder,
  setPickerBusy,
  setScanFailures,
  setAnalyzeError,
  setLastAdded,
  setLastIgnored,
  setLastBatchFolders,
  setFolder,
  setProgress,
  setThumbsVisible,
  setExifVisible,
  setClippingVisible,
  setPeakingVisible,
  setCompositionVisible,
  setCompareMode,
  setGridVisible,
  setNavStack,
  setSelectedIndices,
  setSelectionAnchor,
  setConfirmHome,
}: {
  images: Img[];
  imagesRef: RefObject<Img[]>;
  ratings: Record<number, Rating>;
  settings: Settings;
  phase: Phase;
  pickerBusy: boolean;
  profile: PerformanceProfile;
  recentFolders: RecentEntry[];
  pushRecent: (entry: RecentEntry) => void;
  removeEntry: (key: string) => void;
  undoStack: RefObject<UndoAction[]>;
  redoStack: RefObject<UndoAction[]>;
  resetZoom: () => void;
  setFeedback: Dispatch<SetStateAction<Feedback | null>>;
  setImages: Dispatch<SetStateAction<Img[]>>;
  setRatings: Dispatch<SetStateAction<Record<number, Rating>>>;
  setMetadata: Dispatch<SetStateAction<Record<string, ImageMetadata>>>;
  setCurrentIndex: Dispatch<SetStateAction<number>>;
  setFilter: Dispatch<SetStateAction<Filter>>;
  setPhase: Dispatch<SetStateAction<Phase>>;
  setPendingFolder: Dispatch<SetStateAction<string | null>>;
  setPickerBusy: Dispatch<SetStateAction<boolean>>;
  setScanFailures: Dispatch<SetStateAction<readonly ScanFailure[] | null>>;
  setAnalyzeError: Dispatch<SetStateAction<string | null>>;
  setLastAdded: Dispatch<SetStateAction<number>>;
  setLastIgnored: Dispatch<SetStateAction<number>>;
  setLastBatchFolders: Dispatch<SetStateAction<string[]>>;
  setFolder: Dispatch<SetStateAction<string | null>>;
  setProgress: Dispatch<SetStateAction<AnalyzeProgress>>;
  setThumbsVisible: Dispatch<SetStateAction<boolean>>;
  setExifVisible: Dispatch<SetStateAction<boolean>>;
  setClippingVisible: Dispatch<SetStateAction<boolean>>;
  setPeakingVisible: Dispatch<SetStateAction<boolean>>;
  setCompositionVisible: Dispatch<SetStateAction<boolean>>;
  setCompareMode: Dispatch<SetStateAction<boolean>>;
  setGridVisible: Dispatch<SetStateAction<boolean>>;
  setNavStack: Dispatch<SetStateAction<NavEntry[]>>;
  setSelectedIndices: Dispatch<SetStateAction<Set<number>>>;
  setSelectionAnchor: Dispatch<SetStateAction<number | null>>;
  setConfirmHome: Dispatch<SetStateAction<boolean>>;
}) {
  // Serialises folder opens: a scan already in flight makes any second open
  // (drag-drop, recents, mount auto-open) a no-op until it settles.
  const openBusyRef = useRef(false);
  // Guards begin-culling against a double-click firing two analyze passes.
  const analyzingRef = useRef(false);

  // The recents key of the entry THIS session last wrote. A session's folder
  // set can grow (drop-append while staged), which changes its key — tracking
  // the previous key lets the writer replace the stale entry instead of
  // leaving both "[A]" and "[A, B]" rows behind.
  const sessionRecentsKeyRef = useRef<string | null>(null);

  // Replace this session's recents entry (removing the previous-keyed row if
  // the folder set changed since the last write) and remember the new key.
  const commitSessionRecent = useCallback(
    (paths: string[], count: number, rated: number) => {
      if (paths.length === 0) return;
      const key = recentKey(paths);
      const prevKey = sessionRecentsKeyRef.current;
      if (prevKey && prevKey !== key) removeEntry(prevKey);
      pushRecent({
        paths,
        count,
        rated,
        lastOpened: new Date().toISOString(),
        done: count > 0 && rated === count,
      });
      sessionRecentsKeyRef.current = key;
    },
    [pushRecent, removeEntry],
  );

  // Write this session's single combined recents entry: all source folders in
  // first-staged order, with combined count/rated across the whole set.
  const writeSessionRecent = useCallback(
    (imgs: Img[], ratingsMap: Record<number, Rating>) => {
      if (imgs.length === 0) return;
      const paths: string[] = [];
      const seen = new Set<string>();
      let rated = 0;
      for (const im of imgs) {
        if (!seen.has(im.srcFolder)) {
          seen.add(im.srcFolder);
          paths.push(im.srcFolder);
        }
        if (ratingsMap[im.id]) rated += 1;
      }
      commitSessionRecent(paths, imgs.length, rated);
    },
    [commitSessionRecent],
  );

  /**
   * Scan known folder paths and stage their CR3s, appended in order. Same
   * logic as `pickFolder` minus the OS picker — used by `pickFolder` after the
   * user picks, by drag-drop, by recents clicks (which pass `fromRecentKey` so
   * the session replaces that entry instead of duplicating it), and by the
   * launch-time "open last folder" effect.
   */
  const openFoldersByPaths = useCallback(
    async (picked: string[], opts?: { fromRecentKey?: string }) => {
      // One scan at a time. A second open launched while one is in flight
      // (drag-drop, recents, mount auto-open) would race the append and the
      // begin-culling snapshot — serialise every caller through this gate.
      if (openBusyRef.current) return;
      // NFC-normalize at the single folder-path entry point: macOS file APIs
      // can hand back decomposed Unicode (NFD: "ø" = "o" + combining stroke),
      // which would fork recents keys / cache keys / lastDir comparisons for
      // Danish folder names. Everything downstream sees one canonical form.
      const folders = picked
        .filter((p) => typeof p === "string" && p.length > 0)
        .map((p) => p.normalize("NFC"));
      if (folders.length === 0) return;
      openBusyRef.current = true;
      setPickerBusy(true);
      setScanFailures(null);
      setAnalyzeError(null);
      // A recents click re-opens a saved session: seed the session key so the
      // staged set's write-back REPLACES that entry rather than duplicating it.
      if (opts?.fromRecentKey) sessionRecentsKeyRef.current = opts.fromRecentKey;
      let totalAdded = 0;
      let totalIgnored = 0;
      const okFolders: string[] = [];
      const failures: ScanFailure[] = [];
      try {
        setPhase("loading");
        for (const folderPath of folders) {
          // Per-folder label so the loading screen tracks the batch as it scans.
          setPendingFolder(folderPath);
          try {
            const scan = await invoke<ScanResult>("scan_folder", {
              path: folderPath,
              ignoreSubdir: normalizeRejectedSubfolder(settings.rejectedSubfolder),
            });
            const paths = scan.paths.map((p) => p.normalize("NFC"));
            totalIgnored += scan.ignored;

            // Persist the last-used dir only AFTER a successful scan, so a folder
            // that fails to open never becomes the picker default / auto-open target.
            localStorage.setItem("cull:lastDir", folderPath);

            // APPEND, never replace. Read the prior set from imagesRef and update it
            // synchronously alongside setImages, so dedupe + ids are computed against
            // the freshest set even if two opens land back-to-back. An empty folder
            // appends nothing rather than wiping the set.
            const prev = imagesRef.current;
            const existing = new Set(prev.map((im) => im.path));
            const additions = paths.filter((p) => !existing.has(p));
            const startId = prev.length;
            const appended = additions.map((p, i) => ({
              id: startId + i,
              path: p,
              filename: basename(p),
              srcFolder: folderPath,
            }));
            if (appended.length > 0) {
              imagesRef.current = [...prev, ...appended];
              setImages(imagesRef.current);
            }
            totalAdded += additions.length;
            okFolders.push(folderPath);
          } catch (e) {
            const msg = String(e);
            // Evict a single-folder entry only when its folder is definitively
            // gone (deleted / not a directory). A transient NAS/SMB blip must
            // NOT drop a valid, frequently-used folder — the backend tags
            // permanent vs transient.
            const permanent = /not found|not a directory/i.test(msg);
            if (permanent) removeEntry(recentKey([folderPath]));
            failures.push({ path: folderPath, msg, permanent });
          }
        }

        if (okFolders.length > 0) {
          setLastAdded(totalAdded);
          setLastIgnored(totalIgnored);
          setLastBatchFolders(okFolders);
          // `folder` keeps its "most recently opened" meaning — it labels the
          // loading fallback and seeds the finish dialog's default subfolder.
          setFolder(okFolders[okFolders.length - 1]);
        }

        if (opts?.fromRecentKey) {
          if (failures.some((f) => !f.permanent)) {
            // Part of the saved set failed transiently — keep its entry intact
            // so the user can retry the FULL set later. Whatever did load
            // writes a fresh entry under its own (different) key below.
            sessionRecentsKeyRef.current = null;
          } else if (okFolders.length === 0 && imagesRef.current.length === 0) {
            // Every folder of the saved set is permanently gone — the entry
            // can never open anything again.
            removeEntry(opts.fromRecentKey);
            sessionRecentsKeyRef.current = null;
          }
        }

        // Recents are NOT written at stage time — only beginCulling (and the
        // in-cull refreshes) record a session, so a mis-pick abandoned with
        // Esc leaves no trace and a re-opened recent that's Esc'd keeps its
        // original entry untouched. One exception: a re-opened recent whose
        // folders scanned fine but are now EMPTY can never reach culling, so
        // its existing entry is updated in place to a 0 count here instead of
        // advertising a stale total forever. Gated on the seeded key having
        // survived the failure handling above, so a partially-failed re-open
        // never spawns a fresh count-0 entry for a set that was never culled.
        if (
          sessionRecentsKeyRef.current === opts?.fromRecentKey &&
          opts?.fromRecentKey &&
          imagesRef.current.length === 0 &&
          okFolders.length > 0
        ) {
          commitSessionRecent(okFolders, 0, 0);
        }

        if (failures.length > 0) {
          setScanFailures(failures);
        }

        // Go straight to STAGED after the (sub-millisecond) scans — don't block
        // on preview decode. The current image preloads in the background so
        // "begin culling" is still instant by the time the user clicks it. A
        // successful scan that found nothing still lands on staged so the
        // "+0 · no new CR3 files" feedback is visible; only a batch where
        // every folder failed (and nothing was already staged) returns home.
        setPhase(imagesRef.current.length > 0 || okFolders.length > 0 ? "staged" : "start");
      } finally {
        setPendingFolder(null);
        setPickerBusy(false);
        openBusyRef.current = false;
      }
    },
    [
      commitSessionRecent,
      removeEntry,
      settings.rejectedSubfolder,
      imagesRef,
      setImages,
      setPhase,
      setPendingFolder,
      setPickerBusy,
      setScanFailures,
      setAnalyzeError,
      setLastAdded,
      setLastIgnored,
      setLastBatchFolders,
      setFolder,
    ],
  );

  const pickFolder = useCallback(async () => {
    if (pickerBusy) return; // a second click can't queue another dialog
    setPickerBusy(true);
    try {
      // Open straight into the last-used folder. On a machine with mapped
      // network drives, letting the picker build its default view (Quick
      // Access / Network) makes it enumerate the NAS before it can even
      // paint — pointing at a concrete path skips that.
      const lastDir = localStorage.getItem("cull:lastDir") ?? undefined;
      const picked = await open({ directory: true, multiple: true, defaultPath: lastDir });
      if (!picked) return; // cancelled — stay put
      // The multiple:true overload types the result as string[] | null, but
      // normalize defensively in case a platform dialog hands back a string.
      const folders = Array.isArray(picked) ? picked : [picked];
      // Hand off to the shared open-by-paths. (It also flips pickerBusy on/off,
      // which is fine — setState is idempotent.)
      await openFoldersByPaths(folders);
    } finally {
      setPickerBusy(false);
    }
  }, [pickerBusy, openFoldersByPaths, setPickerBusy]);

  // Launch-time auto-open: if the user prefers it and a last folder is
  // remembered, skip the home screen and load it straight away. Runs once on
  // app mount; intentionally NOT triggered every time settings.openLastFolderOnLaunch
  // flips, since that would re-open the folder mid-cull.

  useEffect(() => {
    if (!settings.openLastFolderOnLaunch) return;
    const lastDir = localStorage.getItem("cull:lastDir");
    if (!lastDir) return;
    // Reopen the full last SESSION when the last-used dir belongs to one —
    // restoring just lastDir out of a multi-folder session would fork a
    // subset entry in recents. (recentFolders is loaded synchronously from
    // localStorage, so the mount-time value is complete.)
    const session = recentFolders.find((r) => r.paths.includes(lastDir));
    if (session) {
      void openFoldersByPaths(session.paths, { fromRecentKey: recentKey(session.paths) });
    } else {
      void openFoldersByPaths([lastDir]);
    }
    // Intentional empty deps — mount-only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist the recents' rated/done counts WHILE culling, not only on the way
  // back home. leaveToHome already records them, but quitting straight from the
  // cull view (closing the window) never hit that path — so a later relaunch
  // showed the stale "327 / 372" from when the folder was opened. Debounced so a
  // rating burst writes once after it settles; localStorage.setItem is sync, so
  // whatever's on disk when the window dies is current to within the debounce.
  useEffect(() => {
    if (phase !== "culling" || images.length === 0) return;
    const t = window.setTimeout(() => writeSessionRecent(images, ratings), 600);
    return () => window.clearTimeout(t);
  }, [phase, images, ratings, writeSessionRecent]);

  // Begin culling: sort the staged set by capture time, restore ratings, then
  // enter the cull view (warming the first screenful of previews first).
  const beginCulling = useCallback(async () => {
    if (images.length === 0) return;
    if (analyzingRef.current) return; // ignore a double-click — one analyze pass
    analyzingRef.current = true;
    setAnalyzeError(null);
    setProgress({ done: 0, total: images.length, phase: "reading" });
    setPhase("analyzing");
    const unlisten = await listen<AnalyzeProgress>("analyze-progress", (e) =>
      setProgress(e.payload),
    );
    let ok = true;
    try {
      const result = await invoke<AnalyzeResult>("analyze_folder", {
        paths: images.map((im) => im.path),
        concurrentRestore: profile.concurrentRestore,
      });

      const sorted = result.order.map((i) => images[i]);
      // ratings are indexed by the ORIGINAL input order; key them by stable id.
      const restoredRatings: Record<number, Rating> = {};
      result.ratings.forEach((r, origIdx) => {
        if (r) restoredRatings[images[origIdx].id] = r as Rating;
      });

      // Seed the metadata map with the LrC star ratings from the sidecar pass
      // we just did. The grid renders before per-image bundles arrive, so this
      // lets the corner ★ badge appear immediately for any image that already
      // had an .xmp sidecar. The bundle read later fills in the rest of meta
      // (camera/lens/EXIF); this seed is the ONLY source of lrcRating — the
      // metaSink merge carries it forward when bundle meta lands without one.
      const seededMeta: Record<string, ImageMetadata> = {};
      const lrcRatings = result.lrcRatings ?? [];
      lrcRatings.forEach((lrc, origIdx) => {
        if (lrc != null && lrc > 0) {
          seededMeta[images[origIdx].path] = { ...EMPTY_METADATA, lrcRating: lrc };
        }
      });

      // ids ride along, so the rating map stays valid post-sort.
      setImages(sorted);
      setRatings(restoredRatings);
      setMetadata((prev) => ({ ...seededMeta, ...prev }));
      // Point the image store at the (sorted) culling set: revoke any prior
      // full-res blobs, keep thumbs, and kick off background thumb fill in
      // cursor-outward / grid-viewport order. Same array we just set.
      imageStore.reset(sorted.map((im) => im.path));
      // Same-session folder switch: drop overlays computed for the previous
      // set (resetSession isn't on this path; the store generation just moved).
      overlayService.reset();

      // Refresh the home-screen recents entry with the restored rated counts
      // straight off the sidecar pass — so reopening home shows "327 / 372"
      // immediately, even before the user touches a key.
      writeSessionRecent(sorted, restoredRatings);

      // Resume where you stopped: land on the first unrated frame in capture
      // order. All-rated or fresh folder → start at top.
      const resumeAt = sorted.findIndex((img) => !restoredRatings[img.id]);
      setCurrentIndex(resumeAt === -1 ? 0 : resumeAt);
      // defaultFilter applies AFTER resume: if it excludes the resumed frame, the
      // auto-jump effect re-homes the cursor to the nearest in-filter one — i.e.
      // defaultFilter intentionally wins over resume-at-first-unrated.
      setFilter(settings.defaultFilter);

      // Reset overlay state to the user's preferred defaults. T/I/H/P/O can
      // still toggle these mid-cull; the settings just set the starting point.
      setThumbsVisible(settings.defaultThumbsVisible);
      setExifVisible(settings.defaultExifVisible);
      setClippingVisible(settings.defaultClippingVisible);
      setPeakingVisible(settings.defaultPeakingVisible);
      setCompositionVisible(settings.defaultCompositionVisible);
      // Enter the cull view immediately — no big concurrent warm-up. The bounded
      // read pool loads the current frame (priority 0) and its prefetch window as
      // soon as the view mounts, so there's no entry-time read stampede.
    } catch (e) {
      // Don't drop the user into an unsorted, ratings-not-restored cull: surface
      // the error and return to the staged screen so they can retry.
      ok = false;
      console.error("analyze_folder failed", e);
      setAnalyzeError(String(e));
    } finally {
      unlisten();
      analyzingRef.current = false;
      setPhase(ok ? "culling" : "staged");
    }
  }, [
    images,
    profile.concurrentRestore,
    settings,
    writeSessionRecent,
    setImages,
    setRatings,
    setMetadata,
    setCurrentIndex,
    setFilter,
    setPhase,
    setAnalyzeError,
    setProgress,
    setThumbsVisible,
    setExifVisible,
    setClippingVisible,
    setPeakingVisible,
    setCompositionVisible,
  ]);

  // Esc out of review → discard the in-memory session and return Home.
  // Successfully-saved ratings live on in the .xmp sidecars, so reopening the
  // folder restores them (a write that's still failing stays flagged for manual
  // retry on the home screen — it's not in the sidecar yet).
  const resetSession = useCallback(() => {
    // Session end: revoke ALL blob URLs (thumbs + full-res) and clear the store.
    imageStore.hardReset();
    setImages([]);
    setMetadata({});
    setRatings({});
    // Drop the undo/redo history with the session it belonged to. The stacks hold
    // imgIds + paths from THIS in-memory cull; the next-opened folder restarts
    // imgIds at 0, so a stray Ctrl+Z would otherwise replay a stale action against
    // a re-used imgId and durably write the WRONG folder's sidecar.
    undoStack.current = [];
    redoStack.current = [];
    setCompareMode(false);
    setGridVisible(false);
    setNavStack([]);
    setCurrentIndex(0);
    setFilter("all");
    setSelectedIndices(new Set());
    setSelectionAnchor(null);
    setFolder(null);
    setPendingFolder(null);
    setScanFailures(null);
    setAnalyzeError(null);
    setLastAdded(0);
    setLastIgnored(0);
    setLastBatchFolders([]);
    // The next session is a fresh folder set — it must write a NEW recents
    // entry, not replace this one's.
    sessionRecentsKeyRef.current = null;
    setClippingVisible(false);
    setPeakingVisible(false);
    setCompositionVisible(false);
    setExifVisible(false);
    // One call drops every overlay cache + request-set (the per-family clears
    // that used to live here); in-flight probes die on the generation bump
    // from hardReset() above.
    overlayService.reset();
    resetZoom();
    setFeedback(null);
    setPhase("start");
  }, [
    resetZoom,
    undoStack,
    redoStack,
    setFeedback,
    setImages,
    setMetadata,
    setRatings,
    setCompareMode,
    setGridVisible,
    setNavStack,
    setCurrentIndex,
    setFilter,
    setSelectedIndices,
    setSelectionAnchor,
    setFolder,
    setPendingFolder,
    setScanFailures,
    setAnalyzeError,
    setLastAdded,
    setLastIgnored,
    setLastBatchFolders,
    setClippingVisible,
    setPeakingVisible,
    setCompositionVisible,
    setExifVisible,
    setPhase,
  ]);

  // Leaving to home: refresh the session's recents entry with its final
  // counts, then discard the in-memory session and return to the start screen.
  const leaveToHome = useCallback(() => {
    writeSessionRecent(images, ratings);
    setConfirmHome(false);
    resetSession();
  }, [images, ratings, resetSession, writeSessionRecent, setConfirmHome]);

  return { openFoldersByPaths, pickFolder, beginCulling, resetSession, leaveToHome };
}
