import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
  SessionSummary,
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
import { SettingsDialog } from "./components/SettingsDialog";
import { ThumbStrip } from "./components/ThumbStrip";
import { WindowControls } from "./components/WindowControls";

import { useRecents, type RecentEntry } from "./hooks/useRecents";
import { useSettings } from "./hooks/useSettings";

import { PERFORMANCE_PROFILES } from "./types/settings";
import { imageStore } from "./image/imageStore";
import { runMaskScan, type MaskKind } from "./overlays/maskScans";
import { maskWorkerAvailable, requestMaskOffThread } from "./overlays/maskClient";
import { useImage } from "./image/useImage";
import { passesFilter } from "./utils/filter";
import { formatRelativeTime, middleTruncate } from "./utils/format";
import { basename } from "./utils/path";
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

// After the immediate first step on hold-start, wait this long before the
// auto-repeat kicks in — so a quick tap moves exactly one image, while a
// sustained hold pauses briefly then ramps into the ~30/s repeat above.
const NAV_HOLD_DELAY_MS = 280;

// How many frames either side of the cursor keep their computed analysis-overlay
// (clip / peak / histogram) PNG cached. Beyond this the cache is pruned, so
// leaving an overlay on across a long shoot doesn't accumulate one PNG per
// visited frame.
const OVERLAY_CACHE_KEEP = 8;

/**
 * Transparent inline-SVG data URI whose intrinsic width/height carry an aspect
 * ratio. Used as an in-flow "sizer" <img> so the photo matte is sized by the
 * KNOWN display ratio — never by whatever pixels happen to be decoded (the THMB
 * is tiny; a mid-decode full is 0). Renders nothing.
 */
const sizerSrc = (w: number, h: number) =>
  `data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='${w}'%20height='${h}'%2F%3E`;

/**
 * All-null ImageMetadata template. Seeds a grid badge from a known LrC star
 * before the per-image bundle read fills in real EXIF — kept centralized (and
 * frozen) so adding a metadata field only touches one place, not every seed.
 */
