import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { Img, NavEntry, NavSite, Rating } from "../types";
import { snapToFilter as snapToFilterPure } from "../utils/snap";

/**
 * Site navigation: loupe / compare / grid — verbatim from App (grand cleanup
 * Phase 6). Sites are mutually exclusive — only one renders at a time. L/C/G
 * switch sites and push the previous one onto a back-stack; ESC pops the
 * stack. Pressing the current site's key is a no-op (you can only leave via
 * another site key or ESC). Compare entries snapshot the champion/challenger
 * so ESC back into compare restores the same pair.
 */
export function useSiteNavigation({
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
}: {
  images: Img[];
  ratings: Record<number, Rating>;
  visibleIndices: number[];
  navStack: NavEntry[];
  setNavStack: Dispatch<SetStateAction<NavEntry[]>>;
  compareMode: boolean;
  setCompareMode: Dispatch<SetStateAction<boolean>>;
  gridVisible: boolean;
  setGridVisible: Dispatch<SetStateAction<boolean>>;
  currentIndex: number;
  setCurrentIndex: Dispatch<SetStateAction<number>>;
  championIndex: number;
  setChampionIndex: Dispatch<SetStateAction<number>>;
  challengerIndex: number;
  setChallengerIndex: Dispatch<SetStateAction<number>>;
  selectedIndices: Set<number>;
  clearMultiSelection: () => void;
  findUnrated: (
    from: number,
    dir: 1 | -1,
    ratingsMap: Record<number, Rating>,
    skip: number,
  ) => number;
  nearestUnrated: (from: number, ratingsMap: Record<number, Rating>, skip: number) => number;
  resetZoom: () => void;
  setConfirmHome: Dispatch<SetStateAction<boolean>>;
}) {
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
      setNavStack,
      setChampionIndex,
      setChallengerIndex,
      setCompareMode,
      setGridVisible,
      setCurrentIndex,
    ],
  );

  // ESC. Pop one nav entry and navigate back. Empty stack at loupe → home
  // confirm (the only "site above loupe" is leaving the cull entirely). Empty
  // stack at compare/grid (shouldn't normally happen, but defends against
  // edge cases) falls back to loupe.
  const goBack = useCallback(
    (landIndex?: number) => {
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
    },
    [
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
      setNavStack,
      setCompareMode,
      setGridVisible,
      setChampionIndex,
      setChallengerIndex,
      setCurrentIndex,
      setConfirmHome,
    ],
  );

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
    [challengerIndex, championIndex, ratings, findUnrated, setChallengerIndex],
  );

  return { snapToFilter, reviveChallenger, buildNavEntry, goToSite, goBack, cycleChallenger };
}
