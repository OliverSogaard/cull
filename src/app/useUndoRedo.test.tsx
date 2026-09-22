// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { SetStateAction } from "react";
import type { Img, Label, LabelValue, NavEntry, Rating, Star } from "../types";
import { useUndoRedo } from "./useUndoRedo";

/**
 * Undo / redo, with the star and colour-label layer beside the verdicts.
 *
 * What makes these worth writing: an `UndoAction` for a star has an EMPTY
 * `changes` array, and every guard in this hook was written when that was
 * impossible. `recordAction` dropped such an action on the floor; `undo`
 * indexed `changes[length - 1]` to pick a landing frame and would have thrown.
 */

afterEach(cleanup);

const IMAGES: Img[] = [0, 1, 2].map((id) => ({
  id,
  path: `/s/${id}.cr3`,
  filename: `${id}.cr3`,
  srcFolder: "/s",
}));

/**
 * One field per hook parameter, every callback an inert typed spy — the hook
 * never reads a setter's result. `satisfies Parameters<…>[0]` is the same
 * compile-time pin `useDecideCallbacks.test.tsx` uses: a renamed prop breaks
 * this file rather than leaving it testing yesterday's shape.
 */
function makeProps() {
  const props = {
    images: IMAGES,
    compareMode: false,
    persistRating: vi.fn((_path: string, _rating: Rating | null) => {}),
    persistStar: vi.fn((_path: string, _star: Star | null) => {}),
    persistLabel: vi.fn((_path: string, _label: Label | null) => {}),
    setRatings: vi.fn((_v: SetStateAction<Record<number, Rating>>) => {}),
    setStars: vi.fn((_v: SetStateAction<Record<number, Star>>) => {}),
    setLabels: vi.fn((_v: SetStateAction<Record<number, LabelValue>>) => {}),
    setCompareMode: vi.fn((_v: SetStateAction<boolean>) => {}),
    setGridVisible: vi.fn((_v: SetStateAction<boolean>) => {}),
    setChampionIndex: vi.fn((_v: SetStateAction<number>) => {}),
    setChallengerIndex: vi.fn((_v: SetStateAction<number>) => {}),
    setCurrentIndex: vi.fn((_v: SetStateAction<number>) => {}),
    setNavStack: vi.fn((_v: SetStateAction<NavEntry[]>) => {}),
    // Nothing on any frame unless a test says otherwise, so a replay that
    // clears a mark leaves an empty sidecar and the sweep fires.
    marksRef: { current: { ratings: {}, stars: {}, labels: {} } },
  };
  return props satisfies Parameters<typeof useUndoRedo>[0];
}

function renderUndo(p: ReturnType<typeof makeProps>) {
  return renderHook(() => useUndoRedo(p));
}

