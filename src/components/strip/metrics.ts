// src/components/strip/metrics.ts
/** Filmstrip cell geometry, shared by FilmStrip + the virtualizer math. */
export const CELL_W = 76;
export const CELL_H = 54;
const CELL_GAP = 4;
/** Per-cell horizontal stride: 76px frame + 4px gap (see App.css .cull-thumb). */
export const CELL_STRIDE = CELL_W + CELL_GAP; // 80
/** Cells rendered beyond the visible viewport on each side (manual-drag margin). */
export const STRIP_BUFFER = 4;
