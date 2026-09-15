import { useCallback, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { Img, NavEntry, Rating, UndoAction } from "../types";
import { imageStore } from "../image/imageStore";

/**
 * The rating decides, verbatim from App (grand cleanup Phase 6): single-frame
 * / grid-selection rating (applyRating, unrateCurrent) and the three compare
 * decides (challenger loses / kept-both / wins). The setState-then-
 * `dropZoomFullsExcept` sequencing is load-bearing — see the sync-flush
 * ordering comments on `resolveCompareDecide`; do not "simplify" it.
 */

/**
 * Everything one compare decide changes. The three decides differ ONLY in
 * these fields; every side effect, and its order, lives in
 * {@link useDecideCallbacks}'s `resolveCompareDecide`.
 */
type DecideSpec = {
  /**
   * Rating writes, in persist order (a win: the dethroned champion first,
   * then the crowned challenger).
   */
  changes: { imgId: number; path: string; before: Rating | undefined; after: Rating }[];
  /** The challenger's verdict and id — the wash is keyed to the frame that was judged. */
  flash: { rating: Rating; imgId: number };
  /** Champion after the decide (unchanged for loses/kept-both; the old challenger for wins). */
  nextChampion: number;
  /** Next challenger, or -1 when nothing unrated is left and compare auto-exits. */
  nextChallenger: number;
  /** Wins re-anchor both panes at the new champion's AF point. */
  resetPan: boolean;
};

export function useDecideCallbacks({
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
}: {
  images: Img[];
  ratings: Record<number, Rating>;
  setRatings: Dispatch<SetStateAction<Record<number, Rating>>>;
  currentIndex: number;
  setCurrentIndex: Dispatch<SetStateAction<number>>;
  championIndex: number;
  setChampionIndex: Dispatch<SetStateAction<number>>;
  challengerIndex: number;
  setChallengerIndex: Dispatch<SetStateAction<number>>;
  visibleIndices: number[];
  gridVisible: boolean;
  selectedIndices: Set<number>;
  navStackRef: RefObject<NavEntry[]>;
  isZoomingRef: RefObject<boolean>;
  keepZoomOnAdvanceRef: RefObject<boolean>;
  setZoomSwapInstant: Dispatch<SetStateAction<boolean>>;
  setPanOffset: Dispatch<SetStateAction<{ x: number; y: number }>>;
  flashFeedback: (rating: Rating, imageId: number) => void;
  persistRating: (path: string, rating: Rating | null) => void;
  recordAction: (action: UndoAction) => void;
  nearestUnrated: (from: number, ratingsMap: Record<number, Rating>, skip: number) => number;
  goBack: (landIndex?: number) => void;
}) {
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
      // The cursor can fall outside the active filter (empty filter, or the
      // last matching frame just rated away). Every site then shows a no-match
      // screen instead of the photo — loupe's render switches on this exact
      // predicate — so rating keys must not touch the invisible cursor frame:
      // rating something you can't see is never right.
      if (pos === -1) return;
      const nextTarget =
        pos !== -1 && pos + 1 < visibleIndices.length ? visibleIndices[pos + 1] : null;
      const nextImg = nextTarget !== null ? images[nextTarget] : null;
      // Flash the verdict on the INCOMING frame's id: the full-frame wash is keyed
      // to the current frame, which the advance below makes nextImg, so keying it to
      // the outgoing cur.id meant the wash was wiped the instant we advanced.
      const flashId = (nextImg ?? cur).id;

      // Rate-while-zoomed: the advance CARRIES the zoom (Space is still held).
      // Pan resets here so the next frame anchors at its own AF point, and the
      // swap lands at scale with no glide (zoomSwapInstant). The reset effect
      // consumes the one-shot flag instead of dropping the zoom.
      const advanceTo = (target: number | null) => {
        if (target === null) return;
        if (isZoomingRef.current) {
          keepZoomOnAdvanceRef.current = true;
          setZoomSwapInstant(true);
          setPanOffset({ x: 0, y: 0 });
        }
        setCurrentIndex(target);
        if (isZoomingRef.current) {
          // Sequential swap: release the outgoing frame's ~130 MB zoom raster
          // BEFORE the incoming one decodes — a carried advance never holds
          // two fulls at once (the jetsam-kill class). The prefetched next
          // full survives (it IS the target). Runs AFTER the last setState:
          // the store's invalidate forces a SYNC React flush, and flushing
          // mid-way rendered a half-updated cursor/ratings pair (the
          // compare-strip crash of 2026-07-07).
          const targetPath = images[target]?.path;
          if (targetPath) imageStore.dropZoomFullsExcept([targetPath]);
        }
      };

      // Re-pressing the same verdict on an already-rated frame changes nothing on
      // disk or in state: skip the redundant sidecar write (an fsync round-trip on
      // the NAS) and the dead before===after undo entry (which would also wipe a
      // pending redo). Still flash + advance so the keyboard-fast flow is unchanged.
      if (ratings[cur.id] === rating) {
        flashFeedback(rating, flashId);
        advanceTo(nextTarget);
        return;
      }

      recordAction({
        changes: [{ imgId: cur.id, path: cur.path, before: ratings[cur.id], after: rating }],
      });
      setRatings((prev) => ({ ...prev, [cur.id]: rating }));
      flashFeedback(rating, flashId);
      persistRating(cur.path, rating); // durable write with retry + failure tracking

      advanceTo(nextTarget);
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
      setRatings,
      setCurrentIndex,
      setZoomSwapInstant,
      setPanOffset,
      isZoomingRef,
      keepZoomOnAdvanceRef,
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
    // Same off-screen guard as applyRating: with the cursor outside the active
    // filter the photo isn't displayed (no-match screen), so `u` must not
    // silently strip a hidden frame's rating.
    if (visibleIndices.indexOf(currentIndex) === -1) return;
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
    setRatings,
  ]);

  /**
   * THE compare-decide sequence — one copy, three callers (challenger loses /
   * kept-both / wins). A caller only builds a {@link DecideSpec}; every side
   * effect, and its ORDER, lives here. That order is load-bearing:
   *
   * - `recordAction` first, with the pair as it stands (`cursorBefore`) and
   *   where undo/redo should land (`cursorAfter`), before anything moves.
   * - `persistRating` per change, in `changes` order, then `setRatings`.
   * - `dropZoomFullsExcept` LAST, after every setState, and only when we stay
   *   in compare. Sequential swap: drop every zoom full outside the surviving
   *   pair BEFORE the new challenger's decodes — holding both pairs at once is
   *   the proven jetsam kill — but the store's invalidate forces a SYNC React
   *   flush, and flushing between `setRatings` and `setChallengerIndex`
   *   rendered a half-updated strip (the compare-strip crash of 2026-07-07).
   *   Runs on UNZOOMED decides too since the pane unification: PhotoPane's
   *   settle policy keeps both panes' fulls resident even unzoomed, so without
   *   the drop each decide accumulated the outgoing challenger's.
   */
  const resolveCompareDecide = useCallback(
    ({ changes, flash, nextChampion, nextChallenger, resetPan }: DecideSpec) => {
      const exiting = nextChallenger === -1;
      // The whole next map, by value (not an updater). The caller already
      // derived this same map to ask `nearestUnrated` what is left.
      const next: Record<number, Rating> = { ...ratings };
      for (const c of changes) next[c.imgId] = c.after;

      recordAction({
        changes,
        cursorBefore: {
          compareMode: true,
          championIndex,
          challengerIndex,
          currentIndex,
          navStack: [...navStackRef.current],
        },
        // Where the crown lands, so a redo re-crowns the NEW champion (not a
        // just-rejected old one); for loses/kept-both `nextChampion` is the
        // unchanged champion and redo just lands on the next challenger. On
        // the last-frame auto-exit we leave compare, landing on the champion.
        cursorAfter: exiting
          ? {
              compareMode: false,
              championIndex: nextChampion,
              challengerIndex,
              currentIndex: nextChampion,
            }
          : {
              compareMode: true,
              championIndex: nextChampion,
              challengerIndex: nextChallenger,
              currentIndex,
            },
      });
      flashFeedback(flash.rating, flash.imgId);
      // Durable writes with retry + failure tracking, in the order the action
      // records them.
      for (const c of changes) persistRating(c.path, c.after);
      setRatings(next);
      // Zoomed decide: the challenger pane's content swaps under the live
      // transform — land it at scale, no drift. The champion pane is untouched
      // (shared pan kept) so its view cannot jump — except with a NEW champion
      // (`resetPan`), where both panes re-anchor at its AF point.
      if (isZoomingRef.current && !exiting) {
        setZoomSwapInstant(true);
        if (resetPan) setPanOffset({ x: 0, y: 0 });
      }
      // Only a win moves the crown. Equivalent to the old unconditional call
      // in challengerWins and no call at all in the other two: a win's
      // `nextChampion` is the old challenger, never the champion, and the
      // other two pass the champion unchanged. The crown still lands on the
      // auto-exit — goBack below is the exit, not a reason to skip it.
      if (nextChampion !== championIndex) setChampionIndex(nextChampion);
      if (exiting) {
        // No more candidates — pop back to whichever site we came from,
        // landing on the champion (after a win, the freshly crowned keeper).
        // Passed explicitly: goBack's own closure still holds the OLD
        // champion. A later compare auto-exit lands further up the stack.
        goBack(nextChampion);
      } else {
        setChallengerIndex(nextChallenger);
      }
      // AFTER the last setState, on purpose — see the sync-flush note above.
      // After a win the new champion's full is already resident (it IS the old
      // challenger), so keeping the pair costs no refetch.
      if (!exiting) {
        const keep = [images[nextChampion]?.path, images[nextChallenger]?.path].filter(
          (x): x is string => Boolean(x),
        );
        imageStore.dropZoomFullsExcept(keep);
      }
    },
    // currentIndex deliberately omitted: compare mode never updates it (known
    // cursor divergence, see setCursor note) — the frozen value is intended.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      championIndex,
      challengerIndex,
      images,
      ratings,
      navStackRef,
      isZoomingRef,
      setRatings,
      setChampionIndex,
      setChallengerIndex,
      setZoomSwapInstant,
      setPanOffset,
      flashFeedback,
      persistRating,
      recordAction,
      goBack,
    ],
  );

  // Backspace → challenger loses (Reject); champion stays; advance to next unrated.
  const challengerLoses = useCallback(() => {
    const challImg = images[challengerIndex];
    if (!challImg) return;
    const next: Record<number, Rating> = { ...ratings, [challImg.id]: "reject" };
    resolveCompareDecide({
      changes: [
        { imgId: challImg.id, path: challImg.path, before: ratings[challImg.id], after: "reject" },
      ],
      flash: { rating: "reject", imgId: challImg.id },
      nextChampion: championIndex,
      nextChallenger: nearestUnrated(challengerIndex, next, championIndex),
      resetPan: false,
    });
  }, [images, challengerIndex, championIndex, ratings, nearestUnrated, resolveCompareDecide]);

  // K → keep both: challenger becomes Keep (F → Favorite); champion is
  // untouched and stays champion; advance to the next unrated. The verb the
  // tournament lacked — comparing two good frames no longer forces a loser.
  const challengerKeptBoth = useCallback(
    (asFavorite: boolean) => {
      const challImg = images[challengerIndex];
      if (!challImg) return;
      const verdict: Rating = asFavorite ? "favorite" : "keep";
      const next: Record<number, Rating> = { ...ratings, [challImg.id]: verdict };
      resolveCompareDecide({
        changes: [
          { imgId: challImg.id, path: challImg.path, before: ratings[challImg.id], after: verdict },
        ],
        flash: { rating: verdict, imgId: challImg.id },
        nextChampion: championIndex,
        nextChallenger: nearestUnrated(challengerIndex, next, championIndex),
        resetPan: false,
      });
    },
    [images, challengerIndex, championIndex, ratings, nearestUnrated, resolveCompareDecide],
  );

  // Enter → challenger wins: promoted to Champion (Keep); old champion → Reject.
  const challengerWins = useCallback(() => {
    const champImg = images[championIndex];
    const challImg = images[challengerIndex];
    if (!champImg || !challImg) return;
    const newChamp = challengerIndex;
    const next: Record<number, Rating> = { ...ratings };
    next[champImg.id] = "reject";
    next[challImg.id] = "keep";
    resolveCompareDecide({
      changes: [
        { imgId: champImg.id, path: champImg.path, before: ratings[champImg.id], after: "reject" },
        { imgId: challImg.id, path: challImg.path, before: ratings[challImg.id], after: "keep" },
      ],
      flash: { rating: "keep", imgId: challImg.id },
      nextChampion: newChamp,
      nextChallenger: nearestUnrated(newChamp, next, newChamp),
      resetPan: true,
    });
  }, [images, championIndex, challengerIndex, ratings, nearestUnrated, resolveCompareDecide]);

  return { applyRating, unrateCurrent, challengerLoses, challengerKeptBoth, challengerWins };
}
