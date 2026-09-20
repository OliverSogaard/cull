# Phase 3B — Scale and layout: design

Second of the three Phase 3 slices (3A See and feel → **3B Scale and layout** → 3C Navigate and review). Oliver chose from a design board built from the app's real stylesheet and components (2026-09-20): **1A 2B 3B 4B 5B 6A 7B** — every recommendation. His screen: 3840 × 2160 at Windows 150 % → a maximized window is 2560 × 1440 CSS px at devicePixelRatio 1.5; the default window is 1600 × 1000.

The app today has no responsive behaviour at all: one `@media` rule (reduced motion), no container queries, one viewport unit. Everything below is additive to that.

## The picks

### 1A · Grid sizes — Small / Medium / Large
- Column target (`GRID_CELL_TARGET`, today 168): **Small 128, Medium 168, Large 256**. The maths is unchanged: `cols = max(2, floor(contentW / target))`, `cellW = floor(contentW / cols)`, square rows.
- Ruling: the board labelled Medium "176 (today)". 176 equals today only at 2560 px (14 columns); at the default 1600-px window it would drop a column. Medium stays **168** so that Medium is today's grid at every window size, which is what the option promised.
- Keys, in the grid only: `+` / `=` larger, `-` smaller (bare keys, numpad too); `Ctrl` + wheel steps under the cursor; `Ctrl+0` back to Medium. `⌘` on macOS. Steps clamp at Small and Large — no wrap.
- The size is a setting (`gridSize: "small" | "medium" | "large"`, default `"medium"`), persisted with the others, with a row in Settings (a three-segment control) and rows in the help sheet's grid group.
- Changing size keeps the current frame in view (the existing auto-scroll does this when `cols` changes — verify, do not rebuild).

### The sharper grid thumbnail (no choice — the grid is already soft)
The grid shows the CR3's embedded THMB, 160 × 120. At DPR 1.5 today's 161-px frame is a 1.5× upscale; Large would be 2.4×. This phase adds a **grid thumbnail: 512 px on the long edge, JPEG q82, made from the CR3's embedded 1620 × 1080 preview**, cached on disk, requested lazily.
- Backend: new `gridthumb.rs` reusing the mid tier's machinery (zune-jpeg decode → fast_image_resize Lanczos3 → jpeg-encoder → **the EXIF-orientation splice, or every portrait frame is sideways**). New cache tier `Grid` (tier byte 3, subdir `grid/`, caps 512 MiB total / 512 KiB per entry; cache `VERSION` stays 3 — additive). New command `read_grid_thumb(path, gen)` returning the app's usual binary frame with header `{gridLen, width, height}`. A preview that is missing, undecodable or not larger than the target answers with one quiet sentinel error, `"grid thumb unavailable"`.
- The grid path must NOT fill the preview cache: 2,726 previews (~2.2 GB) would overflow its 2 GiB cap and thrash it.
- Frontend: a sixth `TierLane` (`gridThumbConcurrency`: 4 local / 1 network), its own windowed eviction around the visible grid range (±120 cells) — the thumb "LRU" has no recency tracking and must not be reused; the new knob is clamped under memory pressure like the others.
- Request rule: only for cells inside the visible grid range, and only when the painted frame needs more than the THMB has: `(cellW − 18) × devicePixelRatio > 160`.
- The THMB stays underneath and paints first; the grid thumbnail fades in over it (`decoding="async"`). A sentinel or any failure leaves the cell on its THMB for the session — no shimmer, no retry loop, no error chip.
- The filmstrip stays on the THMB (104 CSS px at DPR 1.5 = 156 device px — still a downscale).
- Tombstones (`forgotten`) gate this lane's entry point and landings like the others.

### 2B · Filmstrip — two steps
- Cells are 76 × 54, and **104 × 74 when the window is at least 1200 CSS px tall**. Gap 4; stride = width + 4.
- One source of truth: the numbers live in `strip/metrics.ts`; CSS receives them as custom properties set on the strip's root element; the step is chosen by one `matchMedia("(min-height: 1200px)")` subscription. Every consumer of the old constants (`computeWindow`, `BurstBoxes`, `FilmStrip`, the virtualizer) takes the metrics as values.
- Ruling: `.cull-thumbs` declares `height: 82px; padding: 20px 0 8px` with no `box-sizing`, so its real box is 111 px with 28 px of dead space under the cells, although its own comment does the sum as border-box (20 + 54 + 8 = 82). Fixed here: `box-sizing: border-box`, height `20 + cellH + 8` (+1 border) — 83 / 103 px. The photo gains 28 px of height. This is visible; it is on Oliver's walk.

