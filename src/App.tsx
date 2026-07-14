import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Check, Star, X as XIcon } from "lucide-react";
import type {
  AnalyzeProgress,
  FileOpResult,
  Filter,
  Img,
  ImageMetadata,
  NavEntry,
  Phase,
  Rating,
} from "./types";
import "./App.css";

import { CompareStrip } from "./components/CompareStrip";
import { CompareView } from "./components/CompareView";
import { ExifRail } from "./components/ExifRail";
import { FinishDialog } from "./components/FinishDialog";
import { GridView, GRID_CELL_TARGET } from "./components/GridView";
import { HelpOverlay } from "./components/HelpOverlay";
import { verdictGlyph } from "./components/verdictGlyph";
import { ScanFailureCard, type ScanFailure } from "./components/ScanFailureCard";
import { SettingsDialog } from "./components/SettingsDialog";
import { ThumbStrip } from "./components/ThumbStrip";
import { useChipsTooltipVisibility } from "./hooks/useChipsTooltipVisibility";
import { WindowControls } from "./components/WindowControls";
import { DevHud } from "./components/DevHud";
import { PhotoPane } from "./components/pane/PhotoPane";
import { zoomTransition } from "./components/pane/zoomTransition";

import { recentKey, useRecents, type RecentEntry } from "./hooks/useRecents";
import { useSettings } from "./hooks/useSettings";

import { useCullKeymap } from "./app/useCullKeymap";
import { useDecideCallbacks } from "./app/useDecideCallbacks";
import { useDragAndDrop } from "./app/useDragAndDrop";
import { useFolderTrouble } from "./app/useFolderTrouble";
import { useImageStoreWiring } from "./app/useImageStoreWiring";
import { usePaneZoom } from "./app/usePaneZoom";
import { useQuitGuard } from "./app/useQuitGuard";
import { useRatingPersistence } from "./app/useRatingPersistence";
import { useSessionLifecycle } from "./app/useSessionLifecycle";
import { useSiteNavigation } from "./app/useSiteNavigation";
import { useSmartDerivations } from "./app/useSmartDerivations";
import { useUndoRedo } from "./app/useUndoRedo";

import { normalizeRejectedSubfolder } from "./types/settings";
import { imageStore } from "./image/imageStore";
import { overlayService } from "./overlays/overlayService";
import { useImage } from "./image/useImage";
import { passesFilter } from "./utils/filter";
import { cycleFilter, topOf } from "./utils/filterModes";
import { extendSelection } from "./utils/gridSelection";
import { paneZoomZ, type PaneRect } from "./components/pane/paneGeometry";
import type { PressureLevel } from "./image/pressureProfile";
import { formatFolderSet, formatRelativeTime } from "./utils/format";
import { basename } from "./utils/path";
import { modGlyph } from "./utils/platform";
import { pickSmartEmptyState } from "./utils/smartEmptyState";
import { afZoomOrigin } from "./utils/zoom";
import { RATING_COLOR } from "./utils/ratingColor";
import { scrubSpeedForHeldMs, type ScrubSpeed } from "./utils/scrubAccel";

// Read concurrency, previewKeep, and the store profile wiring live in
// app/useImageStoreWiring; the rating-write retry schedule and feedback-flash
// timing live in app/useRatingPersistence (grand cleanup Phase 6).
// Hold-to-navigate cadence. We ignore the OS key auto-repeat (long initial delay,
// uneven rate) and drive stepping ourselves from a rAF loop while the arrow is
// held — one step per this interval, frame-aligned so it never steps faster than
// the display paints (no stutter; self-throttles on a slow frame). ~33ms ≈ 30
// images/s, the fastest that still feels smooth.
const NAV_REPEAT_MS = 33;
// Staged scrub acceleration (1x → 3x @2s → 10x @5s) now lives in
// utils/scrubAccel.ts, shared by this loupe/compare horizontal hold AND the
// grid's vertical hold below — see scrubSpeedForHeldMs.

// After the immediate first step on hold-start, wait this long before the
// auto-repeat kicks in — so a quick tap moves exactly one image, while a
// sustained hold pauses briefly then ramps into the ~30/s repeat above.
const NAV_HOLD_DELAY_MS = 280;

// sizerSrc (the aspect-carrying transparent SVG) moved to utils/sizer.ts —
// rendered by PhotoPane (which also owns the unzoom re-measure discipline).

