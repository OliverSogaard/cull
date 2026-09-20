import { describe, expect, test } from "vitest";
import {
  DEFAULT_GRID_SIZE,
  GRID_CELL_TARGET,
  GRID_SIZES,
  gridCellWidth,
  gridColsFor,
  isGridSize,
  stepGridSize,
} from "./gridSize";

describe("grid size", () => {
  test("three steps, the numbers the board picked, medium in the middle", () => {
    expect(GRID_SIZES).toEqual(["small", "medium", "large"]);
    expect(GRID_CELL_TARGET).toEqual({ small: 128, medium: 168, large: 256 });
    expect(DEFAULT_GRID_SIZE).toBe("medium");
  });

  test("medium is TODAY's grid at both the default and the maximized window", () => {
    // 1600-wide window → .cull-grid content 1600 − 48 padding = 1552.
    expect(gridColsFor(1552, "medium")).toBe(9);
    // 2560-wide window → 2512 of content; today's 168 target gives 14 columns.
    expect(gridColsFor(2512, "medium")).toBe(14);
    expect(gridCellWidth(2512, 14)).toBe(179);
  });

  test("small and large land where the board said", () => {
    expect(gridColsFor(2512, "small")).toBe(19);
    expect(gridCellWidth(2512, 19)).toBe(132);
    expect(gridColsFor(2512, "large")).toBe(9);
    expect(gridCellWidth(2512, 9)).toBe(279);
  });

  test("never fewer than two columns, however narrow", () => {
    expect(gridColsFor(100, "large")).toBe(2);
    expect(gridColsFor(0, "medium")).toBe(2);
  });

  test("stepping clamps at both ends — no wrap", () => {
    expect(stepGridSize("small", 1)).toBe("medium");
    expect(stepGridSize("medium", 1)).toBe("large");
    expect(stepGridSize("large", 1)).toBe("large");
    expect(stepGridSize("large", -1)).toBe("medium");
    expect(stepGridSize("medium", -1)).toBe("small");
    expect(stepGridSize("small", -1)).toBe("small");
  });

  test("the guard accepts exactly the three values", () => {
    expect(GRID_SIZES.every(isGridSize)).toBe(true);
    expect(isGridSize("huge")).toBe(false);
    expect(isGridSize(168)).toBe(false);
    expect(isGridSize(undefined)).toBe(false);
  });

  test("the cell width falls back to the medium target before anything is measured", () => {
    expect(gridCellWidth(0, 6)).toBe(GRID_CELL_TARGET.medium);
  });
});
