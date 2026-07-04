// src/components/strip/useStripVirtualizer.ts
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { computeCenterScrollLeft, computeWindow, type WindowRange } from "./computeWindow";

/**
 * Scroll-driven virtualizer for a horizontal filmstrip. Owns the scroll
 * container ref and the visible {first,last} range. Centering on `centerOffset`
 * is an imperative `scrollLeft` write (instant); the range is recomputed
 * synchronously in the same layout effect so the centered cell is present the
 * same frame. A rAF-throttled scroll handler backstops manual dragging, and a
 * ResizeObserver re-centers on container resize (monitor resize / strip toggle).
 */
export function useStripVirtualizer(args: {
  count: number;
  stride: number;
  cellWidth: number;
  centerOffset: number;
  buffer: number;
  /** Cumulative gap offsets (see computeWindow) — burst breathing room. */
  prefix?: readonly number[];
}) {
  const { count, stride, cellWidth, centerOffset, buffer, prefix } = args;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [range, setRange] = useState<WindowRange>({ first: 0, last: 0 });
  const rafRef = useRef<number | null>(null);
  const trackWidth = count * stride + (prefix?.[count] ?? 0);

  const recompute = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const next = computeWindow({
      scrollLeft: el.scrollLeft,
      clientWidth: el.clientWidth,
      stride,
      count,
      buffer,
      prefix,
    });
    setRange((prev) =>
      prev.first === next.first && prev.last === next.last ? prev : next,
    );
  }, [stride, count, buffer, prefix]);

  const center = useCallback(() => {
    const el = containerRef.current;
    if (el && centerOffset >= 0) {
      el.scrollLeft = computeCenterScrollLeft({
        centerOffset,
        stride,
        cellWidth,
        clientWidth: el.clientWidth,
        trackWidth: count * stride + (prefix?.[count] ?? 0),
        prefix,
      });
    }
    recompute();
  }, [centerOffset, stride, cellWidth, count, prefix, recompute]);

  // Keep a stable ref to the latest `center` so the scroll/resize subscriptions
  // don't tear down + re-subscribe on every scrub step (centerOffset change).
  const centerRef = useRef(center);
  useLayoutEffect(() => {
    centerRef.current = center;
  });

  // Re-center whenever the active offset or geometry changes.
  useLayoutEffect(() => {
    center();
  }, [center]);

  // Manual-scroll backstop: rAF-throttled range recompute.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onScroll = () => {
      if (rafRef.current != null) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        recompute();
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [recompute]);

  // Resize: re-center + recompute (clientWidth changed). Subscribed once.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => centerRef.current());
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return { containerRef, trackWidth, first: range.first, last: range.last };
}
