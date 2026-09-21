# Phase 5A — Stars and colour labels: design

First slice of Phase 5 (Expansion). Signed installers and the updater stay parked — Oliver's recorded decision is that distribution waits for a second user. Every choice here is a ruling under his standing instruction (2026-09-20) to make the calls and keep moving; each says what it costs if wrong. Facts and file:line evidence come from a read-only scout of main `2dfa5df`: `~/.claude/plans/cull-audit-2026-09-13/phase-5-scout.txt`.

## The shape of it

Stars (1–5) and colour labels (Red / Yellow / Green / Blue / Purple) are an **optional layer**, off by default, **orthogonal** to keep / reject / favourite. With the setting off, nothing in the app changes — not a key, not a pixel, not a byte written. That is guaranteed by construction, not by care: the setting selects between two keymap shapes and gates every render branch.

- `Rating` is NOT widened (the scout found consumers that fall through to a default instead of failing). Stars and labels live in two new maps beside `ratings`: `stars: Record<id, 1|2|3|4|5>` and `labels: Record<id, Label>`.
- A starred frame with no keep / reject is still **unrated**: every count, filter and the smart pipeline keep keying on `Rating` alone. Stars never imply a keep. Cost if wrong: a second pass that only stars leaves frames "unrated" — which is the truth.
- A reject keeps its stars and label; Move rejects moves the sidecar as today.

## 1 · Keys — the setting switches the keymap

Lightroom's row is the reason the feature exists, so with the setting ON the digit row is Lightroom's:

| Key | Setting off (today) | Setting on |
|---|---|---|
| `1`–`5` | filters All / Unrated / Keeps / Smart / Rejects | stars 1–5 |
| `0` | unbound | clear the stars |
| `6` `7` `8` `9` | unbound | Red / Yellow / Green / Blue — pressing the active label's key clears it (as Lightroom does) |
| `Shift+6` | unbound | Purple (Lightroom has no key for it) |
| `Shift+1`–`Shift+5` | unbound | the five filters |

- Shift+digit is matched on `e.code` (`Digit1`…), never `e.key` — Shift+1 is `!` on his layout and something else on another. The codebase already has four `e.code` fallbacks.
- Star and label keys act once per press (`e.repeat` ignored), rest under overlays and the help sheet exactly as rating keys do, and apply to the grid selection when one exists, exactly as rating keys do. They are NOT bound in compare mode (the digits are unbound there today; compare decides a pair, it does not grade). Cost if wrong: star in the loupe instead.
- Every hint that names a digit follows the setting: the footer tabs' tips, the empty-filter hints, the help sheet rows, Settings, the README table.
- Cost if the whole ruling is wrong: he prefers filters on the bare digits even with stars on — then the ON shape swaps which row takes Shift, a table edit.

## 2 · On disk — what Lightroom reads, and no migration

- Stars are `xmp:Rating` `1`–`5`; clearing removes the property. Labels are `xmp:Label` with the English default strings `Red` `Yellow` `Green` `Blue` `Purple`. Reading matches those five case-insensitively; **any other label string is a user's custom label: shown as "custom", never rewritten, never cleared by a key that did not set it** — pressing a label key replaces it, `0` does not touch it. `xmp:LabelColor` is not written (unverifiable here). Cost if wrong: a non-English Lightroom shows CULL's labels as white swatches; the fix is five strings in Settings.
- Same writer, same safety: the star and label writes go through the existing substring-surgery writer, the per-path serial queue, the latest-wins guard and the retries — and **every new write command calls `require_source` first**, which is the guard behind the audit's one CRITICAL (an orphaned sidecar after Move rejects). Non-CULL properties stay preserved.
- A star or label the user set through CULL **is user content**. So the existing "never delete a sidecar with user content" gate already does the right thing: unrating a starred frame keeps the sidecar (it still holds the star); clearing the last star / label on an unrated frame lets the existing delete rule fire. No ownership marker is needed for stars or labels.
- **The favourite's courtesy star.** Today a favourite with no user star writes `xmp:Rating="1"` + `cull:fav="star"`. That stays the meaning of every existing sidecar — no bulk migration. The change is lazy and per write: when the user sets a real star on such a frame, write the star and flip the marker to `cull:fav="flag"`; when they clear the star on a favourite, the courtesy star comes back (`Rating="1"` + `"star"`), exactly today's rule for "no user star". With the setting off no star or label is ever written; the only byte that differs from today is the marker in the next point.
- **Fix the live ambiguity the scout found** (`xmp.rs:558`): a KEEP on a frame carrying a genuine user 1★ reads back as a FAVOURITE after reload, because the legacy fallback `star == Some(1)` cannot tell them apart. Ruling: every rating CULL writes carries an explicit marker — `cull:fav` becomes `"star" | "flag" | "no"` — and the legacy `star == 1` fallback applies only to a sidecar with no `cull:fav` at all. This ships regardless of the setting (it is a correctness fix), test-first, with the missing `n = 1` case added to the two existing regression tests.
- Reading: the scan already carries a read-only Lightroom star through to the UI (`lrcRating`); stars and labels ride the same pipeline into the two new maps at open, so a shoot starred in Lightroom shows its stars in CULL when the setting is on.

