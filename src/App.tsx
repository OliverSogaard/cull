import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { Check, Star, X as XIcon } from "lucide-react";
import type {
  AnalyzeProgress,
  AnalyzeResult,
  Feedback,
  FileOpResult,
  Filter,
  Img,
  ImageMetadata,
  NavEntry,
  NavSite,
  Phase,
  Rating,
  UndoAction,
} from "./types";
import "./App.css";

import { shimmerPhaseMs } from "./utils/shimmer";
import { CompareStrip } from "./components/CompareStrip";
import { CompareView } from "./components/CompareView";
import { ExifRail } from "./components/ExifRail";
import { FinishDialog } from "./components/FinishDialog";
import { GridView, GRID_CELL_TARGET } from "./components/GridView";
import { HelpOverlay } from "./components/HelpOverlay";
import { ScanFailureCard, type ScanFailure } from "./components/ScanFailureCard";
import { SettingsDialog } from "./components/SettingsDialog";
import { ThumbStrip } from "./components/ThumbStrip";
import { useSmartCulling } from "./smart/useSmartCulling";
import { groupBursts } from "./smart/groupBursts";
import { groupSimilar, type SimilarCtx } from "./smart/groupSimilar";
import { buildBurstInputs } from "./smart/burstInputs";
import { capFavorites } from "./smart/capFavorites";
import { deriveVerdict, keepEligible, type Suggestion } from "./smart/deriveVerdict";
import { WindowControls } from "./components/WindowControls";
import { DevHud } from "./components/DevHud";
import { LoupeStage } from "./components/loupe/LoupeStage";
import { zoomTransition } from "./components/loupe/zoomTransition";

import { recentKey, useRecents, type RecentEntry } from "./hooks/useRecents";
import { useSettings } from "./hooks/useSettings";

import { PERFORMANCE_PROFILES, normalizeRejectedSubfolder } from "./types/settings";
import { runFolderRetry, type TroubleState } from "./image/folderRetry";
import { imageStore } from "./image/imageStore";
import { overlayService } from "./overlays/overlayService";
import { useImage } from "./image/useImage";
import { passesFilter } from "./utils/filter";
import { formatFolderSet, formatRelativeTime } from "./utils/format";
import { basename } from "./utils/path";
import { modGlyph } from "./utils/platform";
import { snapToFilter as snapToFilterPure } from "./utils/snap";
import { afZoomOrigin } from "./utils/zoom";
import { RATING_COLOR } from "./utils/ratingColor";

// Read concurrency, previewKeep, hi-res zoom warm-up, background-fill rate, and
// concurrent XMP restore all live in PERFORMANCE_PROFILES, switched by the
// storage-mode setting and pushed into the imageStore via `setProfile`.
// Memory bounds for 10k-folder sessions are owned by the imageStore: full-res
// blobs (~5–6 MB each) are kept only within `previewKeep` of the cursor and
// revoked outside it, while thumbnails persist for the session under a 15k-entry
// safety LRU. See src/image/imageStore.ts and ARCHITECTURE.md "Read pipeline".
const FEEDBACK_MS = 320;
// Rating-write retry schedule (ms before each retry). A rating that still fails
// after the last attempt is surfaced as "unsaved" rather than silently dropped.
const WRITE_RETRY_DELAYS = [400, 1500, 4000];
const PAN_STEP = 2; // % per arrow press while zoomed
const PAN_LIMIT = 40; // max % offset from the AF point
// Hold-to-navigate cadence. We ignore the OS key auto-repeat (long initial delay,
// uneven rate) and drive stepping ourselves from a rAF loop while the arrow is
// held — one step per this interval, frame-aligned so it never steps faster than
// the display paints (no stutter; self-throttles on a slow frame). ~33ms ≈ 30
// images/s, the fastest that still feels smooth.
const NAV_REPEAT_MS = 33;
/** Staged scrub acceleration: after this long holding, 3 frames per tick… */
const SCRUB_STAGE2_AT_MS = 2000;
/** …and after this long, 10 — long albums stay traversable. */
const SCRUB_STAGE3_AT_MS = 5000;
const SCRUB_SPEEDS = [1, 3, 10] as const;
type ScrubSpeed = (typeof SCRUB_SPEEDS)[number];

// After the immediate first step on hold-start, wait this long before the
// auto-repeat kicks in — so a quick tap moves exactly one image, while a
// sustained hold pauses briefly then ramps into the ~30/s repeat above.
const NAV_HOLD_DELAY_MS = 280;

/** Wait for the layers' 200ms unzoom transform-transition to finish before
 *  re-measuring — a mid-animation getBoundingClientRect returns a scaled box. */
const ZOOM_UNSETTLE_MEASURE_DELAY_MS = 260;