describe("undo / redo of stars and colour labels", () => {
  it("records a star action at all — its `changes` list is empty", () => {
    const p = makeProps();
    const { result } = renderUndo(p);
    act(() =>
      result.current.recordAction({
        changes: [],
        meta: [{ imgId: 1, path: "/s/1.cr3", field: "star", before: undefined, after: 3 }],
      }),
    );
    act(() => result.current.undo());
    expect(p.persistStar).toHaveBeenCalledWith("/s/1.cr3", null);
  });

  it("undo restores `before`, redo re-applies `after`, on disk and in memory", () => {
    const p = makeProps();
    const { result } = renderUndo(p);
    act(() =>
      result.current.recordAction({
        changes: [],
        meta: [{ imgId: 2, path: "/s/2.cr3", field: "label", before: "red", after: "blue" }],
      }),
    );
    act(() => result.current.undo());
    expect(p.persistLabel).toHaveBeenCalledWith("/s/2.cr3", "red");
    expect(p.setLabels).toHaveBeenCalledTimes(1);
    act(() => result.current.redo());
    expect(p.persistLabel).toHaveBeenLastCalledWith("/s/2.cr3", "blue");
    expect(p.setLabels).toHaveBeenCalledTimes(2);
  });

  it("the map an undo produces restores the key, and a cleared mark DELETES it", () => {
    // Same ruling as the ratings suite: pull the updater out of the mock and
    // run it against a HAND-BUILT map. A stored `undefined` would still make
    // `id in stars` true and every count wrong.
    const p = makeProps();
    const { result } = renderUndo(p);
    act(() =>
      result.current.recordAction({
        changes: [],
        meta: [{ imgId: 1, path: "/s/1.cr3", field: "star", before: undefined, after: 4 }],
      }),
    );
    act(() => result.current.undo());
    const undoUpdater = p.setStars.mock.calls[0][0];
    if (typeof undoUpdater !== "function") throw new Error("setStars needs an updater");
    const afterUndo = undoUpdater({ 1: 4, 2: 5 });
    expect("1" in afterUndo).toBe(false);
    expect(afterUndo).toEqual({ 2: 5 });

    act(() => result.current.redo());
    const redoUpdater = p.setStars.mock.calls[1][0];
    if (typeof redoUpdater !== "function") throw new Error("setStars needs an updater");
    expect(redoUpdater({ 2: 5 })).toEqual({ 1: 4, 2: 5 });
  });

  it("a cleared mark round-trips as null on the wire, not as a missing call", () => {
    const p = makeProps();
    const { result } = renderUndo(p);
    act(() =>
      result.current.recordAction({
        changes: [],
        meta: [{ imgId: 0, path: "/s/0.cr3", field: "star", before: 4, after: undefined }],
      }),
    );
    act(() => result.current.undo());
    expect(p.persistStar).toHaveBeenCalledWith("/s/0.cr3", 4);
    act(() => result.current.redo());
    expect(p.persistStar).toHaveBeenLastCalledWith("/s/0.cr3", null);
  });

  it("never sends `custom` on the wire — CULL cannot reproduce that string", () => {
    // Undoing a colour key pressed over the user's OWN Lightroom label: the
    // original string is not something CULL ever knew, and the backend refuses
    // an unrecognised key outright ("unknown label: custom"), which would show
    // up as a permanently unsaved write. So the undo clears CULL's own label
    // instead — and the map follows the same value, or memory and disk would
    // disagree about the frame.
    const p = makeProps();
    const { result } = renderUndo(p);
    act(() =>
      result.current.recordAction({
        changes: [],
        meta: [{ imgId: 1, path: "/s/1.cr3", field: "label", before: "custom", after: "blue" }],
      }),
    );
    act(() => result.current.undo());
    expect(p.persistLabel).toHaveBeenCalledWith("/s/1.cr3", null);
    const updater = p.setLabels.mock.calls[0][0];
    if (typeof updater !== "function") throw new Error("setLabels needs an updater");
    expect("1" in updater({ 1: "blue" })).toBe(false);
  });

  it("lands the cursor on the frame whose mark changed, with no rating to read", () => {
    // The old code picked the landing frame from `changes[changes.length - 1]`,
    // which is `undefined` for a star action — a TypeError, not a wrong frame.
    const p = makeProps();
    const { result } = renderUndo(p);
    act(() =>
      result.current.recordAction({
        changes: [],
        meta: [{ imgId: 2, path: "/s/2.cr3", field: "star", before: undefined, after: 1 }],
      }),
    );
    act(() => result.current.undo());
    expect(p.setCurrentIndex).toHaveBeenCalledWith(2);
  });

  it("an action carrying BOTH a verdict and a mark replays both", () => {
    const p = makeProps();
    const { result } = renderUndo(p);
    act(() =>
      result.current.recordAction({
        changes: [{ imgId: 1, path: "/s/1.cr3", before: undefined, after: "keep" }],
        meta: [{ imgId: 1, path: "/s/1.cr3", field: "star", before: undefined, after: 2 }],
      }),
    );
    act(() => result.current.undo());
    expect(p.persistRating).toHaveBeenCalledWith("/s/1.cr3", null);
    expect(p.persistStar).toHaveBeenCalledWith("/s/1.cr3", null);
  });

  it("an action with neither list is still dropped", () => {
    const p = makeProps();
    const { result } = renderUndo(p);
    act(() => result.current.recordAction({ changes: [] }));
    act(() => result.current.undo());
    expect(p.persistRating).not.toHaveBeenCalled();
    expect(p.persistStar).not.toHaveBeenCalled();
  });
});