## 3 · Undo

`Change` has no slot for an orthogonal field. Ruling: the undo entry gains an optional `meta` change list (`{ id, field: "star" | "label", before, after }`) beside the rating changes; undo / redo replays both through the same persistence path. One keypress = one undo step, including a multi-select.

## 4 · What it looks like (setting on)

- **Info rail:** a row under the verdict — five star glyphs (filled / hollow, Lucide `Star`) and a label swatch with its name. Clickable, since the rail is the one place with room; keyboard remains the fast path.
- **Grid cell:** the one free corner carries a compact `3★` in the muted text token, and the label is a 4 px bar along the cell's bottom edge. **Filmstrip cell (76×54):** the label bar only — a third marker does not fit.
- **Colours.** Three of Lightroom's five collide with load-bearing meanings here (red = reject, green = keep, purple = favourite). Ruling: labels are told apart from verdicts by **shape and place**, never by hue alone — a verdict is a glyph, a label is a bar or a square swatch — with five dedicated `--label-*` tokens tuned for the dark surfaces to at least 3:1 (the bar for non-text graphics), not reusing `--bad` / `--ok` / `--fav`. Cost if wrong: a swatch is not Lightroom's exact hue.
- A brief flash on set, reusing the rating flash's motion token; reduced motion respected.
- No new footer element and no new filter tab: the scout measured 29.8 px of slack at the 1240 tier against ~77 px for a tab. Filtering by stars is Lightroom's job. Cost if wrong: add star sub-modes inside the existing tabs later, which costs no width.

## 5 · Settings

One toggle, `starsAndLabels` (default **off**), in Settings with one line of description ("Lightroom's keys: 1–5 stars, 6–9 labels. Filters move to Shift+1–5."), declared / defaulted / coerced like `sortByCaptureTime`.

## Testing

- Rust: the writer for stars and labels in both XMP forms (attribute and element), custom-label preservation, `require_source` on every new command, the favourite / star interplay in every order (fav then star, star then fav, clear each), the `cull:fav="no"` marker and the legacy fallback, the delete gate with a CULL-set star. The mutation fuzzer is not extended (it covers the CR3 parser, not XMP).
- The keymap harness: both keymap shapes, table-driven — with the setting off every one of today's 112 assertions passes UNCHANGED (that is the "off = no change" proof); with it on, the digit rows, Shift+digit on `e.code`, `e.repeat`, overlays, compare unbound, grid selection. Each new test is watched red under a named mutation — Phase 4's lesson.
- Undo / redo of stars and labels, including multi-select, through the real persistence mock.
- Render: rail row, grid cell, strip bar present with the setting on and ABSENT with it off; hints follow the setting; contrast test covers the five label tokens at 3:1.
- Live, PC idle, scratch copies only: set stars and labels, Move rejects, undo — no orphaned sidecar; then open the scratch sidecars and read the XMP.

## Out of scope

Filtering or sorting by stars or labels; stars in compare mode; localised label strings; `xmp:LabelColor`; the carried small items (a Cancel during "analyzing", `C` from Rejects, `role="tab"` on the filter tabs, the stepper's `−`, the burst fence) — a later polish pass. Signed installers and the updater. CR3 only.