const EMPTY_METADATA: ImageMetadata = Object.freeze({
  capturedAt: null,
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
  // Live mirror of `images` so openFolderByPath can read the latest staged set
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
  const [helpVisible, setHelpVisible] = useState(false);
  const [confirmHome, setConfirmHome] = useState(false); // Esc → confirm leaving to home
  // Held-arrow fast-scrub. While true we render the cheap thumbnail instead of the
  // full-res preview, so scrub speed isn't bottlenecked by decoding ~6 MP JPEGs
  // per step. Full-res returns the instant the key is released.
  const [scrubbing, setScrubbing] = useState(false);

  // Snapshot of the just-finished cull, shown on the home screen after you leave.
  const [lastSession, setLastSession] = useState<SessionSummary | null>(null);

  // User-tunable settings, persisted to localStorage. Opened with Ctrl+,.
  const [settings, setSettings] = useSettings();
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Recent folders list rendered on the home screen. Pushed to whenever a
  // folder is opened (after a successful `scan_folder`), and refreshed with
  // the rated/done counts when the user leaves the cull back to home — so
  // the list shows "327 / 372" mid-flow and "932 ✓" once everything's rated.
  const { recents: recentFolders, push: pushRecent, remove: removeRecent } = useRecents();

  // Act on the cull (Ctrl+E) — a non-modal finish dialog with two file actions:
  // move rejects to a _rejected/ subfolder, and copy keeps+favorites to an export
  // folder. Non-destructive (skips when the destination already has that file).
  const [actionsOpen, setActionsOpen] = useState(false);
  const [moveResult, setMoveResult] = useState<FileOpResult | null>(null);
  const [copyResult, setCopyResult] = useState<FileOpResult | null>(null);
  const [actionBusy, setActionBusy] = useState<"move" | "copy" | null>(null);

  const [scanError, setScanError] = useState<string | null>(null);
  // Surfaced on the staged screen when analyze_folder fails, so a failed sort /
  // rating-restore returns the user to staged with a retry instead of silently
  // dropping them into an unsorted, ratings-not-restored cull.
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  // True from the moment pickFolder is invoked until the OS dialog resolves
  // (success OR cancel). Prevents a double-click — or a stuck dialog — from
  // queuing a second picker behind the first.
  const [pickerBusy, setPickerBusy] = useState(false);
  const [lastAdded, setLastAdded] = useState(0);
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

  // Deferred full-res zoom: the browser rasterizes the on-screen JPEG only at
  // screen-fit size (keeps navigation instant), so zooming GPU-upscales that
  // until it re-decodes — the ~0.2s softness. Once you settle on a frame we mount
  // a second copy rendered at the image's native pixel size, which forces a
  // full-resolution raster, so the zoom composites from already-sharp pixels.
  const [hiRes, setHiRes] = useState(false);
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  // The full-preview blob URL that has actually finished decoding (its onLoad
  // fired). Keeps the low-res blurred until the full has PAINTED — not merely
  // when the stage flips to "full" — so the low-res never flashes sharp first.
  const [paintedFullUrl, setPaintedFullUrl] = useState<string | null>(null);
  const hiResTimer = useRef<number | null>(null);

  const [clippingVisible, setClippingVisible] = useState(false);
  const [clipMasks, setClipMasks] = useState<Record<string, string>>({});
  const requestedClipMasks = useRef<Set<string>>(new Set());

  // Focus peaking (P) — high-contrast edge overlay highlighting in-focus regions.
  // Computed from the preview JPEG (downscaled to a working size) and cached per
  // path, just like the clipping mask.
  const [peakingVisible, setPeakingVisible] = useState(false);
  const [peakingMasks, setPeakingMasks] = useState<Record<string, string>>({});
  const requestedPeaks = useRef<Set<string>>(new Set());

  // Composition overlay for the loupe — thirds grid (O). Hidden when zoomed
  // (it's for evaluating the whole-frame look). Aspect-crop overlay was removed:
  // static rectangles didn't add anything thirds + the image itself can't.
  const [compositionVisible, setCompositionVisible] = useState(false);

  // RGB histogram (path → rendered data URL), computed from the displayed JPEG
  // only while the EXIF overlay is open.
  const [histograms, setHistograms] = useState<Record<string, string>>({});
  const requestedHistograms = useRef<Set<string>>(new Set());

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
    if (isZoomingRef.current) resetZoom();
  }, [currentIndex, resetZoom]);

  const visibleIndices = useMemo(() => {
    return images.map((_, i) => i).filter((i) => passesFilter(ratings[images[i].id], filter));
  }, [images, ratings, filter]);

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
      setGridCols(Math.max(2, Math.floor(w / GRID_CELL_TARGET)));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [gridVisible, compareMode, gridHasCells]);

  // Compare-mode candidate strip: every UNRATED frame except the champion (which
  // is pinned separately). The challenger is always one of these. Drives both the
  // bottom strip and its thumbnail eviction window, so only unrated frames show —
  // independent of the active `filter`, which is left untouched and restored on exit.
  const compareCandidates = useMemo(() => {
    if (!compareMode) return [];
    // One pass (no throwaway index array): every unrated frame except the champion.
    const out: number[] = [];
    for (let i = 0; i < images.length; i++) {
      if (i !== championIndex && !ratings[images[i].id]) out.push(i);
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
  const profile = PERFORMANCE_PROFILES[settings.storageMode];

  // Storage-mode profile → store concurrency caps + keep-window sizes.
  useEffect(() => {
    imageStore.setProfile(profile);
  }, [profile]);

  // EXIF metadata sink: the store's full-res bundle reads return the full
  // camera / lens / AF / pixel-dims metadata (including the LrC rating, which
  // read_bundle fills in). The bundle meta is authoritative, so it OVERWRITES
  // any seeded lrc-only entry — exactly as the old loadImageRaw did — otherwise
  // a frame that had a pre-seeded LrC star would never gain its full EXIF.
  useEffect(() => {
    imageStore.setMetaSink((path, meta) => {
      setMetadata((m) => ({ ...m, [path]: meta }));
    });
    return () => imageStore.setMetaSink(undefined);
  }, []);

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

  /**
   * Scan a known folder path and stage its CR3s. Same logic as `pickFolder`
   * minus the OS picker — used both by `pickFolder` after the user picks, and
   * by the launch-time "open last folder" effect.
   */
  const openFolderByPath = useCallback(
    async (picked: string) => {
      // One scan at a time. A second open launched while one is in flight
      // (drag-drop, recents, mount auto-open) would race the append and the
      // begin-culling snapshot — serialise every caller through this gate.
      if (openBusyRef.current) return;
      openBusyRef.current = true;
      setPickerBusy(true);
      setScanError(null);
      setAnalyzeError(null);
      try {
        setPendingFolder(picked);
        setPhase("loading");

        const paths = await invoke<string[]>("scan_folder", {
          path: picked,
          ignoreSubdir: settings.rejectedSubfolder.trim() || "_rejected",
        });

        // Persist the last-used dir only AFTER a successful scan, so a folder
        // that fails to open never becomes the picker default / auto-open target.
        localStorage.setItem("cull:lastDir", picked);

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
          srcFolder: picked,
        }));
        if (appended.length > 0) {
          imagesRef.current = [...prev, ...appended];
          setImages(imagesRef.current);
        }
        setLastAdded(additions.length);
        setFolder(picked);

        // Push to the home-screen recents list (or refresh an existing entry).
        // `rated` + `done` only become accurate after `analyze_folder` reads
        // the sidecars, so we leave them at zero/false here and let the cull
        // exit (leaveToHome) — or the analyze pass itself — update them. `count`
        // is THIS folder's own scan total (per-folder, not the merged staged set).
        pushRecent({
          path: picked,
          count: paths.length,
          rated: 0,
          lastOpened: new Date().toISOString(),
          done: false,
        });

        // Go straight to STAGED after the (sub-millisecond) scan — don't block
        // on preview decode. The current image preloads in the background so
        // "begin culling" is still instant by the time the user clicks it.
        setPhase("staged");
      } catch (e) {
        const msg = String(e);
        setScanError(msg);
        // Evict from recents only when the folder is definitively gone (deleted
        // / not a directory). A transient NAS/SMB blip must NOT drop a valid,
        // frequently-used folder — the backend tags permanent vs transient.
        if (/not found|not a directory/i.test(msg)) removeRecent(picked);
        setPhase(imagesRef.current.length > 0 ? "staged" : "start");
      } finally {
        setPendingFolder(null);
        setPickerBusy(false);
        openBusyRef.current = false;
      }
    },
    [pushRecent, removeRecent, settings.rejectedSubfolder],
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
      const picked = await open({ directory: true, multiple: false, defaultPath: lastDir });
      if (!picked || typeof picked !== "string") return; // cancelled — stay put
      // Hand off to the shared open-by-path. (It also flips pickerBusy on/off,
      // which is fine — setState is idempotent.)
      await openFolderByPath(picked);
    } finally {
      setPickerBusy(false);
    }
  }, [pickerBusy, openFolderByPath]);

  // Launch-time auto-open: if the user prefers it and a last folder is
  // remembered, skip the home screen and load it straight away. Runs once on
  // app mount; intentionally NOT triggered every time settings.openLastFolderOnLaunch
  // flips, since that would re-open the folder mid-cull.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!settings.openLastFolderOnLaunch) return;
    const lastDir = localStorage.getItem("cull:lastDir");
    if (!lastDir) return;
    openFolderByPath(lastDir);
    // Intentional empty deps — mount-only.
  }, []);

  // Push one recents entry PER source folder in the staged set, each scoped to
  // its own count/rated — so a session that spans several folders ("open another
  // folder") never records the merged total under one folder's name.
  const recordSessionRecents = useCallback(
    (imgs: Img[], ratingsMap: Record<number, Rating>) => {
      if (imgs.length === 0) return;
      const byFolder = new Map<string, { count: number; rated: number }>();
      for (const im of imgs) {
        const agg = byFolder.get(im.srcFolder) ?? { count: 0, rated: 0 };
        agg.count += 1;
        if (ratingsMap[im.id]) agg.rated += 1;
        byFolder.set(im.srcFolder, agg);
      }
      const now = new Date().toISOString();
      // Push the active folder last so it ends up at the front of the list.
      const folders = [...byFolder.keys()].sort((a, b) =>
        a === folder ? 1 : b === folder ? -1 : 0,
      );
      for (const path of folders) {
        const { count, rated } = byFolder.get(path)!;
        pushRecent({ path, count, rated, lastOpened: now, done: count > 0 && rated === count });
      }
    },
    [folder, pushRecent],
  );

  // Begin culling: sort the staged set by capture time, restore ratings, then
  // enter the cull view (warming the first screenful of previews first).
  const beginCulling = useCallback(async () => {
    if (images.length === 0) return;
    if (analyzingRef.current) return; // ignore a double-click — one analyze pass
    analyzingRef.current = true;
    setAnalyzeError(null);
    setLastSession(null); // starting a new cull → drop the previous session's recap
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
      // (camera/lens/EXIF) and re-asserts the same lrcRating.
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

      // Refresh the home-screen recents entries (one per source folder) with the
      // restored rated counts straight off the sidecar pass — so reopening home
      // shows "327 / 372" immediately, even before the user touches a key.
      recordSessionRecents(sorted, restoredRatings);

      // Resume where you stopped: land on the first unrated frame in capture
      // order. All-rated or fresh folder → start at top.
      const resumeAt = sorted.findIndex((img) => !restoredRatings[img.id]);
      setCurrentIndex(resumeAt === -1 ? 0 : resumeAt);
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
  }, [images, profile.concurrentRestore, settings, recordSessionRecents]);

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

  // Esc out of review → discard the in-memory session and return Home. Ratings
  // live on in the .xmp sidecars, so reopening the folder restores them.
  const resetSession = useCallback(() => {
    // Session end: revoke ALL blob URLs (thumbs + full-res) and clear the store.
    imageStore.hardReset();
    setImages([]);
    setMetadata({});
    setRatings({});
    setCompareMode(false);
    setGridVisible(false);
    setNavStack([]);
    setCurrentIndex(0);
    setFilter("all");
    setSelectedIndices(new Set());
    setSelectionAnchor(null);
    setFolder(null);
    setPendingFolder(null);
    setAnalyzeError(null);
    setLastAdded(0);
    setClippingVisible(false);
    setClipMasks({});
    requestedClipMasks.current.clear();
    // Mirror the clip handling for the other overlay families — these were leaking
    // their PNG caches + requested Sets across sessions.
    setPeakingVisible(false);
    setPeakingMasks({});
    requestedPeaks.current.clear();
    setCompositionVisible(false);
    setHistograms({});
    requestedHistograms.current.clear();
    setExifVisible(false);
    resetZoom();
    setFeedback(null);
    setPhase("start");
  }, [resetZoom]);

  // Leaving to home: snapshot the cull for the home-screen summary, then reset.
  const leaveToHome = useCallback(() => {
    const total = images.length;
    if (total > 0) {
      const favorites = stats.favorites;
      setLastSession({
        folder: folder ? basename(folder) : "",
        total,
        keep: stats.keeps - favorites, // keeps includes favorites; this is keep-only
        favorites,
        rejected: total - stats.unrated - stats.keeps,
        unrated: stats.unrated,
      });
    }
    // Refresh the recents entries (one per source folder) with this session's
    // final counts so the home list reflects what the user just finished.
    recordSessionRecents(images, ratings);
    setConfirmHome(false);
    resetSession();
  }, [images, ratings, stats, folder, resetSession, recordSessionRecents]);

  // Open the act-on-cull dialog with fresh results.
  const openActions = useCallback(() => {
    setMoveResult(null);
    setCopyResult(null);
    setActionsOpen(true);
  }, []);

  // Move rejected CR3s (+sidecars) into a subfolder of the current folder.
  // The subfolder name comes from settings (default `_rejected`).
  const doMoveRejects = useCallback(async () => {
    if (!folder || rejectedPaths.length === 0 || actionBusy !== null) return;
    setActionBusy("move");
    setMoveResult(null);
    try {
      const subfolder = settings.rejectedSubfolder.trim() || "_rejected";
      const res = await invoke<FileOpResult>("move_rejects_to_subfolder", {
        folder,
        paths: rejectedPaths,
        subfolder,
      });
      setMoveResult(res);
    } catch (e) {
      setMoveResult({ completed: 0, skipped: 0, errors: [String(e)] });
    } finally {
      setActionBusy(null);
    }
  }, [folder, rejectedPaths, actionBusy, settings.rejectedSubfolder]);

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
        setCopyResult({ completed: 0, skipped: 0, errors: [String(e)] });
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
    { wantFull: !gridVisible && !compareMode && !!images[currentIndex] && !scrubbing },
  );
  // curReady gates the hi-res zoom warm-up on the CURRENT image's full preview
  // being ready (so an unrelated prefetch landing doesn't reset it).
  const curReady = cur.stage === "full";
  // showFull: true only when the full preview is ready AND we are not mid-scrub.
  // A scrubbed-past frame whose full is already cached must still show as blurred
  // during scrub — otherwise a cached full renders sharp mid-scrub.
  const showFull = cur.stage === "full" && !scrubbing;
  // True only once the CURRENT full preview has decoded+painted (its onLoad
  // fired for this url); until then we keep showing the blurred low-res.
  const fullPainted = showFull && paintedFullUrl === cur.url;
  // Phase for the loupe matte shimmer, pinned per image so every shimmer syncs.
  const loupeShimmerDelay = useMemo(() => shimmerPhaseMs(), [currentIndex]);

  // Reset the measured full-res size on every navigation, so a fresh image's
  // shimmer never inherits the PREVIOUS image's aspect (a vertical matte while
  // landing on a horizontal). Until dims are known the matte is a neutral
  // square; the new full's onLoad re-sets this.
  useEffect(() => {
    setNaturalSize(null);
  }, [currentIndex]);

  // If we LAND on (or settle on) a frame whose full-res is already ready
  // (prefetched / cached), mark it painted at once so the thumb→full blur is
  // skipped — there is no low-res for THIS frame on screen that could flash, so
  // the full appears sharp immediately. Deliberately keyed ONLY on navigation /
  // scrub-settle, NOT on cur.url: a full that ARRIVES while we sit on the thumb
  // must still gate on the <img> onLoad below, or the low-res would flash sharp
  // for ~0.1s before the full paints (the behaviour fullPainted was added for).
  useLayoutEffect(() => {
    if (showFull && cur.url) setPaintedFullUrl(cur.url);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentIndex, scrubbing]);

  // Warm the full-res zoom layer once the cursor rests on a ready frame; reset on
  // every navigation / compare toggle so rapid arrow-through never pays the heavy
  // native-resolution decode. Also resets when the thumbnail strip toggles: that
  // resizes the stage, and the deferred layer (positioned from the measured rect)
  // would otherwise linger at the OLD size, overlapping the reflowed base image.
  // Dropping it here lets it re-mount cleanly at the new size after the settle.
  useEffect(() => {
    setHiRes(false);
    if (hiResTimer.current) clearTimeout(hiResTimer.current);
    if (phase !== "culling" || compareMode || !curReady) return;
    hiResTimer.current = window.setTimeout(
      () => setHiRes(true),
      profile.hiResSettleMs,
    );
    return () => {
      if (hiResTimer.current) clearTimeout(hiResTimer.current);
    };
    // exifVisible included: toggling the info rail resizes the stage too, so the
    // hi-res layer must drop + re-derive at the new rect (same reason as thumbsVisible).
  }, [phase, currentIndex, compareMode, curReady, thumbsVisible, exifVisible, profile.hiResSettleMs]);

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
    measure();
    const ro = new ResizeObserver(measure);
    if (stageRef.current) ro.observe(stageRef.current);
    return () => ro.disconnect();
    // cur.stage/cur.dims: the sizer reflows the frame when dims arrive (thumb
    // stage); the RO is on the stage (which doesn't resize), so re-measure here.
    // images.length (not the array ref) so a folder append doesn't needlessly
    // tear down + rebuild the observer when the displayed frame is unchanged.
  }, [phase, images.length, currentIndex, measureNonce, scrubbing, cur.stage, cur.dims]);

  // Compute a clipping mask PNG for one image's preview (cached by path). Scans
  // pixels for true clipping and paints diagonal stripes (red 45° highlights /
  // blue −45° shadows). Detection uses ALL THREE channels (blown → white /
  // crushed → black): "any channel" flags saturated colours falsely (a yellow
  // flower ≈ R255 G210 B0 trips the blue=0 test). Small tolerance (250/5) since
  // JPEG quantization rarely lands exactly on 255/0. Checks the preview, not RAW.
  // Shared generator for the clip + peak masks — they differ ONLY in the
  // per-pixel scan (runMaskScan dispatches by kind). Downscales the full preview
  // to a bounded working size (~1600px): the mask is a diagnostic overlay CSS
  // stretches to the image rect, so scanning + PNG-encoding the full 32 MP preview
  // would hang the toggle for ~1s for no visible gain. Bails if the session
  // generation changes while the probe decodes, so a folder switch can't write a
  // stale mask into the new set.
  const buildMask = useCallback(
    (
      path: string,
      kind: MaskKind,
      requestedRef: { current: Set<string> },
      setMasks: (updater: (prev: Record<string, string>) => Record<string, string>) => void,
    ) => {
      if (requestedRef.current.has(path)) return;
      const snap = imageStore.snapshot(path);
      if (snap.stage !== "full" || !snap.url) return; // retried once the full lands
      requestedRef.current.add(path);
      const reqGen = imageStore.getGeneration();
      const MAX = 1600;
      const probe = new Image();
      // Commit a finished mask, unless the session changed between decode start
      // and encode completion (the off-thread path adds a round-trip).
      const commit = (url: string) => {
        if (imageStore.getGeneration() !== reqGen) return;
        setMasks((prev) => ({ ...prev, [path]: url }));
      };
      // Main-thread path — also the fallback when the worker is unavailable/errors.
      const inline = () => {
        const scale = Math.min(1, MAX / Math.max(probe.naturalWidth, probe.naturalHeight));
        const w = Math.max(1, Math.round(probe.naturalWidth * scale));
        const h = Math.max(1, Math.round(probe.naturalHeight * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) {
          requestedRef.current.delete(path);
          return;
        }
        ctx.drawImage(probe, 0, 0, w, h);
        const srcData = ctx.getImageData(0, 0, w, h).data;
        const mask = ctx.createImageData(w, h);
        runMaskScan(kind, srcData, mask.data, w, h);
        ctx.putImageData(mask, 0, 0);
        commit(canvas.toDataURL("image/png"));
      };
      probe.onload = () => {
        if (imageStore.getGeneration() !== reqGen) {
          requestedRef.current.delete(path);
          return; // session changed mid-decode — don't write a stale mask
        }
        // Prefer the OffscreenCanvas worker (scan + PNG encode off the UI thread).
        // ANY failure (unsupported runtime / decode / worker crash) falls back to
        // the inline path, so behaviour never regresses below the main-thread one.
        if (maskWorkerAvailable()) {
          createImageBitmap(probe).then(
            (bitmap) => requestMaskOffThread(kind, bitmap, MAX).then(commit, inline),
            inline,
          );
        } else {
          inline();
        }
      };
      probe.onerror = () => requestedRef.current.delete(path);
      probe.src = snap.url;
    },
    [],
  );

  const loadClipMask = useCallback(
    (path: string) => buildMask(path, "clip", requestedClipMasks, setClipMasks),
    [buildMask],
  );

  // Ensure masks exist for the on-screen image(s) when clipping is on; clear when
  // off (clipping does not persist, spec §12).
  useEffect(() => {
    if (!clippingVisible) {
      // Idempotent reset: while clipping is off this effect still re-runs on every
      // scrub frame (currentIndex/cur.* deps), so a fresh {} would force a render
      // each frame. Keep the same ref when already empty so React bails out.
      if (requestedClipMasks.current.size > 0) requestedClipMasks.current.clear();
      setClipMasks((prev) => (Object.keys(prev).length ? {} : prev));
      return;
    }
    if (compareMode) {
      if (images[championIndex]) loadClipMask(images[championIndex].path);
      if (images[challengerIndex]) loadClipMask(images[challengerIndex].path);
    } else if (images[currentIndex]) {
      loadClipMask(images[currentIndex].path);
    }
  }, [
    clippingVisible,
    compareMode,
    championIndex,
    challengerIndex,
    currentIndex,
    images,
    // .stage drives the retry-once-the-full-lands; the loader reads the url
    // itself, so the .url deps were just redundant re-fires (thumb-url→full-url).
    // cur.* is the LOUPE subscription, champShot/chalShot the COMPARE pair; the
    // off-mode subscription is pinned to "" (stable), so its dep is inert.
    cur.stage,
    champShot.stage,
    chalShot.stage,
    loadClipMask,
  ]);

  // Focus peaking: paint yellow on pixels whose luminance gradient is strong (in-
  // focus edges), transparent elsewhere. Same mechanics as the clipping mask —
  // computed off the downscaled preview, cached per path. Threshold tuned for
  // typical JPEG noise floors; bump it if peaking lights up smooth regions.
  const loadPeakingMask = useCallback(
    (path: string) => buildMask(path, "peak", requestedPeaks, setPeakingMasks),
    [buildMask],
  );

  // Mirror of the clipping effect: ensure peaking masks exist while P is on.
  useEffect(() => {
    if (!peakingVisible) {
      // Idempotent reset (see the clipping effect) — avoid a per-scrub-frame render.
      if (requestedPeaks.current.size > 0) requestedPeaks.current.clear();
      setPeakingMasks((prev) => (Object.keys(prev).length ? {} : prev));
      return;
    }
    if (compareMode) {
      if (images[championIndex]) loadPeakingMask(images[championIndex].path);
      if (images[challengerIndex]) loadPeakingMask(images[challengerIndex].path);
    } else if (images[currentIndex]) {
      loadPeakingMask(images[currentIndex].path);
    }
  }, [
    peakingVisible,
    compareMode,
    championIndex,
    challengerIndex,
    currentIndex,
    images,
    // .stage only (see the clipping effect) — .url deps were redundant re-fires.
    cur.stage,
    champShot.stage,
    chalShot.stage,
    loadPeakingMask,
  ]);

  // Compute an RGB histogram PNG for one image (cached by path). Computed from the
  // already-loaded THUMBNAIL (~160px) — a histogram is a distribution, so the tiny
  // sample is plenty, and it avoids decoding the 32 MP preview (which made it pop
  // in ~0.5s late). NOTE: it samples the downscaled thumb, NOT the full preview the
  // clipping overlay uses, so it's a coarse distribution and does not faithfully
  // resolve pixel-level clipping — use the clipping overlay (h) for that. Channels
  // are drawn additively (overlaps brighten); the 0/255 bins set the vertical scale.
  const loadHistogram = useCallback(
    (path: string) => {
      if (requestedHistograms.current.has(path)) return;
      const thumbUrl = imageStore.thumbUrl(path);
      if (!thumbUrl) return; // retried once the thumbnail loads
      requestedHistograms.current.add(path);
      const reqGen = imageStore.getGeneration();
      const probe = new Image();
      probe.onload = () => {
        if (imageStore.getGeneration() !== reqGen) {
          requestedHistograms.current.delete(path);
          return; // session changed mid-decode — don't write a stale histogram
        }
        const SAMPLE = 256;
        const scale = Math.min(1, SAMPLE / Math.max(probe.naturalWidth, probe.naturalHeight));
        const w = Math.max(1, Math.round(probe.naturalWidth * scale));
        const h = Math.max(1, Math.round(probe.naturalHeight * scale));
        const sc = document.createElement("canvas");
        sc.width = w;
        sc.height = h;
        const sctx = sc.getContext("2d", { willReadFrequently: true });
        if (!sctx) {
          requestedHistograms.current.delete(path);
          return;
        }
        sctx.drawImage(probe, 0, 0, w, h);
        const data = sctx.getImageData(0, 0, w, h).data;
        const r = new Uint32Array(256);
        const g = new Uint32Array(256);
        const b = new Uint32Array(256);
        for (let i = 0; i < data.length; i += 4) {
          r[data[i]]++;
          g[data[i + 1]]++;
          b[data[i + 2]]++;
        }
        let max = 1; // include the 0/255 bins so a clipping spike doesn't rescale away
        for (let v = 0; v < 256; v++) max = Math.max(max, r[v], g[v], b[v]);

        const HW = 256;
        const HH = 64;
        const hc = document.createElement("canvas");
        hc.width = HW;
        hc.height = HH;
        const hctx = hc.getContext("2d");
        if (!hctx) {
          requestedHistograms.current.delete(path);
          return;
        }
        hctx.globalCompositeOperation = "lighter"; // additive: R+G+B overlap → white
        const drawChannel = (bins: Uint32Array, color: string) => {
          hctx.fillStyle = color;
          hctx.beginPath();
          hctx.moveTo(0, HH);
          for (let v = 0; v < 256; v++) {
            const y = HH - Math.min(1, bins[v] / max) * HH;
            hctx.lineTo((v / 255) * HW, y);
          }
          hctx.lineTo(HW, HH);
          hctx.closePath();
          hctx.fill();
        };
        drawChannel(r, "rgba(239,68,68,0.65)");
        drawChannel(g, "rgba(16,185,129,0.65)");
        drawChannel(b, "rgba(59,130,246,0.65)");
        setHistograms((prev) => ({ ...prev, [path]: hc.toDataURL("image/png") }));
      };
      probe.onerror = () => requestedHistograms.current.delete(path);
      probe.src = thumbUrl;
    },
    [],
  );

  // Compute the RGB histogram for the on-screen image while the EXIF overlay is
  // open; drop the cache when it closes. Single view ONLY — the compare rail
  // renders no histogram, so computing one per champion/challenger was dead work.
  useEffect(() => {
    if (!exifVisible) {
      // Idempotent reset (see the clipping effect) — avoid a per-scrub-frame render.
      if (requestedHistograms.current.size > 0) requestedHistograms.current.clear();
      setHistograms((prev) => (Object.keys(prev).length ? {} : prev));
      return;
    }
    // The histogram is thumb-sourced, so (unlike clip/peak, which bail on
    // stage!=="full") it would recompute for every scrubbed-past frame. Skip
    // during scrub; the settle re-fires it via the scrubbing dep. Compare has no
    // histogram UI, so skip it there entirely.
    if (scrubbing || compareMode) return;
    if (images[currentIndex]) loadHistogram(images[currentIndex].path);
  }, [exifVisible, scrubbing, compareMode, currentIndex, images, cur.stage, loadHistogram]);

  // Bound the per-path overlay caches to a window around the cursor so leaving an
  // overlay on while arrowing through a long shoot doesn't accumulate a PNG per
  // visited frame. Skipped during scrub (overlays are hidden then). The requested
  // Set is pruned in lock-step, so a revisited frame recomputes its mask cleanly.
  useEffect(() => {
    if (scrubbing) return;
    if (
      requestedClipMasks.current.size === 0 &&
      requestedPeaks.current.size === 0 &&
      requestedHistograms.current.size === 0
    )
      return;
    const near = new Set<string>();
    const add = (i: number) => {
      const p = images[i]?.path;
      if (p) near.add(p);
    };
    for (let d = -OVERLAY_CACHE_KEEP; d <= OVERLAY_CACHE_KEEP; d++) add(currentIndex + d);
    if (compareMode) {
      add(championIndex);
      add(challengerIndex);
    }
    const pruneSet = (req: Set<string>) =>
      req.forEach((k) => {
        if (!near.has(k)) req.delete(k);
      });
    pruneSet(requestedClipMasks.current);
    pruneSet(requestedPeaks.current);
    pruneSet(requestedHistograms.current);
    const pruneRec = (rec: Record<string, string>) => {
      const keys = Object.keys(rec);
      if (keys.length === 0 || keys.every((k) => near.has(k))) return rec; // stable ref
      const next: Record<string, string> = {};
      for (const k of keys) if (near.has(k)) next[k] = rec[k];
      return next;
    };
    setClipMasks(pruneRec);
    setPeakingMasks(pruneRec);
    setHistograms(pruneRec);
  }, [currentIndex, images, scrubbing, compareMode, championIndex, challengerIndex]);

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
      return next;
    });
    setSavingCount((c) => c + 1);
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
      () => setSavingCount((c) => c - 1),
      (e) => {
        setSavingCount((c) => c - 1);
        // Only the latest write to this path may stamp a failure; a superseded
        // older write failing must not resurrect an "unsaved" flag the newer
        // (successful) write already cleared.
        if (isLatest()) {
          console.error(`${cmd} failed permanently`, path, e);
          setFailedWrites((f) => ({ ...f, [path]: rating }));
        }
      },
    );
  }, []);

  // Re-attempt every rating that exhausted its retries (triggered from the unsaved
  // indicator or the quit guard).
  const retryFailed = useCallback(() => {
    Object.entries(failedWrites).forEach(([path, rating]) => persistRating(path, rating));
  }, [failedWrites, persistRating]);

  // Keep the close-handler's mirrors current.
  useEffect(() => {
    savingRef.current = savingCount;
  }, [savingCount]);
  useEffect(() => {
    failedCountRef.current = failedCount;
  }, [failedCount]);

  // Quit guard: never let the window close while a rating is still saving or has
  // failed to save. Registered once; reads live state via refs. "cancel and warn"
  // = cancel the CLOSE, never the write.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    getCurrentWindow()
      .onCloseRequested((event) => {
        if (savingRef.current > 0 || failedCountRef.current > 0) {
          event.preventDefault();
          setQuitGuard(true);
        }
      })
      .then((u) => {
        unlisten = u;
      });
    return () => unlisten?.();
  }, []);

  // ── Drag-and-drop: drop a folder anywhere to open it ─────────────────────
  // Hover the window with a folder → render the champagne dashed overlay on
  // the home screen (the home content dims behind it). Drop → if the first
  // dropped path is a folder, open it. Drops are ignored while the cull view
  // is active (replacing the staged set mid-cull would lose state).
  // openFolderByPath is captured fresh each render; we mirror it into a ref so
  // the once-registered drag-drop listener uses the latest closure without
  // unsubscribing and re-subscribing on every render (which would race with
  // active drag events).
  const [isDragOver, setIsDragOver] = useState(false);
  const phaseRef = useRef(phase);
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);
  const openFolderByPathRef = useRef(openFolderByPath);
  useEffect(() => {
    openFolderByPathRef.current = openFolderByPath;
  }, [openFolderByPath]);

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
          const first = p.paths?.[0];
          if (typeof first === "string" && first.length > 0) {
            // Best-effort: invoke openFolderByPath; if the path is a file (not a
            // folder), Rust's scan_folder will error and we'll surface that as
            // a scan error via the regular failure path.
            openFolderByPathRef.current(first);
          }
        }
      })
      .then((u) => {
        unlisten = u;
      });
    return () => unlisten?.();
  }, []);

  // Once a guarded close has flushed everything, finish closing automatically.
  useEffect(() => {
    if (quitGuard && savingCount === 0 && failedCount === 0) {
      getCurrentWindow().destroy();
    }
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
    // Redo doesn't restore the cursor: the user's now in a fresh context and
    // re-applying the rating change there is the useful intent. Land on the
    // crowned/kept frame (last change) — not the rejected old champion (changes[0]).
    if (!compareMode) {
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
          }));
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

      recordAction({
        changes: [{ imgId: cur.id, path: cur.path, before: ratings[cur.id], after: rating }],
      });
      setRatings((prev) => ({ ...prev, [cur.id]: rating }));
      flashFeedback(rating, cur.id);
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
  const snapToFilter = useCallback(
    (idx: number): number => {
      if (idx < 0 || idx >= images.length) return idx;
      if (visibleIndices.length === 0) return idx;
      if (visibleIndices.indexOf(idx) !== -1) return idx;
      let best = visibleIndices[0];
      let bestDist = Math.abs(best - idx);
      for (const v of visibleIndices) {
        const d = Math.abs(v - idx);
        if (d < bestDist) {
          bestDist = d;
          best = v;
        }
      }
      return best;
    },
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
    (dir: 1 | -1): boolean => {
      const next = findUnrated(challengerIndex, dir, ratings, championIndex);
      if (next !== -1) {
        setChallengerIndex(next);
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
    });
    flashFeedback("reject", challImg.id);
    persistRating(challImg.path, "reject");
    const next: Record<number, Rating> = { ...ratings, [challImg.id]: "reject" };
    setRatings(next);
    const nextChallenger = nearestUnrated(challengerIndex, next, championIndex);
    if (nextChallenger === -1) {
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
    });
    flashFeedback("keep", challImg.id);
    persistRating(champImg.path, "reject"); // dethroned
    persistRating(challImg.path, "keep"); // crowned
    const next: Record<number, Rating> = {
      ...ratings,
      [champImg.id]: "reject",
      [challImg.id]: "keep",
    };
    setRatings(next);
    const newChamp = challengerIndex;
    setChampionIndex(newChamp);
    const nextChallenger = nearestUnrated(newChamp, next, newChamp);
    if (nextChallenger === -1) {
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
    (dir: 1 | -1): boolean => (compareMode ? cycleChallenger(dir) : advance(dir)),
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
        const moved = navStepRef.current(heldDirRef.current as 1 | -1);
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
  useEffect(() => {
    window.addEventListener("blur", stopHold);
    return () => {
      window.removeEventListener("blur", stopHold);
      stopHold();
    };
  }, [stopHold]);

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
      if (heldDirRef.current !== 0 || scrubbingRef.current) stopHold();
      setCurrentIndex(index);
    },
    [stopHold],
  );
  const pickChallengerFromStrip = useCallback(
    (index: number) => {
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
        if (next.has(i)) next.delete(i);
        else next.add(i);
        setSelectedIndices(next);
        // Anchor tracks the last-interacted cell, but null it when the toggle
        // emptied the set so a later shift-range can't extend from a
        // no-longer-selected anchor.
        setSelectionAnchor(next.size === 0 ? null : i);
        setCurrentIndex(i);
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
      if (phase === "staged" && e.key === "Enter") {
        e.preventDefault();
        beginCulling();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [settingsOpen, phase, pickFolder, beginCulling]);

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
        if (!e.repeat && !gridVisible) {
          // (a held scrub was already stopped by the interrupt guard above)
          setIsZooming(true);
          setZoomLevel(e.shiftKey ? 2 : 1); // Shift+Space → 2:1, plain Space → 1:1
          setPanOffset({ x: 0, y: 0 });
        }
        return;
      }

      // ESC is shared across all sites: it pops the nav stack (or, from loupe
      // with empty stack, opens the home-confirm). It's lifted out of the
      // mode-specific branches because the back-stack is global.
      if (e.key === "Escape") {
        e.preventDefault();
        goBack();
        return;
      }

      if (compareMode) {
        switch (e.key) {
          case "Enter":
            e.preventDefault();
            if (!e.repeat) challengerWins();
            break;
          case "Backspace":
            e.preventDefault();
            if (!e.repeat) challengerLoses();
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
        case "Enter":
          e.preventDefault();
          applyRating("keep");
          break;
        case "Backspace":
          e.preventDefault();
          applyRating("reject");
          break;
        case "f":
        case "F":
          applyRating("favorite");
          break;
        case "u":
        case "U":
          unrateCurrent(); // clear the rating, stay on the frame
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
      if (e.key === "ArrowRight" && heldDirRef.current === 1) stopHold();
      else if (e.key === "ArrowLeft" && heldDirRef.current === -1) stopHold();
      if (e.code === "Space") {
        resetZoom();
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
                onClick={() => getCurrentWindow().destroy()}
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
              <div className="cull-drag-indicator__text">Drop folder to open</div>
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
                  {pickerBusy ? "opening…" : "Open folder"}
                  <span className="cull-hero__cta-key">⌃ O</span>
                </button>
                <span className="cull-hero__drop-hint">or drop a folder anywhere</span>
              </div>
              <RecentFolders
                recents={recentFolders}
                onPick={openFolderByPath}
                pickerBusy={pickerBusy}
              />
              {lastSession && (
                <div className="cull-hero__summary">
                  <span className="cull-hero__summary-label">
                    last cull{lastSession.folder ? ` · ${lastSession.folder}` : ""}
                  </span>
                  <span className="cull-hero__summary-stats">
                    <span className="cull-count--keep">
                      {lastSession.keep + lastSession.favorites} kept
                    </span>
                    {lastSession.favorites > 0 && (
                      <span className="cull-count--fav">{lastSession.favorites}★</span>
                    )}
                    <span>{lastSession.rejected} rejected</span>
                    {lastSession.unrated > 0 && <span>{lastSession.unrated} left</span>}
                    <span className="cull-hero__summary-pct">
                      {Math.round(
                        ((lastSession.keep + lastSession.favorites) / lastSession.total) * 100,
                      )}
                      % kept
                    </span>
                  </span>
                </div>
              )}
              {scanError && (
                <pre className="cull-message__body cull-chrome__error">{scanError}</pre>
              )}
              <div className="cull-hero__how">
                <span>
                  <span className="cull-hero__how-key">⌃ ,</span>
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
                {images.length > 0 ? `${images.length} files · decoding first preview…` : "scanning…"}
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
              <div className="cull-chrome__folder cull-staged__folder">
                {lastAdded > 0
                  ? `+${lastAdded} from ${folderName}`
                  : `+0 from ${folderName} · no new CR3 files`}
              </div>
              {analyzeError && (
                <pre className="cull-message__body cull-chrome__error">{analyzeError}</pre>
              )}
              <div className="cull-staged__actions">
                <button
                  className="cull-pick-button cull-pick-button--ghost"
                  onClick={pickFolder}
                  disabled={pickerBusy}
                >
                  {pickerBusy ? "opening…" : "open another folder"}
                </button>
                {images.length > 0 && (
                  <button
                    className="cull-pick-button cull-pick-button--primary"
                    onClick={beginCulling}
                  >
                    begin culling →
                  </button>
                )}
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
  const afX = currentMeta?.afXPct ?? 50;
  const afY = currentMeta?.afYPct ?? 50;
  const originX = Math.max(0, Math.min(100, afX + panOffset.x));
  const originY = Math.max(0, Math.min(100, afY + panOffset.y));

  // Transform for the deferred full-res layer. Derived to reproduce the base
  // image's `scale(Z)` about (originX%, originY%) EXACTLY — but starting from the
  // native-pixel-size element, so it rasterizes at full resolution. Reusing the
  // measured imgRect makes it pixel-aligned with the base by construction, so the
  // layer can appear/disappear without any visible shift.
  // True-1:1 scale: rendering the displayed image at this factor lands one image
  // pixel per screen pixel (when fit, displayed = naturalSize × fit-ratio; this
  // un-does the fit). Falls back to 5× if dimensions aren't known yet.
  const oneToOneScale = naturalSize && imgRect ? naturalSize.w / imgRect.width : 5;
  const zoomZ = isZooming ? zoomLevel * oneToOneScale : 1;
  const hiResScale = imgRect && naturalSize ? (imgRect.width / naturalSize.w) * zoomZ : 1;
  // The hi-res layer lives INSIDE the content-clip box (at 0,0 — the clip IS
  // exactly the displayed image area), so we only need the origin offset INSIDE
  // the image area. imgRect.width/height still report the displayed image's size.
  const hiResTx = imgRect ? (originX / 100) * imgRect.width * (1 - zoomZ) : 0;
  const hiResTy = imgRect ? (originY / 100) * imgRect.height * (1 - zoomZ) : 0;

  // Frame size source: the orientation-correct THMB display dims (w/h > 1 guards
  // the {1,1} UNKNOWN sentinel), else the current full's measured naturalSize
  // ({1,1}-THMB edge case), else a NEUTRAL SQUARE while the aspect is unknown.
  // naturalSize is reset on navigation (below), so it never leaks the previous
  // image's aspect into a fresh shimmer. Drives BOTH --photo-ar and the sizer.
  const frameDims =
    cur.dims && cur.dims.w > 1 && cur.dims.h > 1
      ? cur.dims
      // Large square (not 1×1): the sizer fills the matte by clamping its
      // intrinsic size DOWN to the stage, so the fallback must EXCEED the stage
      // — a square fills the stage height (width = height), like a portrait.
      : (naturalSize ?? { w: 10000, h: 10000 });
  const photoAr = `${frameDims.w} / ${frameDims.h}`;

  const singleModeBody = (
      <div className="cull-stage">
        <div className="cull-loupe-body">
        <div className="cull-image-area" ref={stageRef}>
        {images.length === 0 ? (
          <div className="cull-message">no images</div>
        ) : positionInFilter === -1 ? (
          <EmptyFilter filter={filter} />
        ) : cur.stage === "shimmer" && cur.error ? (
          // Full-screen error only when there's NO thumb to fall back to. If a
          // thumb exists, resolveStage keeps stage "thumb" (with error set) and
          // we keep showing it rather than blanking the frame.
          <div className="cull-message">
            <div className="cull-message__title">preview failed</div>
            <pre className="cull-message__body">{cur.error}</pre>
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
              {/* Sizer: an in-flow transparent replaced element whose intrinsic
                  dims equal the KNOWN display ratio (frameDims). It alone sizes
                  the matte (replaced-element contain), so the frame never shrinks
                  to the tiny THMB pixels and never collapses while the full <img>
                  decodes (intrinsic 0). The pixels below are an absolute overlay. */}
              <img
                className="cull-photo-frame__sizer"
                src={sizerSrc(frameDims.w, frameDims.h)}
                alt=""
                aria-hidden
              />
              <img
                ref={imgRef}
                className="cull-image"
                // During a scrub prefer the thumb so we don't show/decode the
                // sharp full even when it's already cached (showFull is false
                // mid-scrub). When not scrubbing, cur.url is already the best
                // available source (full or thumb per store logic).
                src={
                  showFull
                    ? cur.url
                    : scrubbing && cur.stage === "full"
                      ? (imageStore.thumbUrl(images[currentIndex]?.path ?? "") ?? cur.url)
                      : cur.url
                }
                alt=""
                onLoad={(e) => {
                  // Only update naturalSize from the FULL preview, not the
                  // thumbnail fallback — otherwise the matte would briefly
                  // shrink to the tiny thumbnail's dimensions during scrub
                  // or load. Gate on showFull so a scrub never updates naturalSize.
                  if (showFull) {
                    setMeasureNonce((n) => n + 1);
                    setNaturalSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight });
                    setPaintedFullUrl(cur.url ?? null);
                  }
                }}
                style={{
                  transform: isZooming ? `scale(${zoomZ})` : undefined,
                  transformOrigin: `${originX}% ${originY}%`,
                  transition: "transform 200ms ease-out, filter 200ms ease-out",
                  // object-fit: cover for the low-res — the THMB's ~4:3 shape would
                  // letterbox SMALLER than the 3:2 matte under contain; cover fills
                  // it (the crop is invisible under the blur). contain for the full.
                  objectFit: fullPainted ? "contain" : "cover",
                  // Blur until the full has actually PAINTED (fullPainted), not
                  // merely when the stage flips to "full" — so the low-res never
                  // flashes sharp before the full appears. Transition fades focus in.
                  filter: fullPainted ? undefined : "blur(14px) brightness(0.78)",
                }}
              />
              {/* First load: a skeleton shimmer fills the (now definitely-
                  sized) matte so the frame reads at the photo's true size
                  instead of collapsing to nothing while we wait on disk. */}
              {cur.stage === "shimmer" && (
                <div
                  className="cull-photo-frame__shimmer"
                  aria-hidden
                  style={{ ["--shimmer-delay" as string]: `-${loupeShimmerDelay}ms` }}
                />
              )}
              {/* Spinner overlay shows only while the full is genuinely still
                  loading — i.e. we have the thumb but not yet the full. Once the
                  store HAS the full (cur.stage === "full"), we skip it even
                  though `fullPainted` lags a frame or two behind: for a cached
                  full that gap would flash the spinner for ~0.1s over an image
                  that's already there. The blur fade alone covers the paint gap.
                  At shimmer the skeleton is the indicator; during scrub the
                  blurred thumb stands in, so a spinner there is just noise. */}
              {cur.stage === "thumb" && !scrubbing && (
                <div className="cull-photo-frame__spinner-wrap" aria-hidden>
                  <div className="cull-loading__spinner" />
                </div>
              )}
              {/* Deferred full-res layer: same blob, rendered at native pixel size and
                  transformed to coincide with the base image, so the compositor holds a
                  full-resolution raster and zoom is sharp immediately. Mounts only after
                  the cursor settles (profile.hiResSettleMs — 50ms local / 150ms
                  network); the base image stays beneath as the
                  instant-nav fallback. Gated on the full preview being ready too —
                  the thumbnail fallback isn't worth pinning a hi-res raster of. */}
              {hiRes && !clippingVisible && imgRect && naturalSize && cur.stage === "full" && cur.url && (
                <img
                  className="cull-image cull-image--hires"
                  src={cur.url}
                  alt=""
                  aria-hidden
                  style={{
                    position: "absolute",
                    left: 10,
                    top: 10,
                    width: naturalSize.w,
                    height: naturalSize.h,
                    maxWidth: "none",
                    maxHeight: "none",
                    transformOrigin: "0 0",
                    transform: `translate(${hiResTx}px, ${hiResTy}px) scale(${hiResScale})`,
                    transition: "transform 200ms ease-out",
                    pointerEvents: "none",
                    willChange: "transform",
                  }}
                />
              )}
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
              {clippingVisible && !scrubbing && current && clipMasks[current.path] && (
                <img
                  className="cull-clip-overlay"
                  src={clipMasks[current.path]}
                  alt=""
                  style={{
                    transform: isZooming ? `scale(${zoomZ})` : undefined,
                    transformOrigin: `${originX}% ${originY}%`,
                    transition: "transform 200ms ease-out",
                  }}
                />
              )}
              {peakingVisible && !scrubbing && current && peakingMasks[current.path] && (
                <img
                  className="cull-peaking-overlay"
                  src={peakingMasks[current.path]}
                  alt=""
                  style={{
                    transform: isZooming ? `scale(${zoomZ})` : undefined,
                    transformOrigin: `${originX}% ${originY}%`,
                    transition: "transform 200ms ease-out",
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
            {/* Verdict is now shown in the bottom status bar's pill; the floating
                corner dot is dropped to avoid duplicate signaling and to keep the
                stage clean alongside the EXIF rail. */}
          </>
        )}
        </div>
        {exifVisible && current && (
          <ExifRail
            metadata={currentMeta}
            histogramUrl={histograms[current.path]}
            cullRating={currentRating}
          />
        )}
        </div>
      </div>
  );

  // Build the bottom status bar JSX once so it renders inside each view's
  // flex column AFTER the thumb strip (mockup puts it as the last row, with
  // border-top — see mockup .status). The top chrome row above just holds
  // the brand block and window controls, like a title bar.
  //
  // Layout (left → right) matches the mockup exactly:
  //   filename · MP  ·  verdict pill (glyph + label)
  //   overlay cluster (i h p o t — circular toggle chips, on/off state)
  //   <spacer>
  //   position N / M  ·  filter tabs (loupe + grid)  ·  finish button
  // In compare mode the status bar's filename + MP follows the CHALLENGER —
  // the frame the user is actively judging — not the current cursor (which
  // would track the champion). Single-view shows the cursor's frame.
  const statusBarImg = compareMode ? images[challengerIndex] : current;
  const statusBarMeta = statusBarImg ? metadata[statusBarImg.path] : undefined;
  const mp =
    statusBarMeta?.pixelWidth && statusBarMeta?.pixelHeight
      ? `${(((statusBarMeta.pixelWidth * statusBarMeta.pixelHeight) / 1e6) | 0)} MP`
      : null;
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
            {mp && (
              <>
                <span className="cull-statusbar__filename-sep">·</span>
                <span className="cull-statusbar__filename-meta">{mp}</span>
              </>
            )}
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
              ★
            </button>
          </div>
        )}
        {(stats.keeps > 0 || rejectedPaths.length > 0) && !actionsOpen && (
          <button
            type="button"
            className="cull-statusbar__finish"
            onClick={() => setActionsOpen(true)}
            title="finish the cull — move rejects / copy keeps"
          >
            ⌃E · {totalKeeps} keeps
          </button>
        )}
      </div>
    </footer>
  );

  return (
    <main className="cull-app" data-thumbs-pos={settings.thumbsPosition}>
      {quitGuardOverlay}
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
        </div>
      </header>

      {compareMode ? (
        <>
          {thumbsVisible && settings.thumbsPosition === "top" && (
            <CompareStrip
              images={images}
              candidates={compareCandidates}
              championIndex={championIndex}
              challengerIndex={challengerIndex}
              metadata={metadata}
              onPickChallenger={pickChallengerFromStrip}
            />
          )}
          <CompareView
            images={images}
            championIndex={championIndex}
            challengerIndex={challengerIndex}
            metadata={metadata}
            clipMasks={clipMasks}
            peakingMasks={peakingMasks}
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
          />
          {thumbsVisible && settings.thumbsPosition !== "top" && (
            <CompareStrip
              images={images}
              candidates={compareCandidates}
              championIndex={championIndex}
              challengerIndex={challengerIndex}
              metadata={metadata}
              onPickChallenger={pickChallengerFromStrip}
            />
          )}
          {bottomStatusBar}
        </>
      ) : gridVisible ? (
        <>
          {visibleIndices.length === 0 ? (
            <EmptyFilter filter={filter} />
          ) : (
          <GridView
            images={images}
            visibleIndices={visibleIndices}
            currentIndex={currentIndex}
            cols={gridCols}
            ratings={ratings}
            metadata={metadata}
            selectedIndices={selectedIndices}
            onPick={handleGridPick}
            containerRef={gridContainerRef}
            onViewportChange={handleGridViewport}
          />
          )}
          {bottomStatusBar}
        </>
      ) : (
        <>
          {thumbsVisible && settings.thumbsPosition === "top" && (
            <ThumbStrip
              images={images}
              currentIndex={currentIndex}
              ratings={ratings}
              visibleIndices={visibleIndices}
              metadata={metadata}
              onPick={pickFromStrip}
            />
          )}
          {singleModeBody}
          {thumbsVisible && settings.thumbsPosition !== "top" && (
            <ThumbStrip
              images={images}
              currentIndex={currentIndex}
              ratings={ratings}
              visibleIndices={visibleIndices}
              metadata={metadata}
              onPick={pickFromStrip}
            />
          )}
          {bottomStatusBar}
        </>
      )}

      {feedback && (
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
                ? `${failedCount} rating${failedCount > 1 ? "s have" : " has"} not saved to disk yet (the sidecar write keeps failing). Leaving won't lose ${failedCount > 1 ? "them" : "it"} from the retry queue, but it's safer to stay and retry first. Saved picks live in .xmp sidecars.`
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
 * matches. Matches the mockup's `.empty-state.empty-filter` block: small icon,
 * uppercase eyebrow, headline with the missing filter highlighted, and a key
 * hint to switch out.
 */
function EmptyFilter({ filter }: { filter: Filter }) {
  // Label the user-facing filter name. "All" can never actually be empty (it
  // includes unrated), so falling back to "this" covers the impossible-case.
  const label =
    filter === "favorites"
      ? "★"
      : filter === "keeps"
        ? "Keeps"
        : filter === "unrated"
          ? "Unrated"
          : "this";
  return (
    <div className="cull-empty-state">
      <div className="cull-empty-state__icon">⌀</div>
      <div className="cull-empty-state__eyebrow">No matches</div>
      <div className="cull-empty-state__title">
        No images in the <em>{label}</em> filter
      </div>
      <div className="cull-empty-state__hint">
        <kbd>1</kbd> for all · <kbd>2</kbd> for unrated
      </div>
    </div>
  );
}

/**
 * Recent-folders section on the home screen. Renders nothing on a totally
 * fresh launch (empty state replaces the list, per the mockup). Click a row
 * to re-open that folder; rows that don't have a `count` yet hide the count
 * column rather than show a stub `0`.
 *
 * The mockup uses three columns: path (middle-truncated), count badge
 * (`327 / 372`, plain `421`, or `932 ✓`), and a relative-time stamp.
 */
function RecentFolders({
  recents,
  onPick,
  pickerBusy,
}: {
  recents: RecentEntry[];
  onPick: (path: string) => void;
  pickerBusy: boolean;
}) {
  return (
    <div className="cull-recent">
      <div className="cull-recent__label">Recent</div>
      {recents.length === 0 ? (
        <div className="cull-recent__empty">
          No folders yet. Drop one anywhere, or press{" "}
          <kbd className="cull-recent__kbd">⌃ O</kbd>.
        </div>
      ) : (
        <div className="cull-recent__items">
          {recents.map((r) => (
            <RecentRow
              key={r.path}
              entry={r}
              onPick={() => !pickerBusy && onPick(r.path)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function RecentRow({ entry, onPick }: { entry: RecentEntry; onPick: () => void }) {
  // Truncate at ~52 chars — leaves room for the count + time columns at the
  // mockup's 620px hero width and keeps both the drive letter (head) and the
  // leaf folder name (tail) visible.
  const display = middleTruncate(entry.path, 52);
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
      title={entry.path}
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
