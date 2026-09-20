# Phase 3C — Navigate and review: design

Third and last Phase 3 slice (3A See and feel → 3B Scale and layout → **3C Navigate and review**). No design board this time: Oliver gave a standing instruction on 2026-09-20 to make the calls and keep moving, and none of the three features is a taste decision large enough to stop for. Every choice below is a ruling; each says what it costs if wrong. Facts and file:line references come from a read-only scout of main `c822a3c` (`~/.claude/plans/cull-audit-2026-09-13/phase-3c-scout.txt`).

## A · Home / End / PgUp / PgDn

None of the four keys is bound today; they fall through unhandled, and in the grid an unhandled PageDown scrolls the container behind the cursor.

- **Home / End** — first / last frame *of the active filter* (not index 0): `advance(-1, images.length)` / `advance(+1, images.length)`. `advance` already works in filter-position space and clamps.
- **PgUp / PgDn**
  - Grid: one screenful — `rows × cols`, with `rows = max(1, floor(gridContainer.clientHeight / rowH))`, read at keypress time from the container App already holds a ref to. No new state, no new prop.
  - Loupe and compare: one filmstrip screenful — `max(1, floor(stripClientWidth / stride))` cells, from the live strip metrics (76 or 104 px cells + 4 px gap). Ruling: a screenful, not "the next burst" — burst groups are advisory, often absent, and change as scores land, so the same key would move a different distance at different moments. Cost if wrong: PgDn does not hop bursts; `↓` in the grid and the burst brackets still do that job.
- **Shift+Home / Shift+End** in the grid extend the selection to the edge through the existing `growGridSelection`, with the same mid-hold guard the Shift+arrow cases use.
- All new cases `preventDefault`. They act only where arrows act today (never under dialogs, Settings, the help sheet's swallow, or a text field). Cursor moves push no history — unchanged.
- Help-sheet rows (structured `HelpRow`s, keycaps) in loupe, compare and grid; README keys table.

## B · A Rejects filter tab

So the reject pile can be checked before it is moved.

- A fifth top filter, **`rejects`**, shown LAST: All `1` · Unrated `2` · Keeps `3` · Smart `4` · **Rejects `5`**. Position equals key; nobody's muscle memory moves. `5` is free everywhere.
- No count on the tab (All / Unrated / Keeps carry none; only Smart does).
- It behaves exactly like the other filters, which needs no new logic: un-rejecting a frame inside the tab removes it on the same commit and the cursor lands on the next reject; after Move rejects the tab is empty.
- Empty state gains a Rejects arm — title "No images in the *Rejects* filter", hint "Rejected frames show up here until you finish the cull."
- `stats` gains `rejects` so the tab can be disabled-looking at zero exactly as the others are (follow whatever the existing tabs do at zero — do not invent a treatment).
- **The footer budget.** A fifth tab is 77 px and turns all three binding slacks negative (−63 / −58 / −57 px). Inside the existing `< 1360px` tier — no new breakpoint — (1) Smart's count / percent suffix sheds, as a span hidden with the clip recipe so the button keeps its accessible name, and (2) the tabs' horizontal padding goes 12 → 8 px. That recovers 93 px: slack becomes about +30 / +35 / +36 px, better than today. The arithmetic comment in `statusbar.css` is restated with the five tabs; every always-shown piece counted. At 1360 px and wider the footer simply has a fifth tab.
- The hover-tip alignment rule that targets the tab group's `:last-child` must keep pointing at Smart.

## C · Capture-time order, with a per-folder clock offset

The scout's main finding: a global chronological sort **already ships** — by file modification time, from directory listings, applied once at Begin culling. It is wrong exactly where it matters: inside a burst (the camera's write queue reorders files), after a copy that resets mtimes, and across two bodies whose clocks differ. 3C swaps the sort key; it does not add a sort.

- **The key becomes EXIF** `DateTimeOriginal` + `SubSecTimeOriginal` (millisecond precision). Per file, the fallback chain is EXIF → that file's mtime → none (name order, last). The comparator (`order_by_capture`) does not change.
- **Reading it.** A new `cr3::read_capture_time` reads only the head of the file until the `moov` box is complete and parses the two tags — no thumbnail extraction, no decode. It runs inside `analyze_folder` on the existing worker pattern with a progress phase. A thumb-tier cache hit (its header already carries the capture time, validated by mtime + size) costs no source read, so re-opening a shoot is free.
- **When.** Once, at Begin culling — the one moment the image order, the image store and the overlay service are all rebuilt anyway. Never mid-cull: cursor, selection, compare slots, nav history and the image store's windows are index-keyed. `Img.id` stays stable, as designed.
- **Setting** `sortByCaptureTime`, default **on**, with a toggle on the staged screen. Ruling: on by default because Oliver's shoots are on a local SSD, where the pass is seconds for 4,000 frames; on a slow share it is minutes the first time (then cached) and the toggle is right there. Cost if wrong: a slow first Begin culling on a NAS, with a progress line and an off switch.
- **Per-folder offset** — for two bodies. Shown on the staged screen only when the sort is on and two or more folders are staged: per folder, its name · frame count · first frame's capture time · the signed difference from the first folder's first frame (the hint that usually *is* the offset) · a stepper. Click ±1 s, Shift-click ±1 min, Ctrl-click resets to 0; displayed like `+0 s`, `−1 min 12 s`. Offsets are milliseconds keyed by folder path in Settings (`captureOffsets`) — not in recents, which expire. The offset is added to that folder's EXIF times for ordering only; nothing is written to any file, and the info rail keeps showing the camera's own time.
- No automatic clock matching: it needs content matching to be trustworthy, and a wrong automatic offset is worse than a manual one.
- **Bursts.** `groupBursts` walks the session order and treats a folder change as a wall, so interleaving two bodies by true time would shred both bodies' bursts into singletons. The walk becomes per-folder over the global order (a run continues across foreign-folder frames); group ids stay session-global. This also repairs today's mtime interleaving.
- Timezones: `OffsetTimeOriginal` is not parsed and is not needed — all times are the cameras' local wall clocks, compared with each other; the sort lives in Rust, never in `Date.parse`.

## Testing

- Pure functions: the screenful maths (grid and strip), filter additions (`passesFilter`, cycles), the offset formatter and stepper arithmetic, the burst walk across interleaved folders, `order` with EXIF / mtime / none mixes and offsets (Rust).
- `read_capture_time`: synthetic CR3 head bytes if the existing test utilities can build one, otherwise corpus-gated — plus an UNGATED test of the fallback chain on the pure epoch builder. CI has no CR3 files; a test that can only run with a corpus does not count as coverage.
- Footer: `layout.test.ts` pins the two new `< 1360` rules; the Smart tab keeps its full accessible name.
- Keymap: there is no harness for `useCullKeymap.ts`; the step computations live in pure helpers that are tested, and the key wiring is verified by review. (Building that harness is Phase 4.)
- Live, PC idle, click-and-navigation-keys only, scratch folder: Home / End / PgUp / PgDn in loupe and grid; the Rejects tab (empty — no rating keys are sent); Begin culling with the sort on, and the staged-folder rows with two scratch folders.

## Out of scope

Live re-sorting; sort modes other than capture time; automatic clock matching; stars and colour labels (Phase 5); the keymap test harness (Phase 4). CR3 only.