// sizerSrc (the aspect-carrying transparent SVG) moved to utils/sizer.ts —
// shared with LoupeStage and the compare panes.

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
});

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
  // Serialises folder opens: a scan already in flight makes any second open
  // (drag-drop, recents, mount auto-open) a no-op until it settles.
  const openBusyRef = useRef(false);
  // Guards begin-culling against a double-click firing two analyze passes.
  const analyzingRef = useRef(false);
  // Capture-time order from analyze_folder — preserved so sort modes can return.
  const [currentIndex, setCurrentIndex] = useState(0);
  const [ratings, setRatings] = useState<Record<number, Rating>>({});
  const [filter, setFilter] = useState<Filter>("all");
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
  const [confirmHome, setConfirmHome] = useState(false); // Esc → confirm leaving to home
  // Held-arrow fast-scrub. While true we render the cheap thumbnail instead of the
  // full-res preview, so scrub speed isn't bottlenecked by decoding ~6 MP JPEGs
  // per step. Full-res returns the instant the key is released.
  const [scrubbing, setScrubbing] = useState(false);

  // User-tunable settings, persisted to localStorage. Opened with Ctrl+,.
  const [settings, setSettings] = useSettings();
  const [settingsOpen, setSettingsOpen] = useState(false);

  // ── Smart culling (advisory) ──────────────────────────────────────────────
  // The driver owns the chunked, gen-guarded background pass; scores accumulate
  // keyed by Img.id. ALL cross-frame derivation is pure TS below — bursts and
  // verdicts re-derive instantly on settings changes and self-correct as chunks
  // land. Nothing here writes anything, ever (advisory-only invariant).
  // Rated frames need no suggestion: the pass dispatches unrated-only, so it
  // starts from where the user has reached (see useSmartCulling).
  const ratedIds = useMemo(() => {
    const ids = new Set<number>();
    for (const [id, r] of Object.entries(ratings)) if (r) ids.add(Number(id));
    return ids;
  }, [ratings]);
  const {
    scores: qualityScores,
    analyzing: qualityAnalyzing,
    progress: qualityProgress,
    startAnalysis,
  } = useSmartCulling({
    enabled: settings.smartCulling,
    autoStart: settings.smartCullingOnOpen,
    ml: settings.smartCullingML,
    active: phase === "culling",
    images,
    ratedIds,
    storageMode: settings.storageMode,
  });

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

  // EXIF metadata per path. Fed by the imageStore's metadata sink (full-res
  // bundle reads return camera/lens/AF/pixel-dims) and seeded with LrC stars
  // from the analyze pass. Pixel URLs + display dims now live in the store
  // (consumed via useImage); this map holds only the descriptive metadata.
  const [metadata, setMetadata] = useState<Record<string, ImageMetadata>>({});

  // Bursts are a standing fact about the shoot, NOT a smart-culling feature:
  // grouping inputs come from the EXIF metadata every frame's thumbnail
  // already delivered, upgraded in place by scores (which add the mtime
  // fallback and the sharpness that determines a winner) when the pass runs.
  const burstData = useMemo(
    () => buildBurstInputs(images, qualityScores, metadata),
    [images, qualityScores, metadata],
  );
  // Winner candidacy is SMART CULLING's call: a member must clear the active
  // keep threshold to be pickable, and with the feature off nothing wins —
  // burst detection/boxes stay factual, the "best frame" is advisory. Shared
  // between burstCtx and similarCtx so it's computed exactly once.
  const keepEligibleMap = useMemo(() => {
    const eligible: Record<number, boolean> = {};
    if (settings.smartCulling) {
      for (const [idStr, sc] of Object.entries(qualityScores)) {
        eligible[Number(idStr)] = keepEligible(sc, settings.smartCullingConfidence);
      }
    }
    return eligible;
  }, [qualityScores, settings.smartCulling, settings.smartCullingConfidence]);
  const burstCtx = useMemo(
    () => groupBursts(images, burstData.inputs, burstData.sharp, keepEligibleMap),
    [images, burstData, keepEligibleMap],
  );
  // Time-local near-duplicate grouping (spec 3c) — unlike bursts this IS a
  // smart-culling feature (the grouping itself is advisory heuristics, not a
  // camera-clocked fact), so it stays empty with the feature off.
  const similarCtx = useMemo(() => {
    if (!settings.smartCulling) return new Map<number, SimilarCtx>();
    return groupSimilar(images, qualityScores, burstCtx, burstData.sharp, keepEligibleMap);
  }, [images, qualityScores, burstCtx, burstData.sharp, settings.smartCulling, keepEligibleMap]);
  // Only frames with an emitted verdict land in the map — the badge/filter
  // predicate is a simple presence check. Session-capped favorites (spec 3c)
  // overlay a "favorite" verdict onto the top-N standout-aesthetic keeps.
  const suggestions = useMemo(() => {
    if (!settings.smartCulling) return {};
    const out: Record<number, Suggestion> = {};
    for (const [idStr, s] of Object.entries(qualityScores)) {
      const id = Number(idStr);
      const sug = deriveVerdict(s, burstCtx.get(id), similarCtx.get(id), settings.smartCullingConfidence);
      if (sug.verdict) out[id] = sug;
    }
    for (const id of capFavorites(qualityScores, out, settings.smartCullingConfidence)) {
      out[id] = {
        ...out[id],
        verdict: "favorite",
        reasons: ["standout aesthetic", ...out[id].reasons],
      };
    }
    return out;
  }, [qualityScores, burstCtx, similarCtx, settings.smartCulling, settings.smartCullingConfidence]);

  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const feedbackTimer = useRef<number | null>(null);

  // Grid container — shared between GridView (for layout/scroll) and the cols-
  // computing ResizeObserver (defined after visibleIndices, below, so it can
  // also re-run when the grid gains cells — see there).
  const gridContainerRef = useRef<HTMLDivElement>(null);

  // Rating-write durability. Every rating writes an .xmp sidecar; we count writes
  // in flight (savingCount) and remember any that exhausted their retries
  // (failedWrites: path → the rating that didn't land) so we can show them and
  // block a quit that would lose work.
  const [savingCount, setSavingCount] = useState(0);
  // path → the rating that didn't land. `null` = an unrate (clear) that failed,
  // so a stuck unrate is surfaced and guarded just like a stuck rating.
  const [failedWrites, setFailedWrites] = useState<Record<string, Rating | null>>({});
  const [quitGuard, setQuitGuard] = useState(false); // close requested while unsafe
  // Mirrors of the above for the (once-registered) close-request handler, which
  // would otherwise capture stale values.
  const savingRef = useRef(0);
  const failedCountRef = useRef(0);
  const destroyedRef = useRef(false); // window.destroy() must fire at most once
  const quitShownAtRef = useRef(0); // when the quit guard was shown (min-visible floor)
  const failedCount = Object.keys(failedWrites).length;

  const [isZooming, setIsZooming] = useState(false);
  const [zoomLevel, setZoomLevel] = useState<1 | 2>(1); // 1 = 1:1, 2 = 2:1 (Shift+Space)
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  // Live mirror of isZooming so the navigation-reset effect can fire on a cursor
  // move WITHOUT depending on isZooming (which would make it cancel the very zoom
  // a Space-press just started).
  const isZoomingRef = useRef(isZooming);
  useEffect(() => {
    isZoomingRef.current = isZooming;
  }, [isZooming]);

  // Measured rect of the displayed image (relative to the stage). Consumed ONLY
  // by the deferred hi-res zoom layer's transform (so it composites pixel-aligned
  // with the base image) — the analysis overlays align via CSS, not this rect.
  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [imgRect, setImgRect] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const [measureNonce, setMeasureNonce] = useState(0);
  // True when the measure effect last ran with zoom engaged — its next
  // unzoomed run delays past the 200ms transform transition (see the effect).
  const wasZoomingRef = useRef(false);

  // Deferred full-res zoom: the browser rasterizes the on-screen JPEG only at
  // screen-fit size (keeps navigation instant), so zooming GPU-upscales that
  // until it re-decodes — the ~0.2s softness. Once you settle on a frame we mount
  // a second copy rendered at the image's native pixel size, which forces a
  // full-resolution raster, so the zoom composites from already-sharp pixels.
  const [hiRes, setHiRes] = useState(false);
  const hiResTimer = useRef<number | null>(null);

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

  // Latched by the store when several paths reach terminal read-failure (NAS
  // unmounted / sleep-wake): shows the non-blocking "folder unreachable" chip.
  // Full retry-flow state (checking / still / recovered) lives in folderRetry.ts.
  const [folderTrouble, setFolderTrouble] = useState<TroubleState>("hidden");
  // Dev HUD flag, read once at mount: localStorage["cull:devhud"]="1" + reload.
  const [devHudOn] = useState(() => {
    try {
      return localStorage.getItem("cull:devhud") === "1";
    } catch {
      return false;
    }
  });
  // LoupeStage flips its double-buffer → re-measure the (new) front layer.
  const bumpMeasureNonce = useCallback(() => setMeasureNonce((n) => n + 1), []);

  const pan = useCallback((dx: number, dy: number) => {
    setPanOffset((o) => ({
      x: Math.max(-PAN_LIMIT, Math.min(PAN_LIMIT, o.x + dx)),
      y: Math.max(-PAN_LIMIT, Math.min(PAN_LIMIT, o.y + dy)),
    }));
  }, []);

  // Exit zoom: drop the scale and re-center. (zoomLevel is intentionally left
  // as-is — the next Space-press re-sets it.) Centralized so the exit points stay
  // consistent.
  const resetZoom = useCallback(() => {
    setIsZooming(false);
    setPanOffset({ x: 0, y: 0 });
  }, []);

  // Leaving a zoomed frame via a cursor move (strip click, rating-advance) must
  // drop the zoom — otherwise the new image lands scaled to the old pan. Keyboard
  // arrows pan instead of navigating while zoomed, so currentIndex changes here
  // only when we genuinely left the frame. Reads isZoomingRef so it fires on the
  // index change, never on the Space-press that started the zoom.
  useEffect(() => {
    // Leaving a zoomed frame via a cursor move drops the zoom. Reads isZoomingRef
    // (not isZooming) so it fires on the index change, never on the Space-press that
    // started the zoom.
    if (isZoomingRef.current) resetZoom();
  }, [currentIndex, resetZoom]);

  const visibleIndices = useMemo(() => {
    // "suggested" resolves against the live suggestions map: frames with a
    // suggestion that are STILL unrated (rating a frame removes it live).
    if (filter === "suggested") {
      return images
        .map((_, i) => i)
        .filter((i) => !ratings[images[i].id] && suggestions[images[i].id]);
    }
    return images.map((_, i) => i).filter((i) => passesFilter(ratings[images[i].id], filter));
  }, [images, ratings, filter, suggestions]);

  // Memoized: this O(n) indexOf used to run on EVERY render (incl. every
  // ~30 Hz scrub frame); now only when the filter list or cursor actually moves.
  const positionInFilter = useMemo(
    () => visibleIndices.indexOf(currentIndex),
    [visibleIndices, currentIndex],
  );

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
  // read pool, the windowed full-res cache, and blob-URL lifecycle now live in
  // `imageStore` (driven below + consumed by `useImage` in each view). App only
  // feeds it the storage profile, the cursor, the grid viewport, and a metadata
  // sink — and tells it when the folder / session changes.
  // `?? local` is belt-and-suspenders: useSettings now validates storageMode, but
  // a future bug or out-of-range value must never make this undefined (the store
  // would then read .previewKeep/.previewConcurrency off undefined and crash).
  const profile = PERFORMANCE_PROFILES[settings.storageMode] ?? PERFORMANCE_PROFILES.local;

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
  }, []);
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
  }, [phase, compareMode, gridVisible]);
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

  // EXIF metadata sink: the store's full-res bundle reads return the full
  // camera / lens / AF / pixel-dims metadata. The bundle meta replaces the
  // per-path entry (a pre-seeded lrc-only entry must still gain its EXIF),
  // EXCEPT lrcRating: the bundle no longer reads the sidecar per navigation
  // (that cost one NAS round-trip per image — pipeline Phase 0), so the LrC
  // stars exist only in the analyze-pass seed and must be carried forward.
  useEffect(() => {
    imageStore.setMetaSink((path, meta) => {
      setMetadata((m) => {
        const prevLrc = m[path]?.lrcRating ?? null;
        const merged =
          meta.lrcRating == null && prevLrc != null
            ? { ...meta, lrcRating: prevLrc }
            : meta;
        return { ...m, [path]: merged };
      });
    });
    return () => imageStore.setMetaSink(undefined);
  }, []);

  // Cursor → drives the store's full-res keep-window + thumb/bg prioritisation
  // (nearest-first). Follows the challenger in compare, the cursor otherwise.
  useEffect(() => {
    imageStore.setCursor(compareMode ? challengerIndex : currentIndex, scrubbing);
  }, [currentIndex, compareMode, challengerIndex, scrubbing]);

  // Folder-trouble chip: the store latches once when several paths go
  // terminal; any new path-set (re-open / append → reset) clears it.
  useEffect(() => {
    // Mid-probe ("checking"/"still") the retry flow owns the chip — the sink
    // re-latches from anywhere else, including over a brief "reconnected".
    imageStore.setTroubleSink(() =>
      setFolderTrouble((s) => (s === "checking" || s === "still" ? s : "latched")),
    );
    return () => imageStore.setTroubleSink(undefined);
  }, []);
  useEffect(() => {
    setFolderTrouble("hidden");
  }, [images]);

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
  useEffect(() => {
    if (!isZooming) return undefined;
    const p = images[currentIndex]?.path;
    if (!p) return undefined;
    imageStore.pinFull(p);
    imageStore.requestZoomFull(p);
    return () => imageStore.unpinFull(p);
  }, [isZooming, currentIndex, images]);

  // Folder-trouble retry: re-run the scan as a reachability probe on every
  // source folder, then re-arm the store's queues IN PLACE — same session,
  // same cursor, no phase change — so a NAS reconnect self-heals without
  // restarting the app. Still unreachable → the chip re-latches.
  const folderRetryRunning = useRef(false);
  const retryUnreachableFolders = useCallback(async () => {
    // The chip disables itself while checking, but a double-click can land
    // before the "checking" render — hard-guard reentry.
    if (folderRetryRunning.current) return;
    folderRetryRunning.current = true;
    const seen = new Set<string>();
    const folders: string[] = [];
    for (const im of imagesRef.current) {
      if (!seen.has(im.srcFolder)) {
        seen.add(im.srcFolder);
        folders.push(im.srcFolder);
      }
    }
    try {
      await runFolderRetry({
        folders,
        probe: (f) =>
          invoke<string[]>("scan_folder", {
            path: f,
            ignoreSubdir: normalizeRejectedSubfolder(settings.rejectedSubfolder),
          }),
        setState: setFolderTrouble,
        rearm: () => imageStore.rearm(),
      });
    } finally {
      folderRetryRunning.current = false;
    }
  }, [settings.rejectedSubfolder]);

  // Grid viewport range → store background-fill prioritisation (visible cells
  // first). Wired to GridView's onViewportChange.
  const handleGridViewport = useCallback((first: number, last: number) => {
    imageStore.setGridRange(first, last);
  }, []);

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
      const okFolders: string[] = [];
      const failures: ScanFailure[] = [];
      try {
        setPhase("loading");
        for (const folderPath of folders) {
          // Per-folder label so the loading screen tracks the batch as it scans.
          setPendingFolder(folderPath);
          try {
            const paths = (
              await invoke<string[]>("scan_folder", {
                path: folderPath,
                ignoreSubdir: normalizeRejectedSubfolder(settings.rejectedSubfolder),
              })
            ).map((p) => p.normalize("NFC"));

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
    [commitSessionRecent, removeEntry, settings.rejectedSubfolder],
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
  }, [pickerBusy, openFoldersByPaths]);

  // Launch-time auto-open: if the user prefers it and a last folder is
  // remembered, skip the home screen and load it straight away. Runs once on
  // app mount; intentionally NOT triggered every time settings.openLastFolderOnLaunch
  // flips, since that would re-open the folder mid-cull.
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
      openFoldersByPaths(session.paths, { fromRecentKey: recentKey(session.paths) });
    } else {
      openFoldersByPaths([lastDir]);
    }
    // Intentional empty deps — mount-only.
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
    const unlisten = await listen<AnalyzeProgress>("analyze-progress", (e) => setProgress(e.payload));
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
  }, [images, profile.concurrentRestore, settings, writeSessionRecent]);

  // Wipe the multi-selection state — called whenever the user leaves the grid
  // context (site switch, ESC, opening another folder). Cleanly decoupled from
  // resetSession so site-switch handlers don't have to drop the whole cull.
  const clearMultiSelection = useCallback(() => {
    setSelectedIndices((s) => (s.size > 0 ? new Set() : s));
    setSelectionAnchor(null);
  }, []);

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
    // a re-used imgId and durably write the WRONG folder's sidecar. (Refs are
    // stable; declared further down but only read when this callback runs.)
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
  }, [resetZoom]);

  // Leaving to home: refresh the session's recents entry with its final
  // counts, then discard the in-memory session and return to the start screen.
  const leaveToHome = useCallback(() => {
    writeSessionRecent(images, ratings);
    setConfirmHome(false);
    resetSession();
  }, [images, ratings, resetSession, writeSessionRecent]);

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
  const doMoveRejects = useCallback(async () => {
    if (rejectedPaths.length === 0 || actionBusy !== null) return;
    setActionBusy("move");
    setMoveResult(null);
    try {
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
  }, [images, ratings, rejectedPaths, actionBusy, settings.rejectedSubfolder]);

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
  const cur = useImage(
    !gridVisible && !compareMode ? images[currentIndex]?.path ?? "" : "",
    {
      // Only want the full-res ONCE CULLING HAS STARTED. Before that (staged
      // screen) this hook still runs at App scope, and without the phase gate it
      // requested the full at the pre-reset generation; beginCulling's reset() then
      // discarded that load, and since path/wantFull didn't change across the reset
      // the effect never re-fired — so the first frame stayed blurred until you
      // navigated. Gating on phase makes wantFull flip false→true AFTER the reset,
      // re-firing the effect so the first frame loads at the live generation.
      wantFull:
        phase === "culling" &&
        !gridVisible &&
        !compareMode &&
        !!images[currentIndex] &&
        !scrubbing,
    },
  );
  // curReady gates the hi-res zoom warm-up on the CURRENT image's full preview
  // being ready (so an unrelated prefetch landing doesn't reset it).
  const curReady = cur.stage === "full";
  // Phase for the loupe matte shimmer, pinned per image so every shimmer syncs.
  const loupeShimmerDelay = useMemo(() => shimmerPhaseMs(), [currentIndex]);

  // Warm the full-res zoom layer once the cursor rests on a ready frame; reset on
  // every navigation / compare toggle so rapid arrow-through never pays the heavy
  // fetch + native-resolution decode. Since Phase 3 the settle FETCHES the full
  // (the displayed nav tier is the 1620px preview): requestZoomFull pulls the
  // ~10 MB mdat JPEG via the exact-range hint; the layer mounts when it lands
  // (cur.full). fullSettleMs (400 net / 150 local) only charges deliberately-
  // parked frames. Also resets when the thumbnail strip toggles: that resizes
  // the stage, and the deferred layer (positioned from the measured rect)
  // would otherwise linger at the OLD size, overlapping the reflowed base image.
  useEffect(() => {
    setHiRes(false);
    if (hiResTimer.current) clearTimeout(hiResTimer.current);
    if (phase !== "culling" || compareMode || !curReady) return;
    const path = images[currentIndex]?.path;
    hiResTimer.current = window.setTimeout(() => {
      setHiRes(true);
      if (path) {
        // Phase 8: the settled fit view prefers the mid on high-DPI stages —
        // the store re-checks needPx fresh and no-ops below the threshold.
        imageStore.maybeRequestMid(path);
        imageStore.requestZoomFull(path);
      }
    }, profile.fullSettleMs);
    return () => {
      if (hiResTimer.current) clearTimeout(hiResTimer.current);
    };
    // exifVisible included: toggling the info rail resizes the stage too, so the
    // hi-res layer must drop + re-derive at the new rect (same reason as thumbsVisible).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, currentIndex, compareMode, curReady, thumbsVisible, exifVisible, profile.fullSettleMs]);

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

  // Measure the displayed image's rect (relative to the stage) to feed the
  // deferred hi-res zoom layer's transform. A ResizeObserver on the stage
  // re-measures on ANY layout change — window resize AND the image growing /
  // shrinking when the thumbnail strip or info rail toggles — so the hi-res layer
  // never lands at the old size. (The analysis overlays align via CSS, not this.)
  useLayoutEffect(() => {
    if (phase !== "culling") {
      setImgRect(null);
      return;
    }
    if (scrubbing) return; // overlays are hidden mid-scrub; skip measure + RO churn
    // NEVER measure while zoomed: getBoundingClientRect returns the
    // TRANSFORMED (scaled) box, and a preview landing mid-zoom re-fires this
    // effect — the corrupted rect then collapses every zoom factor derived
    // from it (the "zooms back out and breaks" bug from the macOS matrix).
    // imgRect keeps its last-good fit-size value; the isZooming dep re-runs
    // the measure the moment zoom disengages.
    if (isZooming) {
      wasZoomingRef.current = true;
      return;
    }
    // …and when zoom JUST disengaged, the layers are still mid-transition
    // (transform 200ms ease-out back to identity) — measuring immediately
    // captures the animating, still-scaled box (the "unzoom snaps to a huge
    // top-left image" bug). Arm the measure + observer after the transition.
    const justUnzoomed = wasZoomingRef.current;
    wasZoomingRef.current = false;
    const measure = () => {
      const img = imgRef.current;
      const stage = stageRef.current;
      if (!img || !stage) {
        setImgRect(null);
        return;
      }
      const ir = img.getBoundingClientRect();
      const sr = stage.getBoundingClientRect();
      if (ir.width < 1) {
        setImgRect(null);
        return;
      }
      setImgRect({
        left: ir.left - sr.left,
        top: ir.top - sr.top,
        width: ir.width,
        height: ir.height,
      });
    };
    const ro = new ResizeObserver(measure);
    let armTimer: number | null = null;
    const arm = () => {
      measure();
      if (stageRef.current) ro.observe(stageRef.current);
    };
    if (justUnzoomed) armTimer = window.setTimeout(arm, ZOOM_UNSETTLE_MEASURE_DELAY_MS);
    else arm();
    return () => {
      ro.disconnect();
      if (armTimer !== null) clearTimeout(armTimer);
    };
    // cur.stage/cur.dims: the sizer reflows the frame when dims arrive (thumb
    // stage); the RO is on the stage (which doesn't resize), so re-measure here.
    // images.length (not the array ref) so a folder append doesn't needlessly
    // tear down + rebuild the observer when the displayed frame is unchanged.
  }, [phase, images.length, currentIndex, measureNonce, scrubbing, isZooming, cur.stage, cur.dims]);

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

  const flashFeedback = useCallback((rating: Rating, imageId: number) => {
    setFeedback({ rating, imageId, ts: Date.now() });
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    feedbackTimer.current = window.setTimeout(() => setFeedback(null), FEEDBACK_MS);
  }, []);

  // Durably write a rating's .xmp sidecar. Retries on failure (NAS blips happen),
  // and if every attempt fails the path is recorded in failedWrites so the UI can
  // flag it and the quit guard can refuse to lose it. The backend write is
  // idempotent, so retries (and a later rating superseding this one) are safe.
  // `rating === null` clears the rating (unrate) via clear_xmp_rating; otherwise
  // it writes the rating. Both go through the same retry + failure tracking.
  // Per-path serial write queue: each new persistRating chains after the prior
  // write to the SAME path, so an Undo immediately after a rate can never lose
  // the race with the original write (which used to fire-and-forget). Different
  // paths still run in parallel (subject to backend bounds).
  const writeQueue = useRef<Map<string, Promise<unknown>>>(new Map());
  // Monotonic per-path write sequence. A write only owns the failed/saved verdict
  // for a path while it's still the LATEST write to that path — otherwise an
  // older write that exhausts its retries AFTER a newer write already succeeded
  // would re-stamp a phantom "unsaved" failure (and falsely block quit).
  const writeSeq = useRef<Map<string, number>>(new Map());

  const persistRating = useCallback((path: string, rating: Rating | null) => {
    const seq = (writeSeq.current.get(path) ?? 0) + 1;
    writeSeq.current.set(path, seq);
    const isLatest = () => writeSeq.current.get(path) === seq;

    // A fresh write/clear for this path supersedes any earlier failure.
    setFailedWrites((f) => {
      if (!(path in f)) return f;
      const next = { ...f };
      delete next[path];
      failedCountRef.current = Object.keys(next).length;
      return next;
    });
    setSavingCount((c) => c + 1);
    savingRef.current += 1; // synchronous: the close guard reads this, not lagged state
    const cmd = rating === null ? "clear_xmp_rating" : "write_xmp_rating";
    const args = rating === null ? { path } : { path, rating };

    // tryWrite returns a promise that resolves on success, rejects only after
    // every retry slot has been exhausted — so the queue holds the next write
    // until ALL retries of this one have finished.
    const tryWrite = (n: number): Promise<unknown> =>
      invoke(cmd, args).catch((e) => {
        if (n < WRITE_RETRY_DELAYS.length) {
          return new Promise((resolve, reject) =>
            window.setTimeout(() => tryWrite(n + 1).then(resolve, reject), WRITE_RETRY_DELAYS[n]),
          );
        }
        throw e;
      });

    const prev = writeQueue.current.get(path) ?? Promise.resolve();
    const next = prev.then(() => tryWrite(0), () => tryWrite(0)).finally(() => {
      if (writeQueue.current.get(path) === next) writeQueue.current.delete(path);
    });
    writeQueue.current.set(path, next);

    next.then(
      () => {
        setSavingCount((c) => c - 1);
        savingRef.current -= 1;
      },
      (e) => {
        setSavingCount((c) => c - 1);
        savingRef.current -= 1;
        // Only the latest write to this path may stamp a failure; a superseded
        // older write failing must not resurrect an "unsaved" flag the newer
        // (successful) write already cleared.
        if (isLatest()) {
          console.error(`${cmd} failed permanently`, path, e);
          setFailedWrites((f) => {
            const next = { ...f, [path]: rating };
            failedCountRef.current = Object.keys(next).length;
            return next;
          });
        }
      },
    );
  }, []);

  // Re-attempt every rating that exhausted its retries (triggered from the unsaved
  // indicator or the quit guard).
  const retryFailed = useCallback(() => {
    Object.entries(failedWrites).forEach(([path, rating]) => persistRating(path, rating));
  }, [failedWrites, persistRating]);

  // savingRef / failedCountRef are maintained SYNCHRONOUSLY inside persistRating
  // (above) rather than via a passive effect, so the once-registered close handler
  // can never read a stale zero in the commit-lag window right after a rating
  // keystroke — which would otherwise let the window close with a write in flight.

  // Quit guard: never let the window close while a rating is still saving or has
  // failed to save. Registered once; reads live state via refs. "cancel and warn"
  // = cancel the CLOSE, never the write.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    getCurrentWindow()
      .onCloseRequested((event) => {
        if (savingRef.current > 0 || failedCountRef.current > 0) {
          event.preventDefault();
          quitShownAtRef.current = performance.now();
          setQuitGuard(true);
        }
      })
      .then((u) => {
        unlisten = u;
      });
    return () => unlisten?.();
  }, []);

  // ── Drag-and-drop: drop folders anywhere to open them ────────────────────
  // Hover the window with folders → render the champagne dashed overlay on
  // the home screen (the home content dims behind it). Drop → every dropped
  // folder is scanned and staged together. Drops are ignored while the cull
  // view is active (replacing the staged set mid-cull would lose state).
  // openFoldersByPaths is captured fresh each render; we mirror it into a ref
  // so the once-registered drag-drop listener uses the latest closure without
  // unsubscribing and re-subscribing on every render (which would race with
  // active drag events).
  const [isDragOver, setIsDragOver] = useState(false);
  const phaseRef = useRef(phase);
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);
  const openFoldersByPathsRef = useRef(openFoldersByPaths);
  useEffect(() => {
    openFoldersByPathsRef.current = openFoldersByPaths;
  }, [openFoldersByPaths]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    getCurrentWindow()
      .onDragDropEvent((event) => {
        const p = event.payload;
        // Only react when the user is on a chrome screen (start/loading/etc).
        // During an active cull we ignore drop events outright so a stray drop
        // can't kill the in-progress session.
        // Ignore drops while a cull is active OR a scan/analyze is in flight —
        // appending then would race the in-flight staging / begin-culling.
        if (
          phaseRef.current === "culling" ||
          phaseRef.current === "loading" ||
          phaseRef.current === "analyzing"
        ) {
          if (p.type === "enter" || p.type === "over") setIsDragOver(false);
          return;
        }
        if (p.type === "enter" || p.type === "over") {
          setIsDragOver(true);
        } else if (p.type === "leave") {
          setIsDragOver(false);
        } else if (p.type === "drop") {
          setIsDragOver(false);
          const dropped = (p.paths ?? []).filter(
            (path): path is string => typeof path === "string" && path.length > 0,
          );
          if (dropped.length > 0) {
            // Best-effort: stage every dropped folder in one batch; if a path
            // is a file (not a folder), Rust's scan_folder will error and we'll
            // surface that as a scan error via the regular failure path.
            openFoldersByPathsRef.current(dropped);
          }
        }
      })
      .then((u) => {
        unlisten = u;
      });
    return () => unlisten?.();
  }, []);

  // Once a guarded close has flushed everything, finish closing automatically.
  // destroyedRef makes destroy() fire at most once (a stray re-trigger during the
  // async teardown would otherwise reject); .catch swallows the unhandled rejection.
  useEffect(() => {
    if (!(quitGuard && savingCount === 0 && failedCount === 0 && !destroyedRef.current)) return;
    // Keep the guard on screen a beat even if the write finished in the same tick
    // it appeared — otherwise destroy() fires on the overlay's first painted frame
    // and the user never sees the "saving…" panel.
    const elapsed = performance.now() - quitShownAtRef.current;
    const t = window.setTimeout(() => {
      if (destroyedRef.current) return;
      destroyedRef.current = true;
      getCurrentWindow().destroy().catch(() => {});
    }, Math.max(0, 350 - elapsed));
    return () => window.clearTimeout(t);
  }, [quitGuard, savingCount, failedCount]);

  // ── Undo / redo of rating actions ────────────────────────────────────────
  // Each action is a list of per-image changes so compound actions (champion
  // wins/loses) revert atomically. Refs because the stacks themselves don't
  // drive any render — only the rating writes they replay do.
  const undoStack = useRef<UndoAction[]>([]);
  const redoStack = useRef<UndoAction[]>([]);
  const HISTORY_LIMIT = 100;

  const recordAction = useCallback((action: UndoAction) => {
    if (action.changes.length === 0) return;
    undoStack.current.push(action);
    if (undoStack.current.length > HISTORY_LIMIT) undoStack.current.shift();
    redoStack.current = []; // a new action invalidates the redo branch
  }, []);

  // Apply a list of {id → rating} changes to state + durable XMP in one shot.
  const applyChanges = useCallback(
    (changes: { imgId: number; path: string; rating: Rating | undefined }[]) => {
      setRatings((prev) => {
        const next = { ...prev };
        for (const c of changes) {
          if (c.rating === undefined) delete next[c.imgId];
          else next[c.imgId] = c.rating;
        }
        return next;
      });
      for (const c of changes) persistRating(c.path, c.rating ?? null);
    },
    [persistRating],
  );

  const undo = useCallback(() => {
    const action = undoStack.current.pop();
    if (!action) return;
    applyChanges(action.changes.map((c) => ({ imgId: c.imgId, path: c.path, rating: c.before })));
    // Restore the compare cursor for compound actions so Ctrl+Z lands you in the
    // SAME pair you were judging (champion/challenger), not stranded somewhere else.
    if (action.cursorBefore) {
      setCompareMode(action.cursorBefore.compareMode);
      // Sites are mutually exclusive — when undo restores compare-mode, peel
      // grid so we don't end up rendering compare with grid lingering behind.
      if (action.cursorBefore.compareMode) setGridVisible(false);
      setChampionIndex(action.cursorBefore.championIndex);
      setChallengerIndex(action.cursorBefore.challengerIndex);
      setCurrentIndex(action.cursorBefore.currentIndex);
      // Restore the nav back-stack snapshot too, so ESC after this undo pops the
      // entry the user actually came from (the action's auto-exit may have popped
      // it, leaving the live stack out of sync with the restored compare view).
      if (action.cursorBefore.navStack) setNavStack(action.cursorBefore.navStack);
    } else if (!compareMode) {
      // For a compound (compare) action, changes[0] is the OLD champion that got
      // rejected; the frame the user actually cares about is the crowned/kept
      // one — the LAST change. (Identical to changes[0] for single-change actions.)
      const landId = action.changes[action.changes.length - 1].imgId;
      const idx = images.findIndex((im) => im.id === landId);
      if (idx !== -1) setCurrentIndex(idx);
    }
    redoStack.current.push(action);
  }, [applyChanges, compareMode, images]);

  const redo = useCallback(() => {
    const action = redoStack.current.pop();
    if (!action) return;
    applyChanges(action.changes.map((c) => ({ imgId: c.imgId, path: c.path, rating: c.after })));
    // Compound compare actions snapshot where the crown LANDS (cursorAfter) so a
    // redo re-crowns the NEW champion instead of leaving the old (now-rejected)
    // one in the compare pane. Single-frame rates have no cursorAfter: land on the
    // crowned/kept frame (last change) in the loupe, as before.
    if (action.cursorAfter) {
      setCompareMode(action.cursorAfter.compareMode);
      if (action.cursorAfter.compareMode) setGridVisible(false);
      setChampionIndex(action.cursorAfter.championIndex);
      setChallengerIndex(action.cursorAfter.challengerIndex);
      setCurrentIndex(action.cursorAfter.currentIndex);
    } else if (!compareMode) {
      const landId = action.changes[action.changes.length - 1].imgId;
      const idx = images.findIndex((im) => im.id === landId);
      if (idx !== -1) setCurrentIndex(idx);
    }
    undoStack.current.push(action);
  }, [applyChanges, compareMode, images]);

  const applyRating = useCallback(
    (rating: Rating) => {
      // Selection branch: any non-empty grid selection rates the SELECTED SET
      // (one undo entry, sidecars in parallel), so the rating always lands on the
      // tinted cells — never the cursor (which can diverge after a ctrl-toggle).
      // No auto-advance — the user is acting on a set. Intersect with the active
      // filter so a rating never hits a selected frame that's filtered out /
      // off-screen (matches the single-frame branch's pos===-1 guard below).
      if (gridVisible && selectedIndices.size >= 1) {
        const visibleSet = new Set(visibleIndices);
        const changes = Array.from(selectedIndices)
          .filter((idx) => visibleSet.has(idx))
          .map((idx) => images[idx])
          .filter((im): im is Img => Boolean(im))
          .map((im) => ({
            imgId: im.id,
            path: im.path,
            before: ratings[im.id],
            after: rating,
          }))
          // Skip cells already at this rating — no redundant write, no dead
          // before===after entry in the action (mirrors unrateCurrent's guard).
          .filter((c) => c.before !== c.after);
        if (changes.length === 0) return;
        recordAction({ changes });
        setRatings((prev) => {
          const next = { ...prev };
          for (const c of changes) next[c.imgId] = c.after;
          return next;
        });
        for (const c of changes) persistRating(c.path, c.after);
        // Feedback flashes once on the current cell so the user sees confirmation
        // without N popping circles. (Grid doesn't render the feedback overlay
        // per-cell anyway — it's a single center burst.)
        const cur = images[currentIndex];
        if (cur) flashFeedback(rating, cur.id);
        return;
      }

      const cur = images[currentIndex];
      if (!cur) return;
      const pos = visibleIndices.indexOf(currentIndex);
      // In grid, the cursor can fall outside the active filter (e.g. the last
      // matching frame was just rated away, emptying the filter). There's then no
      // visible cell to act on, so ignore the rating key rather than rate a stale,
      // off-screen frame. Loupe/compare always display `cur`, so they're unaffected.
      if (gridVisible && pos === -1) return;
      const nextTarget =
        pos !== -1 && pos + 1 < visibleIndices.length ? visibleIndices[pos + 1] : null;
      const nextImg = nextTarget !== null ? images[nextTarget] : null;
      // (Rating is blocked while zoomed — see the keymap — so zoom is never active
      // here and the next frame can't inherit it.)
      // Flash the verdict on the INCOMING frame's id: the full-frame wash is keyed
      // to the current frame, which the advance below makes nextImg, so keying it to
      // the outgoing cur.id meant the wash was wiped the instant we advanced.
      const flashId = (nextImg ?? cur).id;

      // Re-pressing the same verdict on an already-rated frame changes nothing on
      // disk or in state: skip the redundant sidecar write (an fsync round-trip on
      // the NAS) and the dead before===after undo entry (which would also wipe a
      // pending redo). Still flash + advance so the keyboard-fast flow is unchanged.
      if (ratings[cur.id] === rating) {
        flashFeedback(rating, flashId);
        if (nextTarget !== null) setCurrentIndex(nextTarget);
        return;
      }

      recordAction({
        changes: [{ imgId: cur.id, path: cur.path, before: ratings[cur.id], after: rating }],
      });
      setRatings((prev) => ({ ...prev, [cur.id]: rating }));
      flashFeedback(rating, flashId);
      persistRating(cur.path, rating); // durable write with retry + failure tracking

      if (nextTarget !== null) setCurrentIndex(nextTarget);
    },
    [
      gridVisible,
      selectedIndices,
      images,
      currentIndex,
      visibleIndices,
      ratings,
      flashFeedback,
      persistRating,
      recordAction,
    ],
  );

  // Unrate (u): clear the current frame's rating and delete the rating data we
  // wrote. A correction, not a verdict — stay on the frame (don't advance). No-op
  // if it's already unrated, so we never touch a sidecar for nothing.
  // In grid with a non-empty selection, clears every selected frame's rating
  // (skipping already-unrated ones so the undo stack only carries real reverts),
  // intersected with the active filter so it never touches an off-screen frame.
  const unrateCurrent = useCallback(() => {
    if (gridVisible && selectedIndices.size >= 1) {
      const visibleSet = new Set(visibleIndices);
      const changes = Array.from(selectedIndices)
        .filter((idx) => visibleSet.has(idx))
        .map((idx) => images[idx])
        .filter((im): im is Img => Boolean(im) && ratings[im.id] !== undefined)
        .map((im) => ({
          imgId: im.id,
          path: im.path,
          before: ratings[im.id],
          after: undefined as Rating | undefined,
        }));
      if (changes.length === 0) return;
      recordAction({ changes });
      setRatings((prev) => {
        const next = { ...prev };
        for (const c of changes) delete next[c.imgId];
        return next;
      });
      for (const c of changes) persistRating(c.path, null);
      return;
    }

    const cur = images[currentIndex];
    if (!cur || !ratings[cur.id]) return;
    recordAction({
      changes: [{ imgId: cur.id, path: cur.path, before: ratings[cur.id], after: undefined }],
    });
    setRatings((prev) => {
      const next = { ...prev };
      delete next[cur.id];
      return next;
    });
    persistRating(cur.path, null); // durable clear (delete sidecar / strip rating)
  }, [
    gridVisible,
    selectedIndices,
    visibleIndices,
    images,
    currentIndex,
    ratings,
    persistRating,
    recordAction,
  ]);

  // ── Site navigation: loupe / compare / grid ───────────────────────────────
  // Sites are mutually exclusive — only one renders at a time. L/C/G switch
  // sites and push the previous one onto a back-stack; ESC pops the stack.
  // Pressing the current site's key is a no-op (you can only leave via another
  // site key or ESC). Compare entries snapshot the champion/challenger so ESC
  // back into compare restores the same pair.

  // Snap an image index to the nearest member of the current visible filter,
  // so a frame the filter no longer admits (e.g. a freshly-kept image while
  // filtered to UNRATED) doesn't leave loupe/grid with no current cell.
  // Pure logic + its tests live in utils/snap; this just binds the live deps.
  const snapToFilter = useCallback(
    (idx: number): number => snapToFilterPure(idx, visibleIndices, images.length),
    [images.length, visibleIndices],
  );

  // Resolve a saved compare snapshot's challenger. If the saved one was rated
  // since (so it's no longer eligible), advance to the next unrated. Returns
  // -1 if no unrated remains anywhere (snapshot is unrestorable).
  const reviveChallenger = useCallback(
    (champ: number, savedChall: number): number => {
      if (
        savedChall >= 0 &&
        savedChall < images.length &&
        savedChall !== champ &&
        !ratings[images[savedChall].id]
      ) {
        return savedChall;
      }
      return nearestUnrated(champ, ratings, champ);
    },
    [images, ratings, nearestUnrated],
  );

  // Build a NavEntry for the SITE WE'RE LEAVING — compare snapshots its pair
  // so ESC back can restore it.
  const buildNavEntry = useCallback(
    (from: NavSite): NavEntry =>
      from === "compare"
        ? { site: "compare", champ: championIndex, chall: challengerIndex }
        : { site: from },
    [championIndex, challengerIndex],
  );

  // L/C/G entry point. Pressing the current site's key is a no-op (you can
  // only switch by pressing one of the OTHER site keys, or pop with ESC).
  const goToSite = useCallback(
    (target: NavSite) => {
      const current: NavSite = compareMode ? "compare" : gridVisible ? "grid" : "loupe";
      if (target === current) return;

      // Entering compare needs an eligible challenger; bail (without pushing
      // a stack entry) if there isn't one, so the back-stack stays meaningful.
      if (target === "compare") {
        const champ = currentIndex;
        if (!images[champ]) return;
        // Don't pin a rejected frame as champion — goBack's compare-restore
        // refuses to reseat a reject champion, so allowing it on entry would be
        // inconsistent (and would re-reject it as a no-op on the next Enter).
        if (ratings[images[champ].id] === "reject") return;
        const firstChall = nearestUnrated(champ, ratings, champ);
        if (firstChall === -1) return;
        setNavStack((s) => [...s, buildNavEntry(current)]);
        setChampionIndex(champ);
        setChallengerIndex(firstChall);
        setCompareMode(true);
        setGridVisible(false);
        resetZoom();
        return;
      }

      // Leaving compare → land the cursor on the champion (the latest pick).
      if (current === "compare") {
        setCurrentIndex(snapToFilter(championIndex));
      }
      setNavStack((s) => [...s, buildNavEntry(current)]);
      setCompareMode(false);
      setGridVisible(target === "grid");
      resetZoom();
    },
    [
      compareMode,
      gridVisible,
      currentIndex,
      championIndex,
      images,
      ratings,
      nearestUnrated,
      buildNavEntry,
      snapToFilter,
      resetZoom,
    ],
  );

  // ESC. Pop one nav entry and navigate back. Empty stack at loupe → home
  // confirm (the only "site above loupe" is leaving the cull entirely). Empty
  // stack at compare/grid (shouldn't normally happen, but defends against
  // edge cases) falls back to loupe.
  const goBack = useCallback((landIndex?: number) => {
    // ESC in grid with a multi-selection clears the selection first, instead
    // of popping the nav stack. The user almost certainly wants "deselect"
    // before "go back", so we make the cheap intent succeed first.
    if (gridVisible && selectedIndices.size > 0) {
      clearMultiSelection();
      return;
    }
    // When leaving compare, land on the caller's explicit index if provided (e.g.
    // the freshly-crowned champion), else the current champion. The closure's
    // championIndex alone can be stale (the just-rejected frame) on auto-exit.
    const compareLanding = () =>
      setCurrentIndex(snapToFilter(landIndex != null ? landIndex : championIndex));
    if (navStack.length === 0) {
      if (compareMode || gridVisible) {
        if (compareMode) compareLanding();
        setCompareMode(false);
        setGridVisible(false);
        resetZoom();
      } else {
        setConfirmHome(true);
      }
      return;
    }

    const entry = navStack[navStack.length - 1];
    setNavStack((s) => s.slice(0, -1));

    // Leaving compare? Land on the explicit/champion landing.
    if (compareMode) compareLanding();

    if (entry.site === "compare") {
      // Only restore the saved pair if its champion is still a sensible keeper.
      // If it was rejected since the entry was saved (lost a later compare, or was
      // re-rated/undone), don't reseat a reject in the champion slot — fall through
      // to loupe at the latest champion.
      const champImg = images[entry.champ];
      const champValid = champImg && ratings[champImg.id] !== "reject";
      const chall = champValid ? reviveChallenger(entry.champ, entry.chall) : -1;
      if (chall === -1) {
        // Saved compare is unrestorable (champion no longer a keeper, or no
        // unrated challenger remains) — fall through to loupe at the latest champion.
        setCompareMode(false);
        setGridVisible(false);
      } else {
        setChampionIndex(entry.champ);
        setChallengerIndex(chall);
        setCompareMode(true);
        setGridVisible(false);
      }
    } else {
      setCompareMode(false);
      setGridVisible(entry.site === "grid");
    }
    resetZoom();
  }, [
    navStack,
    compareMode,
    gridVisible,
    championIndex,
    snapToFilter,
    reviveChallenger,
    selectedIndices,
    clearMultiSelection,
    images,
    ratings,
    resetZoom,
  ]);

  // ← / → → move the challenger to the next/previous unrated frame (champion skipped).
  const cycleChallenger = useCallback(
    (dir: 1 | -1, step = 1): boolean => {
      // Walk up to `step` unrated frames in ONE call: accelerated scrub can't
      // loop the single-step version — it reads this render's challengerIndex,
      // so repeated calls in one tick recompute the same target.
      let cur = challengerIndex;
      let landed = -1;
      for (let k = 0; k < step; k++) {
        const next = findUnrated(cur, dir, ratings, championIndex);
        if (next === -1) break;
        landed = next;
        cur = next;
      }
      if (landed !== -1) {
        setChallengerIndex(landed);
        return true;
      }
      return false; // no more unrated in this direction
    },
    [challengerIndex, championIndex, ratings, findUnrated],
  );

  // Backspace → challenger loses (Reject); champion stays; advance to next unrated.
  const challengerLoses = useCallback(() => {
    const challImg = images[challengerIndex];
    if (!challImg) return;
    const next: Record<number, Rating> = { ...ratings, [challImg.id]: "reject" };
    const nextChallenger = nearestUnrated(challengerIndex, next, championIndex);
    const exiting = nextChallenger === -1;
    recordAction({
      changes: [
        { imgId: challImg.id, path: challImg.path, before: ratings[challImg.id], after: "reject" },
      ],
      cursorBefore: {
        compareMode: true,
        championIndex,
        challengerIndex,
        currentIndex,
        navStack: [...navStackRef.current],
      },
      // Champion is unchanged; redo just lands on the next challenger (or leaves
      // compare on the last-frame auto-exit, landing on the champion).
      cursorAfter: exiting
        ? { compareMode: false, championIndex, challengerIndex, currentIndex: championIndex }
        : { compareMode: true, championIndex, challengerIndex: nextChallenger, currentIndex },
    });
    flashFeedback("reject", challImg.id);
    persistRating(challImg.path, "reject");
    setRatings(next);
    if (exiting) {
      // No more candidates — pop back to whichever site we came from, landing on
      // the (unchanged) champion. ESC after this lands further up the stack.
      goBack(championIndex);
    } else {
      setChallengerIndex(nextChallenger);
    }
  }, [
    challengerIndex,
    championIndex,
    images,
    ratings,
    flashFeedback,
    persistRating,
    nearestUnrated,
    goBack,
    recordAction,
  ]);

  // Enter → challenger wins: promoted to Champion (Keep); old champion → Reject.
  const challengerWins = useCallback(() => {
    const champImg = images[championIndex];
    const challImg = images[challengerIndex];
    if (!champImg || !challImg) return;
    const next: Record<number, Rating> = {
      ...ratings,
      [champImg.id]: "reject",
      [challImg.id]: "keep",
    };
    const newChamp = challengerIndex;
    const nextChallenger = nearestUnrated(newChamp, next, newChamp);
    const exiting = nextChallenger === -1;
    recordAction({
      changes: [
        { imgId: champImg.id, path: champImg.path, before: ratings[champImg.id], after: "reject" },
        { imgId: challImg.id, path: challImg.path, before: ratings[challImg.id], after: "keep" },
      ],
      cursorBefore: {
        compareMode: true,
        championIndex,
        challengerIndex,
        currentIndex,
        navStack: [...navStackRef.current],
      },
      // Where the crown lands, so a redo re-crowns the new champion (not the
      // just-rejected old one). On the last-frame auto-exit we leave compare.
      cursorAfter: exiting
        ? { compareMode: false, championIndex: newChamp, challengerIndex, currentIndex: newChamp }
        : { compareMode: true, championIndex: newChamp, challengerIndex: nextChallenger, currentIndex },
    });
    flashFeedback("keep", challImg.id);
    persistRating(champImg.path, "reject"); // dethroned
    persistRating(challImg.path, "keep"); // crowned
    setRatings(next);
    setChampionIndex(newChamp);
    if (exiting) {
      // Crowned the last unrated frame — pop back to where the user came from,
      // landing on the new keeper. Pass newChamp explicitly: goBack's own closure
      // still holds the OLD (just-rejected) champion. (Auto-exit, like ESC.)
      goBack(newChamp);
    } else {
      setChallengerIndex(nextChallenger);
    }
  }, [
    championIndex,
    challengerIndex,
    images,
    ratings,
    flashFeedback,
    persistRating,
    nearestUnrated,
    goBack,
    recordAction,
  ]);

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
        const speed: ScrubSpeed =
          held >= SCRUB_STAGE3_AT_MS ? 10 : held >= SCRUB_STAGE2_AT_MS ? 3 : 1;
        if (speed !== scrubSpeedRef.current) {
          scrubSpeedRef.current = speed;
          setScrubSpeed(speed);
        }
        // ONE call with step=speed: advance/cycleChallenger read this render's
        // position, so calling them repeatedly within a tick would recompute
        // the same target `speed` times and move a single frame (the "50× that
        // scrubbed at 1×" bug). Both walk `step` frames internally instead.
        const moved = navStepRef.current(heldDirRef.current as 1 | -1, speed);
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

  // Stop a held scrub if the key-release is missed (window blur) and on unmount.
  // Also clear the Space-held flag so a lost Space keyup can't wedge zoom off.
  useEffect(() => {
    const onBlur = () => {
      stopHold();
      resetZoom(); // focus lost mid-hold (e.g. Alt+Tab) → exit zoom
    };
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("blur", onBlur);
      stopHold();
    };
  }, [stopHold, resetZoom]);

  // Safety net: if Settings opens while a hold-scrub is active — by keyboard
  // (Ctrl+,, which returns before the keydown handler's stopHold guard) OR by
  // clicking the home-screen gear mid-hold — stop the rAF loop so it can't keep
  // advancing the cursor behind the modal.
  useEffect(() => {
    if (settingsOpen) stopHold();
  }, [settingsOpen, stopHold]);

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
    [stopHold],
  );
  const pickChallengerFromStrip = useCallback(
    (index: number) => {
      if (isZoomingRef.current) return; // disabled while zoomed (see pickFromStrip)
      if (heldDirRef.current !== 0 || scrubbingRef.current) stopHold();
      setChallengerIndex(index);
    },
    [stopHold],
  );

  // Grid cell click — stable identity so GridView/GridCell memoization holds and
  // only the changed cell re-renders. (The old inline closure was a fresh
  // function on every App render, so every visible grid cell re-rendered on any
  // unrelated state change — e.g. the save-pill counter ticking.) Three modes:
  // shift-extend, ctrl-toggle, plain click → open in loupe.
  const handleGridPick = useCallback(
    (i: number, modifiers: { shift: boolean; ctrl: boolean }) => {
      if (modifiers.shift) {
        const anchor = selectionAnchor ?? i;
        const a = visibleIndices.indexOf(anchor);
        const b = visibleIndices.indexOf(i);
        let next: Set<number>;
        if (a === -1 || b === -1) {
          // Anchor fell out of the filter — reseat it on the clicked cell so the
          // NEXT shift-click extends from a valid in-filter anchor instead of
          // collapsing to a single cell again.
          next = new Set([i]);
          setSelectionAnchor(i);
        } else {
          const [lo, hi] = a < b ? [a, b] : [b, a];
          next = new Set();
          for (let k = lo; k <= hi; k++) next.add(visibleIndices[k]);
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
    [visibleIndices, selectionAnchor, selectedIndices, clearMultiSelection, goToSite],
  );

  // Chrome-screen keyboard, phase-agnostic (settings can be opened before a
  // folder is picked, to set the storage mode). Kept separate from the big cull
  // keymap so these few shortcuts don't ride its ~25-dependency re-subscription.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Settings modal owns the keyboard while open: Esc closes, nothing else.
      if (settingsOpen) {
        if (e.key === "Escape") {
          e.preventDefault();
          setSettingsOpen(false);
        }
        return;
      }
      // Ctrl/Cmd+, → settings. `e.code` fallback covers non-US layouts where the
      // comma key reports a different `e.key`.
      if ((e.ctrlKey || e.metaKey) && (e.key === "," || e.code === "Comma")) {
        e.preventDefault();
        setSettingsOpen(true);
        return;
      }
      // Ctrl/Cmd+O → open a folder, from the home or staged screens (matches the
      // "⌃ O" hint on the open button).
      if (
        (e.ctrlKey || e.metaKey) &&
        (e.key === "o" || e.code === "KeyO") &&
        (phase === "start" || phase === "staged")
      ) {
        e.preventDefault();
        pickFolder();
        return;
      }
      // Enter on the staged screen → begin culling (mirrors the primary button).
      // With 0 images staged the primary button is "open folders" instead —
      // leave Enter alone there so a focused button still activates.
      if (phase === "staged" && e.key === "Enter" && images.length > 0) {
        e.preventDefault();
        beginCulling();
        return;
      }
      // Esc on the staged screen → discard the staged set and return Home, so
      // a mis-picked batch can just be retried. No confirm needed: nothing is
      // rated before the analyze pass, so there's no work to lose — and since
      // recents are only written once culling begins, an abandoned staging
      // leaves no entry behind.
      if (phase === "staged" && e.key === "Escape") {
        e.preventDefault();
        resetSession();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [settingsOpen, phase, pickFolder, beginCulling, images.length, resetSession]);

  // The cull keymap closures capture currentIndex/ratings/etc., so they rebuild on
  // every nav step + rating. Dispatch through a ref and register the window
  // listeners once, so the scrub hot path doesn't churn add/removeEventListener.
  const cullKeyRef = useRef<{
    onKey: (e: KeyboardEvent) => void;
    onKeyUp: (e: KeyboardEvent) => void;
  }>({ onKey: () => {}, onKeyUp: () => {} });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Chrome shortcuts (settings, open folder, begin culling) are handled by
      // the phase-agnostic effect above. While the settings modal is open,
      // swallow all cull keys here so nothing slips through behind it.
      if (settingsOpen) return;
      // The quit-guard overlay owns the keyboard while it's up: Esc = keep culling
      // (dismiss), everything else is swallowed so a rating/undo can't be enqueued
      // behind a "we're closing" modal or race the auto-close-after-flush.
      if (quitGuard) {
        if (e.key === "Escape") {
          e.preventDefault();
          setQuitGuard(false);
        }
        return;
      }
      if (phase !== "culling") return; // chrome screens are button-driven

      // Bare modifier presses (Ctrl/Shift/Alt/Meta alone) carry no cull action —
      // make them a no-op so e.g. tapping Shift mid-scrub doesn't abort the hold.
      if (e.key === "Control" || e.key === "Shift" || e.key === "Alt" || e.key === "Meta") return;

      // A held scrub is sustained ONLY by its own arrow key. Any OTHER key (zoom,
      // rating, help, esc, compare, digits…) interrupts it, so nothing keeps
      // scrubbing behind a modal. The opposite arrow is handled in the arrow cases
      // below — it's ignored entirely (can't redirect or stop the flow).
      const isNavArrow = e.key === "ArrowLeft" || e.key === "ArrowRight";
      if (heldDirRef.current !== 0 && !isNavArrow) stopHold();

      // Leave-to-home confirm owns the keyboard while it's up: Enter leaves, Esc
      // stays. Swallow everything else so no rating slips through behind it.
      if (confirmHome) {
        if (e.key === "Enter") {
          e.preventDefault();
          leaveToHome();
        } else if (e.key === "Escape") {
          e.preventDefault();
          setConfirmHome(false);
        }
        return;
      }

      // Act-on-cull dialog owns the keyboard while it's up: Esc closes; other
      // keys are swallowed so nothing slips through behind it.
      if (actionsOpen) {
        if (e.key === "Escape") {
          e.preventDefault();
          setActionsOpen(false);
        }
        return;
      }

      // Undo / redo, works in both single and compare. Compound actions
      // (challenger wins/loses) revert as one Ctrl+Z.
      if ((e.ctrlKey || e.metaKey) && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === "y" || e.key === "Y")) {
        e.preventDefault();
        redo();
        return;
      }

      // Ctrl+E → act-on-cull dialog (move rejects / copy keeps).
      if ((e.ctrlKey || e.metaKey) && (e.key === "e" || e.key === "E")) {
        e.preventDefault();
        openActions();
        return;
      }

      // Tab (hold) → keyboard help. Available in both single and compare.
      if (e.key === "Tab") {
        e.preventDefault();
        if (!e.repeat) setHelpVisible(true);
        return;
      }
      if (helpVisible) return; // swallow everything else while the help is up

      // Drop any other Ctrl/Meta/Alt combination — the explicit Ctrl combos
      // we support (Z / Y / E) returned above. This stops muscle-memory OS
      // shortcuts (Ctrl+S save, Ctrl+L address bar, Ctrl+F find, Alt+F menu)
      // from accidentally cycling sort, switching to loupe, marking favorite,
      // etc. Shift modifiers still pass through (Shift+Space = 2:1 zoom,
      // capital letters from Shift+letter still match their lowercase cases).
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      // Space (hold) → 1:1 zoom (Shift+Space → 2:1); arrows pan while zoomed.
      // Works in single + compare. No-op in grid (there's no loupe image to zoom).
      if (e.code === "Space") {
        e.preventDefault();
        // Arm zoom on a fresh press only (ignore OS auto-repeat so panning a held
        // zoom works). Rating + strip-clicks are blocked while zoomed, so zoom can
        // never carry to another frame — no held-key gymnastics needed.
        if (!e.repeat && !gridVisible) {
          setIsZooming(true);
          setZoomLevel(e.shiftKey ? 2 : 1); // Shift+Space → 2:1, plain Space → 1:1
          setPanOffset({ x: 0, y: 0 });
        }
        return;
      }

      // ESC from any site opens the leave-to-home confirm (Enter=leave, Esc=stay).
      // Stepping back site-by-site felt wrong, so ESC does the same thing wherever
      // you are. (goBack is still used by the compare auto-exit flows.)
      if (e.key === "Escape") {
        e.preventDefault();
        setConfirmHome(true);
        return;
      }

      if (compareMode) {
        switch (e.key) {
          case "Enter":
            e.preventDefault();
            if (!e.repeat && !isZoomingRef.current) challengerWins(); // disabled while zoomed
            break;
          case "Backspace":
            e.preventDefault();
            if (!e.repeat && !isZoomingRef.current) challengerLoses(); // disabled while zoomed
            break;
          case "ArrowRight":
            e.preventDefault();
            if (isZooming) pan(PAN_STEP, 0);
            else if (!e.repeat && heldDirRef.current === 0) startHold(1);
            break;
          case "ArrowLeft":
            e.preventDefault();
            if (isZooming) pan(-PAN_STEP, 0);
            else if (!e.repeat && heldDirRef.current === 0) startHold(-1);
            break;
          case "ArrowUp":
            e.preventDefault();
            if (isZooming) pan(0, -PAN_STEP);
            break;
          case "ArrowDown":
            e.preventDefault();
            if (isZooming) pan(0, PAN_STEP);
            break;
          case "i":
          case "I":
            setExifVisible((v) => !v);
            break;
          case "h":
          case "H":
            setClippingVisible((v) => !v);
            break;
          case "p":
          case "P":
            setPeakingVisible((v) => !v);
            break;
          case "t":
          case "T":
            setThumbsVisible((v) => !v);
            break;
          case "o":
          case "O":
            // Thirds grid — visible on the matte in compare too.
            setCompositionVisible((v) => !v);
            break;
          case "l":
          case "L":
            e.preventDefault();
            goToSite("loupe");
            break;
          case "g":
          case "G":
            e.preventDefault();
            goToSite("grid");
            break;
          // 'c' in compare is a no-op now — leave via L, G, or ESC.
          // F (favorite) is intentionally disabled in compare.
        }
        return;
      }

      switch (e.key) {
        // Rating is disabled WHILE ZOOMED (rating advanced the frame, which left the
        // next one stuck zoomed). Release Space first, then rate.
        case "Enter":
          e.preventDefault();
          if (!isZoomingRef.current) applyRating("keep");
          break;
        case "Backspace":
          e.preventDefault();
          if (!isZoomingRef.current) applyRating("reject");
          break;
        case "f":
        case "F":
          if (!isZoomingRef.current) applyRating("favorite");
          break;
        case "u":
        case "U":
          if (!isZoomingRef.current) unrateCurrent(); // clear rating, stay on frame
          break;
        case "l":
        case "L":
          e.preventDefault();
          goToSite("loupe"); // no-op if already in loupe
          break;
        case "c":
        case "C":
          e.preventDefault();
          goToSite("compare");
          break;
        case "ArrowRight":
          e.preventDefault();
          // In grid, isZooming is always false (Space-zoom is gated by
          // !gridVisible, and entering grid calls resetZoom) — the pan() branch
          // is live only for the shared loupe path. Grid arrows step one cell per
          // OS key event (tap = one cell; hold = OS auto-repeat) and abandon any
          // multi-selection, so the cursor and the rated frame stay in sync.
          if (isZooming) pan(PAN_STEP, 0);
          else if (gridVisible) {
            clearMultiSelection();
            advance(1);
          } else if (!e.repeat && heldDirRef.current === 0) startHold(1);
          break;
        case "ArrowLeft":
          e.preventDefault();
          if (isZooming) pan(-PAN_STEP, 0);
          else if (gridVisible) {
            clearMultiSelection();
            advance(-1);
          } else if (!e.repeat && heldDirRef.current === 0) startHold(-1);
          break;
        case "ArrowUp":
          e.preventDefault();
          if (isZooming) pan(0, -PAN_STEP);
          else if (gridVisible) {
            clearMultiSelection();
            advance(-1, gridCols); // jump up a row in the grid
          }
          break;
        case "ArrowDown":
          e.preventDefault();
          if (isZooming) pan(0, PAN_STEP);
          else if (gridVisible) {
            clearMultiSelection();
            advance(1, gridCols); // jump down a row in the grid
          }
          break;
        case "g":
        case "G":
          e.preventDefault();
          goToSite("grid"); // no-op if already in grid; ESC to leave
          break;
        case "o":
        case "O":
          setCompositionVisible((v) => !v);
          break;
        case "1":
          setFilter("all");
          break;
        case "2":
          setFilter("unrated");
          break;
        case "3":
          setFilter("keeps");
          break;
        case "4":
          setFilter("favorites");
          break;
        case "5":
          if (settings.smartCulling) {
            setFilter("suggested");
            startAnalysis(); // no-op unless "analyze on open" is off and unrun
          }
          break;
        case "i":
        case "I":
          setExifVisible((v) => !v);
          break;
        case "h":
        case "H":
          setClippingVisible((v) => !v);
          break;
        case "p":
        case "P":
          setPeakingVisible((v) => !v);
          break;
        case "t":
        case "T":
          setThumbsVisible((v) => !v);
          break;
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      // Tab (hold) → keyboard help, released to dismiss, in both modes.
      if (e.key === "Tab") {
        e.preventDefault();
        setHelpVisible(false);
      }
      // Only the HELD arrow's release stops the scrub; releasing the opposite
      // arrow (which was ignored on keydown) must not interrupt the flow.
      // Stop on the held arrow's release. Use e.code as a fallback: a modifier
      // (Alt/Shift) still held at release can mangle e.key, which used to make the
      // exact match miss and leave the rAF scrub loop running forever.
      const isRightUp = e.key === "ArrowRight" || e.code === "ArrowRight";
      const isLeftUp = e.key === "ArrowLeft" || e.code === "ArrowLeft";
      if (isRightUp && heldDirRef.current === 1) stopHold();
      else if (isLeftUp && heldDirRef.current === -1) stopHold();
      if (e.code === "Space") {
        resetZoom(); // release → exit zoom
      }
    };
    cullKeyRef.current = { onKey, onKeyUp };
  }, [
    phase,
    startHold,
    stopHold,
    advance,
    gridVisible,
    gridCols,
    applyRating,
    unrateCurrent,
    undo,
    redo,
    openActions,
    actionsOpen,
    settingsOpen,
    helpVisible,
    confirmHome,
    quitGuard,
    isZooming,
    pan,
    leaveToHome,
    compareMode,
    championIndex,
    goToSite,
    goBack,
    challengerWins,
    challengerLoses,
    resetZoom,
    clearMultiSelection,
    settings.smartCulling,
    startAnalysis,
  ]);

  // Register the window key listeners ONCE; dispatch through cullKeyRef so the
  // frequently-rebuilt handler closures above don't re-bind the DOM listeners on
  // every scrub frame / rating. The effect above just refreshes the ref.
  useEffect(() => {
    const down = (e: KeyboardEvent) => cullKeyRef.current.onKey(e);
    const up = (e: KeyboardEvent) => cullKeyRef.current.onKeyUp(e);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    };
  }, []);

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
              {failedCount} {failedCount > 1 ? "ratings are" : "rating is"} not on disk
              (the sidecar write kept failing). Closing now will lose{" "}
              {failedCount > 1 ? "them" : "it"}.
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
                  getCurrentWindow().destroy().catch(() => {});
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
        <div
          className={`cull-chrome${isDragOver ? " is-drag-over" : ""}`}
          data-tauri-drag-region
        >
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
                <button
                  className="cull-hero__cta"
                  onClick={pickFolder}
                  disabled={pickerBusy}
                >
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

  // Transform for the deferred full-res layer. Derived to reproduce the base
  // image's `scale(Z)` about (originX%, originY%) EXACTLY — but starting from the
  // native-pixel-size element, so it rasterizes at full resolution. Reusing the
  // measured imgRect makes it pixel-aligned with the base by construction, so the
  // layer can appear/disappear without any visible shift.
  // Native dims of the ZOOM raster (the 32 MP full) — since Phase 3 the
  // displayed image is the 1620px preview, so measured element sizes must NOT
  // feed the zoom math. Preference: the zoom tier's meta-derived dims → the
  // thumb's sensor display dims (cur.dims is the full sensor size,
  // orientation-adjusted — not 160×120).
  const zoomNative =
    cur.full?.dims ??
    (cur.dims && cur.dims.w > 1 && cur.dims.h > 1 ? cur.dims : undefined);
  // True-1:1 scale: rendering the displayed image at this factor lands one image
  // pixel per screen pixel (when fit, displayed = native × fit-ratio; this
  // un-does the fit). Falls back to 5× if dimensions aren't known yet.
  const oneToOneScale = zoomNative && imgRect ? zoomNative.w / imgRect.width : 5;
  const zoomZ = isZooming ? zoomLevel * oneToOneScale : 1;
  const hiResScale = imgRect && zoomNative ? (imgRect.width / zoomNative.w) * zoomZ : 1;
  // The hi-res layer lives INSIDE the content-clip box (at 0,0 — the clip IS
  // exactly the displayed image area), so we only need the origin offset INSIDE
  // the image area. imgRect.width/height still report the displayed image's size.
  const hiResTx = imgRect ? (originX / 100) * imgRect.width * (1 - zoomZ) : 0;
  const hiResTy = imgRect ? (originY / 100) * imgRect.height * (1 - zoomZ) : 0;

  // Frame size source: the orientation-correct THMB display dims (w/h > 1 guards
  // the {1,1} UNKNOWN sentinel), else a NEUTRAL SQUARE while the aspect is
  // unknown. Drives BOTH --photo-ar and the sizer.
  const frameDims =
    cur.dims && cur.dims.w > 1 && cur.dims.h > 1
      ? cur.dims
      // Large square (not 1×1): the sizer fills the matte by clamping its
      // intrinsic size DOWN to the stage, so the fallback must EXCEED the stage
      // — a square fills the stage height (width = height), like a portrait.
      : { w: 10000, h: 10000 };
  const photoAr = `${frameDims.w} / ${frameDims.h}`;

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
        <div className="cull-image-area" ref={stageRef}>
        {images.length === 0 ? (
          <div className="cull-message">no images</div>
        ) : positionInFilter === -1 ? (
          <EmptyFilter filter={filter} analyzing={qualityAnalyzing} scoredCount={Object.keys(qualityScores).length} progress={qualityProgress} />
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
            <div
              className={`cull-photo-frame${
                feedback && current && feedback.imageId === current.id
                  ? ` cull-photo-frame--flash-${feedback.rating === "favorite" ? "fav" : feedback.rating}`
                  : ""
              }`}
              style={{ ["--photo-ar" as string]: photoAr } as React.CSSProperties}
            >
              {/* The decode-gated presenter (Phase 4): LoupeStage owns the
                  sizer, double-buffered layers, shimmer, spinner, error chip,
                  and the post-decode zoom layer. The old single-<img> path was
                  deleted after the dual-engine manual matrix passed. */}
              <LoupeStage
                  path={current?.path ?? ""}
                  cur={cur}
                  scrubbing={scrubbing}
                  isZooming={isZooming}
                  zoomZ={zoomZ}
                  originX={originX}
                  originY={originY}
                  frameDims={frameDims}
                  shimmerDelayMs={loupeShimmerDelay}
                  hiRes={hiRes}
                  hasImgRect={!!imgRect}
                  zoomNative={zoomNative}
                  hiResTx={hiResTx}
                  hiResTy={hiResTy}
                  hiResScale={hiResScale}
                  imgRef={imgRef}
                  onFrontFlip={bumpMeasureNonce}
                />
              {/* Overlays inset to match the photo-frame's 14px padding (the
                  matte). They paint over the image area only, never the matte
                  or the stage. They scale with the image transform so they
                  remain aligned through zoom. */}
              {/* Overlays — positioning + sizing comes from the CSS rule
                  (`position: absolute !important; inset: 14px`), NOT inline
                  style. That keeps them out of flow even if a future edit
                  drops the inline `style`, so they cannot influence the
                  photo-frame's intrinsic size (which is what was causing
                  the image to visibly resize when clipping toggled).
                  Inline style is reserved for the zoom transform. */}
              <div className="cull-photo-frame__clip" aria-hidden>
              {!scrubbing && currentClipMask && (
                <img
                  className="cull-clip-overlay"
                  src={currentClipMask}
                  alt=""
                  style={{
                    transform: isZooming ? `scale(${zoomZ})` : undefined,
                    transformOrigin: `${originX}% ${originY}%`,
                    transition: zoomTransition(isZooming),
                  }}
                />
              )}
              {!scrubbing && currentPeakMask && (
                <img
                  className="cull-peaking-overlay"
                  src={currentPeakMask}
                  alt=""
                  style={{
                    transform: isZooming ? `scale(${zoomZ})` : undefined,
                    transformOrigin: `${originX}% ${originY}%`,
                    transition: zoomTransition(isZooming),
                  }}
                />
              )}
              {/* Thirds grid is a whole-frame tool: intentionally hidden while
                  zoomed, unlike the clip/peak masks (which stay mounted and scale
                  via the inline transform). */}
              {compositionVisible && !isZooming && !scrubbing && (
                <svg
                  className="cull-composition-overlay"
                  viewBox="0 0 100 100"
                  preserveAspectRatio="none"
                  aria-hidden
                >
                  <line x1="33.333" y1="0" x2="33.333" y2="100" />
                  <line x1="66.667" y1="0" x2="66.667" y2="100" />
                  <line x1="0" y1="33.333" x2="100" y2="33.333" />
                  <line x1="0" y1="66.667" x2="100" y2="66.667" />
                </svg>
              )}
              </div>
            </div>
            {/* Verdict is now shown in the bottom status bar's pill; the floating
                corner dot is dropped to avoid duplicate signaling and to keep the
                stage clean alongside the EXIF rail. */}
          </>
        )}
        {feedbackChip}
        </div>
        {exifVisible && current && (
          <ExifRail
            metadata={currentMeta}
            histogramUrl={currentHistogram}
            cullRating={currentRating}
            suggestion={suggestions[current.id] ?? null}
            burst={burstCtx.get(current.id) ?? null}
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
  // Glyph rendered as a Lucide SVG icon (not a Unicode character) so it
  // centers perfectly inside the 14px circle. Unicode ★ ✓ ✕ in Segoe UI
  // Symbol / system-ui have inconsistent baselines on Windows — `flex; center;
  // center` alone wasn't enough to put the star visually mid-circle.
  const verdictGlyph: Record<Rating, ReactNode> = {
    keep: <Check size={9} color="#0a0a0c" strokeWidth={3} />,
    reject: <XIcon size={9} color="#0a0a0c" strokeWidth={3} />,
    favorite: <Star size={9} color="#0a0a0c" strokeWidth={2.6} fill="#0a0a0c" />,
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
              {verdictGlyph[currentRating]}
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
            {scrubSpeed > 1 && (
              <span className="cull-statusbar__scrubspeed">{scrubSpeed}×</span>
            )}
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
              title="i — info"
              aria-pressed={exifVisible}
            >
              i
            </button>
            <button
              type="button"
              className={`cull-statusbar__ov${clippingVisible ? " is-on" : ""}`}
              onClick={() => setClippingVisible((v) => !v)}
              title="h — clipping"
              aria-pressed={clippingVisible}
            >
              h
            </button>
            <button
              type="button"
              className={`cull-statusbar__ov${peakingVisible ? " is-on" : ""}`}
              onClick={() => setPeakingVisible((v) => !v)}
              title="p — focus peaking"
              aria-pressed={peakingVisible}
            >
              p
            </button>
            <button
              type="button"
              className={`cull-statusbar__ov${compositionVisible ? " is-on" : ""}`}
              onClick={() => setCompositionVisible((v) => !v)}
              title="o — thirds"
              aria-pressed={compositionVisible}
            >
              o
            </button>
            <button
              type="button"
              className={`cull-statusbar__ov${thumbsVisible ? " is-on" : ""}`}
              onClick={() => setThumbsVisible((v) => !v)}
              title="t — thumb strip"
              aria-pressed={thumbsVisible}
            >
              t
            </button>
          </div>
        )}
        {gridVisible && selectedIndices.size >= 1 && (
          <span
            className="cull-statusbar__multi"
            title="selection — rating keys apply to all selected"
          >
            {selectedIndices.size} selected
          </span>
        )}
        {failedCount > 0 ? (
          <span
            className="cull-statusbar__unsaved"
            onClick={retryFailed}
            title="some ratings failed to save — click to retry"
          >
            ⚠ {failedCount} unsaved · retry
          </span>
        ) : (
          savingCount > 0 && <span className="cull-statusbar__saving">saving {savingCount}…</span>
        )}
      </div>
      <div className="cull-statusbar__spacer" />
      <div className="cull-statusbar__right">
        <span
          className="cull-statusbar__pos"
          title={compareMode ? "challenger position / total candidates" : "current position / filtered total"}
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
              onClick={() => setFilter("all")}
              title="1 · show all images"
            >
              All
            </button>
            <button
              type="button"
              className={filter === "unrated" ? "is-active" : ""}
              onClick={() => setFilter("unrated")}
              title="2 · show only unrated"
            >
              Unrated
            </button>
            <button
              type="button"
              className={filter === "keeps" ? "is-active" : ""}
              onClick={() => setFilter("keeps")}
              title="3 · show only keeps"
            >
              Keeps
            </button>
            <button
              type="button"
              className={filter === "favorites" ? "is-active" : ""}
              onClick={() => setFilter("favorites")}
              title="4 · show only favorites"
            >
              Favorites
            </button>
            {settings.smartCulling && (
              <button
                type="button"
                className={filter === "suggested" ? "is-active" : ""}
                onClick={() => {
                  setFilter("suggested");
                  startAnalysis(); // manual start when "analyze on open" is off
                }}
                title="5 · show unrated frames with a smart-culling suggestion"
              >
                {qualityAnalyzing && qualityProgress
                  ? `Smart ${Math.round((qualityProgress.done / Math.max(qualityProgress.total, 1)) * 100)}%`
                  : "Smart"}
              </button>
            )}
          </div>
        )}
        {(stats.keeps > 0 || rejectedPaths.length > 0) && !actionsOpen && (
          <button
            type="button"
            className="cull-statusbar__finish"
            onClick={() => setActionsOpen(true)}
            title="finish the cull — move rejects / copy keeps"
          >
            {modGlyph}E · {totalKeeps} keeps
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
          <SaveStatusPill
            failedCount={failedCount}
            savingCount={savingCount}
            onRetry={retryFailed}
          />
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
                    ? "the folder is still not responding — check the drive / NAS connection, then retry"
                    : folderTrouble === "recovered"
                      ? "folder reachable again — resuming loads"
                      : "several reads failed — the folder may be unreachable (NAS asleep / unmounted)"
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
        </div>
      </header>

      {compareMode ? (
        <>
          {thumbsVisible && settings.thumbsPosition === "top" && cmpStrip}
          <CompareView
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
            championSuggestion={
              images[championIndex] && !ratings[images[championIndex].id]
                ? suggestions[images[championIndex].id] ?? null
                : null
            }
            challengerSuggestion={
              images[challengerIndex] && !ratings[images[challengerIndex].id]
                ? suggestions[images[challengerIndex].id] ?? null
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
              <EmptyFilter filter={filter} analyzing={qualityAnalyzing} scoredCount={Object.keys(qualityScores).length} progress={qualityProgress} />
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
                bursts={burstCtx}
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
                ? `${failedCount} rating${failedCount > 1 ? "s have" : " has"} not saved to disk yet (the sidecar write keeps failing). Leaving won't lose ${failedCount > 1 ? "them" : "it"} — the unsaved flag stays on the home screen so you can retry saving from there, but it's safer to stay and retry first.`
                : "This clears the current session and returns to the start screen. Your ratings are saved in .xmp sidecars, so reopening the folder restores them."}
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
        <HelpOverlay mode={compareMode ? "compare" : gridVisible ? "grid" : "loupe"} />
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
/**
 * Centered empty-state shown in loupe / grid when the active filter has zero
 * matches. Small icon,
 * uppercase eyebrow, headline with the missing filter highlighted, and a key
 * hint to switch out.
 */
function EmptyFilter({
  filter,
  analyzing,
  scoredCount,
  progress,
}: {
  filter: Filter;
  analyzing?: boolean;
  /** How many frames the smart pass has scored — distinguishes "analyzed,
   *  no obvious calls" (the healthy quiet case) from "never analyzed". */
  scoredCount?: number;
  /** Live pass progress — on a 5000-frame NAS folder the pass runs for many
   *  minutes (by design: it always yields to interactive reads), and without
   *  a count "analyzing" is indistinguishable from "hung". */
  progress?: { done: number; total: number } | null;
}) {
  // The suggested filter has three empty states, and telling them apart is
  // the difference between "working as designed" and "looks broken":
  if (filter === "suggested") {
    if (analyzing) {
      // Not done yet — suggestions fill in progressively per chunk.
      return (
        <div className="cull-empty-state">
          <div className="cull-empty-state__icon">…</div>
          <div className="cull-empty-state__eyebrow">Analyzing</div>
          <div className="cull-empty-state__title">
            Looking for obvious calls
            {progress ? ` — ${progress.done.toLocaleString()} of ${progress.total.toLocaleString()} scored` : ""}
          </div>
          <div className="cull-empty-state__hint">
            fills in as frames are scored — culling always takes priority · <kbd>1</kbd> for all
          </div>
        </div>
      );
    }
    if ((scoredCount ?? 0) > 0) {
      // The healthy quiet case: everything scored, nothing worth flagging.
      // An advisory tool only speaks on clear calls — silence is a verdict.
      return (
        <div className="cull-empty-state">
          <div className="cull-empty-state__icon">✓</div>
          <div className="cull-empty-state__eyebrow">Analyzed</div>
          <div className="cull-empty-state__title">
            No obvious calls in this folder ({scoredCount} scored)
          </div>
          <div className="cull-empty-state__hint">
            no clearly soft, blurred, or burst-redundant frames · <kbd>1</kbd> for all
          </div>
        </div>
      );
    }
    // Zero scores and not analyzing: the pass hasn't run (auto-analyze off)
    // or every chunk failed (drive hiccup) — 5 retries in both cases.
    return (
      <div className="cull-empty-state">
        <div className="cull-empty-state__icon">⌀</div>
        <div className="cull-empty-state__eyebrow">Not analyzed</div>
        <div className="cull-empty-state__title">No frames have been scored yet</div>
        <div className="cull-empty-state__hint">
          <kbd>5</kbd> to analyze · <kbd>1</kbd> for all
        </div>
      </div>
    );
  }
  // Label the user-facing filter name. "All" can never actually be empty (it
  // includes unrated), so falling back to "this" covers the impossible-case.
  const label =
    filter === "favorites"
      ? "Favorites"
      : filter === "keeps"
        ? "Keeps"
        : filter === "unrated"
          ? "Unrated"
          : "this"; // "suggested" fully handled (and narrowed away) above
  return (
    <div className="cull-empty-state">
      <div className="cull-empty-state__icon">⌀</div>
      <div className="cull-empty-state__eyebrow">No matches</div>
      <div className="cull-empty-state__title">
        No images in the <em>{label}</em> filter
      </div>
      <div className="cull-empty-state__hint">
        <kbd>1</kbd> for all
      </div>
    </div>
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
            <RecentRow
              key={recentKey(r.paths)}
              entry={r}
              onPick={() => !pickerBusy && onPick(r)}
            />
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
                {" "}✓
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

function SaveStatusPill({
  failedCount,
  savingCount,
  onRetry,
}: {
  failedCount: number;
  savingCount: number;
  onRetry: () => void;
}) {
  const state =
    failedCount > 0 ? "failed" : savingCount > 0 ? "saving" : "idle";
  const text =
    state === "failed"
      ? "failed · retry"
      : state === "saving"
        ? "saving…"
        : "saved";
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
          ? "some ratings failed to save — click to retry"
          : state === "saving"
            ? `saving ${savingCount} rating${savingCount > 1 ? "s" : ""}`
            : "all ratings saved to disk"
      }
    >
      <span className="cull-save-status__dot" />
      <span className="cull-save-status__label">{text}</span>
    </span>
  );
}
