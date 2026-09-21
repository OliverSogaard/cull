// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { EMPTY_METADATA, type ImageMetadata } from "../types";
import { ExifRail } from "./ExifRail";

/**
 * The rail's star and colour-label row. The `absent` half of every test is
 * the point: with `starsAndLabels` unset the rail must render EXACTLY what
 * it rendered before this feature, read-only LrC row included.
 */

afterEach(cleanup);

const META: ImageMetadata = { ...EMPTY_METADATA, lrcRating: 2 };

function renderRail(over: Partial<Parameters<typeof ExifRail>[0]> = {}) {
  return render(<ExifRail metadata={META} histogramUrl={undefined} {...over} />);
}

describe("the rail with the layer OFF", () => {
  it("renders the read-only LrC row and no mark row at all", () => {
    const { container } = renderRail();
    expect(container.querySelector(".cull-exif-rail__lrc")).not.toBeNull();
    expect(container.querySelector(".cull-mark-stars")).toBeNull();
    expect(container.querySelector(".cull-label-swatch")).toBeNull();
  });

  it("ignores a star and a label it was handed anyway", () => {
    // Off is off: a wiring mistake must render nothing, not a half-feature.
    const { container } = renderRail({ star: 4, label: "red" });
    expect(container.querySelector(".cull-mark-stars")).toBeNull();
    expect(container.querySelector(".cull-label-swatch")).toBeNull();
  });
});

describe("the rail with the layer ON", () => {
  it("replaces the read-only LrC row with the live star meter", () => {
    const { container } = renderRail({ starsAndLabels: true, star: 3 });
    // The same property on disk — rendering both would show a snapshot from
    // open beside the live value.
    expect(container.querySelector(".cull-exif-rail__lrc")).toBeNull();
    const meter = container.querySelector(".cull-mark-stars");
    expect(meter).not.toBeNull();
    expect(meter?.getAttribute("aria-label")).toBe("3 of 5 stars");
    expect(container.querySelectorAll(".cull-mark-star--on")).toHaveLength(3);
    expect(container.querySelectorAll(".cull-mark-star--off")).toHaveLength(2);
  });

  it("clicking a star sets it; clicking the one already set clears it", () => {
    const onSetStar = vi.fn((_s: number | null) => {});
    const { container } = renderRail({ starsAndLabels: true, star: 3, onSetStar });
    const stars = container.querySelectorAll<HTMLButtonElement>(".cull-mark-stars button");
    expect(stars).toHaveLength(5);
    fireEvent.click(stars[4]);
    expect(onSetStar).toHaveBeenCalledWith(5);
    fireEvent.click(stars[2]);
    expect(onSetStar).toHaveBeenLastCalledWith(null);
  });

  it("names the active label and rings its swatch", () => {
    const { container } = renderRail({ starsAndLabels: true, label: "blue" });
    expect(container.querySelectorAll(".cull-label-swatch")).toHaveLength(5);
    expect(container.querySelector(".cull-exif-rail__label-name")?.textContent).toBe("Blue");
    expect(container.querySelector(".cull-label-swatch.is-active")?.className).toContain(
      "cull-label--blue",
    );
  });

  it("shows a label CULL did not write as a sixth, outlined swatch", () => {
    const { container } = renderRail({ starsAndLabels: true, label: "custom" });
    expect(container.querySelectorAll(".cull-label-swatch")).toHaveLength(6);
    expect(container.querySelector(".cull-exif-rail__label-name")?.textContent).toBe("Custom");
    // …and it is not something a click can produce.
    const buttons = container.querySelectorAll<HTMLButtonElement>(".cull-exif-rail__labels button");
    expect(buttons).toHaveLength(5);
  });

  it("clicking a swatch sends the label key", () => {
    const onSetLabel = vi.fn((_l: string) => {});
    const { container } = renderRail({ starsAndLabels: true, onSetLabel });
    const buttons = container.querySelectorAll<HTMLButtonElement>(".cull-exif-rail__labels button");
    fireEvent.click(buttons[1]);
    expect(onSetLabel).toHaveBeenCalledWith("yellow");
  });

  it("flashes when the value CHANGES on one frame, not when the frame changes", () => {
    vi.useFakeTimers();
    try {
      const { container, rerender } = render(
        <ExifRail metadata={META} histogramUrl={undefined} starsAndLabels frameId={1} star={3} />,
      );
      const meter = () => container.querySelector(".cull-mark-stars");
      expect(meter()?.className).not.toContain("cull-mark-flash");

      // Same frame, new star → flash.
      rerender(
        <ExifRail metadata={META} histogramUrl={undefined} starsAndLabels frameId={1} star={4} />,
      );
      expect(meter()?.className).toContain("cull-mark-flash");
      vi.advanceTimersByTime(200);
      rerender(
        <ExifRail metadata={META} histogramUrl={undefined} starsAndLabels frameId={1} star={4} />,
      );
      expect(meter()?.className).not.toContain("cull-mark-flash");

      // New frame that happens to carry a different star → NO flash. A
      // per-cell version of this could not tell the two apart, which is why
      // the grid and the strip do not flash at all.
      rerender(
        <ExifRail metadata={META} histogramUrl={undefined} starsAndLabels frameId={2} star={1} />,
      );
      expect(meter()?.className).not.toContain("cull-mark-flash");
    } finally {
      vi.useRealTimers();
    }
  });
});