/**
 * Undoing a star or label SET can return a frame to nothing at all — and the
 * sidecar CULL created for that mark is then an empty file the backend will
 * only delete when it is sent `clear_xmp_rating`. The replay has to ask for
 * that unrate exactly as the keypress does.
 */
describe("an undo that empties a frame asks for the unrate too", () => {
  it("sends the unrate after the mark clear, on the same per-path queue", () => {
    const p = makeProps();
    const { result } = renderUndo(p);
    act(() =>
      result.current.recordAction({
        changes: [],
        meta: [{ imgId: 1, path: "/s/1.cr3", field: "star", before: undefined, after: 3 }],
      }),
    );
    act(() => result.current.undo());

    expect(p.persistStar).toHaveBeenCalledWith("/s/1.cr3", null);
    expect(p.persistRating).toHaveBeenCalledWith("/s/1.cr3", null);
    expect(p.persistStar.mock.invocationCallOrder[0]).toBeLessThan(
      p.persistRating.mock.invocationCallOrder[0],
    );
  });

  // Split in two (each fixture carries exactly ONE reason to stay quiet) so
  // a guard that broke on only ratings, or only labels, would fail its own
  // test rather than hiding behind the other guard still holding. The
  // bundled fixture this replaced could not tell which guard a red run meant.
  it("stays quiet when the frame still carries a verdict", () => {
    const p = makeProps();
    p.marksRef.current = { ratings: { 1: "keep" }, stars: {}, labels: {} };
    const { result } = renderUndo(p);
    act(() =>
      result.current.recordAction({
        changes: [],
        meta: [{ imgId: 1, path: "/s/1.cr3", field: "star", before: undefined, after: 3 }],
      }),
    );
    act(() => result.current.undo());

    expect(p.persistStar).toHaveBeenCalledWith("/s/1.cr3", null);
    expect(p.persistRating).not.toHaveBeenCalled();
  });

  it("stays quiet when the frame still carries another mark", () => {
    const p = makeProps();
    p.marksRef.current = { ratings: {}, stars: {}, labels: { 1: "blue" } };
    const { result } = renderUndo(p);
    act(() =>
      result.current.recordAction({
        changes: [],
        meta: [{ imgId: 1, path: "/s/1.cr3", field: "star", before: undefined, after: 3 }],
      }),
    );
    act(() => result.current.undo());

    expect(p.persistStar).toHaveBeenCalledWith("/s/1.cr3", null);
    expect(p.persistRating).not.toHaveBeenCalled();
  });

  it("never follows a verdict the same action just restored with an unrate", () => {
    // The sweep reads the PRE-replay maps, which still say this frame was
    // unrated — but `applyChanges` has just put the keep back from the
    // action's own record. An unsuppressed sweep would wipe it one line later.
    const p = makeProps();
    const { result } = renderUndo(p);
    act(() =>
      result.current.recordAction({
        changes: [{ imgId: 1, path: "/s/1.cr3", before: "keep", after: undefined }],
        meta: [{ imgId: 1, path: "/s/1.cr3", field: "star", before: undefined, after: 3 }],
      }),
    );
    act(() => result.current.undo());

    expect(p.persistRating.mock.calls).toEqual([["/s/1.cr3", "keep"]]);
  });

  it("stays quiet when the undo RESTORES a mark rather than clearing one", () => {
    const p = makeProps();
    const { result } = renderUndo(p);
    act(() =>
      result.current.recordAction({
        changes: [],
        meta: [{ imgId: 1, path: "/s/1.cr3", field: "label", before: "red", after: "blue" }],
      }),
    );
    act(() => result.current.undo());

    expect(p.persistLabel).toHaveBeenCalledWith("/s/1.cr3", "red");
    expect(p.persistRating).not.toHaveBeenCalled();
  });
});
