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
  PreviewEntry,
  Rating,
  SessionSummary,
  UndoAction,
} from "./types";
import "./App.css";

import { CompareStrip } from "./components/CompareStrip";
import { CompareView } from "./components/CompareView";
import { ExifRail } from "./components/ExifRail";
import { FinishDialog } from "./components/FinishDialog";
import { GridView, GRID_CELL_TARGET } from "./components/GridView";
import { HelpOverlay } from "./components/HelpOverlay";
import { SettingsDialog } from "./components/SettingsDialog";
import { STRIP_RADIUS } from "./components/ThumbCell";
import { ThumbStrip } from "./components/ThumbStrip";
import { WindowControls } from "./components/WindowControls";

import { useRecents, type RecentEntry } from "./hooks/useRecents";
import { useSettings } from "./hooks/useSettings";

import { PERFORMANCE_PROFILES } from "./types/settings";
import {
  fetchBundle,
  fetchThumbnail,
  fetchBlurhash,
  blurhashToDataUrl,
  type BlurInfo,
} from "./utils/bundle";
import { loadBlurCache, saveBlurCache } from "./utils/blurhashCache";
import { passesFilter } from "./utils/filter";
import { formatRelativeTime, middleTruncate } from "./utils/format";
import { basename } from "./utils/path";
import { RATING_COLOR } from "./utils/ratingColor";

// PREFETCH_AHEAD / PREFETCH_BEHIND / PREVIEW_KEEP / HIRES_SETTLE_MS / read-pool
// caps + concurrent XMP restore all live in PERFORMANCE_PROFILES, switched by
// the storage-mode setting. Read at point-of-use through `profile`.
// Memory bounds for 10k-folder sessions: keep only a window of decoded blobs
// around the cursor and revoke the rest. Previews are the full-resolution
// embedded JPEG (~5–6 MB each), so this window (~37 held ≈ 200 MB) is the main
// memory knob — lower it if RAM is tight, raise it for more backward-scrub cache.
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

/** Decode a BlurHash to a data URL, cached process-wide by hash. Deliberately a
 * plain function, NOT a hook: the loupe's `curBlur` is computed AFTER the
 * component's `if (phase !== "culling") return …` early return, so using
 * `useMemo` there changed the hook count between the home and culling phases and
 * crashed React (black screen on entering the loupe). */
const blurDecodeCache = new Map<string, string | null>();
function decodeBlurCached(info: BlurInfo | undefined): string | undefined {
  if (!info) return undefined;
  if (!blurDecodeCache.has(info.hash)) {
    blurDecodeCache.set(info.hash, blurhashToDataUrl(info.hash, info.w / info.h));
  }
  return blurDecodeCache.get(info.hash) ?? undefined;
}