### 3B · Footer sheds as the window narrows; minimum window width 1024
Pure CSS on the window width — no resize listener:
- below **1360**: the key hint is hidden;
- below **1200**: the zoom chip reads `1:1` instead of `zoom 1:1` (likewise for the other zoom levels), the scrub chip loses its label the same way, and the file name loses its extension;
- below **1100**: the finish button's label is `Finish`.
Where a label comes from a prop, the component renders both forms and CSS shows one. `minWidth` 800 → **1024** in `tauri.conf.json`. Nothing is ever clipped at 1024, including the "All N rated" finish state and a failed-save chip — test the worst case, not the typical one.

### 4B · Compact info rail below 1200 px of window width
Loupe rail 290 → **232** (padding `28px 20px`, gap 28); compare rail 340 → **288** (the compare rows' fixed first column narrows in proportion, 90 → 76). Through the `--rail-w` / `--rail-w-compare` tokens.

### 5B · The home screen grows with the window
From **2000 px** of window width: hero and recents max-width 620 → **780**, title 56 → **72**, sub 17 → **19** with its max-width 500 → **620** (and the how-it-works line likewise), recents path 14 → **15** with row padding `13px 0` → `16px 0`. Same left-aligned editorial layout. Below 2000 px nothing changes.

### 6A · Settings stays 680 px wide
No change.

### 7B · The help sheet draws keycaps
- Every shortcut is drawn with the app's keycap (`KeyCombo` / `.kbd`), one vocabulary: `Ctrl` `Z` · `Ctrl` `Shift` `Z` · `Shift` `Space` · `Esc` · `Enter` · `Backspace` · `Tab` · `Space` · `Click` · arrows as `←` `→` `↑` `↓` caps · letters upper-case in the cap · a range as `1` – `4` with a muted en dash · "hold" as a muted word after the caps, never inside one.
- The row data becomes structured (key tokens + an optional `hold` flag / range), not a display string.
- Key column 110 → **132 px**.
- The new grid-size rows (`+` `−`, `Ctrl` `0`) are born in this form.

## Included without a choice
- `tauri.conf.json` `backgroundColor` `#000000` → **`#0c0c0d`** (= `--bg` = `index.html`'s inline colour): no black flash on launch and resize.
- The layout tokens that exist but were never referenced (`--bar-h`, `--winbtn-w`, `--rail-w`, `--rail-w-compare`, `--strip-h`, `--cell-w`, `--cell-h`) are wired to their use sites; the responsive steps above change tokens, not scattered literals.
- The title bar reserves the real width of the Windows window buttons (4 × 44 = 176 px; today 148).
- **Backdrops: the tone is baked, the vignette is not.** `grayscale(1) brightness(0.85) contrast(1.05)` at `opacity: 0.11` over `--bg` is baked into each JPEG, at 2560 px wide (Lanczos from the 1440 / 1600-px sources — there is no larger source, so no true 2× exists; the image is a dim texture and the upscale only has to beat the browser's bilinear one). The radial mask stays in CSS: it is sized to the window, not the image, and baking it would change the vignette at every aspect ratio other than the one it was baked at. The bake is a committed, re-runnable script with no new dependency.
- Both backdrops get the identical recipe (they already share it; they keep sharing it).

## Rulings on scope
- The class ↔ rule CSS census is done: 329 classes defined, none dead (all 25 "unreferenced" names are `--modifier` completions built at runtime); 3 referenced names have no rule and are harmless hooks. No guard test — a regex census is ~90 % noise on this codebase. Recorded, closed.
- `minHeight` stays 500.
- No DPR-driven layout, no `zoom`, no user font-size setting.

## Testing
- Pure functions get unit tests: grid size stepping and clamping, the grid-thumb request rule, strip metrics by window height, help-row rendering, the settings migration/default for `gridSize`.
- Stylesheet guards by raw read (the established pattern): the breakpoints exist with the picked numbers; the strip's CSS numbers equal `metrics.ts`; tokens are referenced.
- Rust: generator tests mirroring the mid tier's (dimensions, orientation splice, too-small source), cache-tier roundtrip / clear / oversized for the fourth store.
- `imageStore`: the sixth lane joins the lane-parity net; eviction window; tombstones; the sentinel latches per path; pressure clamp.
- Live, PC idle, click-only on a scratch copy: grid at three sizes (sharpness at Large), the strip at 1600 × 1000 and maximized, the footer at 1024, the rail at 1100, home maximized.

## Out of scope
Home / End / PgUp / PgDn, the Rejects tab, capture-time sort (3C). Tests & CI work (Phase 4). Stars and colour labels, installers (Phase 5). CR3 only.
