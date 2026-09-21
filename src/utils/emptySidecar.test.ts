import { describe, expect, it } from "vitest";
import { emptiedPaths, type MarkMaps } from "./emptySidecar";
import type { MetaChange } from "../types";

/**
 * Which frames a star / colour-label change leaves with an EMPTY sidecar.
 *
 * The backend only deletes a CULL-created sidecar inside `clear_xmp_rating`,
 * and the unrate key never sends that command for a frame that was already
 * unrated — so `3` then `0` on an unrated frame used to leave an empty `.xmp`
 * behind for good. The caller answers this question and follows the clear
 * with the unrate; the backend still decides whether the file may go.
 */

const NONE: MarkMaps = { ratings: {}, stars: {}, labels: {} };
const star = (imgId: number, after: 1 | 2 | 3 | 4 | 5 | undefined): MetaChange => ({
  imgId,
  path: `/s/${imgId}.cr3`,
  field: "star",
  before: 3,
  after,
});
const label = (imgId: number, after: "red" | undefined): MetaChange => ({
  imgId,
  path: `/s/${imgId}.cr3`,
  field: "label",
  before: "red",
  after,
});

describe("emptiedPaths", () => {
  it("names a frame whose last star just went, with nothing else on it", () => {
    expect(emptiedPaths([star(1, undefined)], { ...NONE, stars: { 1: 3 } })).toEqual(["/s/1.cr3"]);
  });

  it("says nothing about a frame that still carries a verdict", () => {
    expect(emptiedPaths([star(1, undefined)], { ...NONE, ratings: { 1: "keep" } })).toEqual([]);
  });

  it("says nothing about a frame that still carries a colour label", () => {
    expect(emptiedPaths([star(1, undefined)], { ...NONE, labels: { 1: "blue" } })).toEqual([]);
    // The user's own Lightroom label is content too — arguably the content
    // most worth not deleting.
    expect(emptiedPaths([star(1, undefined)], { ...NONE, labels: { 1: "custom" } })).toEqual([]);
  });

  it("says nothing about a frame that still carries a star", () => {
    expect(emptiedPaths([label(1, undefined)], { ...NONE, stars: { 1: 2 } })).toEqual([]);
  });

  it("says nothing when the change SETS a mark rather than clearing it", () => {
    expect(emptiedPaths([star(1, 4)], NONE)).toEqual([]);
    expect(emptiedPaths([label(1, "red")], NONE)).toEqual([]);
  });

  it("reads the change, not the stale map, for the field it touches", () => {
    // The map still holds the star this very change is removing.
    expect(emptiedPaths([star(1, undefined)], { ...NONE, stars: { 1: 5 } })).toEqual(["/s/1.cr3"]);
  });

  it("names each frame of a multi-select exactly once", () => {
    const meta = [star(1, undefined), star(2, undefined)];
    expect(emptiedPaths(meta, { ...NONE, stars: { 1: 3, 2: 4 } })).toEqual([
      "/s/1.cr3",
      "/s/2.cr3",
    ]);
  });

  it("names a frame once even when both of its fields are cleared at once", () => {
    expect(emptiedPaths([star(1, undefined), label(1, undefined)], NONE)).toEqual(["/s/1.cr3"]);
  });
});
