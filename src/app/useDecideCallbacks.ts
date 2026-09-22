import { useCallback, type Dispatch, type RefObject, type SetStateAction } from "react";
import type {
  Img,
  Label,
  LabelValue,
  MetaChange,
  NavEntry,
  Rating,
  Star,
  UndoAction,
} from "../types";
import { imageStore } from "../image/imageStore";
import { emptiedPaths } from "../utils/emptySidecar";
import { withChanges, withMeta } from "../utils/withChanges";

/** The two halves of {@link MetaChange}, narrowed. `withMeta` is generic over
 *  ONE value type, so the union itself would not fit the `Record<number, Star>`
 *  call; each builder below produces only its own half anyway. */
type StarChange = Extract<MetaChange, { field: "star" }>;
type LabelChange = Extract<MetaChange, { field: "label" }>;

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
  stars,
  setStars,
  labels,
  setLabels,
  persistStar,
  persistLabel,
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
  stars: Record<number, Star>;
  setStars: Dispatch<SetStateAction<Record<number, Star>>>;
  labels: Record<number, LabelValue>;
  setLabels: Dispatch<SetStateAction<Record<number, LabelValue>>>;
  persistStar: (path: string, star: Star | null) => void;
  persistLabel: (path: string, label: Label | null) => void;
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
        setRatings((prev) => withChanges(prev, changes));
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
      setRatings((prev) => withChanges(prev, changes));
      for (const c of changes) persistRating(c.path, null);
      return;
    }

    const cur = images[currentIndex];
    if (!cur || !ratings[cur.id]) return;
    // Same off-screen guard as applyRating: with the cursor outside the active
    // filter the photo isn't displayed (no-match screen), so `u` must not
    // silently strip a hidden frame's rating.
    if (visibleIndices.indexOf(currentIndex) === -1) return;
    const changes = [{ imgId: cur.id, path: cur.path, before: ratings[cur.id], after: undefined }];
    recordAction({ changes });
    setRatings((prev) => withChanges(prev, changes));
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
   * Which frames a star / colour-label keypress acts on: the whole grid
   * selection when there is one, intersected with the active filter, exactly
   * as `applyRating` does — else the current frame, and NOTHING when the
   * cursor sits outside the active filter (the loupe shows a no-match screen
   * there, and grading a frame you cannot see is never right).
   */
  const markTargets = useCallback((): Img[] => {
    if (gridVisible && selectedIndices.size >= 1) {
      const visibleSet = new Set(visibleIndices);
      return Array.from(selectedIndices)
        .filter((idx) => visibleSet.has(idx))
        .map((idx) => images[idx])
        .filter((im): im is Img => Boolean(im));
    }
    const cur = images[currentIndex];
    if (!cur) return [];
    if (visibleIndices.indexOf(currentIndex) === -1) return [];
    return [cur];
  }, [gridVisible, selectedIndices, visibleIndices, images, currentIndex]);

  /**
   * A mark clear can leave a CULL-created sidecar holding nothing at all, and
   * the backend only deletes such a file inside `clear_xmp_rating` — which
   * `unrateCurrent` never sends for a frame that is already unrated. So every
   * star / label change is followed by the unrate for whichever frames it
   * emptied: same per-path queue, issued AFTER the clear, once per frame. The
   * backend still refuses to delete a sidecar it did not create or one that
   * holds user content; this only gives it the chance to decide.
   */
  const sweepEmptied = useCallback(
    (meta: readonly MetaChange[]) => {
      for (const path of emptiedPaths(meta, { ratings, stars, labels })) {
        persistRating(path, null);
      }
    },
    [ratings, stars, labels, persistRating],
  );

  /**
   * Set (or clear, with `null`) the star on the current frame or the whole
   * grid selection. ONE undo step per keypress, whatever the selection size.
   *
   * Deliberately NOT like `applyRating`: no advance and no verdict flash. A
   * star is orthogonal to keep/reject — it finishes nothing, so the cursor
   * stays where the user is looking, and the full-frame wash belongs to a
   * verdict. Frames already at the target star are dropped, so a re-press is
   * free (no sidecar round-trip, no dead before===after entry that would also
   * wipe a pending redo).
   */
  const applyStar = useCallback(
    (star: Star | null) => {
      const after = star ?? undefined;
      const meta: StarChange[] = markTargets()
        .filter((im) => stars[im.id] !== after)
        .map((im) => ({
          imgId: im.id,
          path: im.path,
          field: "star" as const,
          before: stars[im.id],
          after,
        }));
      if (meta.length === 0) return;
      recordAction({ changes: [], meta });
      setStars((prev) => withMeta(prev, meta));
      for (const m of meta) persistStar(m.path, star);
      sweepEmptied(meta);
    },
    [markTargets, stars, recordAction, setStars, persistStar, sweepEmptied],
  );

  /**
   * Set the colour label on the current frame or the whole grid selection —
   * TOGGLING it off when that label is already there, as Lightroom does.
   *
   * With a multi-select the toggle needs one answer, not N: the ANCHOR
   * decides — the cursor frame when it is inside the selection, else the
   * first selected frame — so one press does one thing to the whole set
   * instead of half-toggling it.
   *
   * A frame carrying `"custom"` — the user's own Lightroom label — is SKIPPED
   * outright: no state change, no write, no undo entry. CULL only ever learns
   * the WORD "custom", never the string behind it, so overwriting one would be
   * a one-way door that undo could not reverse. In a multi-select the other
   * frames still change; when every target is custom the press does nothing at
   * all. It is therefore not eligible to be the anchor either — the toggle
   * question is answered by a frame the press can actually reach.
   */
  const applyLabel = useCallback(
    (label: Label) => {
      const targets = markTargets().filter((im) => labels[im.id] !== "custom");
      if (targets.length === 0) return;
      const cursor = images[currentIndex];
      const anchor = targets.find((im) => im.id === cursor?.id) ?? targets[0];
      const after: Label | undefined = labels[anchor.id] === label ? undefined : label;
      const meta: LabelChange[] = targets
        .filter((im) => labels[im.id] !== after)
        .map((im) => ({
          imgId: im.id,
          path: im.path,
          field: "label" as const,
          before: labels[im.id],
          after,
        }));
      if (meta.length === 0) return;
      recordAction({ changes: [], meta });
      setLabels((prev) => withMeta(prev, meta));
      for (const m of meta) persistLabel(m.path, after ?? null);
      sweepEmptied(meta);
    },
    [
      markTargets,
      labels,
      images,
      currentIndex,
      recordAction,
      setLabels,
      persistLabel,
      sweepEmptied,
    ],
  );

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
      const next = withChanges(ratings, changes);

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
    const changes: DecideSpec["changes"] = [
      { imgId: challImg.id, path: challImg.path, before: ratings[challImg.id], after: "reject" },
    ];
    const next = withChanges(ratings, changes);
    resolveCompareDecide({
      changes,
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
      const changes: DecideSpec["changes"] = [
        { imgId: challImg.id, path: challImg.path, before: ratings[challImg.id], after: verdict },
      ];
      const next = withChanges(ratings, changes);
      resolveCompareDecide({
        changes,
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
    const changes: DecideSpec["changes"] = [
      { imgId: champImg.id, path: champImg.path, before: ratings[champImg.id], after: "reject" },
      { imgId: challImg.id, path: challImg.path, before: ratings[challImg.id], after: "keep" },
    ];
    const next = withChanges(ratings, changes);
    resolveCompareDecide({
      changes,
      flash: { rating: "keep", imgId: challImg.id },
      nextChampion: newChamp,
      nextChallenger: nearestUnrated(newChamp, next, newChamp),
      resetPan: true,
    });
  }, [images, championIndex, challengerIndex, ratings, nearestUnrated, resolveCompareDecide]);

  return {
    applyRating,
    unrateCurrent,
    challengerLoses,
    challengerKeptBoth,
    challengerWins,
    applyStar,
    applyLabel,
  };
}
