import { useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { Filter, Img, NavSite, Phase, Rating, Settings } from "../types";
import { cycleFilter } from "../utils/filterModes";

const PAN_STEP = 2; // % per arrow press while zoomed

/**
 * The keyboard, verbatim from App (grand cleanup Phase 7): the phase-agnostic
 * chrome-screen shortcuts, the big cull keymap, the capture-phase ESC swallow,
 * and the once-bound window listeners.
 *
 * Contract (do not "simplify"):
 * - The cull keymap closures capture currentIndex/ratings/etc., so they
 *   rebuild on every nav step + rating. Dispatch goes through `cullKeyRef`
 *   and the window listeners register ONCE, so the scrub hot path doesn't
 *   churn add/removeEventListener.
 * - Modal precedence order (settings → quitGuard → confirmHome → actionsOpen
 *   → scrub-interrupt → Ctrl combos → Tab/help → Space → ESC → sites) is a
 *   verbatim move.
 */
export function useCullKeymap({
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
}: {
  phase: Phase;
  images: Img[];
  settings: Settings;
  settingsOpen: boolean;
  setSettingsOpen: Dispatch<SetStateAction<boolean>>;
  pickFolder: () => Promise<void>;
  beginCulling: () => Promise<void>;
  resetSession: () => void;
  quitGuard: boolean;
  setQuitGuard: Dispatch<SetStateAction<boolean>>;
  confirmHome: boolean;
  setConfirmHome: Dispatch<SetStateAction<boolean>>;
  leaveToHome: () => void;
  actionsOpen: boolean;
  setActionsOpen: Dispatch<SetStateAction<boolean>>;
  openActions: () => void;
  helpVisible: boolean;
  setHelpVisible: Dispatch<SetStateAction<boolean>>;
  setHelpIntro: Dispatch<SetStateAction<boolean>>;
  undo: () => void;
  redo: () => void;
  gridVisible: boolean;
  gridCols: number;
  advance: (dir: 1 | -1, step?: number) => boolean;
  selectAllInGrid: () => void;
  growGridSelection: (deltaCells: number) => void;
  clearMultiSelection: () => void;
  heldDirRef: RefObject<0 | 1 | -1>;
  startHold: (dir: 1 | -1) => void;
  stopHold: () => void;
  heldGridVertDirRef: RefObject<0 | 1 | -1>;
  startGridVertHold: (dir: 1 | -1) => void;
  stopGridVertHold: () => void;
  isZooming: boolean;
  isZoomingRef: RefObject<boolean>;
  setIsZooming: Dispatch<SetStateAction<boolean>>;
  setZoomLevel: Dispatch<SetStateAction<1 | 2>>;
  setPanOffset: Dispatch<SetStateAction<{ x: number; y: number }>>;
  mouseZooming: boolean;
  resetZoom: () => void;
  pan: (dx: number, dy: number) => void;
  compareMode: boolean;
  championIndex: number;
  goToSite: (target: NavSite) => void;
  goBack: (landIndex?: number) => void;
  challengerWins: () => void;
  challengerLoses: () => void;
  challengerKeptBoth: (asFavorite: boolean) => void;
  applyRating: (rating: Rating) => void;
  unrateCurrent: () => void;
  setFilter: Dispatch<SetStateAction<Filter>>;
  chipsTooltip: { pulse: () => void };
  startAnalysis: () => void;
  setExifVisible: Dispatch<SetStateAction<boolean>>;
  setClippingVisible: Dispatch<SetStateAction<boolean>>;
  setPeakingVisible: Dispatch<SetStateAction<boolean>>;
  setThumbsVisible: Dispatch<SetStateAction<boolean>>;
  setCompositionVisible: Dispatch<SetStateAction<boolean>>;
}): void {
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
        void pickFolder();
        return;
      }
      // Enter on the staged screen → begin culling (mirrors the primary button).
      // With 0 images staged the primary button is "open folders" instead —
      // leave Enter alone there so a focused button still activates.
      if (phase === "staged" && e.key === "Enter" && images.length > 0) {
        e.preventDefault();
        void beginCulling();
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
  }, [settingsOpen, phase, pickFolder, beginCulling, images.length, resetSession, setSettingsOpen]);

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
      // Same rule for the grid's vertical hold — sustained only by its own
      // arrow, interrupted by anything else (rating, esc, mode switch…).
      const isVertNavArrow = e.key === "ArrowUp" || e.key === "ArrowDown";
      if (heldGridVertDirRef.current !== 0 && !isVertNavArrow) stopGridVertHold();

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

      // Ctrl/Cmd+A → select all visible cells (grid only). Swallowed in every
      // site so the webview's own select-all never fires.
      if ((e.ctrlKey || e.metaKey) && (e.key === "a" || e.key === "A")) {
        e.preventDefault();
        if (gridVisible) selectAllInGrid();
        return;
      }

      // Tab (hold) → keyboard help. Available in both single and compare.
      if (e.key === "Tab") {
        e.preventDefault();
        if (!e.repeat) {
          setHelpVisible(true);
          setHelpIntro(false);
        }
        return;
      }
      if (helpVisible) {
        // Any other key dismisses AND is swallowed — one press closes the
        // auto-shown intro without also rating a frame. (During a held-Tab
        // showing this just closes early; Tab-release would have anyway.)
        // preventDefault too: the dismissing key must not fall through to a
        // platform default (ESC exiting macOS fullscreen was the live bug).
        e.preventDefault();
        setHelpVisible(false);
        setHelpIntro(false);
        return;
      }

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
        // Arm zoom on a fresh press only — and only when NOT already zoomed.
        // The already-zoomed guard is what makes rate-while-zoomed safe: after
        // a rating keypress, macOS resumes the still-held Space's auto-repeat
        // as a NON-repeat keydown (the quirk that sank the old attempts, see
        // 7bf33e8) — with zoom carried, that phantom press must change nothing.
        if (!e.repeat && !gridVisible && !isZoomingRef.current) {
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
          // Deciding works WHILE ZOOMED via the memory-budgeted swap: each
          // action first DROPS every zoom full outside the surviving pair
          // (dropZoomFullsExcept), so the old and new pairs never coexist —
          // holding both is what jetsam-killed WebContent (gray window,
          // 2026-07-07, 2.25 GB lifetimeMax). Under real OS pressure the
          // caches shed further (memory-pressure event → pressureProfile).
          case "Enter":
            e.preventDefault();
            if (!e.repeat) challengerWins();
            break;
          case "Backspace":
            e.preventDefault();
            if (!e.repeat) challengerLoses();
            break;
          case "k":
          case "K":
            // Keep both: challenger keeps, champion stays champion.
            if (!e.repeat) challengerKeptBoth(false);
            break;
          case "f":
          case "F":
            // Keep both + star the challenger.
            if (!e.repeat) challengerKeptBoth(true);
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
        }
        return;
      }

      switch (e.key) {
        // Rating works WHILE ZOOMED: the advance carries the zoom to the next
        // frame at its own AF anchor (see applyRating's advanceTo). The old
        // block existed to fight the held Space key re-arming zoom — the carry
        // design goes WITH the held key instead, and the arm guard on Space
        // makes the OS's resumed-repeat keydown a no-op.
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
          unrateCurrent(); // clear rating, stay on frame (zoom unaffected)
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
            if (e.shiftKey) growGridSelection(1);
            else {
              clearMultiSelection();
              advance(1);
            }
          } else if (!e.repeat && heldDirRef.current === 0) startHold(1);
          break;
        case "ArrowLeft":
          e.preventDefault();
          if (isZooming) pan(-PAN_STEP, 0);
          else if (gridVisible) {
            if (e.shiftKey) growGridSelection(-1);
            else {
              clearMultiSelection();
              advance(-1);
            }
          } else if (!e.repeat && heldDirRef.current === 0) startHold(-1);
          break;
        case "ArrowUp":
          e.preventDefault();
          if (isZooming) pan(0, -PAN_STEP);
          else if (gridVisible) {
            if (e.shiftKey) {
              // One row per key event (OS repeat drives a held shift+arrow) —
              // selection growth wants precision, not the staged scrub. Shift
              // added MID-hold must kill the rAF loop first, or the two would
              // race over currentIndex until the arrow is released.
              if (heldGridVertDirRef.current !== 0) stopGridVertHold();
              growGridSelection(-gridCols);
            } else if (!e.repeat && heldGridVertDirRef.current === 0) {
              // Held-arrow row-jump, staged-accelerated like the horizontal
              // scrub (see startGridVertHold). Ignore OS auto-repeat — our own
              // rAF loop drives the cadence, same reasoning as startHold above.
              clearMultiSelection();
              startGridVertHold(-1);
            }
          }
          break;
        case "ArrowDown":
          e.preventDefault();
          if (isZooming) pan(0, PAN_STEP);
          else if (gridVisible) {
            if (e.shiftKey) {
              // Same mid-hold guard as ArrowUp above.
              if (heldGridVertDirRef.current !== 0) stopGridVertHold();
              growGridSelection(gridCols);
            } else if (!e.repeat && heldGridVertDirRef.current === 0) {
              clearMultiSelection();
              startGridVertHold(1);
            }
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
          setFilter((f) => cycleFilter(f, "all"));
          break;
        case "2":
          setFilter((f) => cycleFilter(f, "unrated"));
          break;
        case "3":
          setFilter((f) => cycleFilter(f, "keeps"));
          chipsTooltip.pulse(); // show the sub-mode tooltip immediately on cycle
          break;
        case "4":
          // Smart tab is a valid filter state even with smart culling off —
          // it lands on the "disabled" empty screen. Only kick off analysis
          // when the feature is actually on.
          setFilter((f) => cycleFilter(f, "suggested"));
          chipsTooltip.pulse(); // show the sub-mode tooltip immediately on cycle
          if (settings.smartCulling) {
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
        setHelpIntro(false);
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
      // Same held-arrow-release rule for the grid's vertical hold.
      const isUpUp = e.key === "ArrowUp" || e.code === "ArrowUp";
      const isDownUp = e.key === "ArrowDown" || e.code === "ArrowDown";
      if (isUpUp && heldGridVertDirRef.current === -1) stopGridVertHold();
      else if (isDownUp && heldGridVertDirRef.current === 1) stopGridVertHold();
      if (e.code === "Space") {
        // Release → exit zoom, unless the MOUSE owns it (tapping Space while
        // click-zoom is held must not drop the drag).
        if (!mouseZooming) resetZoom();
      }
    };
    cullKeyRef.current = { onKey, onKeyUp };
    // chipsTooltip deliberately omitted: the hook returns a fresh object each
    // render — including it would rebuild the keymap every render for no
    // benefit (onKey reads only its stable pulse method).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    phase,
    startHold,
    stopHold,
    startGridVertHold,
    stopGridVertHold,
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
    mouseZooming,
    pan,
    leaveToHome,
    compareMode,
    championIndex,
    goToSite,
    goBack,
    challengerWins,
    challengerLoses,
    challengerKeptBoth,
    resetZoom,
    clearMultiSelection,
    growGridSelection,
    selectAllInGrid,
    settings.smartCulling,
    startAnalysis,
  ]);

  // ESC must never reach the OS: on macOS an unhandled ESC exits native
  // fullscreen (and other platforms have their own cancel defaults). One
  // capture-phase listener, registered once, preventDefaults it in EVERY
  // phase — home included, where no app handler claims it. Capture does not
  // stop propagation, so the bubble-phase handlers below still run all the
  // app's own ESC logic (leave-confirm, dialog closes, staged reset).
  useEffect(() => {
    const swallowEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") e.preventDefault();
    };
    window.addEventListener("keydown", swallowEsc, { capture: true });
    return () => window.removeEventListener("keydown", swallowEsc, { capture: true });
  }, []);

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
}