export default function App() {
  const [phase, setPhase] = useState<Phase>("start");
  const [folder, setFolder] = useState<string | null>(null);
  const [images, setImages] = useState<Img[]>([]);
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

  const [previews, setPreviews] = useState<Record<string, PreviewEntry>>({});
  const requestedPreviews = useRef<Set<string>>(new Set());
  const [metadata, setMetadata] = useState<Record<string, ImageMetadata>>({});
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  // Per-image BlurHash placeholder data: the hash + DISPLAY dims (orientation-
  // adjusted). Populated by the thumbnail pool AND a background warm pass, so
  // EVERY frame (grid / strip / loupe-load) has a correctly-shaped placeholder,
  // not just thumbnails that happen to have loaded. The frame aspect ratio comes
  // from these authoritative EXIF dims (not the frozen full-preview naturalSize),
  // and the ~25-byte hash decodes to a data URL lazily, per-component. The ref
  // mirror lets the warm pass + loaders skip already-known paths without
  // re-subscribing.
  const [blurhashes, setBlurhashes] = useState<Record<string, BlurInfo>>({});
  const blurhashesRef = useRef(blurhashes);
  useEffect(() => {
    blurhashesRef.current = blurhashes;
  }, [blurhashes]);
  const requestedThumbs = useRef<Set<string>>(new Set());

  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const feedbackTimer = useRef<number | null>(null);

  // Grid container — shared between GridView (for layout/scroll) and the cols-
  // computing ResizeObserver below (so the keydown handler can step by row).
  // We depend on `gridVisible && !compareMode` rather than just gridVisible:
  // when the user enters compare from grid, GridView unmounts behind compare's
  // overlay and the DOM node we're observing is detached. On exit, GridView
  // re-mounts with a NEW node. Without including compareMode in the deps the
  // observer would keep watching the dead node and gridCols would never update
  // on a window resize during the second grid session.
  const gridContainerRef = useRef<HTMLDivElement>(null);
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
  }, [gridVisible, compareMode]);

  // Mirror gridVisible into a ref so pumpThumbs (which runs from rAF / settle
  // callbacks, outside the React render cycle) can switch its prioritisation.
  useEffect(() => {
    gridVisibleRef.current = gridVisible;
    if (!gridVisible) gridViewportRef.current = null;
  }, [gridVisible]);

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

  // Measured rect of the displayed image (relative to the stage), used to align
  // pixel-accurate overlays like the clipping mask to the letterboxed image.
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

  const visibleIndices = useMemo(() => {
    return images.map((_, i) => i).filter((i) => passesFilter(ratings[images[i].id], filter));
  }, [images, ratings, filter]);

  // Memoized: this O(n) indexOf used to run on EVERY render (incl. every
  // ~30 Hz scrub frame); now only when the filter list or cursor actually moves.
  const positionInFilter = useMemo(
    () => visibleIndices.indexOf(currentIndex),
    [visibleIndices, currentIndex],
  );

  // Compare-mode candidate strip: every UNRATED frame except the champion (which
  // is pinned separately). The challenger is always one of these. Drives both the
  // bottom strip and its thumbnail eviction window, so only unrated frames show —
  // independent of the active `filter`, which is left untouched and restored on exit.
  const compareCandidates = useMemo(() => {
    if (!compareMode) return [];
    return images.map((_, i) => i).filter((i) => i !== championIndex && !ratings[images[i].id]);
  }, [compareMode, images, ratings, championIndex]);

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

  // ── Bounded NAS read pool ─────────────────────────────────────────────────
  // A latency-bound NAS thrashes when hit with many simultaneous reads: opening a
  // folder / jumping mounts ~200 filmstrip cells + warms previews → hundreds of
  // reads at once, starving the on-screen image for 10–20s. So all reads go
  // through two small bounded pools (preview bundles + tiny thumbnails), with the
  // on-screen image dispatched first.
  const bundleQueue = useRef<{ path: string; prio: number }[]>([]);
  const bundleInFlight = useRef(0);
  const bundleHighInFlight = useRef(0); // prio-0 (on-screen) bundles in flight
  const thumbQueue = useRef<{ path: string; index: number }[]>([]);
  const thumbInFlight = useRef(0);
  // The whole performance profile lives in a ref so pumps + effects that
  // run outside the React render cycle see live values when the storage
  // setting flips. In-flight reads finish at the old caps; the new caps
  // apply on the next pumped pick (no restart, no queue flush).
  const profile = PERFORMANCE_PROFILES[settings.storageMode];
  const profileRef = useRef(profile);
  useEffect(() => {
    profileRef.current = profile;
  }, [profile]);
  const currentIndexRef = useRef(0);
  // Grid mode flips the thumbnail prioritisation: cells inside the current
  // viewport (book order within the window) win over cells outside it. The
  // viewport range is reported by GridView via a ref so pumpThumbs — which
  // runs outside React's render cycle — can see it without re-rendering.
  const gridVisibleRef = useRef(false);
  const gridViewportRef = useRef<{ first: number; last: number } | null>(null);
  // Thumbnail prioritization (nearest-first) follows what's actually on screen:
  // the challenger in compare, the cursor otherwise.
  useEffect(() => {
    currentIndexRef.current = compareMode ? challengerIndex : currentIndex;
  }, [currentIndex, compareMode, challengerIndex]);

  // One file open yields the full-res preview + metadata (see read_bundle); the
  // bundle pool calls this. Thumbnails are loaded separately so the fast thumbnail
  // read isn't blocked by this 12 MB read (that's what feeds the blur placeholder).
  const loadImageRaw = useCallback((path: string, onSettle: () => void) => {
    requestedPreviews.current.add(path);
    setPreviews((p) => ({ ...p, [path]: { status: "loading" } }));
    fetchBundle(path)
      .then(({ previewUrl, meta }) => {
        setPreviews((p) => {
          const existing = p[path];
          if (existing && existing.status === "ready") {
            // A concurrent load (e.g. across an evict-then-reload window) already
            // populated this path. Don't clobber its URL — that would leak the
            // blob; drop the just-fetched duplicate instead. Mirrors the
            // thumbnail loader's guard.
            if (existing.url !== previewUrl) URL.revokeObjectURL(previewUrl);
            return p;
          }
          return { ...p, [path]: { status: "ready", url: previewUrl } };
        });
        if (meta) setMetadata((m) => ({ ...m, [path]: meta }));
      })
      .catch((e) => {
        setPreviews((p) => ({ ...p, [path]: { status: "error", error: String(e) } }));
        requestedPreviews.current.delete(path);
      })
      .finally(onSettle);
  }, []);

  // Small thumbnail-only read; the thumbnail pool calls this.
  const loadThumbnailRaw = useCallback((path: string, onSettle: () => void) => {
    requestedThumbs.current.add(path);
    fetchThumbnail(path)
      .then(({ url, blurhash, width, height }) => {
        setThumbnails((t) => {
          if (t[path]) {
            URL.revokeObjectURL(url);
            return t;
          }
          return { ...t, [path]: url };
        });
        // Store the hash + DISPLAY dims so every consumer (loupe / strip / grid)
        // can place a correctly-shaped blurhash and read the aspect ratio.
        if (blurhash && width && height) {
          setBlurhashes((b) =>
            b[path] ? b : { ...b, [path]: { hash: blurhash, w: width, h: height } },
          );
        }
      })
      .catch(() => requestedThumbs.current.delete(path))
      .finally(onSettle);
  }, []);

  const pumpBundles = useCallback(() => {
    while (bundleInFlight.current < profileRef.current.bundleConcurrency && bundleQueue.current.length > 0) {
      let bi = 0; // lowest prio number = highest priority
      for (let i = 1; i < bundleQueue.current.length; i++) {
        if (bundleQueue.current[i].prio < bundleQueue.current[bi].prio) bi = i;
      }
      // Hold prefetch (prio ≥ 1) while an on-screen frame (prio 0) is still in
      // flight, so the current image gets the NAS to itself (full bandwidth)
      // instead of sharing it with prefetch reads.
      if (bundleQueue.current[bi].prio >= 1 && bundleHighInFlight.current > 0) break;
      const { path, prio } = bundleQueue.current.splice(bi, 1)[0];
      if (requestedPreviews.current.has(path)) continue;
      bundleInFlight.current += 1;
      if (prio < 1) bundleHighInFlight.current += 1;
      loadImageRaw(path, () => {
        bundleInFlight.current -= 1;
        if (prio < 1) bundleHighInFlight.current -= 1;
        pumpBundles();
      });
    }
  }, [loadImageRaw]);

  const pumpThumbs = useCallback(() => {
    while (thumbInFlight.current < profileRef.current.thumbConcurrency && thumbQueue.current.length > 0) {
      const gridMode = gridVisibleRef.current;
      const c = currentIndexRef.current;
      const vp = gridMode ? gridViewportRef.current : null;
      // Pass 1: cells inside the current grid viewport, lowest absolute index
      // first (book order within the visible window). The queue can carry
      // off-screen entries left over from before a scroll/jump — those wait.
      let bi = -1;
      if (vp) {
        for (let i = 0; i < thumbQueue.current.length; i++) {
          const idx = thumbQueue.current[i].index;
          if (idx >= vp.first && idx <= vp.last) {
            if (bi === -1 || idx < thumbQueue.current[bi].index) bi = i;
          }
        }
      }
      // Pass 2: nothing in the viewport (or not in grid mode). Loupe/compare
      // pick nearest-the-cursor; grid falls back to lowest-index book order.
      if (bi === -1) {
        bi = 0;
        for (let i = 1; i < thumbQueue.current.length; i++) {
          const better = gridMode
            ? thumbQueue.current[i].index < thumbQueue.current[bi].index
            : Math.abs(thumbQueue.current[i].index - c) <
              Math.abs(thumbQueue.current[bi].index - c);
          if (better) bi = i;
        }
      }
      const { path } = thumbQueue.current.splice(bi, 1)[0];
      if (requestedThumbs.current.has(path)) continue;
      thumbInFlight.current += 1;
      loadThumbnailRaw(path, () => {
        thumbInFlight.current -= 1;
        pumpThumbs();
      });
    }
  }, [loadThumbnailRaw]);

  // Replace the bundle queue with a fresh window around the cursor (dropping stale,
  // not-yet-started entries), then pump. In-flight reads keep running.
  const scheduleBundles = useCallback(
    (items: { path: string; prio: number }[]) => {
      bundleQueue.current = items.filter((it) => !requestedPreviews.current.has(it.path));
      pumpBundles();
    },
    [pumpBundles],
  );

  // Background BlurHash warm pass: after a folder opens, progressively fetch the
  // hash + display dims for EVERY frame (cursor-outward priority) so the grid,
  // strip, and loupe/compare load placeholders are correctly shaped for the whole
  // shoot — without blocking the (mtime fast-path) analyze. Low concurrency so it
  // never starves the on-screen thumbnail/preview reads on a NAS. Cancels +
  // restarts when the staged set changes (new folder). Results are batch-flushed
  // (~250ms) so 5k tiny updates don't thrash React.
  useEffect(() => {
    if (phase !== "culling" || images.length === 0 || !folder) return;
    let cancelled = false;
    // Everything we know for this folder (persisted cache + warmed this session) —
    // used to skip already-known frames and to persist back.
    const known: Record<string, BlurInfo> = { ...loadBlurCache(folder) };
    let dirty = false;
    // Instant population from the persisted cache (CR3s are immutable, so a
    // path-keyed cache never goes stale). Live entries win — don't clobber fresher.
    if (Object.keys(known).length > 0) {
      setBlurhashes((prev) => ({ ...known, ...prev }));
    }
    const pending: Record<string, BlurInfo> = {};
    let flushTimer: number | null = null;
    const flush = () => {
      flushTimer = null;
      const keys = Object.keys(pending);
      if (cancelled || keys.length === 0) return;
      setBlurhashes((prev) => {
        const next = { ...prev };
        for (const k of keys) next[k] = pending[k];
        return next;
      });
      for (const k of keys) delete pending[k];
    };
    const scheduleFlush = () => {
      if (flushTimer == null) flushTimer = window.setTimeout(flush, 250);
    };
    const persist = () => {
      if (dirty) saveBlurCache(folder, { ...blurhashesRef.current, ...known });
    };
    // Cursor-outward order so the visible area fills first.
    const center = currentIndexRef.current;
    const order = images.map((_, i) => i).sort((a, b) => Math.abs(a - center) - Math.abs(b - center));
    let cursor = 0;
    const WARM_CONCURRENCY = 4;
    const worker = async (): Promise<void> => {
      while (!cancelled) {
        const oi = cursor++;
        if (oi >= order.length) return;
        const path = images[order[oi]].path;
        if (known[path] || blurhashesRef.current[path] || pending[path]) continue;
        try {
          const { blurhash, width, height } = await fetchBlurhash(path);
          if (!cancelled && blurhash && width && height) {
            const info = { hash: blurhash, w: width, h: height };
            known[path] = info;
            pending[path] = info;
            dirty = true;
            scheduleFlush();
          }
        } catch {
          // skip — a frame without a placeholder just shows the shimmer.
        }
      }
    };
    void Promise.all(Array.from({ length: WARM_CONCURRENCY }, () => worker())).then(() => {
      flush();
      persist();
    });
    return () => {
      cancelled = true;
      if (flushTimer != null) clearTimeout(flushTimer);
      persist(); // persist progress on folder change / unmount
    };
  }, [phase, images, folder]);

  // Enqueue one filmstrip thumbnail (deduped). `index` drives nearest-first order.
  const loadThumbnail = useCallback(
    (path: string, index = 0) => {
      if (requestedThumbs.current.has(path) || thumbQueue.current.some((t) => t.path === path)) {
        return;
      }
      thumbQueue.current.push({ path, index });
      pumpThumbs();
    },
    [pumpThumbs],
  );

  /**
   * Scan a known folder path and stage its CR3s. Same logic as `pickFolder`
   * minus the OS picker — used both by `pickFolder` after the user picks, and
   * by the launch-time "open last folder" effect.
   */
  const openFolderByPath = useCallback(
    async (picked: string) => {
      setPickerBusy(true);
      setScanError(null);
      try {
        localStorage.setItem("cull:lastDir", picked);
        setPhase("loading");

        const paths = await invoke<string[]>("scan_folder", { path: picked });

        // APPEND, never replace. Add only paths not already staged, preserving
        // existing images, ratings, and loaded previews. An empty folder
        // appends nothing rather than wiping the set.
        const existing = new Set(images.map((im) => im.path));
        const additions = paths.filter((p) => !existing.has(p));
        const startId = images.length;
        const appended = additions.map((p, i) => ({
          id: startId + i,
          path: p,
          filename: basename(p),
        }));
        setImages((prev) => [...prev, ...appended]);
        setLastAdded(additions.length);
        setFolder(picked);

        // Push to the home-screen recents list (or refresh an existing entry).
        // `rated` + `done` only become accurate after `analyze_folder` reads
        // the sidecars, so we leave them at zero/false here and let the cull
        // exit (leaveToHome) — or the analyze pass itself — update them.
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
        setScanError(String(e));
        // Folder is gone / unreadable — drop it from recents so the home screen
        // doesn't keep advertising a path that no longer opens.
        removeRecent(picked);
        setPhase(images.length > 0 ? "staged" : "start");
      } finally {
        setPickerBusy(false);
      }
    },
    [images, pushRecent, removeRecent],
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

  // Begin culling: sort the staged set by capture time, restore ratings, then
  // enter the cull view (warming the first screenful of previews first).
  const beginCulling = useCallback(async () => {
    if (images.length === 0) return;
    setLastSession(null); // starting a new cull → drop the previous session's recap
    setProgress({ done: 0, total: images.length, phase: "reading" });
    setPhase("analyzing");
    const unlisten = await listen<AnalyzeProgress>("analyze-progress", (e) => setProgress(e.payload));
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
          seededMeta[images[origIdx].path] = {
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
            lrcRating: lrc,
          };
        }
      });

      // ids ride along, so the rating map stays valid post-sort.
      setImages(sorted);
      setRatings(restoredRatings);
      setMetadata((prev) => ({ ...seededMeta, ...prev }));

      // Refresh the home-screen recents entry with the restored rated count
      // straight off the sidecar pass — so reopening home shows "327 / 372"
      // immediately, even before the user touches a key in the new session.
      if (folder) {
        const ratedNow = Object.keys(restoredRatings).length;
        pushRecent({
          path: folder,
          count: sorted.length,
          rated: ratedNow,
          lastOpened: new Date().toISOString(),
          done: sorted.length > 0 && ratedNow === sorted.length,
        });
      }

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
      console.error("analyze_folder failed; proceeding unsorted", e);
    } finally {
      unlisten();
      setPhase("culling");
    }
  }, [images, profile.concurrentRestore, settings, folder, pushRecent]);

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

  // Esc out of review → discard the in-memory session and return Home. Ratings
  // live on in the .xmp sidecars, so reopening the folder restores them.
  const resetSession = useCallback(() => {
    setPreviews((prev) => {
      Object.values(prev).forEach((e) => e.status === "ready" && URL.revokeObjectURL(e.url));
      return {};
    });
    setThumbnails((prev) => {
      Object.values(prev).forEach((url) => URL.revokeObjectURL(url));
      return {};
    });
    requestedPreviews.current.clear();
    requestedThumbs.current.clear();
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
    setLastAdded(0);
    setClippingVisible(false);
    setClipMasks({});
    requestedClipMasks.current.clear();
    setExifVisible(false);
    setIsZooming(false);
    setPanOffset({ x: 0, y: 0 });
    setFeedback(null);
    setPhase("start");
  }, []);

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
    // Refresh the recents entry with this session's final counts so the home
    // list reflects what the user just finished (rated count + done badge).
    if (folder && total > 0) {
      const ratedNow = total - stats.unrated;
      pushRecent({
        path: folder,
        count: total,
        rated: ratedNow,
        lastOpened: new Date().toISOString(),
        done: ratedNow === total,
      });
    }
    setConfirmHome(false);
    resetSession();
  }, [images.length, stats, folder, resetSession, pushRecent]);

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

  // curReady gates the hi-res zoom warm-up on the CURRENT image's readiness only
  // (not the whole previews map), so an unrelated prefetch landing doesn't reset it.
  const curPath = images[currentIndex]?.path;
  const curReady = curPath ? previews[curPath]?.status === "ready" : false;

  // Drive the bundle pool from the cursor: the current frame is priority 0 (loads
  // first), the prefetch window follows by distance. A fast thumbnail read is
  // kicked alongside so the blurred placeholder can paint while the bundle loads.
  useEffect(() => {
    if (images.length === 0 || currentIndex >= images.length) return;
    const cur = images[currentIndex].path;
    loadThumbnail(cur, currentIndex); // nearest-first → placeholder paints quickly

    // While scrubbing OR in the grid, don't fetch full-res — scrubbing flies past
    // frames it never decodes, and grid renders thumbnails (the full-res would be
    // a wasted ~40 MB NAS read per frame). The current frame's full-res is
    // scheduled on release / on grid-close (those re-run this effect via deps).
    if (scrubbing || gridVisible) return;

    // In compare, the champion/challenger effect schedules bundles instead.
    if (phase !== "culling" || compareMode) {
      scheduleBundles([{ path: cur, prio: 0 }]);
      return;
    }
    const pos = visibleIndices.indexOf(currentIndex);
    if (pos === -1) {
      scheduleBundles([{ path: cur, prio: 0 }]);
      return;
    }
    const items = [{ path: cur, prio: 0 }];
    const { prefetchAhead, prefetchBehind } = profile;
    const span = Math.max(prefetchAhead, prefetchBehind);
    for (let d = 1; d <= span; d++) {
      if (d <= prefetchAhead && pos + d < visibleIndices.length)
        items.push({ path: images[visibleIndices[pos + d]].path, prio: d });
      if (d <= prefetchBehind && pos - d >= 0)
        items.push({ path: images[visibleIndices[pos - d]].path, prio: d + 0.5 });
    }
    scheduleBundles(items);
  }, [phase, currentIndex, visibleIndices, images, compareMode, scrubbing, gridVisible, scheduleBundles, loadThumbnail, profile]);

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

  // Evict previews outside a window of the cursor (in filtered/visible order, so
  // it tracks the prefetch window) plus the active compare burst. Revoking the
  // object URLs keeps memory flat across an arbitrarily long session; evicted
  // paths drop out of requestedPreviews so they reload if revisited.
  useEffect(() => {
    if (phase !== "culling") return;
    const keep = new Set<string>();
    const cur = images[currentIndex]?.path;
    if (cur) keep.add(cur);
    const pos = visibleIndices.indexOf(currentIndex);
    if (pos !== -1) {
      const win = profile.previewKeep;
      for (let d = -win; d <= win; d++) {
        const p = pos + d;
        if (p >= 0 && p < visibleIndices.length) keep.add(images[visibleIndices[p]].path);
      }
    }
    if (compareMode) {
      if (images[championIndex]) keep.add(images[championIndex].path);
      if (images[challengerIndex]) keep.add(images[challengerIndex].path);
    }
    setPreviews((prev) => {
      let changed = false;
      const next: Record<string, PreviewEntry> = {};
      for (const path in prev) {
        if (keep.has(path)) {
          next[path] = prev[path];
        } else {
          const e = prev[path];
          if (e.status === "ready") URL.revokeObjectURL(e.url);
          requestedPreviews.current.delete(path);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [phase, currentIndex, visibleIndices, images, compareMode, championIndex, challengerIndex, profile.previewKeep]);

  // Evict thumbnails outside a (wider) window in image order — the strip renders
  // ±STRIP_RADIUS, so the keep-window must exceed it to avoid evicting visible
  // cells. Sizes come from the performance profile so local gets a bigger cache.
  useEffect(() => {
    if (phase !== "culling") return;
    const { thumbKeep, thumbKeepGrid } = profile;
    const lo = Math.max(0, currentIndex - thumbKeep);
    const hi = Math.min(images.length, currentIndex + thumbKeep + 1);
    const keep = new Set<string>();
    for (let i = lo; i < hi; i++) keep.add(images[i].path);
    if (compareMode) {
      if (images[championIndex]) keep.add(images[championIndex].path);
      if (images[challengerIndex]) keep.add(images[challengerIndex].path);
      // Keep the candidate cells the strip renders around the challenger
      // (±STRIP_RADIUS in candidate space) so scrolling the unrated strip — which
      // can span far in absolute index — doesn't evict-and-reload its thumbnails.
      const cpos = compareCandidates.indexOf(challengerIndex);
      if (cpos !== -1) {
        const clo = Math.max(0, cpos - STRIP_RADIUS);
        const chi = Math.min(compareCandidates.length, cpos + STRIP_RADIUS + 1);
        for (let k = clo; k < chi; k++) keep.add(images[compareCandidates[k]].path);
      }
    }
    // GRID mode: keep a wide window around the *filter-relative* position. With
    // a sparse filter (e.g., favs scattered across a 5k-image shoot) the
    // image-order window above keeps the wrong neighbours; this protects the
    // cells the user actually sees on screen.
    if (gridVisible) {
      const fpos = visibleIndices.indexOf(currentIndex);
      if (fpos !== -1) {
        const flo = Math.max(0, fpos - thumbKeepGrid);
        const fhi = Math.min(visibleIndices.length, fpos + thumbKeepGrid + 1);
        for (let i = flo; i < fhi; i++) keep.add(images[visibleIndices[i]].path);
      } else {
        // Current isn't in the active filter — fall back to keeping the first
        // chunk of the filter so the grid isn't empty.
        for (let i = 0; i < Math.min(thumbKeepGrid, visibleIndices.length); i++) {
          keep.add(images[visibleIndices[i]].path);
        }
      }
    }
    setThumbnails((prev) => {
      let changed = false;
      const next: Record<string, string> = {};
      for (const path in prev) {
        if (keep.has(path)) {
          next[path] = prev[path];
        } else {
          URL.revokeObjectURL(prev[path]);
          requestedThumbs.current.delete(path);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [
    phase,
    currentIndex,
    images,
    compareMode,
    championIndex,
    challengerIndex,
    compareCandidates,
    gridVisible,
    visibleIndices,
    profile.thumbKeep,
    profile.thumbKeepGrid,
  ]);

  // Unmount safety net: revoke any blob URLs still outstanding when the app tears
  // down. The eviction effects and resetSession cover the in-session cases; this
  // covers a hard unmount so nothing is left dangling. The maps are mirrored into
  // refs so this effect runs cleanup ONCE (on unmount) without re-subscribing as
  // previews/thumbnails change.
  const previewsRef = useRef(previews);
  const thumbnailsRef = useRef(thumbnails);
  useEffect(() => {
    previewsRef.current = previews;
  }, [previews]);
  useEffect(() => {
    thumbnailsRef.current = thumbnails;
  }, [thumbnails]);
  useEffect(
    () => () => {
      Object.values(previewsRef.current).forEach(
        (e) => e.status === "ready" && URL.revokeObjectURL(e.url),
      );
      Object.values(thumbnailsRef.current).forEach((u) => URL.revokeObjectURL(u));
    },
    [],
  );

  // In compare mode, schedule the champion + challenger (priority 0) and a few of
  // the nearest unrated frames each way, so cycling the challenger is instant.
  useEffect(() => {
    if (!compareMode) return;
    // While scrubbing the challenger, keep the (unchanging) champion loaded but
    // don't fetch full-res for the candidates we're flying past — the strip's
    // thumbnails feed the challenger scrub view; full-res returns on release.
    if (scrubbing) {
      if (images[championIndex])
        scheduleBundles([{ path: images[championIndex].path, prio: 0 }]);
      if (images[challengerIndex]) loadThumbnail(images[challengerIndex].path, challengerIndex);
      return;
    }
    const items: { path: string; prio: number }[] = [];
    if (images[championIndex]) items.push({ path: images[championIndex].path, prio: 0 });
    if (images[challengerIndex]) items.push({ path: images[challengerIndex].path, prio: 0 });
    const neighborSpan = profile.compareNeighborPrefetch;
    for (const dir of [1, -1] as const) {
      let i = challengerIndex;
      for (let n = 1; n <= neighborSpan; n++) {
        i = findUnrated(i, dir, ratings, championIndex);
        if (i === -1) break;
        items.push({ path: images[i].path, prio: n });
      }
    }
    scheduleBundles(items);
  }, [
    compareMode,
    championIndex,
    challengerIndex,
    images,
    ratings,
    scrubbing,
    scheduleBundles,
    findUnrated,
    loadThumbnail,
    profile.compareNeighborPrefetch,
  ]);

  // Auto-jump: if current falls out of the active filter, hop to the nearest
  // match (before paint, so no flash of an out-of-filter state). Suspended during
  // compare, which drives its own champion/challenger indices.
  useLayoutEffect(() => {
    if (compareMode || images.length === 0 || visibleIndices.length === 0) return;
    if (visibleIndices.includes(currentIndex)) return;
    const forward = visibleIndices.find((i) => i >= currentIndex);
    setCurrentIndex(forward ?? visibleIndices[visibleIndices.length - 1]);
  }, [visibleIndices, currentIndex, images.length, compareMode]);

  // Measure the displayed image's rect (relative to the stage) so overlays can
  // align to the letterboxed image. A ResizeObserver on the stage re-measures on
  // ANY layout change — window resize AND the image growing/shrinking when the
  // thumbnail strip toggles — so the clipping overlay never lags at the old size.
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
  }, [phase, images, currentIndex, measureNonce, scrubbing]);

  // Compute a clipping mask PNG for one image's preview (cached by path). Scans
  // pixels for true clipping and paints diagonal stripes (red 45° highlights /
  // blue −45° shadows). Detection uses ALL THREE channels (blown → white /
  // crushed → black): "any channel" flags saturated colours falsely (a yellow
  // flower ≈ R255 G210 B0 trips the blue=0 test). Small tolerance (250/5) since
  // JPEG quantization rarely lands exactly on 255/0. Checks the preview, not RAW.
  const loadClipMask = useCallback(
    (path: string) => {
      if (requestedClipMasks.current.has(path)) return;
      const entry = previews[path];
      if (entry?.status !== "ready") return; // retried once the preview decodes
      requestedClipMasks.current.add(path);
      const probe = new Image();
      probe.onload = () => {
        // Downscale to a bounded working size: the mask is a diagnostic overlay
        // that CSS stretches to the image rect, so scanning + PNG-encoding the
        // full 32 MP preview is pure waste — it would hang the toggle for ~1s.
        // ~1600 px keeps clipping detection meaningful while making it instant.
        const MAX = 1600;
        const scale = Math.min(1, MAX / Math.max(probe.naturalWidth, probe.naturalHeight));
        const w = Math.max(1, Math.round(probe.naturalWidth * scale));
        const h = Math.max(1, Math.round(probe.naturalHeight * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) {
          requestedClipMasks.current.delete(path);
          return;
        }
        ctx.drawImage(probe, 0, 0, w, h);
        const src = ctx.getImageData(0, 0, w, h).data;
        const mask = ctx.createImageData(w, h);
        const m = mask.data;
        const PERIOD = 8;
        const STRIPE = 3;
        for (let i = 0; i < src.length; i += 4) {
          const r = src[i];
          const g = src[i + 1];
          const b = src[i + 2];
          const idx = i >> 2;
          const x = idx % w;
          const y = (idx / w) | 0;
          if (r >= 250 && g >= 250 && b >= 250) {
            if ((x + y) % PERIOD < STRIPE) {
              m[i] = 239;
              m[i + 1] = 68;
              m[i + 2] = 68;
              m[i + 3] = 215;
            }
          } else if (r <= 5 && g <= 5 && b <= 5) {
            if ((x - y + h) % PERIOD < STRIPE) {
              m[i] = 59;
              m[i + 1] = 130;
              m[i + 2] = 246;
              m[i + 3] = 215;
            }
          }
        }
        ctx.putImageData(mask, 0, 0);
        setClipMasks((prev) => ({ ...prev, [path]: canvas.toDataURL("image/png") }));
      };
      probe.onerror = () => requestedClipMasks.current.delete(path);
      probe.src = entry.url;
    },
    [previews],
  );

  // Ensure masks exist for the on-screen image(s) when clipping is on; clear when
  // off (clipping does not persist, spec §12).
  useEffect(() => {
    if (!clippingVisible) {
      requestedClipMasks.current.clear();
      setClipMasks({});
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
    previews,
    loadClipMask,
  ]);

  // Focus peaking: paint yellow on pixels whose luminance gradient is strong (in-
  // focus edges), transparent elsewhere. Same mechanics as the clipping mask —
  // computed off the downscaled preview, cached per path. Threshold tuned for
  // typical JPEG noise floors; bump it if peaking lights up smooth regions.
  const loadPeakingMask = useCallback(
    (path: string) => {
      if (requestedPeaks.current.has(path)) return;
      const entry = previews[path];
      if (entry?.status !== "ready") return; // retried once the preview decodes
      requestedPeaks.current.add(path);
      const probe = new Image();
      probe.onload = () => {
        const MAX = 1600;
        const scale = Math.min(1, MAX / Math.max(probe.naturalWidth, probe.naturalHeight));
        const w = Math.max(1, Math.round(probe.naturalWidth * scale));
        const h = Math.max(1, Math.round(probe.naturalHeight * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) {
          requestedPeaks.current.delete(path);
          return;
        }
        ctx.drawImage(probe, 0, 0, w, h);
        const src = ctx.getImageData(0, 0, w, h).data;
        const mask = ctx.createImageData(w, h);
        const m = mask.data;
        const THRESHOLD = 60;
        // Luminance via cheap (R + 2G + B)/4. Central differences for the gradient
        // — borders left transparent (they'd false-trigger against the letterbox).
        for (let y = 1; y < h - 1; y++) {
          const rowAbove = (y - 1) * w * 4;
          const rowBelow = (y + 1) * w * 4;
          const row = y * w * 4;
          for (let x = 1; x < w - 1; x++) {
            const ixL = row + (x - 1) * 4;
            const ixR = row + (x + 1) * 4;
            const ixU = rowAbove + x * 4;
            const ixD = rowBelow + x * 4;
            const lumL = (src[ixL] + 2 * src[ixL + 1] + src[ixL + 2]) >> 2;
            const lumR = (src[ixR] + 2 * src[ixR + 1] + src[ixR + 2]) >> 2;
            const lumU = (src[ixU] + 2 * src[ixU + 1] + src[ixU + 2]) >> 2;
            const lumD = (src[ixD] + 2 * src[ixD + 1] + src[ixD + 2]) >> 2;
            const grad = Math.abs(lumR - lumL) + Math.abs(lumD - lumU);
            if (grad > THRESHOLD) {
              const o = row + x * 4;
              m[o] = 252;     // R
              m[o + 1] = 211; // G
              m[o + 2] = 77;  // B (warm yellow)
              m[o + 3] = 215; // alpha
            }
          }
        }
        ctx.putImageData(mask, 0, 0);
        setPeakingMasks((prev) => ({ ...prev, [path]: canvas.toDataURL("image/png") }));
      };
      probe.onerror = () => requestedPeaks.current.delete(path);
      probe.src = entry.url;
    },
    [previews],
  );

  // Mirror of the clipping effect: ensure peaking masks exist while P is on.
  useEffect(() => {
    if (!peakingVisible) {
      requestedPeaks.current.clear();
      setPeakingMasks({});
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
    previews,
    loadPeakingMask,
  ]);

  // Compute an RGB histogram PNG for one image (cached by path). Computed from the
  // already-loaded THUMBNAIL (~160px) — a histogram is a distribution, so the tiny
  // sample is plenty, and it avoids decoding the 32 MP preview (which made it pop
  // in ~0.5s late). Channels are drawn additively (overlaps brighten); the full
  // 0–255 range (including clipping spikes) sets the vertical scale.
  const loadHistogram = useCallback(
    (path: string) => {
      if (requestedHistograms.current.has(path)) return;
      const thumbUrl = thumbnails[path];
      if (!thumbUrl) return; // retried once the thumbnail loads
      requestedHistograms.current.add(path);
      const probe = new Image();
      probe.onload = () => {
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
        let max = 1; // include the 0/255 bins — clipping spikes are part of the truth
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
    [thumbnails],
  );

  // Compute histograms for the on-screen image(s) while the EXIF overlay is open;
  // drop the cache when it closes. Covers single view and both compare panels.
  useEffect(() => {
    if (!exifVisible) {
      requestedHistograms.current.clear();
      setHistograms({});
      return;
    }
    if (compareMode) {
      if (images[championIndex]) loadHistogram(images[championIndex].path);
      if (images[challengerIndex]) loadHistogram(images[challengerIndex].path);
    } else if (images[currentIndex]) {
      loadHistogram(images[currentIndex].path);
    }
  }, [
    exifVisible,
    compareMode,
    championIndex,
    challengerIndex,
    currentIndex,
    images,
    thumbnails,
    loadHistogram,
  ]);

  const advance = useCallback(
    (dir: 1 | -1, step = 1): boolean => {
      if (visibleIndices.length === 0) return false;
      const pos = visibleIndices.indexOf(currentIndex);
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
    [visibleIndices, currentIndex],
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
        if (phaseRef.current === "culling") {
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
      // Multi-select branch: when the user is in grid with >1 selection, apply
      // the rating to every selected frame at once (one undo-stack entry,
      // sidecars written in parallel). No auto-advance — the user is acting on
      // a set, not stepping through one frame at a time.
      if (gridVisible && selectedIndices.size > 1) {
        const ids = Array.from(selectedIndices);
        const changes = ids
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
  // In grid multi-select with >1 selection, clears every selected frame's
  // rating (skipping the already-unrated ones so the undo stack only carries
  // actual reverts).
  const unrateCurrent = useCallback(() => {
    if (gridVisible && selectedIndices.size > 1) {
      const ids = Array.from(selectedIndices);
      const changes = ids
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
        const firstChall = nearestUnrated(champ, ratings, champ);
        if (firstChall === -1) return;
        setNavStack((s) => [...s, buildNavEntry(current)]);
        setChampionIndex(champ);
        setChallengerIndex(firstChall);
        setCompareMode(true);
        setGridVisible(false);
        setIsZooming(false);
        setPanOffset({ x: 0, y: 0 });
        return;
      }

      // Leaving compare → land the cursor on the champion (the latest pick).
      if (current === "compare") {
        setCurrentIndex(snapToFilter(championIndex));
      }
      setNavStack((s) => [...s, buildNavEntry(current)]);
      setCompareMode(false);
      setGridVisible(target === "grid");
      setIsZooming(false);
      setPanOffset({ x: 0, y: 0 });
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
        setIsZooming(false);
        setPanOffset({ x: 0, y: 0 });
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
    setIsZooming(false);
    setPanOffset({ x: 0, y: 0 });
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
    snapToFilter,
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
    snapToFilter,
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
    lastStepTsRef.current = performance.now();
    const loop = (ts: number) => {
      if (heldDirRef.current === 0) return;
      if (ts - lastStepTsRef.current >= NAV_REPEAT_MS) {
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
          next = new Set([i]);
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
        setSelectedIndices((prev) => {
          const next = new Set(prev);
          if (next.has(i)) next.delete(i);
          else next.add(i);
          return next;
        });
        setSelectionAnchor(i);
        setCurrentIndex(i);
        return;
      }
      // Plain click.
      clearMultiSelection();
      setCurrentIndex(i);
      goToSite("loupe");
    },
    [visibleIndices, selectionAnchor, clearMultiSelection, goToSite],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Settings can be opened from any phase — it lets the user pick the
      // storage mode before opening a folder. So both the open shortcut and
      // the modal's ESC live above the phase gate.
      if (settingsOpen) {
        if (e.key === "Escape") {
          e.preventDefault();
          setSettingsOpen(false);
        }
        return;
      }
      // Ctrl/Cmd + comma → open settings. We accept both `e.key === ","` and
      // `e.code === "Comma"` so non-US keyboard layouts (where the comma key
      // may report a different e.key) also work.
      if ((e.ctrlKey || e.metaKey) && (e.key === "," || e.code === "Comma")) {
        e.preventDefault();
        setSettingsOpen(true);
        return;
      }
      if (phase !== "culling") return; // chrome screens are button-driven

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
          if (isZooming) pan(PAN_STEP, 0);
          // Grid: one cell per OS key event. Tap = one event (single cell).
          // Hold = OS auto-repeat (~30Hz after a ~500ms delay) → smooth
          // traversal without the loupe's rAF burst overshooting on a tap.
          else if (gridVisible) advance(1);
          else if (!e.repeat && heldDirRef.current === 0) startHold(1);
          break;
        case "ArrowLeft":
          e.preventDefault();
          if (isZooming) pan(-PAN_STEP, 0);
          else if (gridVisible) advance(-1);
          else if (!e.repeat && heldDirRef.current === 0) startHold(-1);
          break;
        case "ArrowUp":
          e.preventDefault();
          if (isZooming) pan(0, -PAN_STEP);
          else if (gridVisible) advance(-1, gridCols); // jump up a row in the grid
          break;
        case "ArrowDown":
          e.preventDefault();
          if (isZooming) pan(0, PAN_STEP);
          else if (gridVisible) advance(1, gridCols); // jump down a row in the grid
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
        setIsZooming(false);
        setPanOffset({ x: 0, y: 0 });
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
    };
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
  ]);

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
                onPick={(p) => openFolderByPath(p)}
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
                  <span className="cull-hero__how-key">tab</span>
                  hold for help
                </span>
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
                loading <span className="cull-chrome__folder">{folderName}</span>
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
  const currentPreview = current ? previews[current.path] : undefined;
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

  // Frame aspect ratio: prefer the per-image DISPLAY dims (authoritative EXIF,
  // available the moment the thumbnail loads — so correct even mid-scrub) over
  // the full preview's naturalSize (which freezes on the last settled frame, the
  // root of the "scrub locks to the first frame's shape" bug).
  const curBlurInfo = current ? blurhashes[current.path] : undefined;
  const photoAr = curBlurInfo
    ? `${curBlurInfo.w} / ${curBlurInfo.h}`
    : naturalSize
      ? `${naturalSize.w} / ${naturalSize.h}`
      : undefined;
  // Placeholder while scrubbing / before the full preview decodes: the per-image
  // blurhash (correct aspect, already blurred). Decoded once per hash (memoised
  // so the warm pass updating OTHER frames never re-decodes the current one).
  const curBlur = decodeBlurCached(curBlurInfo);

  const singleModeBody = (
      <div className="cull-stage">
        <div className="cull-loupe-body">
        <div className="cull-image-area" ref={stageRef}>
        {images.length === 0 ? (
          <div className="cull-message">no images</div>
        ) : positionInFilter === -1 ? (
          <EmptyFilter filter={filter} />
        ) : currentPreview?.status === "error" ? (
          <div className="cull-message">
            <div className="cull-message__title">preview failed</div>
            <pre className="cull-message__body">{currentPreview.error}</pre>
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
              style={
                photoAr
                  ? ({ ["--photo-ar" as string]: photoAr } as React.CSSProperties)
                  : undefined
              }
            >
              <img
                ref={imgRef}
                className="cull-image"
                src={
                  currentPreview?.status === "ready" && !scrubbing
                    ? currentPreview.url
                    : curBlur
                      ? curBlur
                      : current && thumbnails[current.path]
                        ? thumbnails[current.path]
                        : undefined
                }
                alt=""
                onLoad={(e) => {
                  // Only update naturalSize from the FULL preview, not the
                  // thumbnail fallback — otherwise the matte would briefly
                  // shrink to the tiny thumbnail's dimensions during scrub
                  // or load.
                  if (currentPreview?.status === "ready" && !scrubbing) {
                    setMeasureNonce((n) => n + 1);
                    setNaturalSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight });
                  }
                }}
                style={{
                  transform: isZooming ? `scale(${zoomZ})` : undefined,
                  transformOrigin: `${originX}% ${originY}%`,
                  transition: "transform 200ms ease-out",
                  // Heavy blur while scrubbing or loading the thumbnail
                  // fallback — masks the low-res thumbnail and reads as
                  // a "settling" indicator. Drops to 0 the moment the full
                  // preview is ready.
                  filter:
                    currentPreview?.status === "ready" && !scrubbing
                      ? undefined
                      : curBlur
                        ? "blur(6px) brightness(0.82)"
                        : "blur(14px) brightness(0.78)",
                }}
              />
              {/* Spinner overlay only when the full preview is loading AND
                  we're not mid-scrub. During scrub the blurred thumbnail
                  stands in for the preview, no spinner needed — adding it
                  on every step would just be visual noise as the user
                  flies past. */}
              {currentPreview?.status !== "ready" && !scrubbing && (
                <div className="cull-photo-frame__spinner-wrap" aria-hidden>
                  <div className="cull-loading__spinner" />
                </div>
              )}
              {/* Deferred full-res layer: same blob, rendered at native pixel size and
                  transformed to coincide with the base image, so the compositor holds a
                  full-resolution raster and zoom is sharp immediately. Mounts only after
                  the cursor settles (HIRES_SETTLE_MS); the base image stays beneath as the
                  instant-nav fallback. Gated on the full preview being ready too —
                  the thumbnail fallback isn't worth pinning a hi-res raster of. */}
              {hiRes && !clippingVisible && imgRect && naturalSize && currentPreview?.status === "ready" && (
                <img
                  className="cull-image cull-image--hires"
                  src={currentPreview.url}
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
        {gridVisible && selectedIndices.size > 1 && (
          <span
            className="cull-statusbar__multi"
            title="multi-selection — rating keys apply to all selected"
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
              <b>{Math.max(0, compareCandidates.indexOf(challengerIndex) + 1)}</b>
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
              thumbnails={thumbnails}
              blurhashes={blurhashes}
              metadata={metadata}
              loadThumbnail={loadThumbnail}
              onPickChallenger={pickChallengerFromStrip}
            />
          )}
          <CompareView
            images={images}
            championIndex={championIndex}
            challengerIndex={challengerIndex}
            previews={previews}
            metadata={metadata}
            clipMasks={clipMasks}
            peakingMasks={peakingMasks}
            thumbnails={thumbnails}
            blurhashes={blurhashes}
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
              thumbnails={thumbnails}
              blurhashes={blurhashes}
              metadata={metadata}
              loadThumbnail={loadThumbnail}
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
            thumbnails={thumbnails}
            blurhashes={blurhashes}
            metadata={metadata}
            selectedIndices={selectedIndices}
            loadThumbnail={loadThumbnail}
            onPick={handleGridPick}
            containerRef={gridContainerRef}
            viewportRangeRef={gridViewportRef}
            onViewportPump={pumpThumbs}
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
              thumbnails={thumbnails}
              blurhashes={blurhashes}
              metadata={metadata}
              loadThumbnail={loadThumbnail}
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
              thumbnails={thumbnails}
              blurhashes={blurhashes}
              metadata={metadata}
              loadThumbnail={loadThumbnail}
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
