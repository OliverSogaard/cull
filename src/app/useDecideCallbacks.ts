import { useCallback, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { Img, NavEntry, Rating, UndoAction } from "../types";
import { imageStore } from "../image/imageStore";

/**
 * The rating decides, verbatim from App (grand cleanup Phase 6): single-frame
 * / grid-selection rating (applyRating, unrateCurrent) and the three compare
 * decides (challenger loses / kept-both / wins). The setState-then-
 * `dropZoomFullsExcept` sequencing inside each decide is load-bearing — see
 * the sync-flush ordering comments in the bodies; do not "simplify" it.
 */
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
    // Zoomed decide: the challenger pane's content swaps under the live
    // transform — land it at scale, no drift. Champion pane is untouched
    // (shared pan kept), so its view can't jump.
    if (isZoomingRef.current && !exiting) setZoomSwapInstant(true);
    if (exiting) {
      // No more candidates — pop back to whichever site we came from, landing on
      // the (unchanged) champion. ESC after this lands further up the stack.
      goBack(championIndex);
    } else {
      setChallengerIndex(nextChallenger);
    }
    // Sequential swap: drop every zoom full outside the surviving pair BEFORE
    // the new challenger's decodes (holding both pairs at once is the proven
    // jetsam kill). AFTER the last setState on purpose: the store's invalidate
    // forces a SYNC React flush, and flushing between setRatings and
    // setChallengerIndex rendered a half-updated strip (the 2026-07-07 crash).
    // Runs on UNZOOMED decides too since the pane unification: PhotoPane's
    // settle policy keeps both panes' fulls resident even unzoomed, so
    // without the drop each decide accumulated the outgoing challenger's.
    if (!exiting) {
      const keep = [images[championIndex]?.path, images[nextChallenger]?.path].filter(
        (x): x is string => Boolean(x),
      );
      imageStore.dropZoomFullsExcept(keep);
    }
    // currentIndex deliberately omitted: compare mode never updates it (known
    // cursor divergence, see setCursor note) — the frozen value is intended.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // K → keep both: challenger becomes Keep (F → Favorite); champion is
  // untouched and stays champion; advance to the next unrated. The verb the
  // tournament lacked — comparing two good frames no longer forces a loser.
  const challengerKeptBoth = useCallback(
    (asFavorite: boolean) => {
      const challImg = images[challengerIndex];
      if (!challImg) return;
      const verdict: Rating = asFavorite ? "favorite" : "keep";
      const next: Record<number, Rating> = { ...ratings, [challImg.id]: verdict };
      const nextChallenger = nearestUnrated(challengerIndex, next, championIndex);
      const exiting = nextChallenger === -1;
      recordAction({
        changes: [
          { imgId: challImg.id, path: challImg.path, before: ratings[challImg.id], after: verdict },
        ],
        cursorBefore: {
          compareMode: true,
          championIndex,
          challengerIndex,
          currentIndex,
          navStack: [...navStackRef.current],
        },
        // Champion is unchanged; redo lands on the next challenger (or leaves
        // compare on the last-frame auto-exit, landing on the champion).
        cursorAfter: exiting
          ? { compareMode: false, championIndex, challengerIndex, currentIndex: championIndex }
          : { compareMode: true, championIndex, challengerIndex: nextChallenger, currentIndex },
      });
      flashFeedback(verdict, challImg.id);
      persistRating(challImg.path, verdict);
      setRatings(next);
      // Same zoomed-decide handling as challengerLoses: champion untouched.
      if (isZoomingRef.current && !exiting) setZoomSwapInstant(true);
      if (exiting) {
        // No more candidates — pop back to whichever site we came from, landing
        // on the (unchanged) champion, exactly like challengerLoses' exit.
        goBack(championIndex);
      } else {
        setChallengerIndex(nextChallenger);
      }
      // Outgoing challenger's full dropped AFTER the last setState (see
      // challengerLoses for the sync-flush ordering rationale; unzoomed too
      // since the pane unification keeps fulls resident).
      if (!exiting) {
        const keep = [images[championIndex]?.path, images[nextChallenger]?.path].filter(
          (x): x is string => Boolean(x),
        );
        imageStore.dropZoomFullsExcept(keep);
      }
    },
    // currentIndex deliberately omitted: compare mode never updates it (known
    // cursor divergence, see setCursor note) — the frozen value is intended.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      challengerIndex,
      championIndex,
      images,
      ratings,
      flashFeedback,
      persistRating,
      nearestUnrated,
      goBack,
      recordAction,
    ],
  );

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
        : {
            compareMode: true,
            championIndex: newChamp,
            challengerIndex: nextChallenger,
            currentIndex,
          },
    });
    flashFeedback("keep", challImg.id);
    persistRating(champImg.path, "reject"); // dethroned
    persistRating(challImg.path, "keep"); // crowned
    setRatings(next);
    // Zoomed decide with a NEW champion: both panes re-anchor at the new
    // champion's AF point (shared pan resets), landing at scale instantly.
    if (isZoomingRef.current && !exiting) {
      setZoomSwapInstant(true);
      setPanOffset({ x: 0, y: 0 });
    }
    setChampionIndex(newChamp);
    if (exiting) {
      // Crowned the last unrated frame — pop back to where the user came from,
      // landing on the new keeper. Pass newChamp explicitly: goBack's own closure
      // still holds the OLD (just-rejected) champion. (Auto-exit, like ESC.)
      goBack(newChamp);
    } else {
      setChallengerIndex(nextChallenger);
    }
    // Sequential swap: the old champion's full goes NOW (the new champion IS
    // the old challenger, so its full is already resident, no refetch). AFTER
    // the last setState (see challengerLoses for the sync-flush rationale;
    // unzoomed too since the pane unification keeps fulls resident).
    if (!exiting) {
      const keep = [images[newChamp]?.path, images[nextChallenger]?.path].filter((x): x is string =>
        Boolean(x),
      );
      imageStore.dropZoomFullsExcept(keep);
    }
    // currentIndex deliberately omitted: compare mode never updates it (known
    // cursor divergence, see setCursor note) — the frozen value is intended.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  return { applyRating, unrateCurrent, challengerLoses, challengerKeptBoth, challengerWins };
}