export default function App() {
  const [phase, setPhase] = useState<Phase>("start");
  const [folder, setFolder] = useState<string | null>(null);
  // The folder currently being scanned (set before the scan resolves) so the
  // loading screen labels the folder it's actually opening, not the previous one.
  const [pendingFolder, setPendingFolder] = useState<string | null>(null);
  const [images, setImages] = useState<Img[]>([]);
  // Live mirror of `images` so openFoldersByPaths can read the latest staged set
  // without depending on `images` (keeps its identity stable across staging).
  // Updated on commit here AND synchronously at the append site, so even a
  // same-tick second open computes a correct startId (no duplicate ids).
  const imagesRef = useRef(images);
  useEffect(() => {
    imagesRef.current = images;
  }, [images]);
  // Capture-time order from analyze_folder — preserved so sort modes can return.
  const [currentIndex, setCurrentIndex] = useState(0);
  const [ratings, setRatings] = useState<Record<number, Rating>>({});
  const [filter, setFilter] = useState<Filter>("all");
  // Floating tooltip above the active Keeps/Smart tab that hosts the
  // sub-mode chips (all/★, or all/✕/✓/★) — see useChipsTooltipVisibility for
  // the activity-fade rules. `pulse()` is called on every filter change;
  // `hoverProps` is spread onto the active tab button and the tooltip itself.
  const chipsTooltip = useChipsTooltipVisibility();
  /** Burst/Similar run boxes render in the grid only under filters that keep
   *  runs contiguous — see the GridView call site for why. Checked against
   *  the TOP-LEVEL tab (topOf) so Keeps·★ / Smart sub-modes gate the same
   *  as their base modes. */
  const showGridGroupBoxes = topOf(filter) === "all" || topOf(filter) === "unrated";
  // Grid multi-select. Indices are ABSOLUTE (into images), not filter-relative,
  // so a rating action operating on the set lands on the right photos even if
  // the filter changes mid-flow. `selectionAnchor` is the cell shift-range
  // extends from; null means "no anchor yet, set on the next click".
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(() => new Set());
  const [selectionAnchor, setSelectionAnchor] = useState<number | null>(null);
  const [exifVisible, setExifVisible] = useState(false);
  const [thumbsVisible, setThumbsVisible] = useState(true);
  const [gridVisible, setGridVisible] = useState(false); // G toggles the contact-sheet grid
  const [gridCols, setGridCols] = useState(6); // updated by ResizeObserver while grid is open
  // Grid content width (padding-subtracted) from the SAME ResizeObserver, passed
  // to GridView so its cellW derives from the same measurement as gridCols (no
  // second observer / second padding-math that could disagree for a frame).
  const [gridContentW, setGridContentW] = useState(0);
  const [helpVisible, setHelpVisible] = useState(false);
  // True only for the one-time auto-shown first-cull overlay (no Tab held):
  // it changes the overlay's title and arms any-key/click dismissal.
  const [helpIntro, setHelpIntro] = useState(false);

  // The very first cull ever shows the key overlay unprompted — the app is
  // keyboard-driven and nothing else on screen says how to rate. Once, ever:
  // the flag is written immediately so a re-entry never re-triggers it.
  useEffect(() => {
    if (phase !== "culling") return;
    try {
      if (localStorage.getItem("cull:helpSeen")) return;
      localStorage.setItem("cull:helpSeen", "1");
    } catch {
      return; // private mode: skip the intro rather than show it every time
    }
    setHelpVisible(true);
    setHelpIntro(true);
  }, [phase]);

  const [confirmHome, setConfirmHome] = useState(false); // Esc → confirm leaving to home
  // Held-arrow fast-scrub. While true we render the cheap thumbnail instead of the
  // full-res preview, so scrub speed isn't bottlenecked by decoding ~6 MP JPEGs
  // per step. Full-res returns the instant the key is released.
  const [scrubbing, setScrubbing] = useState(false);

  // User-tunable settings, persisted to localStorage. Opened with Ctrl+,.
  const [settings, setSettings] = useSettings();
  const [settingsOpen, setSettingsOpen] = useState(false);

  // EXIF metadata per path. Fed by the imageStore's metadata sink (full-res
  // bundle reads return camera/lens/AF/pixel-dims) and seeded with LrC stars
  // from the analyze pass. Pixel URLs + display dims now live in the store
  // (consumed via useImage); this map holds only the descriptive metadata.
  const [metadata, setMetadata] = useState<Record<string, ImageMetadata>>({});

  // ── Smart culling (advisory) ──────────────────────────────────────────────
  // The driver + the pure cross-frame derivation chain (bursts, similars,
  // verdicts, favorites cap) live in app/useSmartDerivations — advisory-only,
  // nothing in there writes anything, ever.
  const {
    suggestions,
    burstCtx,
    similarCtx,
    liveSuggestionCount,
    qualityScores,
    qualityAnalyzing,
    qualityProgress,
    startAnalysis,
  } = useSmartDerivations({ images, ratings, metadata, settings, phase });

  // Recent sessions list rendered on the home screen. One entry per folder
  // SET, written once a session ENTERS CULLING (staging alone leaves no trace,
  // so an Esc'd mis-pick never lands in the list) and refreshed with the
  // rated/done counts while culling and on the way back home — so the list
  // shows "327 / 372" mid-flow and "932 ✓" once everything's rated.
  const { recents: recentFolders, push: pushRecent, removeEntry } = useRecents();

  // Act on the cull (Ctrl+E) — a non-modal finish dialog with two file actions:
  // move rejects to a _rejected/ subfolder, and copy keeps+favorites to an export
  // folder. Non-destructive (skips when the destination already has that file).
  const [actionsOpen, setActionsOpen] = useState(false);
  const [moveResult, setMoveResult] = useState<FileOpResult | null>(null);
  const [copyResult, setCopyResult] = useState<FileOpResult | null>(null);
  const [actionBusy, setActionBusy] = useState<"move" | "copy" | null>(null);

  const [scanFailures, setScanFailures] = useState<readonly ScanFailure[] | null>(null);
  // Surfaced on the staged screen when analyze_folder fails, so a failed sort /
  // rating-restore returns the user to staged with a retry instead of silently
  // dropping them into an unsorted, ratings-not-restored cull.
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  // True from the moment pickFolder is invoked until the OS dialog resolves
  // (success OR cancel). Prevents a double-click — or a stuck dialog — from
  // queuing a second picker behind the first.
  const [pickerBusy, setPickerBusy] = useState(false);
  const [lastAdded, setLastAdded] = useState(0);
  // Non-CR3 files the most recent open batch saw and skipped. Shown on the
  // staged screen so a JPEG-heavy folder reads as by-design, not broken.
  const [lastIgnored, setLastIgnored] = useState(0);
  // Folders that scanned successfully in the most recent open batch — drives
  // the staged screen's "+N from a + b" summary line.
  const [lastBatchFolders, setLastBatchFolders] = useState<string[]>([]);
  const [progress, setProgress] = useState<AnalyzeProgress>({ done: 0, total: 0, phase: "" });

  // Compare mode: Champion vs Challenger. championIndex/challengerIndex are
  // indices into the (chronologically sorted) images array. The champion (left)
  // is the pinned running frame — whatever the user is comparing against; its
  // rating is whatever it currently is (only persisted as Keep once it actually
  // wins a comparison, so on entry it may still be unrated). The challenger
  // (right) is an unrated frame the user accepts (Enter → it becomes champion) or
  // rejects (Backspace). Available on any image — no burst grouping.
  const [compareMode, setCompareMode] = useState(false);
  const [championIndex, setChampionIndex] = useState(0);
  const [challengerIndex, setChallengerIndex] = useState(0);

  // Site navigation history. Each entry records where the user came FROM. ESC
  // pops one entry and navigates back to it. Pressing a site key (L/C/G) for
  // the current site is a no-op; pressing one for a different site pushes the
  // current site and switches. Compare entries snapshot champion + challenger
  // so ESC into compare resumes the same pair (validated for the saved
  // challenger still being unrated — otherwise advance to the next).
  const [navStack, setNavStack] = useState<NavEntry[]>([]);
  // Live mirror of the nav stack so compare handlers can snapshot it into undo
  // actions without taking navStack as a dependency (which would re-create those
  // callbacks on every navigation).
  const navStackRef = useRef(navStack);
  useEffect(() => {
    navStackRef.current = navStack;
  }, [navStack]);

  // Grid container — shared between GridView (for layout/scroll) and the cols-
  // computing ResizeObserver (defined after visibleIndices, below, so it can
  // also re-run when the grid gains cells — see there).
  const gridContainerRef = useRef<HTMLDivElement>(null);

  // Rating-write durability (savingCount / failed-write tracking / the serial
  // per-path write queue) lives in app/useRatingPersistence; the quit guard
  // that refuses to lose those writes lives in app/useQuitGuard.
  const {
    feedback,
    setFeedback,
    flashFeedback,
    persistRating,
    retryFailed,
    savingCount,
    failedCount,
    savingRef,
    failedCountRef,
  } = useRatingPersistence();
  const { quitGuard, setQuitGuard, destroyedRef } = useQuitGuard({
    savingCount,
    failedCount,
    savingRef,
    failedCountRef,
  });

  // ── Undo / redo of rating actions ────────────────────────────────────────
  // Stacks + recordAction/undo/redo live in app/useUndoRedo (no effects, so
  // its position here carries no ordering weight). Refs because the stacks
  // themselves don't drive any render — only the rating writes they replay do.
  const { undoStack, redoStack, recordAction, undo, redo } = useUndoRedo({
    images,
    compareMode,
    persistRating,
    setRatings,
    setCompareMode,
    setGridVisible,
    setChampionIndex,
    setChallengerIndex,
    setCurrentIndex,
    setNavStack,
  });

  // Measured rect of the displayed image (relative to the stage), reported up
  // by the loupe's PhotoPane (which owns the measure discipline). Consumed by
  // the cursor-anchored mouse zoom + the drag-factor mirror (usePaneZoom) —
  // the analysis overlays align via CSS, not this rect.
  const stageRef = useRef<HTMLDivElement>(null);
  const [imgRect, setImgRect] = useState<PaneRect | null>(null);

  const [clippingVisible, setClippingVisible] = useState(false);

  // Focus peaking (P) — high-contrast edge overlay highlighting in-focus regions.
  const [peakingVisible, setPeakingVisible] = useState(false);

  // The overlay pixels themselves (clip/peak masks + the EXIF histogram) live
  // in overlayService (Phase 6) — per-kind bounded LRUs of data URLs computed
  // off-thread from the nav-tier preview. This one version subscription
  // re-renders every consumer (loupe overlays, compare panes, EXIF rail) when
  // a result lands or a kind is cleared. The version is ALSO a dep of the
  // ensure effects below: LRU recency is refreshed by ensure(), but commits
  // land async — without re-ensuring per landing, a compare challenger tap-
  // burst (≥16 same-kind landings after the champion's last touch) could
  // evict the on-screen champion's mask out from under its pane.
  const overlayVersion = useSyncExternalStore(overlayService.subscribe, overlayService.getVersion);

  // Composition overlay for the loupe — thirds grid (O). Hidden when zoomed
  // (it's for evaluating the whole-frame look). Aspect-crop overlay was removed:
  // static rectangles didn't add anything thirds + the image itself can't.
  const [compositionVisible, setCompositionVisible] = useState(false);

  // OS memory pressure, forwarded by the Rust side. warn = caches shrunk;
  // critical = zoom rasters dropped + zoom released. The response exists so
  // the WebContent process sheds BEFORE jetsam kills it (the proven gray-
  // window crash: 2.25 GB lifetimeMax at the 2026-07-06 jetsam event).
  const [memPressure, setMemPressure] = useState<PressureLevel>("normal");
  // Dev HUD flag, read once at mount: localStorage["cull:devhud"]="1" + reload.
  const [devHudOn] = useState(() => {
    try {
      return localStorage.getItem("cull:devhud") === "1";
    } catch {
      return false;
    }
  });
  const visibleIndices = useMemo(() => {
    // The whole "suggested" family resolves against the live suggestions
    // map: frames with a suggestion that are STILL unrated (rating a frame
    // removes it live). Sub-modes narrow further by the suggestion's verdict.
    if (topOf(filter) === "suggested") {
      return images
        .map((_, i) => i)
        .filter((i) => {
          if (ratings[images[i].id]) return false;
          const sug = suggestions[images[i].id];
          if (!sug) return false;
          switch (filter) {
            case "suggestedRejects":
              return sug.verdict === "reject";
            case "suggestedKeeps":
              return sug.verdict === "keep";
            case "suggestedFavs":
              return sug.verdict === "favorite";
            default:
              return true; // "suggested" — any live suggestion.
          }
        });
    }
    return images.map((_, i) => i).filter((i) => passesFilter(ratings[images[i].id], filter));
  }, [images, ratings, filter, suggestions]);

  // Memoized: this O(n) indexOf used to run on EVERY render (incl. every
  // ~30 Hz scrub frame); now only when the filter list or cursor actually moves.
  const positionInFilter = useMemo(
    () => visibleIndices.indexOf(currentIndex),
    [visibleIndices, currentIndex],
  );

  // ── Zoom choreography ─────────────────────────────────────────────────────
  // Space/mouse zoom state, keyboard pan, the carried-advance flag, the
  // two-rAF zoomSwapInstant reset, the index-change reset/carry, and the
  // cursor-anchored mouse zoom live in app/usePaneZoom. The render-derived
  // zoomZ/zoomGlide stay in the culling render below (they read the loupe's
  // useImage result), assigning zoomZRef each render.
  const {
    isZooming,
    setIsZooming,
    zoomLevel,
    setZoomLevel,
    panOffset,
    setPanOffset,
    zoomSwapInstant,
    setZoomSwapInstant,
    isZoomingRef,
    keepZoomOnAdvanceRef,
    mouseZooming,
    zoomZRef,
    pan,
    resetZoom,
    handleStageMouseDown,
  } = usePaneZoom({ images, currentIndex, metadata, imgRect, stageRef, positionInFilter });

  // Subscribe to the Rust-side pressure events (see the memPressure state
  // above for why). Registered once; resetZoom is identity-stable.
  useEffect(() => {
    const un = listen<PressureLevel>("memory-pressure", (e) => {
      const level = e.payload;
      setMemPressure(level);
      imageStore.setMemoryPressure(level);
      if (level === "critical") {
        // The scaled zoom rasters are the largest live allocations — release
        // zoom entirely; the chip explains why the view just un-zoomed.
        resetZoom();
      }
    });
    return () => {
      void un.then((f) => f());
    };
  }, [resetZoom]);

  // Grid column count from the container width — the keydown handler steps by
  // row using it. Depends on `gridVisible && !compareMode` (entering compare
  // unmounts GridView, detaching the observed node; exit re-mounts a NEW node)
  // AND on gridHasCells: when the grid is entered under a no-match filter, the
  // EmptyFilter placeholder renders instead of GridView, so gridContainerRef is
  // null and the first run bails — re-run once cells appear so we attach then.
  const gridHasCells = gridVisible && !compareMode && visibleIndices.length > 0;
  useLayoutEffect(() => {
    if (!gridVisible || compareMode) return;
    const el = gridContainerRef.current;
    if (!el) return;
    const update = () => {
      // Subtract horizontal padding so the col count matches the actual
      // content area (otherwise cells overflow → horizontal scrollbar).
      const cs = window.getComputedStyle(el);
      const padL = parseFloat(cs.paddingLeft) || 0;
      const padR = parseFloat(cs.paddingRight) || 0;
      const w = Math.max(0, el.clientWidth - padL - padR);
      setGridContentW(w);
      setGridCols(Math.max(2, Math.floor(w / GRID_CELL_TARGET)));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [gridVisible, compareMode, gridHasCells]);

  // Compare-mode candidates: every UNRATED frame except the champion (which the
  // strip shows separately as its grayed in-track ghost). The challenger is
  // always one of these. Drives the strip's pickable set and its thumbnail
  // eviction window — independent of the active `filter`, which is left
  // untouched and restored on exit.
  const compareCandidates = useMemo(() => {
    if (!compareMode) return [];
    // One pass (no throwaway index array): every unrated frame except the champion.
    const out: number[] = [];
    for (let i = 0; i < images.length; i++) {
      if (i !== championIndex && !ratings[images[i].id]) out.push(i);
    }
    return out;
  }, [compareMode, images, ratings, championIndex]);

  // What the compare strip DISPLAYS: the candidates plus the champion in its
  // capture-order slot, rendered as a grayed, unselectable ghost — you can see
  // where the current reference sits in the timeline without being able to
  // pick it against itself. Navigation stays on compareCandidates.
  const compareStripIndices = useMemo(() => {
    if (!compareMode) return [];
    const out: number[] = [];
    for (let i = 0; i < images.length; i++) {
      if (i === championIndex || !ratings[images[i].id]) out.push(i);
    }
    return out;
  }, [compareMode, images, ratings, championIndex]);

  // Challenger's position within the candidate list, memoized like positionInFilter
  // so the status bar's "N / M" doesn't run an O(n) indexOf on every App render
  // (incl. every ~30 Hz compare scrub frame).
  const challengerPos = useMemo(
    () => compareCandidates.indexOf(challengerIndex),
    [compareCandidates, challengerIndex],
  );

  const stats = useMemo(() => {
    const vals = Object.values(ratings);
    const favorites = vals.filter((r) => r === "favorite").length;
    const keeps = vals.filter((r) => r === "keep").length + favorites;
    return { total: images.length, unrated: images.length - vals.length, keeps, favorites };
  }, [ratings, images.length]);

  // Paths the act-on-cull actions operate on.
  const rejectedPaths = useMemo(
    () => images.filter((im) => ratings[im.id] === "reject").map((im) => im.path),
    [images, ratings],
  );
  const keptPaths = useMemo(
    () =>
      images
        .filter((im) => ratings[im.id] === "keep" || ratings[im.id] === "favorite")
        .map((im) => im.path),
    [images, ratings],
  );

  // Find the next/previous UNRATED image (in capture order) from `from`, skipping
  // `skip` (the champion). Returns -1 if none in that direction. The champion is
  // already rated Keep, so it's naturally excluded too — `skip` guards the entry
  // moment before its rating lands in state.
  const findUnrated = useCallback(
    (from: number, dir: 1 | -1, ratingsMap: Record<number, Rating>, skip: number) => {
      for (let i = from + dir; i >= 0 && i < images.length; i += dir) {
        if (i !== skip && !ratingsMap[images[i].id]) return i;
      }
      return -1;
    },
    [images],
  );
  // Nearest unrated to `from`: forward first, then backward.
  const nearestUnrated = useCallback(
    (from: number, ratingsMap: Record<number, Rating>, skip: number) => {
      const fwd = findUnrated(from, 1, ratingsMap, skip);
      return fwd !== -1 ? fwd : findUnrated(from, -1, ratingsMap, skip);
    },
    [findUnrated],
  );

  // ── Image loading via imageStore ──────────────────────────────────────────
  // All pixel loading (thumbs + full-res previews), the bounded-concurrency NAS
  // read pool, the windowed full-res cache, and blob-URL lifecycle live in
  // `imageStore` (driven by app/useImageStoreWiring + consumed by `useImage` in
  // each view). App only feeds it the storage profile, the cursor, the grid
  // viewport, and a metadata sink — and tells it when the folder / session
  // changes.
  const { profile, handleGridViewport } = useImageStoreWiring({
    storageMode: settings.storageMode,
    phase,
    compareMode,
    gridVisible,
    currentIndex,
    challengerIndex,
    scrubbing,
    stageRef,
    setMetadata,
  });

  // Folder-trouble chip + retry flow (NAS unmounted / sleep-wake) live in
  // app/useFolderTrouble.
  const { folderTrouble, retryUnreachableFolders } = useFolderTrouble({
    images,
    imagesRef,
    rejectedSubfolder: settings.rejectedSubfolder,
  });

  // Pin the compare pair's fulls for the whole compare session. The cursor
  // follows the CHALLENGER, so without the pin the champion — far from the
  // cursor — would be evicted and re-fetched on every challenger step,
  // thrashing back to a blurred load (P5).
  useEffect(() => {
    if (!compareMode) return undefined;
    const champ = images[championIndex]?.path;
    const chal = images[challengerIndex]?.path;
    if (champ) imageStore.pinFull(champ);
    if (chal && chal !== champ) imageStore.pinFull(chal);
    return () => {
      if (champ) imageStore.unpinFull(champ);
      if (chal && chal !== champ) imageStore.unpinFull(chal);
    };
  }, [compareMode, championIndex, challengerIndex, images]);

  // Pin the zoomed frame: a keep-window eviction mid-zoom would blur the
  // very pixels the user is inspecting (P5). Engaging zoom also fetches the
  // zoom-tier full immediately (Phase 3) — if the settle already warmed it
  // this is a no-op; if not, the preview upscales until the full lands.
  // LOUPE ONLY: compare pins + fetches its own pair (the session-pin effect
  // above and ComparePanel's zoom fetch). currentIndex is FROZEN while
  // compare is open, so running this there pinned and fetched a stale frame
  // nobody displays — a phantom ~130 MB raster during the exact operation
  // the memory budget protects (review catch on the jetsam work).
  useEffect(() => {
    if (!isZooming || compareMode) return undefined;
    const p = images[currentIndex]?.path;
    if (!p) return undefined;
    imageStore.pinFull(p);
    imageStore.requestZoomFull(p);
    return () => imageStore.unpinFull(p);
  }, [isZooming, compareMode, currentIndex, images]);

  // ── Session lifecycle ─────────────────────────────────────────────────────
  // Staging (picker / drag-drop / recents / launch auto-open), begin-culling
  // (analyze + sort + rating restore), the session's recents write-back, and
  // session teardown (reset / leave-to-home) live in app/useSessionLifecycle.
  const { openFoldersByPaths, pickFolder, beginCulling, resetSession, leaveToHome } =
    useSessionLifecycle({
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
    });

  // Wipe the multi-selection state — called whenever the user leaves the grid
  // context (site switch, ESC, opening another folder). Cleanly decoupled from
  // resetSession so site-switch handlers don't have to drop the whole cull.
  const clearMultiSelection = useCallback(() => {
    setSelectedIndices((s) => (s.size > 0 ? new Set() : s));
    setSelectionAnchor(null);
  }, []);

  // Click-away deselect (Finder-style): with a grid selection active, any
  // click that ISN'T on a grid cell — empty grid space, the header, the
  // footer — drops the selection. Cell clicks manage selection themselves
  // (plain/shift/ctrl in handleGridPick), so they're exempt. Listener only
  // exists while a selection is up: zero cost the rest of the time.
  const hasGridSelection = gridVisible && selectedIndices.size > 0;
  useEffect(() => {
    if (!hasGridSelection) return;
    const onClickAway = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (t?.closest(".cull-grid__cell")) return;
      clearMultiSelection();
    };
    window.addEventListener("click", onClickAway);
    return () => window.removeEventListener("click", onClickAway);
  }, [hasGridSelection, clearMultiSelection]);

  // Multi-selection is only meaningful while the grid is open. The moment the
  // user leaves the grid (G → L / C, ESC pops out, any path that mounts the
  // loupe or compare), drop the selection — bringing it back into a different
  // site would be confusing, and the visual tint isn't rendered there anyway.
  useEffect(() => {
    if (!gridVisible) clearMultiSelection();
  }, [gridVisible, clearMultiSelection]);

  // When leaving the grid, clear the stored grid viewport so background-fill
  // prioritises purely by cursor distance rather than the stale grid window.
  useEffect(() => {
    if (!gridVisible) imageStore.clearGridRange();
  }, [gridVisible]);

  // Open the act-on-cull dialog with fresh results.
  const openActions = useCallback(() => {
    setMoveResult(null);
    setCopyResult(null);
    setActionsOpen(true);
  }, []);

  // Move rejected CR3s (+sidecars) into a subfolder of the folder each photo
  // came FROM — a multi-folder session must not sweep folder A's rejects into
  // folder B's `_rejected`. One backend call per source folder, results merged
  // into a single FileOpResult for the dialog. The subfolder name comes from
  // settings (default `_rejected`).
  const doMoveRejects = useCallback(
    async (dest: "subfolder" | "trash" = "subfolder") => {
      if (rejectedPaths.length === 0 || actionBusy !== null) return;
      setActionBusy("move");
      setMoveResult(null);
      try {
        if (dest === "trash") {
          // OS Trash: no destination folder, so no per-source-folder split — one
          // call for the whole set. Recoverable by design (never a hard delete).
          try {
            setMoveResult(
              await invoke<FileOpResult>("move_rejects_to_trash", { paths: rejectedPaths }),
            );
          } catch (e) {
            setMoveResult({ completed: 0, skipped: 0, errors: [String(e)], errorCount: 1 });
          }
          return;
        }
        const subfolder = normalizeRejectedSubfolder(settings.rejectedSubfolder);
        const byFolder = new Map<string, string[]>();
        for (const im of images) {
          if (ratings[im.id] !== "reject") continue;
          const list = byFolder.get(im.srcFolder);
          if (list) list.push(im.path);
          else byFolder.set(im.srcFolder, [im.path]);
        }
        const merged: FileOpResult = { completed: 0, skipped: 0, errors: [], errorCount: 0 };
        for (const [srcFolder, paths] of byFolder) {
          try {
            const res = await invoke<FileOpResult>("move_rejects_to_subfolder", {
              folder: srcFolder,
              paths,
              subfolder,
            });
            merged.completed += res.completed;
            merged.skipped += res.skipped;
            merged.errors.push(...res.errors);
            merged.errorCount = (merged.errorCount ?? 0) + (res.errorCount ?? res.errors.length);
          } catch (e) {
            // One folder failing (offline NAS, permissions) must not abort the
            // moves for the folders that ARE reachable.
            merged.errors.push(`${srcFolder}: ${String(e)}`);
            merged.errorCount = (merged.errorCount ?? 0) + 1;
          }
        }
        // Mirror the backend's error-list cap so a huge failure can't bloat the UI;
        // errorCount still carries the true total.
        merged.errors = merged.errors.slice(0, 20);
        setMoveResult(merged);
      } finally {
        setActionBusy(null);
      }
    },
    [images, ratings, rejectedPaths, actionBusy, settings.rejectedSubfolder],
  );

  // Copy keeps + favorites (+sidecars) to `dest`. The finish dialog decides
  // where dest comes from — for pinned mode it joins the pinned root with the
  // editable subfolder; for ask-each-time mode it surfaces the picker first
  // and re-uses the picked path here. This stays a thin Tauri wrapper so the
  // dialog can drive a two-stage flow (pick → confirm) without forking the
  // copy command.
  const doCopyKeeps = useCallback(
    async (dest: string) => {
      if (keptPaths.length === 0 || actionBusy !== null) return;
      if (!dest) {
        setCopyResult({
          completed: 0,
          skipped: 0,
          errors: ["destination not set"],
          errorCount: 1,
        });
        return;
      }
      // Remember the last *root* the user copied into when in ask-each-time mode,
      // so the next session's picker opens there. Pinned mode is its own root,
      // so it doesn't need this hint.
      if (settings.exportFolder.mode === "remember") {
        localStorage.setItem("cull:lastExportDest", dest);
      }
      setActionBusy("copy");
      setCopyResult(null);
      try {
        const res = await invoke<FileOpResult>("copy_keeps_to_export", {
          paths: keptPaths,
          dest,
        });
        setCopyResult(res);
      } catch (e) {
        setCopyResult({ completed: 0, skipped: 0, errors: [String(e)], errorCount: 1 });
      } finally {
        setActionBusy(null);
      }
    },
    [keptPaths, actionBusy, settings.exportFolder.mode],
  );

  // Loupe main-image subscription. Lives at App scope (unconditional — rules of
  // hooks) because the hi-res warm effect + the overlay-retrigger effects below
  // need its stage, and the loupe render block consumes its url/dims/error.
  // `wantFull` only while NOT scrubbing: a scrub flies past frames it never
  // decodes, so we want just the (blurred) thumb mid-scrub; full loads on
  // release (scrubbing flips false → wantFull true → store fetches the full).
  const cur = useImage(!gridVisible && !compareMode ? (images[currentIndex]?.path ?? "") : "", {
    // Only want the full-res ONCE CULLING HAS STARTED. Before that (staged
    // screen) this hook still runs at App scope, and without the phase gate it
    // requested the full at the pre-reset generation; beginCulling's reset() then
    // discarded that load, and since path/wantFull didn't change across the reset
    // the effect never re-fired — so the first frame stayed blurred until you
    // navigated. Gating on phase makes wantFull flip false→true AFTER the reset,
    // re-firing the effect so the first frame loads at the live generation.
    wantFull:
      phase === "culling" && !gridVisible && !compareMode && !!images[currentIndex] && !scrubbing,
  });
  // NOTE: the hi-res zoom warm-up (settle timer + zoom-full fetch) and the
  // displayed-image measure discipline both live in PhotoPane now — the loupe
  // passes profile.fullSettleMs and a settleResetKey for the stage-resizing
  // chrome toggles (thumb strip / info rail), and receives the measured rect
  // back via onRectChange for the mouse-zoom math below.

  // NOTE: preview/thumbnail eviction, the unmount blob-cleanup, and compare's
  // full-res scheduling are all owned by `imageStore` now — its windowed
  // full-res cache + LRU thumb cache + cursor/grid-driven background fill cover
  // every case the old App-side effects handled, with one revoke per blob.

  // Compare champion/challenger subscriptions. These exist at App scope so App
  // re-renders (and the overlay-retrigger effects below re-run) when their
  // thumb/full pixels land. `wantFull:false` — ComparePanel itself owns the
  // wantFull refcount for the actual full-res; these only observe.
  const champShot = useImage(
    compareMode && images[championIndex] ? images[championIndex].path : "",
    { wantFull: false },
  );
  const chalShot = useImage(
    compareMode && images[challengerIndex] ? images[challengerIndex].path : "",
    { wantFull: false },
  );

  // Auto-jump: if current falls out of the active filter, hop to the nearest
  // match (before paint, so no flash of an out-of-filter state). Suspended during
  // compare, which drives its own champion/challenger indices.
  useLayoutEffect(() => {
    if (compareMode || images.length === 0 || visibleIndices.length === 0) return;
    if (positionInFilter !== -1) return; // reuse the memo, not a fresh O(n) scan
    const forward = visibleIndices.find((i) => i >= currentIndex);
    setCurrentIndex(forward ?? visibleIndices[visibleIndices.length - 1]);
  }, [visibleIndices, currentIndex, positionInFilter, images.length, compareMode]);

  // While zoomed with the current frame's full landed, warm the NEXT frame's
  // zoom full so a carried rating advance lands sharp (or nearly) instead of
  // sitting on the upscaled preview for a full fetch+decode. Ordered AFTER the
  // active frame on purpose (cur.stage gate): it can never compete with the
  // zoom fetch the user is actually looking at. requestZoomFull is idempotent
  // (ready/loading/queued/cooldown guards), so re-fires are free.
  useEffect(() => {
    if (phase !== "culling" || compareMode || !isZooming) return;
    if (cur.stage !== "full") return;
    const nextIdx = positionInFilter >= 0 ? visibleIndices[positionInFilter + 1] : undefined;
    const nextPath = nextIdx !== undefined ? images[nextIdx]?.path : undefined;
    if (nextPath) imageStore.requestZoomFull(nextPath);
  }, [phase, compareMode, isZooming, cur.stage, positionInFilter, visibleIndices, images]);

  // Ensure clip masks exist for the on-screen image(s) while clipping is on;
  // toggling off drops the kind's cache + request-set in the service (clipping
  // does not persist). Skipped mid-scrub: the overlays are hidden then, and
  // computing a mask per flown-past warm frame would churn the LRU + worker
  // for nothing — the release re-fires this via the scrubbing dep. The service
  // bails per path until its PREVIEW lands; the .stage deps re-fire it then.
  // (Mask/histogram pixel work itself lives in overlayService/overlayCompute —
  // worker-first with an inline fallback, generation-guarded. Phase 6.)
  useEffect(() => {
    if (!clippingVisible) {
      overlayService.clearKind("clip");
      return;
    }
    if (scrubbing) return;
    if (compareMode) {
      if (images[championIndex]) overlayService.ensure("clip", images[championIndex].path);
      if (images[challengerIndex]) overlayService.ensure("clip", images[challengerIndex].path);
    } else if (images[currentIndex]) {
      overlayService.ensure("clip", images[currentIndex].path);
    }
  }, [
    clippingVisible,
    scrubbing,
    compareMode,
    championIndex,
    challengerIndex,
    currentIndex,
    images,
    // .stage drives the compute-once-the-preview-lands retry; cur.* is the
    // LOUPE subscription, champShot/chalShot the COMPARE pair; the off-mode
    // subscription is pinned to "" (stable), so its dep is inert.
    cur.stage,
    champShot.stage,
    chalShot.stage,
    // every async commit re-runs this so ensure() re-touches the on-screen
    // paths' LRU recency — see the subscription comment above.
    overlayVersion,
  ]);

  // Mirror of the clipping effect: ensure peaking masks exist while P is on.
  useEffect(() => {
    if (!peakingVisible) {
      overlayService.clearKind("peak");
      return;
    }
    if (scrubbing) return;
    if (compareMode) {
      if (images[championIndex]) overlayService.ensure("peak", images[championIndex].path);
      if (images[challengerIndex]) overlayService.ensure("peak", images[challengerIndex].path);
    } else if (images[currentIndex]) {
      overlayService.ensure("peak", images[currentIndex].path);
    }
  }, [
    peakingVisible,
    scrubbing,
    compareMode,
    championIndex,
    challengerIndex,
    currentIndex,
    images,
    cur.stage,
    champShot.stage,
    chalShot.stage,
    overlayVersion, // re-touch on-screen LRU recency per landing (see above)
  ]);

  // RGB histogram for the on-screen image while the EXIF overlay is open; the
  // kind drops when it closes. Single view ONLY — the compare rail renders no
  // histogram, so computing one per champion/challenger would be dead work;
  // scrub skipped like the masks (the settle re-fires via the scrubbing dep).
  useEffect(() => {
    if (!exifVisible) {
      overlayService.clearKind("histogram");
      return;
    }
    if (scrubbing || compareMode) return;
    if (images[currentIndex]) overlayService.ensure("histogram", images[currentIndex].path);
    // overlayVersion: re-touch on-screen LRU recency per landing (see above).
  }, [exifVisible, scrubbing, compareMode, currentIndex, images, cur.stage, overlayVersion]);

  const advance = useCallback(
    (dir: 1 | -1, step = 1): boolean => {
      if (visibleIndices.length === 0) return false;
      const pos = positionInFilter; // reuse the memo, not a fresh O(n) indexOf
      if (pos === -1) {
        setCurrentIndex(visibleIndices[0]);
        return true;
      }
      // Clamp to the edges — so e.g. Down on a partial last row of the grid still
      // jumps to the very last image. Returns false only if we were already there.
      const target = pos + dir * step;
      const clamped = Math.max(0, Math.min(visibleIndices.length - 1, target));
      if (clamped === pos) return false;
      setCurrentIndex(visibleIndices[clamped]);
      return true;
    },
    [visibleIndices, positionInFilter],
  );

  // ── Drag-and-drop: drop folders anywhere to open them ────────────────────
  // The overlay flag + once-registered drop listener live in app/useDragAndDrop.
  const { isDragOver } = useDragAndDrop({ phase, openFoldersByPaths });

  // ── Site navigation: loupe / compare / grid ───────────────────────────────
  // Sites are mutually exclusive — only one renders at a time. The back-stack,
  // L/C/G switching, ESC pops, compare-pair snapshots, and challenger cycling
  // live in app/useSiteNavigation.
  const { goToSite, goBack, cycleChallenger } = useSiteNavigation({
    images,
    ratings,
    visibleIndices,
    navStack,
    setNavStack,
    compareMode,
    setCompareMode,
    gridVisible,
    setGridVisible,
    currentIndex,
    setCurrentIndex,
    championIndex,
    setChampionIndex,
    challengerIndex,
    setChallengerIndex,
    selectedIndices,
    clearMultiSelection,
    findUnrated,
    nearestUnrated,
    resetZoom,
    setConfirmHome,
  });

  // The rating decides — single-frame / grid-selection rating and the three
  // compare decides, with their load-bearing setState-then-dropZoomFullsExcept
  // sequencing — live in app/useDecideCallbacks.
  const { applyRating, unrateCurrent, challengerLoses, challengerKeptBoth, challengerWins } =
    useDecideCallbacks({
      images,
      ratings,
      setRatings,
      currentIndex,
      setCurrentIndex,
      championIndex,
      setChampionIndex,
      challengerIndex,
      setChallengerIndex,
      visibleIndices,
      gridVisible,
      selectedIndices,
      navStackRef,
      isZoomingRef,
      keepZoomOnAdvanceRef,
      setZoomSwapInstant,
      setPanOffset,
      flashFeedback,
      persistRating,
      recordAction,
      nearestUnrated,
      goBack,
    });

  // Held-arrow navigation. The OS key-repeat is uneven and starts with a ~0.4s
  // delay, which made the first second of a hold feel jumpy. Instead we step once
  // on the initial press and then drive a steady rAF loop while the key is held.
  // navStep dispatches to the right action for the current mode; navStepRef keeps
  // the loop calling the LATEST closure (fresh currentIndex / challenger) each tick.
  const navStep = useCallback(
    (dir: 1 | -1, step = 1): boolean =>
      compareMode ? cycleChallenger(dir, step) : advance(dir, step),
    [compareMode, advance, cycleChallenger],
  );
  const navStepRef = useRef(navStep);
  useEffect(() => {
    navStepRef.current = navStep;
  }, [navStep]);

  const heldDirRef = useRef<0 | 1 | -1>(0);
  const navRafRef = useRef<number | null>(null);
  const lastStepTsRef = useRef(0);
  const holdStartTsRef = useRef(0);
  const scrubbingRef = useRef(false);
  // Staged acceleration (1× → 3× → 10× by hold time) — state only for the
  // indicators (scrub bar + footer chip); the loop reads the ref.
  const [scrubSpeed, setScrubSpeed] = useState<ScrubSpeed>(1);
  const scrubSpeedRef = useRef<ScrubSpeed>(1);

  const stopHold = useCallback(() => {
    heldDirRef.current = 0;
    if (navRafRef.current != null) {
      cancelAnimationFrame(navRafRef.current);
      navRafRef.current = null;
    }
    if (scrubbingRef.current) {
      scrubbingRef.current = false;
      setScrubbing(false); // settle → full-res snaps back for the landed frame
    }
    if (scrubSpeedRef.current !== 1) {
      scrubSpeedRef.current = 1;
      setScrubSpeed(1);
    }
  }, []);

  const startHold = useCallback((dir: 1 | -1) => {
    if (heldDirRef.current === dir) return; // already scrubbing this way
    if (navRafRef.current != null) cancelAnimationFrame(navRafRef.current);
    heldDirRef.current = dir;
    navStepRef.current(dir); // immediate first step — no OS initial-repeat delay
    holdStartTsRef.current = performance.now();
    lastStepTsRef.current = holdStartTsRef.current;
    let repeating = false; // false until the initial hold delay elapses
    const loop = (ts: number) => {
      if (heldDirRef.current === 0) return;
      // First repeat waits NAV_HOLD_DELAY_MS after hold-start (so a tap = 1 step);
      // once repeating, each subsequent step waits NAV_REPEAT_MS.
      const due = repeating
        ? ts - lastStepTsRef.current >= NAV_REPEAT_MS
        : ts - holdStartTsRef.current >= NAV_HOLD_DELAY_MS;
      if (due) {
        repeating = true;
        lastStepTsRef.current = ts;
        // Staged acceleration: the longer the hold, the more frames per tick
        // (1× → 3× → 10×). Multi-steps stop at a boundary mid-tick.
        const held = ts - holdStartTsRef.current;
        const speed = scrubSpeedForHeldMs(held);
        if (speed !== scrubSpeedRef.current) {
          scrubSpeedRef.current = speed;
          setScrubSpeed(speed);
        }
        // ONE call with step=speed: advance/cycleChallenger read this render's
        // position, so calling them repeatedly within a tick would recompute
        // the same target `speed` times and move a single frame (the "50× that
        // scrubbed at 1×" bug). Both walk `step` frames internally instead.
        const moved = navStepRef.current(heldDirRef.current, speed);
        // Blur only while actually moving. At a boundary (nothing to move to) keep
        // the current frame full-res — no point blurring when we aren't going
        // anywhere. Toggle only on change to avoid per-step re-renders.
        if (moved !== scrubbingRef.current) {
          scrubbingRef.current = moved;
          setScrubbing(moved);
        }
      }
      navRafRef.current = requestAnimationFrame(loop);
    };
    navRafRef.current = requestAnimationFrame(loop);
  }, []);

  // Held ArrowUp/ArrowDown in the grid: the SAME staged acceleration as the
  // loupe/compare horizontal hold above (via scrubSpeedForHeldMs), but
  // stepping `gridCols * speed` rows per repeat tick instead of frames.
  // Separate ref/loop from heldDirRef/startHold — the two hold systems are
  // mutually exclusive by mode (grid vs. loupe/compare) but keeping them
  // distinct avoids any risk of one loop's cleanup stomping the other's.
  // advanceRef/gridColsRef mirror navStepRef: the loop must read the LATEST
  // advance + gridCols each tick, not the ones closed over at hold-start,
  // since `advance`'s identity (and possibly gridCols, on a mid-hold resize)
  // changes every step.
  const advanceRef = useRef(advance);
  useEffect(() => {
    advanceRef.current = advance;
  }, [advance]);
  const gridColsRef = useRef(gridCols);
  useEffect(() => {
    gridColsRef.current = gridCols;
  }, [gridCols]);

  const heldGridVertDirRef = useRef<0 | 1 | -1>(0);
  const gridVertRafRef = useRef<number | null>(null);
  const gridVertLastStepTsRef = useRef(0);
  const gridVertHoldStartTsRef = useRef(0);

  const stopGridVertHold = useCallback(() => {
    heldGridVertDirRef.current = 0;
    if (gridVertRafRef.current != null) {
      cancelAnimationFrame(gridVertRafRef.current);
      gridVertRafRef.current = null;
    }
    // Same settle as stopHold: drop the shared scrubbing/scrubSpeed state so
    // the footer chip + strip scrub bar's grid counterparts (footer chip and
    // the grid's right-edge speed badge) clear together. One shared pair of
    // indicators for both hold systems — see the state's declaration comment.
    if (scrubbingRef.current) {
      scrubbingRef.current = false;
      setScrubbing(false);
    }
    if (scrubSpeedRef.current !== 1) {
      scrubSpeedRef.current = 1;
      setScrubSpeed(1);
    }
  }, []);

  const startGridVertHold = useCallback((dir: 1 | -1) => {
    if (heldGridVertDirRef.current === dir) return; // already scrubbing this way
    if (gridVertRafRef.current != null) cancelAnimationFrame(gridVertRafRef.current);
    heldGridVertDirRef.current = dir;
    advanceRef.current(dir, gridColsRef.current); // immediate first row-jump
    gridVertHoldStartTsRef.current = performance.now();
    gridVertLastStepTsRef.current = gridVertHoldStartTsRef.current;
    let repeating = false;
    const loop = (ts: number) => {
      if (heldGridVertDirRef.current === 0) return;
      const due = repeating
        ? ts - gridVertLastStepTsRef.current >= NAV_REPEAT_MS
        : ts - gridVertHoldStartTsRef.current >= NAV_HOLD_DELAY_MS;
      if (due) {
        repeating = true;
        gridVertLastStepTsRef.current = ts;
        const held = ts - gridVertHoldStartTsRef.current;
        const speed = scrubSpeedForHeldMs(held);
        // Same shared scrubSpeed state the loupe/compare hold drives — this is
        // what the footer chip AND the grid's own right-edge speed badge read.
        if (speed !== scrubSpeedRef.current) {
          scrubSpeedRef.current = speed;
          setScrubSpeed(speed);
        }
        // ONE call with step = gridCols * speed — same one-call rule as the
        // horizontal hold above (see its comment): N single-row calls would
        // all read the same render-frozen position and go nowhere.
        const moved = advanceRef.current(heldGridVertDirRef.current, gridColsRef.current * speed);
        // Same shared "scrubbing" flag the loupe hold flips (see startHold) —
        // only true once actually moving, so parking at the top/bottom edge
        // doesn't flash the footer's "Scrubbing" chip for nothing.
        if (moved !== scrubbingRef.current) {
          scrubbingRef.current = moved;
          setScrubbing(moved);
        }
      }
      gridVertRafRef.current = requestAnimationFrame(loop);
    };
    gridVertRafRef.current = requestAnimationFrame(loop);
  }, []);

  // A grid-exit that doesn't go through a keydown (e.g. a footer/mouse
  // navigation) must still stop the loop — mirrors the clearMultiSelection
  // effect below, which resets grid-only state the same way.
  useEffect(() => {
    if (!gridVisible) stopGridVertHold();
  }, [gridVisible, stopGridVertHold]);

  // Stop a held scrub if the key-release is missed (window blur) and on unmount.
  // Also clear the Space-held flag so a lost Space keyup can't wedge zoom off.
  useEffect(() => {
    const onBlur = () => {
      stopHold();
      stopGridVertHold();
      resetZoom(); // focus lost mid-hold (e.g. Alt+Tab) → exit zoom
    };
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("blur", onBlur);
      stopHold();
      stopGridVertHold();
    };
  }, [stopHold, stopGridVertHold, resetZoom]);

  // Safety net: if Settings opens while a hold-scrub is active — by keyboard
  // (Ctrl+,, which returns before the keydown handler's stopHold guard) OR by
  // clicking the home-screen gear mid-hold — stop the rAF loop so it can't keep
  // advancing the cursor behind the modal.
  useEffect(() => {
    if (settingsOpen) {
      stopHold();
      stopGridVertHold();
    }
  }, [settingsOpen, stopHold, stopGridVertHold]);

  // Click-pick handlers for the thumb / candidate strips. A click must
  // immediately interrupt any held-arrow scrub so the new image lands and
  // renders straight away instead of waiting for the scrub loop to settle on
  // its own. We only call stopHold() when a hold is ACTUALLY active —
  // calling it unconditionally on a plain tap means an extra setState
  // (setScrubbing(false)) on every click, which can churn the photo-frame's
  // mount/unmount during the same render pass as the new index, reading
  // as a stutter.
  const pickFromStrip = useCallback(
    (index: number) => {
      // Ignore strip clicks while zoomed — changing the frame mid-zoom is disabled
      // (it left the next frame stuck zoomed). Release Space first.
      if (isZoomingRef.current) return;
      if (heldDirRef.current !== 0 || scrubbingRef.current) stopHold();
      setCurrentIndex(index);
    },
    // isZoomingRef is an identity-stable hook return — listed for exhaustive-deps.
    [stopHold, isZoomingRef],
  );
  const pickChallengerFromStrip = useCallback(
    (index: number) => {
      if (isZoomingRef.current) return; // disabled while zoomed (see pickFromStrip)
      if (heldDirRef.current !== 0 || scrubbingRef.current) stopHold();
      setChallengerIndex(index);
    },
    // isZoomingRef: same stable-ref listing as pickFromStrip above.
    [stopHold, isZoomingRef],
  );

  // Grid cell click — stable identity so GridView/GridCell memoization holds and
  // only the changed cell re-renders. (The old inline closure was a fresh
  // function on every App render, so every visible grid cell re-rendered on any
  // unrelated state change — e.g. the save-pill counter ticking.) Three modes:
  // shift-extend, ctrl-toggle, plain click → open in loupe.
  const handleGridPick = useCallback(
    (i: number, modifiers: { shift: boolean; ctrl: boolean }) => {
      // A click (shift/ctrl-range or plain) jumps the cursor itself — a held
      // vertical scrub still running would fight it on the next repeat tick,
      // continuing from wherever the click landed. Mirrors pickFromStrip's
      // same guard for the loupe/compare horizontal hold.
      if (heldGridVertDirRef.current !== 0) stopGridVertHold();
      if (modifiers.shift) {
        const anchor = selectionAnchor ?? i;
        // Range math shared with shift+arrow (extendSelection) so mouse and
        // keyboard grow the exact same selection.
        let next = extendSelection(visibleIndices, anchor, i);
        if (next === null) {
          // Anchor fell out of the filter — reseat it on the clicked cell so the
          // NEXT shift-click extends from a valid in-filter anchor instead of
          // collapsing to a single cell again.
          next = new Set([i]);
          setSelectionAnchor(i);
        }
        setSelectedIndices(next);
        if (selectionAnchor === null) setSelectionAnchor(i);
        setCurrentIndex(i);
        return;
      }
      if (modifiers.ctrl) {
        const next = new Set(selectedIndices);
        const wasSelected = next.has(i);
        if (wasSelected) next.delete(i);
        else next.add(i);
        setSelectedIndices(next);
        // Anchor tracks the last-interacted cell, but null it when the toggle
        // emptied the set so a later shift-range can't extend from a
        // no-longer-selected anchor.
        setSelectionAnchor(next.size === 0 ? null : i);
        // Only an ADD moves the cursor (and its outline) onto the cell; a
        // deselect leaves current where it was, so the just-deselected cell
        // doesn't get a stray current-outline just because it was clicked.
        if (!wasSelected) setCurrentIndex(i);
        return;
      }
      // Plain click.
      clearMultiSelection();
      setCurrentIndex(i);
      goToSite("loupe");
    },
    [
      visibleIndices,
      selectionAnchor,
      selectedIndices,
      clearMultiSelection,
      goToSite,
      stopGridVertHold,
    ],
  );

  // Shift+arrow selection growth — the keyboard twin of shift-click. The
  // range recomputes anchor→target, so arrowing back toward the anchor shrinks
  // the selection exactly like shift-clicking closer does.
  const growGridSelection = useCallback(
    (deltaCells: number) => {
      const pos = visibleIndices.indexOf(currentIndex);
      if (pos === -1) return;
      const targetPos = Math.max(0, Math.min(visibleIndices.length - 1, pos + deltaCells));
      const target = visibleIndices[targetPos];
      const anchor = selectionAnchor ?? currentIndex;
      const next = extendSelection(visibleIndices, anchor, target);
      if (next === null) {
        // Anchor fell out of the filter — reseat on the cursor (shift-click's
        // own fallback) and extend from there.
        setSelectionAnchor(currentIndex);
        const reseated = extendSelection(visibleIndices, currentIndex, target);
        if (reseated) {
          setSelectedIndices(reseated);
          setCurrentIndex(target);
        }
        return;
      }
      if (selectionAnchor === null) setSelectionAnchor(anchor);
      setSelectedIndices(next);
      setCurrentIndex(target);
    },
    [visibleIndices, currentIndex, selectionAnchor],
  );

  // Ctrl/Cmd+A — select everything the current filter shows. Rating keys then
  // act on the whole set (one undo entry): the sanctioned bulk-apply path, e.g.
  // Smart ✕ filter → grid → ⌘A → Backspace clears every suggested reject.
  const selectAllInGrid = useCallback(() => {
    if (visibleIndices.length === 0) return;
    setSelectedIndices(new Set(visibleIndices));
    setSelectionAnchor(visibleIndices.includes(currentIndex) ? currentIndex : visibleIndices[0]);
  }, [visibleIndices, currentIndex]);

  // ── The keyboard ──────────────────────────────────────────────────────────
  // Chrome-screen shortcuts, the big cull keymap (rebuilt per render,
  // dispatched through a once-bound ref so the scrub hot path never churns
  // listeners), the capture-phase ESC swallow, and the window listeners all
  // live in app/useCullKeymap.
  useCullKeymap({
    phase,
    images,
    settings,
    settingsOpen,
    setSettingsOpen,
    pickFolder,
    beginCulling,
    resetSession,
    quitGuard,
    setQuitGuard,
    confirmHome,
    setConfirmHome,
    leaveToHome,
    actionsOpen,
    setActionsOpen,
    openActions,
    helpVisible,
    setHelpVisible,
    setHelpIntro,
    undo,
    redo,
    gridVisible,
    gridCols,
    advance,
    selectAllInGrid,
    growGridSelection,
    clearMultiSelection,
    heldDirRef,
    startHold,
    stopHold,
    heldGridVertDirRef,
    startGridVertHold,
    stopGridVertHold,
    isZooming,
    isZoomingRef,
    setIsZooming,
    setZoomLevel,
    setPanOffset,
    mouseZooming,
    resetZoom,
    pan,
    compareMode,
    championIndex,
    goToSite,
    goBack,
    challengerWins,
    challengerLoses,
    challengerKeptBoth,
    applyRating,
    unrateCurrent,
    setFilter,
    chipsTooltip,
    startAnalysis,
    setExifVisible,
    setClippingVisible,
    setPeakingVisible,
    setThumbsVisible,
    setCompositionVisible,
  });

  const folderName = folder ? basename(folder) : "";

  // Shown (in any phase) when a close was requested while ratings are still
  // saving or have failed. Pending → auto-closes once flushed; failed → requires
  // an explicit choice so work is never silently lost.
  const quitGuardOverlay = quitGuard && (
    <div className="cull-quitguard">
      <div className="cull-quitguard__box">
        {failedCount > 0 ? (
          <>
            <div className="cull-quitguard__title cull-quitguard__title--warn">
              ⚠ {failedCount} rating{failedCount > 1 ? "s" : ""} didn’t save
            </div>
            <div className="cull-quitguard__body">
              {failedCount} {failedCount > 1 ? "ratings are" : "rating is"} not on disk (the sidecar
              write kept failing). Closing now will lose {failedCount > 1 ? "them" : "it"}.
            </div>
            <div className="cull-quitguard__actions">
              <button className="cull-pick-button cull-pick-button--primary" onClick={retryFailed}>
                retry saving
              </button>
              <button className="cull-pick-button" onClick={() => setQuitGuard(false)}>
                keep culling
              </button>
              <button
                className="cull-pick-button cull-quitguard__danger"
                onClick={() => {
                  if (destroyedRef.current) return;
                  destroyedRef.current = true;
                  getCurrentWindow()
                    .destroy()
                    .catch(() => {});
                }}
              >
                close anyway
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="cull-quitguard__title">
              saving {savingCount} rating{savingCount > 1 ? "s" : ""}…
            </div>
            <div className="cull-quitguard__body">
              The app will close on its own the moment your ratings are safely on disk.
            </div>
            <div className="cull-quitguard__actions">
              <button className="cull-pick-button" onClick={() => setQuitGuard(false)}>
                keep culling
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );

  // ── Chrome phases (start / loading / staged) ───────────────────────────────
  if (phase !== "culling") {
    const chromeMode =
      phase === "start"
        ? "HOME"
        : phase === "loading"
          ? "OPENING"
          : phase === "analyzing"
            ? "ANALYZING"
            : "STAGED";
    return (
      <main className="cull-app cull-app--chrome">
        {quitGuardOverlay}
        <WindowControls onSettings={() => setSettingsOpen(true)} />
        {/* Top chrome row — brand block with mode name and save status pill.
            The top-right chrome (settings, minimize, close) is rendered by
            WindowControls as a fixed overlay so it stays visible across all
            views and overlays. */}
        <header className="cull-statusbar cull-statusbar--top" data-tauri-drag-region>
          <div className="cull-statusbar__left">
            <span className="cull-statusbar__brandblock">
              <span className="cull-statusbar__brand">CULL</span>
              <span className="cull-statusbar__brand-sep">·</span>
              <span className="cull-statusbar__brand-mode">{chromeMode}</span>
            </span>
            <SaveStatusPill
              failedCount={failedCount}
              savingCount={savingCount}
              onRetry={retryFailed}
            />
          </div>
        </header>
        <div className={`cull-chrome${isDragOver ? " is-drag-over" : ""}`} data-tauri-drag-region>
          {isDragOver && (
            <div className="cull-drag-indicator" aria-hidden>
              <div className="cull-drag-indicator__arrow">↓</div>
              <div className="cull-drag-indicator__text">Drop folders to open</div>
            </div>
          )}
          {phase === "start" && (
            <div className="cull-hero">
              <h1 className="cull-hero__title">
                Pick keepers, <em>fast.</em>
              </h1>
              <p className="cull-hero__sub">
                A keyboard-first culling tool for Canon CR3 RAW photos. Verdicts save into
                Lightroom-compatible XMP sidecars.
              </p>
              <div className="cull-hero__cta-row">
                <button className="cull-hero__cta" onClick={pickFolder} disabled={pickerBusy}>
                  {pickerBusy ? "opening…" : "Open folders"}
                  <span className="cull-hero__cta-key">{modGlyph} O</span>
                </button>
                <span className="cull-hero__drop-hint">or drop folders anywhere</span>
              </div>
              <RecentFolders
                recents={recentFolders}
                onPick={(entry) =>
                  openFoldersByPaths(entry.paths, { fromRecentKey: recentKey(entry.paths) })
                }
                pickerBusy={pickerBusy}
              />
              {scanFailures && <ScanFailureCard failures={scanFailures} />}
              <div className="cull-hero__how">
                <span>
                  <span className="cull-hero__how-key">{modGlyph} ,</span>
                  settings
                </span>
              </div>
            </div>
          )}

          {phase === "loading" && (
            <>
              <div className="cull-spinner" />
              <div className="cull-chrome__status">
                loading{" "}
                <span className="cull-chrome__folder">
                  {pendingFolder ? basename(pendingFolder) : folderName}
                </span>
              </div>
              <div className="cull-chrome__sub">
                {images.length > 0 ? `${images.length} files staged · scanning…` : "scanning…"}
              </div>
            </>
          )}

          {phase === "analyzing" && (
            <>
              <div className="cull-chrome__status">
                {progress.phase === "restoring"
                  ? "restoring ratings…"
                  : progress.phase === "done"
                    ? "sorting…"
                    : "reading capture times…"}
              </div>
              <div className="cull-progress">
                {progress.done === 0 ? (
                  <div className="cull-progress__indeterminate" />
                ) : (
                  <div
                    className="cull-progress__fill"
                    style={{ width: `${(progress.done / progress.total) * 100}%` }}
                  />
                )}
              </div>
              <div className="cull-chrome__sub">
                {progress.done > 0 ? `${progress.done} / ${progress.total}` : "starting…"}
              </div>
            </>
          )}

          {phase === "staged" && (
            <>
              <div className="cull-staged__check">{images.length > 0 ? "✓" : "—"}</div>
              <div className="cull-staged__count">
                {images.length} CR3 {images.length === 1 ? "image" : "images"} staged
              </div>
              <div
                className="cull-chrome__folder cull-staged__folder"
                title={lastBatchFolders.join("\n")}
              >
                {lastAdded > 0
                  ? `+${lastAdded} from ${formatFolderSet(lastBatchFolders, 40)}`
                  : `+0 from ${formatFolderSet(lastBatchFolders, 40)} · no new CR3 files`}
              </div>
              {lastIgnored > 0 && (
                <div className="cull-staged__ignored">
                  {lastIgnored.toLocaleString()} non-CR3 file{lastIgnored === 1 ? "" : "s"} ignored
                </div>
              )}
              {scanFailures && <ScanFailureCard failures={scanFailures} />}
              {analyzeError && (
                <pre className="cull-message__body cull-chrome__error">{analyzeError}</pre>
              )}
              <div className="cull-staged__actions">
                {images.length > 0 ? (
                  <button
                    className="cull-pick-button cull-pick-button--primary"
                    onClick={beginCulling}
                  >
                    begin culling →
                  </button>
                ) : (
                  <button
                    className="cull-pick-button cull-pick-button--primary"
                    onClick={pickFolder}
                    disabled={pickerBusy}
                  >
                    {pickerBusy ? "opening…" : "open folders"}
                  </button>
                )}
              </div>
              <div className="cull-staged__hint">
                drop folders anywhere to add more · {modGlyph} O · esc to start over
              </div>
            </>
          )}
        </div>
        {settingsOpen && (
          <SettingsDialog
            settings={settings}
            onChange={setSettings}
            onClose={() => setSettingsOpen(false)}
          />
        )}
      </main>
    );
  }

  // ── Culling phase ──────────────────────────────────────────────────────────
  const current = images[currentIndex];
  // `cur` (the loupe's useImage result) is computed unconditionally near the
  // top of the component. It carries the stage/url/dims/error for the loupe.
  const currentMeta = current ? metadata[current.path] : undefined;
  const currentRating = current ? ratings[current.id] : undefined;

  // Zoom transform-origin = AF point (display coords) + pan, clamped to image.
  const { x: originX, y: originY } = afZoomOrigin(currentMeta, panOffset);

  // The pane owns the real zoom geometry (hi-res transform, frame dims);
  // this mirror of its zoomZ exists only for the mouse-drag pan factor, via
  // the SAME shared formula over the rect the pane reports up. Native dims
  // of the ZOOM raster: the zoom tier's meta-derived dims → the thumb's
  // sensor display dims (cur.dims is orientation-adjusted, not 160×120).
  const zoomNative =
    cur.full?.dims ?? (cur.dims && cur.dims.w > 1 && cur.dims.h > 1 ? cur.dims : undefined);
  const zoomZ = paneZoomZ(zoomNative, imgRect, zoomLevel, isZooming);
  // Render-phase ref mirror for the mouse-drag pan loop (see its effect):
  // pure function of state, same value every render, no tearing concern.
  zoomZRef.current = zoomZ;
  // One transition string for EVERY layer that scales with zoom (presenter,
  // hi-res, clip/peak masks) — "none" for the carried-zoom frame swap, the
  // directional glide otherwise. Single source so layers can't tear apart.
  const zoomGlide = zoomSwapInstant ? "none" : zoomTransition(isZooming);

  // Rating feedback chip — a brief corner badge. Rendered INSIDE the loupe photo
  // stage and the grid view (each its own positioning context) so it sits bottom-
  // right within the image / grid area, clear of the thumb strip and the footer.
  const feedbackChip = feedback && (
    <div className="cull-feedback" key={feedback.ts}>
      <div
        className="cull-feedback__circle"
        style={{ backgroundColor: RATING_COLOR[feedback.rating] }}
      >
        {feedback.rating === "keep" && <Check size={22} color="white" strokeWidth={3} />}
        {feedback.rating === "reject" && <XIcon size={22} color="white" strokeWidth={3} />}
        {feedback.rating === "favorite" && (
          <Star size={22} color="white" strokeWidth={3} fill="white" />
        )}
      </div>
    </div>
  );

  // Analysis-overlay pixels for the displayed frame, read from the service's
  // bounded LRUs (the useSyncExternalStore subscription above re-renders this
  // component when one lands, so plain reads here stay fresh).
  const currentClipMask =
    clippingVisible && current ? overlayService.get("clip", current.path) : undefined;
  const currentPeakMask =
    peakingVisible && current ? overlayService.get("peak", current.path) : undefined;
  const currentHistogram =
    exifVisible && current ? overlayService.get("histogram", current.path) : undefined;

  const singleModeBody = (
    <div className="cull-stage">
      <div className="cull-loupe-body">
        <div
          className={`cull-image-area${
            positionInFilter !== -1 && !isZooming
              ? " cull-image-area--zoomable"
              : mouseZooming
                ? " cull-image-area--grabbing"
                : ""
          }`}
          ref={stageRef}
          onMouseDown={handleStageMouseDown}
        >
          {images.length === 0 ? (
            <div className="cull-message">no images</div>
          ) : positionInFilter === -1 ? (
            <EmptyFilter
              filter={filter}
              smartCulling={settings.smartCulling}
              smartCullingOnOpen={settings.smartCullingOnOpen}
              analyzing={qualityAnalyzing}
              scoredCount={Object.keys(qualityScores).length}
              progress={qualityProgress}
            />
          ) : cur.stage === "shimmer" && cur.error ? (
            // Full-screen error only when there's NO thumb to fall back to. If a
            // thumb exists, resolveStage keeps stage "thumb" (with error set) and
            // we keep showing it rather than blanking the frame.
            <div className="cull-message">
              <div className="cull-message__title">preview failed</div>
              <pre className="cull-message__body">{cur.error}</pre>
              <button
                type="button"
                className="cull-message__retry"
                onClick={() => current && imageStore.retry(current.path)}
              >
                retry
              </button>
            </div>
          ) : (
            // Photo-frame stays mounted across image transitions AND across
            // scrubbing so the matte + outer structure don't pop in/out on
            // every tap-to-navigate or arrow-key release. The inner <img>
            // swaps between full preview (when ready and not scrubbing) and
            // the thumbnail fallback (during scrub / while preview loads),
            // so there's always pixels in the frame and no remount of overlays.
            // The spinner appears only when neither scrubbing nor ready —
            // i.e. true "waiting on disk" state.
            <>
              {/* The unified pane (PhotoPane): frame + sizer, decode-gated
                presenter layers, shimmer, spinner, error chip, the settle-
                gated post-decode zoom layer, and the mask/thirds overlays.
                It measures the displayed image against the stage and reports
                the rect up for the mouse-zoom math. */}
              <PhotoPane
                variant="loupe"
                path={current?.path ?? ""}
                img={cur}
                scrubbing={scrubbing}
                isZooming={isZooming}
                zoomGlide={zoomGlide}
                zoomLevel={zoomLevel}
                originX={originX}
                originY={originY}
                fullSettleMs={profile.fullSettleMs}
                settleResetKey={`${thumbsVisible}|${exifVisible}`}
                flashRating={
                  feedback && current && feedback.imageId === current.id ? feedback.rating : null
                }
                clipMaskUrl={currentClipMask}
                peakingMaskUrl={currentPeakMask}
                showComposition={compositionVisible}
                measureContainerRef={stageRef}
                onRectChange={setImgRect}
              />
              {/* Verdict is now shown in the bottom status bar's pill; the floating
                corner dot is dropped to avoid duplicate signaling and to keep the
                stage clean alongside the EXIF rail. */}
            </>
          )}
          {feedbackChip}
        </div>
        {/* No rail on the empty-filter screen: `current` still points at the
            last-viewed frame there, and its EXIF next to "no matches" reads
            as stale ghost data. */}
        {exifVisible && current && positionInFilter !== -1 && (
          <ExifRail
            metadata={currentMeta}
            histogramUrl={currentHistogram}
            cullRating={currentRating}
            suggestion={suggestions[current.id] ?? null}
            burst={burstCtx.get(current.id) ?? null}
            similar={similarCtx.get(current.id) ?? null}
          />
        )}
      </div>
    </div>
  );

  // Build the bottom status bar JSX once so it renders inside each view's
  // flex column AFTER the thumb strip (the last row, with a border-top). The
  // top chrome row above just holds the brand block and window controls, like
  // a title bar.
  //
  // Layout (left → right):
  //   filename · MP  ·  verdict pill (glyph + label)
  //   overlay cluster (i h p o t — circular toggle chips, on/off state)
  //   <spacer>
  //   position N / M  ·  filter tabs (loupe + grid)  ·  finish button
  // In compare mode the status bar's filename follows the CHALLENGER — the frame
  // the user is actively judging — not the current cursor (which would track the
  // champion). Single-view shows the cursor's frame.
  const statusBarImg = compareMode ? images[challengerIndex] : current;
  const verdictLabel: Record<Rating, string> = {
    keep: "Keep",
    reject: "Reject",
    favorite: "Fav",
  };
  const verdictCls: Record<Rating, string> = {
    keep: "cull-statusbar__verdict--keep",
    reject: "cull-statusbar__verdict--reject",
    favorite: "cull-statusbar__verdict--fav",
  };
  const totalKeeps = stats.keeps; // includes favorites
  const bottomStatusBar = (
    <footer className="cull-statusbar">
      <div className="cull-statusbar__left">
        {statusBarImg && (
          <span className="cull-statusbar__filename">
            <span className="cull-statusbar__filename-name">{statusBarImg.filename}</span>
          </span>
        )}
        {!compareMode && currentRating && (
          <span
            className={`cull-statusbar__verdict ${verdictCls[currentRating]}`}
            aria-label={verdictLabel[currentRating]}
          >
            <span className="cull-statusbar__verdict-glyph" aria-hidden>
              {verdictGlyph(currentRating, 9)}
            </span>
            {verdictLabel[currentRating]}
          </span>
        )}
        {isZooming && (
          <span className="cull-statusbar__chip cull-statusbar__chip--zoom">
            zoom {zoomLevel}:1
          </span>
        )}
        {scrubbing && (
          <span className="cull-statusbar__scrub" aria-label="scrubbing">
            Scrubbing
            {scrubSpeed > 1 && <span className="cull-statusbar__scrubspeed">{scrubSpeed}×</span>}
          </span>
        )}
        {/* Overlay cluster — five circular toggle chips. Hidden in grid (those
            overlays don't apply there). The thumb-strip chip (t) shows in
            loupe / compare only too. */}
        {!gridVisible && (
          <div className="cull-statusbar__overlay-cluster" aria-label="overlays">
            <button
              type="button"
              className={`cull-statusbar__ov${exifVisible ? " is-on" : ""}`}
              onClick={() => setExifVisible((v) => !v)}
              title="i · info"
              aria-pressed={exifVisible}
            >
              i
            </button>
            <button
              type="button"
              className={`cull-statusbar__ov${clippingVisible ? " is-on" : ""}`}
              onClick={() => setClippingVisible((v) => !v)}
              title="h · clipping"
              aria-pressed={clippingVisible}
            >
              h
            </button>
            <button
              type="button"
              className={`cull-statusbar__ov${peakingVisible ? " is-on" : ""}`}
              onClick={() => setPeakingVisible((v) => !v)}
              title="p · focus peaking"
              aria-pressed={peakingVisible}
            >
              p
            </button>
            <button
              type="button"
              className={`cull-statusbar__ov${compositionVisible ? " is-on" : ""}`}
              onClick={() => setCompositionVisible((v) => !v)}
              title="o · thirds"
              aria-pressed={compositionVisible}
            >
              o
            </button>
            <button
              type="button"
              className={`cull-statusbar__ov${thumbsVisible ? " is-on" : ""}`}
              onClick={() => setThumbsVisible((v) => !v)}
              title="t · thumb strip"
              aria-pressed={thumbsVisible}
            >
              t
            </button>
          </div>
        )}
        {gridVisible && selectedIndices.size >= 1 && (
          <span
            className="cull-statusbar__multi"
            title="selection · rating keys apply to all selected"
          >
            {selectedIndices.size} selected
          </span>
        )}
        {failedCount > 0 ? (
          <span
            className="cull-statusbar__unsaved"
            onClick={retryFailed}
            title="ratings failed to save · click to retry"
          >
            ⚠ {failedCount} unsaved · retry
          </span>
        ) : (
          savingCount > 0 && <span className="cull-statusbar__saving">saving {savingCount}…</span>
        )}
      </div>
      <div className="cull-statusbar__spacer" />
      <div className="cull-statusbar__right">
        <span className="cull-statusbar__keyhint" aria-hidden>
          tab · keys
        </span>
        <span
          className="cull-statusbar__pos"
          title={
            compareMode
              ? "challenger position / total candidates"
              : "current position / filtered total"
          }
        >
          {compareMode ? (
            <>
              <b>{Math.max(0, challengerPos + 1)}</b>
              <span className="of"> / {compareCandidates.length}</span>
            </>
          ) : (
            <>
              <b>{positionInFilter >= 0 ? positionInFilter + 1 : 0}</b>
              <span className="of"> / {visibleIndices.length}</span>
            </>
          )}
        </span>
        {/* Filter tabs disabled in compare. */}
        {!compareMode && (
          <div className="cull-filter-tabs" role="tablist" aria-label="filter">
            <button
              type="button"
              className={filter === "all" ? "is-active" : ""}
              onClick={() => setFilter((f) => cycleFilter(f, "all"))}
              data-tip={filter === "all" ? undefined : "1 · show all"}
            >
              All
            </button>
            <button
              type="button"
              className={filter === "unrated" ? "is-active" : ""}
              onClick={() => setFilter((f) => cycleFilter(f, "unrated"))}
              data-tip={filter === "unrated" ? undefined : "2 · show unrated"}
            >
              Unrated
            </button>
            <span className="cull-filter-tab-group">
              <button
                type="button"
                className={topOf(filter) === "keeps" ? "is-active" : ""}
                onClick={() => {
                  setFilter((f) => cycleFilter(f, "keeps"));
                  chipsTooltip.pulse();
                }}
                // Tip only while INACTIVE (the active tab floats the sub-chip
                // tooltip in the same spot). data-tip renders instantly via
                // CSS — the OS title delay made it lose the race against the
                // neighbouring chip tooltip's fade-out.
                data-tip={topOf(filter) === "keeps" ? undefined : "3 · show keeps"}
                {...(topOf(filter) === "keeps" ? chipsTooltip.hoverProps : undefined)}
              >
                Keeps
              </button>
              {topOf(filter) === "keeps" && (
                <span
                  className={`cull-filter-tab-tooltip${chipsTooltip.visible ? " is-on" : ""}`}
                  {...chipsTooltip.hoverProps}
                >
                  <button
                    type="button"
                    className={filter === "keeps" ? "is-active" : ""}
                    onClick={() => {
                      setFilter("keeps");
                      chipsTooltip.pulse();
                    }}
                    title="keeps and favorites"
                  >
                    all
                  </button>
                  <button
                    type="button"
                    className={filter === "keepsFavs" ? "is-active" : ""}
                    onClick={() => {
                      setFilter("keepsFavs");
                      chipsTooltip.pulse();
                    }}
                    title="favorites only"
                  >
                    ★
                  </button>
                </span>
              )}
            </span>
            {/* Always visible — smart culling off just lands on the
                "disabled" empty screen (see EmptyFilter) instead of a tab
                that vanishes out from under an active filter. */}
            <span className="cull-filter-tab-group">
              <button
                type="button"
                className={topOf(filter) === "suggested" ? "is-active" : ""}
                onClick={() => {
                  setFilter((f) => cycleFilter(f, "suggested"));
                  chipsTooltip.pulse();
                  if (settings.smartCulling) {
                    startAnalysis(); // no-op unless "analyze on open" is off and unrun
                  }
                }}
                // Same inactive-only instant tip as the Keeps tab above.
                data-tip={topOf(filter) === "suggested" ? undefined : "4 · show suggestions"}
                {...(topOf(filter) === "suggested" ? chipsTooltip.hoverProps : undefined)}
              >
                {qualityAnalyzing && qualityProgress
                  ? `Smart ${Math.round((qualityProgress.done / Math.max(qualityProgress.total, 1)) * 100)}%`
                  : liveSuggestionCount > 0
                    ? `Smart · ${liveSuggestionCount}`
                    : "Smart"}
              </button>
              {topOf(filter) === "suggested" && (
                <span
                  className={`cull-filter-tab-tooltip${chipsTooltip.visible ? " is-on" : ""}`}
                  {...chipsTooltip.hoverProps}
                >
                  <button
                    type="button"
                    className={filter === "suggested" ? "is-active" : ""}
                    onClick={() => {
                      setFilter("suggested");
                      chipsTooltip.pulse();
                    }}
                    title="any suggestion"
                  >
                    all
                  </button>
                  <button
                    type="button"
                    className={filter === "suggestedRejects" ? "is-active" : ""}
                    onClick={() => {
                      setFilter("suggestedRejects");
                      chipsTooltip.pulse();
                    }}
                    title="suggested rejects"
                  >
                    ✕
                  </button>
                  <button
                    type="button"
                    className={filter === "suggestedKeeps" ? "is-active" : ""}
                    onClick={() => {
                      setFilter("suggestedKeeps");
                      chipsTooltip.pulse();
                    }}
                    title="suggested keeps"
                  >
                    ✓
                  </button>
                  <button
                    type="button"
                    className={filter === "suggestedFavs" ? "is-active" : ""}
                    onClick={() => {
                      setFilter("suggestedFavs");
                      chipsTooltip.pulse();
                    }}
                    title="suggested favorites"
                  >
                    ★
                  </button>
                </span>
              )}
            </span>
          </div>
        )}
        {(stats.keeps > 0 || rejectedPaths.length > 0) && !actionsOpen && (
          // The finish moment: once every frame is rated the button announces it
          // and brightens — the one nudge from "culling" to "act on the cull".
          <button
            type="button"
            className={`cull-statusbar__finish${
              stats.unrated === 0 && stats.total > 0 ? " is-done" : ""
            }`}
            onClick={() => setActionsOpen(true)}
            title="finish the cull · move rejects / copy keeps"
          >
            {stats.unrated === 0 && stats.total > 0
              ? `All ${stats.total} rated · ${modGlyph}E finish`
              : `${modGlyph}E · ${totalKeeps} keeps`}
          </button>
        )}
      </div>
    </footer>
  );

  // Each strip is built once and reused in the top OR bottom slot (only one of
  // the two placement guards is ever truthy, so it materializes in exactly one
  // DOM position). Avoids the verbatim prop-block duplication; placement still
  // controls DOM order, which focus/scroll depend on.
  const loupeStrip = (
    <ThumbStrip
      images={images}
      currentIndex={currentIndex}
      ratings={ratings}
      visibleIndices={visibleIndices}
      metadata={metadata}
      onPick={pickFromStrip}
      suggestions={suggestions}
      bursts={burstCtx}
      similar={similarCtx}
      scrubbing={scrubbing}
      scrubSpeed={scrubSpeed}
    />
  );
  const cmpStrip = (
    <CompareStrip
      images={images}
      stripIndices={compareStripIndices}
      championIndex={championIndex}
      challengerIndex={challengerIndex}
      metadata={metadata}
      onPickChallenger={pickChallengerFromStrip}
      suggestions={suggestions}
      bursts={burstCtx}
      similar={similarCtx}
      scrubbing={scrubbing}
      scrubSpeed={scrubSpeed}
    />
  );

  return (
    <main className="cull-app" data-thumbs-pos={settings.thumbsPosition}>
      {quitGuardOverlay}
      {devHudOn && <DevHud />}
      <WindowControls onSettings={() => setSettingsOpen(true)} />
      {/* Top chrome / title bar — brand block + view name + save status pill.
          Top-right chrome (settings · minimize · close) is fixed by
          WindowControls. Bottom status bar holds filename / chips / filters /
          count / finish. */}
      <header className="cull-statusbar cull-statusbar--top" data-tauri-drag-region>
        <div className="cull-statusbar__left">
          <span className="cull-statusbar__brandblock">
            <span className="cull-statusbar__brand">CULL</span>
            <span className="cull-statusbar__brand-sep">·</span>
            <span className="cull-statusbar__brand-mode">
              {compareMode ? "COMPARE" : gridVisible ? "GRID" : "LOUPE"}
            </span>
          </span>
          {/* No save pill while culling — the footer owns saving/unsaved there
              (it's where the eye lives and its chip is clickable-to-retry).
              The pill still renders on the chrome screens, which have no
              footer, so saves that outlive a session stay visible on home. */}
          {folderTrouble !== "hidden" && (
            <button
              type="button"
              className="cull-trouble-chip"
              data-state={folderTrouble}
              disabled={folderTrouble !== "latched"}
              onClick={() => void retryUnreachableFolders()}
              title={
                folderTrouble === "checking"
                  ? "probing every source folder…"
                  : folderTrouble === "still"
                    ? "still not responding. Check the drive or NAS, then retry"
                    : folderTrouble === "recovered"
                      ? "folder reachable again. Resuming loads"
                      : "several reads failed. The folder may be unreachable (NAS asleep or unmounted)"
              }
            >
              {folderTrouble === "checking"
                ? "checking folder…"
                : folderTrouble === "still"
                  ? "still unreachable"
                  : folderTrouble === "recovered"
                    ? "reconnected"
                    : "folder unreachable · retry"}
            </button>
          )}
          {memPressure !== "normal" && (
            <span
              className={`cull-mem-chip${memPressure === "critical" ? " is-critical" : ""}`}
              title={
                memPressure === "critical"
                  ? "system memory critically low. Zoom was released and its caches dropped to keep the app alive"
                  : "system memory is running low. Image caches shrunk; full speed returns when pressure eases"
              }
            >
              {memPressure === "critical" ? "low memory · zoom off" : "low memory"}
            </span>
          )}
        </div>
      </header>

      {compareMode ? (
        <>
          {thumbsVisible && settings.thumbsPosition === "top" && cmpStrip}
          <CompareView
            zoomGlide={zoomGlide}
            images={images}
            championIndex={championIndex}
            challengerIndex={challengerIndex}
            metadata={metadata}
            championClipMask={
              images[championIndex] && overlayService.get("clip", images[championIndex].path)
            }
            challengerClipMask={
              images[challengerIndex] && overlayService.get("clip", images[challengerIndex].path)
            }
            championPeakingMask={
              images[championIndex] && overlayService.get("peak", images[championIndex].path)
            }
            challengerPeakingMask={
              images[challengerIndex] && overlayService.get("peak", images[challengerIndex].path)
            }
            ratings={ratings}
            exifVisible={exifVisible}
            clippingVisible={clippingVisible}
            peakingVisible={peakingVisible}
            compositionVisible={compositionVisible}
            isZooming={isZooming}
            zoomLevel={zoomLevel}
            panOffset={panOffset}
            feedback={feedback}
            scrubbing={scrubbing}
            fullSettleMs={profile.fullSettleMs}
            settleResetKey={`${thumbsVisible}|${exifVisible}`}
            championSuggestion={
              images[championIndex] && !ratings[images[championIndex].id]
                ? (suggestions[images[championIndex].id] ?? null)
                : null
            }
            challengerSuggestion={
              images[challengerIndex] && !ratings[images[challengerIndex].id]
                ? (suggestions[images[challengerIndex].id] ?? null)
                : null
            }
          />
          {thumbsVisible && settings.thumbsPosition !== "top" && cmpStrip}
          {bottomStatusBar}
        </>
      ) : gridVisible ? (
        <>
          <div className="cull-grid-wrap">
            {visibleIndices.length === 0 ? (
              <EmptyFilter
                filter={filter}
                smartCulling={settings.smartCulling}
                smartCullingOnOpen={settings.smartCullingOnOpen}
                analyzing={qualityAnalyzing}
                scoredCount={Object.keys(qualityScores).length}
                progress={qualityProgress}
              />
            ) : (
              <GridView
                images={images}
                visibleIndices={visibleIndices}
                currentIndex={currentIndex}
                cols={gridCols}
                contentWidth={gridContentW}
                ratings={ratings}
                metadata={metadata}
                selectedIndices={selectedIndices}
                onPick={handleGridPick}
                containerRef={gridContainerRef}
                onViewportChange={handleGridViewport}
                suggestions={suggestions}
                // Group boxes only where runs survive contiguously (All /
                // Unrated). Cherry-picking filters (Keeps/Favorites/Smart)
                // leave 1-2 members per group — the boxes degrade into
                // cut-off fragments that read as broken chrome, not info.
                bursts={showGridGroupBoxes ? burstCtx : undefined}
                similar={showGridGroupBoxes ? similarCtx : undefined}
                scrubSpeed={scrubSpeed}
              />
            )}
            {feedbackChip}
          </div>
          {bottomStatusBar}
        </>
      ) : (
        <>
          {thumbsVisible && settings.thumbsPosition === "top" && loupeStrip}
          {singleModeBody}
          {thumbsVisible && settings.thumbsPosition !== "top" && loupeStrip}
          {bottomStatusBar}
        </>
      )}

      {confirmHome && (
        <div className="cull-quitguard">
          <div className="cull-quitguard__box">
            <div
              className={`cull-quitguard__title${failedCount > 0 ? " cull-quitguard__title--warn" : ""}`}
            >
              {failedCount > 0
                ? `⚠ leave with ${failedCount} unsaved rating${failedCount > 1 ? "s" : ""}?`
                : "leave to home?"}
            </div>
            <div className="cull-quitguard__body">
              {failedCount > 0
                ? `${failedCount} rating${failedCount > 1 ? "s have" : " has"} not saved to disk yet. Leaving won't lose ${failedCount > 1 ? "them" : "it"}: the unsaved flag stays on the home screen for retrying. Staying to retry first is safer.`
                : "Ratings are saved in .xmp sidecars. Reopening the folder restores them."}
            </div>
            <div className="cull-quitguard__actions">
              <button className="cull-pick-button cull-pick-button--primary" onClick={leaveToHome}>
                leave to home
              </button>
              <button className="cull-pick-button" onClick={() => setConfirmHome(false)}>
                stay
              </button>
            </div>
            <div className="cull-quitguard__hint">enter · leave · · · esc · stay</div>
          </div>
        </div>
      )}

      {actionsOpen && (
        <FinishDialog
          folder={folder}
          folderName={folderName}
          keptPaths={keptPaths}
          rejectedPaths={rejectedPaths}
          favorites={stats.favorites}
          unrated={stats.unrated}
          keepsCount={stats.keeps}
          savingCount={savingCount}
          failedCount={failedCount}
          actionBusy={actionBusy}
          moveResult={moveResult}
          copyResult={copyResult}
          settings={settings}
          onMoveRejects={doMoveRejects}
          onCopyKeeps={doCopyKeeps}
          onClose={() => setActionsOpen(false)}
        />
      )}

      {helpVisible && (
        <HelpOverlay
          mode={compareMode ? "compare" : gridVisible ? "grid" : "loupe"}
          intro={helpIntro}
          onDismiss={() => {
            setHelpVisible(false);
            setHelpIntro(false);
          }}
        />
      )}

      {settingsOpen && (
        <SettingsDialog
          settings={settings}
          onChange={setSettings}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </main>
  );
}

/**
 * Shared markup for the two true "no match" empty states (not-analyzed and
 * filter-empty) — both drop the old `⌀` glyph for a faint desert backdrop
 * instead. The "analyzing" / "analyzed" variants above them are transient
 * or informational rather than "nothing here", so they keep their glyph
 * and skip the backdrop.
 */
function NoMatchEmptyState({
  eyebrow,
  title,
  hint,
}: {
  eyebrow: string;
  title: ReactNode;
  hint: ReactNode;
}) {
  return (
    <div className="cull-empty-state cull-empty-state--desert">
      <div className="cull-empty-state__eyebrow">{eyebrow}</div>
      <div className="cull-empty-state__title">{title}</div>
      <div className="cull-empty-state__hint">{hint}</div>
    </div>
  );
}

/**
 * Centered empty-state shown in loupe / grid when the active filter has zero
 * matches. Small icon,
 * uppercase eyebrow, headline with the missing filter highlighted, and a key
 * hint to switch out.
 */
function EmptyFilter({
  filter,
  smartCulling,
  smartCullingOnOpen,
  analyzing,
  scoredCount,
  progress,
}: {
  filter: Filter;
  /** `settings.smartCulling` — the master switch. Smart is now a valid filter
   *  state even when off, so this drives the "disabled" empty screen. */
  smartCulling?: boolean;
  /** `settings.smartCullingOnOpen` — whether the pass self-starts; changes
   *  the not-analyzed hint (self-starting passes never need a "press 4"). */
  smartCullingOnOpen?: boolean;
  analyzing?: boolean;
  /** How many frames the smart pass has scored — distinguishes "analyzed,
   *  no obvious calls" (the healthy quiet case) from "never analyzed". */
  scoredCount?: number;
  /** Live pass progress — on a 5000-frame NAS folder the pass runs for many
   *  minutes (by design: it always yields to interactive reads), and without
   *  a count "analyzing" is indistinguishable from "hung". */
  progress?: { done: number; total: number } | null;
}) {
  // The whole "suggested" family (base + verdict sub-modes) has five empty
  // states, and telling them apart is the difference between "working as
  // designed" and "looks broken". All five are NoMatchEmptyState (desert
  // backdrop, no icon circle) — see pickSmartEmptyState for the precedence.
  if (topOf(filter) === "suggested") {
    const state = pickSmartEmptyState({
      smartCulling: smartCulling ?? false,
      autoStart: smartCullingOnOpen ?? false,
      analyzing: analyzing ?? false,
      scoredCount: scoredCount ?? 0,
    });
    switch (state) {
      case "disabled":
        return (
          <NoMatchEmptyState
            eyebrow="Smart culling off"
            title="Smart culling is turned off"
            hint={
              <>
                <kbd>{modGlyph} ,</kbd> for Settings · <kbd>1</kbd> for all
              </>
            }
          />
        );
      case "analyzing":
        // Not done yet — suggestions fill in progressively per chunk.
        return (
          <NoMatchEmptyState
            eyebrow="Analyzing"
            title={
              <>
                Looking for obvious calls
                {progress
                  ? ` · ${progress.done.toLocaleString()} of ${progress.total.toLocaleString()} scored`
                  : ""}
              </>
            }
            hint={
              <>
                fills in as frames are scored · culling comes first · <kbd>1</kbd> for all
              </>
            }
          />
        );
      case "analyzedNoSuggestions":
        // The healthy quiet case: everything scored (or since rated away),
        // nothing worth flagging. An advisory tool only speaks on clear
        // calls — silence is a verdict, whether this filter never had a hit
        // or every hit it had has since been rated.
        return (
          <NoMatchEmptyState
            eyebrow="Analyzed"
            title={<>Analysis done · no suggestions left here ({scoredCount} scored)</>}
            hint={
              <>
                <kbd>1</kbd> for all
              </>
            }
          />
        );
      case "notAnalyzedAutoStart":
        // The pass self-starts — this screen is a blink, no "press 4" needed.
        return (
          <NoMatchEmptyState
            eyebrow="Not analyzed"
            title="No frames have been scored yet"
            hint={
              <>
                <kbd>1</kbd> for all
              </>
            }
          />
        );
      case "notAnalyzedManual":
        // Auto-analyze off: the pass hasn't run, or every chunk failed
        // (drive hiccup) — 5 retries in both cases.
        return (
          <NoMatchEmptyState
            eyebrow="Not analyzed"
            title="No frames have been scored yet"
            hint={
              <>
                <kbd>4</kbd> to analyze · <kbd>1</kbd> for all
              </>
            }
          />
        );
    }
  }
  // Label the user-facing filter name. "All" can never actually be empty (it
  // includes unrated), so falling back to "this" covers the impossible-case.
  const label =
    filter === "keepsFavs"
      ? "Favorites"
      : filter === "keeps"
        ? "Keeps"
        : filter === "unrated"
          ? "Unrated"
          : "this"; // "suggested*" fully handled (and narrowed away) above
  return (
    <NoMatchEmptyState
      eyebrow="No matches"
      title={
        <>
          No images in the <em>{label}</em> filter
        </>
      }
      hint={
        <>
          <kbd>1</kbd> for all
        </>
      }
    />
  );
}

/**
 * Recent-sessions section on the home screen. Renders nothing on a totally
 * fresh launch (empty state replaces the list). Click a row to re-open that
 * session's folder set; rows that don't have a `count` yet hide the count
 * column rather than show a stub `0`.
 *
 * Three columns: folder names (`wedding-d1 + wedding-d2`, overflowing to
 * `+N more` — full paths in the tooltip), count badge (`327 / 372`, plain
 * `421`, or `932 ✓`), and a relative-time stamp.
 */
function RecentFolders({
  recents,
  onPick,
  pickerBusy,
}: {
  recents: RecentEntry[];
  onPick: (entry: RecentEntry) => void;
  pickerBusy: boolean;
}) {
  return (
    <div className="cull-recent">
      <div className="cull-recent__label">Recent</div>
      {recents.length === 0 ? (
        <div className="cull-recent__empty">
          No folders yet. Drop some anywhere, or press{" "}
          <kbd className="cull-recent__kbd">{modGlyph} O</kbd>.
        </div>
      ) : (
        <div className="cull-recent__items">
          {recents.map((r) => (
            <RecentRow key={recentKey(r.paths)} entry={r} onPick={() => !pickerBusy && onPick(r)} />
          ))}
        </div>
      )}
    </div>
  );
}

function RecentRow({ entry, onPick }: { entry: RecentEntry; onPick: () => void }) {
  // Folder NAMES, not paths — budgeted at ~52 chars so the count + time
  // columns still fit at the 620px hero width. The tooltip carries the full
  // paths (one per line), which also disambiguates duplicate basenames.
  const display = formatFolderSet(entry.paths, 52);
  const rel = formatRelativeTime(entry.lastOpened);
  return (
    <div
      className="cull-recent__item"
      role="button"
      tabIndex={0}
      onClick={onPick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onPick();
        }
      }}
      title={entry.paths.join("\n")}
    >
      <span className="cull-recent__path">{display}</span>
      <span className="cull-recent__count">
        {entry.count > 0 ? (
          entry.done ? (
            <>
              <b>{entry.count}</b>
              <span className="cull-recent__done" aria-label="finished">
                {" "}
                ✓
              </span>
            </>
          ) : entry.rated > 0 ? (
            <>
              <b>{entry.rated}</b>
              <span className="cull-recent__of"> / {entry.count}</span>
            </>
          ) : (
            <b>{entry.count}</b>
          )
        ) : null}
      </span>
      <span className="cull-recent__time">{rel ?? ""}</span>
    </div>
  );
}

/**
 * XMP save-status pill rendered in the top chrome (next to the brand). The
 * bottom status bar also surfaces failed saves — this is a peripheral mirror
 * the user catches with their peripheral vision so a failed write doesn't sit
 * unnoticed when the bottom bar is occluded by a modal.
 *
 * Three states, fully derived from existing state (no new state machinery):
 *  - failed   → red pill, clickable, runs the same retry path as the bottom bar
 *  - saving   → champagne dot pulsing, "saving…" text
 *  - idle     → muted dot, "saved" text (default)
 *
 * Failed wins over saving so an in-flight retry doesn't visually mask the
 * still-failing batch behind it.
 */
function SaveStatusPill({
  failedCount,
  savingCount,
  onRetry,
}: {
  failedCount: number;
  savingCount: number;
  onRetry: () => void;
}) {
  const state = failedCount > 0 ? "failed" : savingCount > 0 ? "saving" : "idle";
  // Quiet when there's nothing to say: a standing "saved" on a fresh home
  // screen reads as noise. The pill exists for in-flight and failed writes.
  if (state === "idle") return null;
  const text = state === "failed" ? "failed · retry" : "saving…";
  return (
    <span
      className={`cull-save-status cull-save-status--${state}`}
      role={state === "failed" ? "button" : undefined}
      tabIndex={state === "failed" ? 0 : undefined}
      onClick={state === "failed" ? onRetry : undefined}
      onKeyDown={
        state === "failed"
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onRetry();
              }
            }
          : undefined
      }
      title={
        state === "failed"
          ? "ratings failed to save · click to retry"
          : `saving ${savingCount} rating${savingCount > 1 ? "s" : ""}`
      }
    >
      <span className="cull-save-status__dot" />
      <span className="cull-save-status__label">{text}</span>
    </span>
  );
}
