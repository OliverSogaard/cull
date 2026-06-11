import { useEffect, useState } from "react";
import { imageStore } from "../image/imageStore";

/**
 * Dev-only performance HUD (IMAGE_PIPELINE_PLAN.md Phase 3): per-nav fetch
 * timings, lane/queue utilization, cache sizes, eviction/error counters, and
 * the decoded-memory estimate. Enable with `localStorage["cull:devhud"]="1"`
 * in devtools + reload. Every later profile-tuning claim cites these numbers,
 * not feel — this is also where the pending Windows raw-IPC measurement
 * (Phase 2 decision gate) gets read off.
 */
export function DevHud() {
  const [stats, setStats] = useState(() => imageStore.debugStats());
  useEffect(() => {
    const id = window.setInterval(() => setStats(imageStore.debugStats()), 500);
    return () => window.clearInterval(id);
  }, []);
  return (
    <div className="cull-devhud" aria-hidden>
      <div className="cull-devhud__row cull-devhud__row--head">
        nav avg {stats.navMsAvg}ms · {stats.legacyNav ? "LEGACY full-nav" : "preview-nav"} · ~
        {stats.decodedMB}MB decoded
      </div>
      <div className="cull-devhud__row">
        lanes&nbsp; prvw {stats.lanes.preview} · zoom {stats.lanes.zoom} · thumb {stats.lanes.thumb} · bg{" "}
        {stats.lanes.bg}
      </div>
      <div className="cull-devhud__row">
        cache&nbsp; prvw {stats.caches.previews} · zoom {stats.caches.zoomFulls} · thumb{" "}
        {stats.caches.thumbs} · dims {stats.caches.dims}
      </div>
      <div className="cull-devhud__row">
        loads n{stats.counts.navLoads} z{stats.counts.zoomLoads} t{stats.counts.thumbLoads} · evict p
        {stats.counts.previewEvicts} z{stats.counts.zoomEvicts} · err {stats.counts.errors}
      </div>
      {stats.navTimings.map((t, i) => (
        <div className="cull-devhud__row cull-devhud__row--dim" key={i}>
          {t.ms}ms&nbsp;{t.name}
          {t.legacy ? " (legacy)" : ""}
        </div>
      ))}
      {/* Zoom-tier (full) fetch times — on a local drive ≈ the raw-IPC
          transfer cost of the ~10 MB full (the Phase 2 Windows benchmark). */}
      {stats.zoomTimings.map((t, i) => (
        <div className="cull-devhud__row cull-devhud__row--dim" key={`z${i}`}>
          zoom {t.ms}ms&nbsp;{t.name}
        </div>
      ))}
    </div>
  );
}
