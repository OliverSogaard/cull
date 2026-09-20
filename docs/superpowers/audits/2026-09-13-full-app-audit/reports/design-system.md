# CULL — Design-System Code Review

**Scope.** Read-only audit of the visual code in `C:\Users\OSA\Developer\cull`: `src/App.css` (3,858 lines, ~450 rules, ~2,074 declarations, 293 `.cull-*` classes — the only stylesheet), `index.html`, `src/main.tsx`, `src/App.tsx`, every file under `src/components/**`, `src/utils/ratingColor.ts`, `src/utils/shimmer.ts`, `src/image/present.ts` (tier presentation), `src-tauri/tauri.conf.json`, the two woff2 fonts, the two backdrop JPEGs and the app icon. Screenshots were deliberately not used; every claim below is traceable to a file:line.

---

## 1. Summary verdict

CULL has a **strong, opinionated design language** — champagne on near-black, a real two-voice type pairing (Inter prose / JetBrains Mono data), a coherent verdict-glyph system, and motion that is engineered at a level most desktop apps never reach (compositor-only, shared-phase shimmers, a single sourced zoom glide with directional easing). The *taste* is consistent across screens. The *implementation* is not a system: it is one 3,858-line file with a 15-property colour palette as its only token layer, and every other design decision (21 font sizes, 18 letter-spacings, 33 spacing values, 11 radii, 14 shadows, ~20 durations, 16 z-index layers, 39 alpha tints) is a raw literal restated per component. Consequently the same button, chip, keycap, dialog, banner, progress bar and spinner each exist in 2–12 hand-rolled variants, and the app's single biggest visual inconsistency — **two different verdict palettes** (CSS tokens vs a Tailwind-coloured `RATING_COLOR` map in JS) — went unnoticed because nothing enforces one source.

Grade as a product: **B+**. Grade as a design system: **C**. The gap is closable in roughly two focused days: (1) a tier-2 token sheet, (2) eight shared primitives, (3) a file split, (4) a reduced-motion block, (5) one palette for verdicts.

---

## 2. What is genuinely excellent

1. **Palette restraint.** `--bg #0c0c0d`, three surfaces, three text greys, and a muted photographic triad for verdicts (`--ok #9ec5a4` sage, `--bad #c87f7f` rose, `--fav/--accent #d4af6a` champagne). No saturated UI-kit colours anywhere in the CSS. `--muted` was deliberately lifted from 3.7:1 to 4.6:1 with the reasoning written next to it (`src/App.css:62-65`). Measured pairs: `--text` 16.7:1, `--text-2` 7.8:1, `--accent` 9.4:1, `#1a1408` on accent 8.8:1.
2. **Typography is a pairing, not a default.** Inter carries prose and titles; JetBrains Mono carries every number, filename, eyebrow and keycap. `font-feature-settings: "ss01","cv11","cv10"` (`:85-87`) is a deliberate Inter tuning (single-storey a, open digits). `tabular-nums` is on every live counter (`:439, :1314, :2184, :3308, :3756, :3846`), and `.cull-statusbar__pos` is pinned to `12ch` so "N / M" never pans (`:445`). Both woff2 files are true variable fonts (fvar tables verified), self-hosted, CSP-locked.
3. **Motion engineering.** Every animation in the file moves `transform` or `opacity`: the shimmer sweep is a `translateX` band phase-locked across all cells via `--shimmer-delay` from one module epoch (`src/utils/shimmer.ts`), the scrub bar and grid indicator move by transform with the transition on one positioner (`:2883-2888`, `:3198-3205`), the toggle knob translates (`:1946-1956`). Non-animation decisions are written down (grid outline must not animate `:3243`; group opacity ghosting in WKWebView `:1785-1790`). The zoom glide is **one string** from `src/components/pane/zoomTransition.ts` consumed by presenter layers, hi-res raster and masks, directional on purpose (300 ms slow-start engage, 200 ms ease-out release, with the rationale). The presenter crossfade has a designed timing model (`FADE_MS 140`, `SNAP_WINDOW_MS 48`, `THUMB_HOLDOFF_MS 160` in `src/image/present.ts`).
4. **The verdict-glyph system.** `verdictGlyph()` + `VerdictDot` + `ghostGlyph` (`src/components/verdictGlyph.tsx`, `VerdictDot.tsx`): committed = solid disc with dark glyph; suggested = dashed ring, hollow glyph in the verdict's own colour, dark halo (`:3058-3078`). Provisional vs committed is a *form* distinction, not an opacity hack — the comment even records that the 55%-opacity draft failed.
5. **Burst / similar run boxes as real `<fieldset>/<legend>`** (`src/components/strip/BurstBoxes.tsx`, `GridView.tsx:363-399`, `:3083-3128`): native border gap under the label, same alpha with only the hue shifted for "similar" — a genuinely elegant use of the platform.
6. **One reusable fade recipe** (`opacity 0.12s ease 0s` in / `opacity 0.4s ease 0.35s` out) applied identically to the filter tooltip, the strip scrub bar and the grid indicator (`:571-578`, `:2871-2877`, `:3190-3196`) — and cross-referenced in comments. This is what the rest of the file should look like.
7. **PhotoPane unification** with `VARIANT_CLASSES` (`PhotoPane.tsx:25-36`): one matte, one clip window, one overlay stack for loupe and both compare panes; the `--photo-ar` + content-box trick (`:692-717`) makes overlays register exactly on the image.
8. **BEM discipline is enforced**, not hoped for (`.stylelintrc.json` `selector-class-pattern`), the `cull-` namespace is universal, and the CSS is unusually well-commented about *why* (WebKit mask compositing `:774-778`, fieldset box-sizing `:88-91`, absolutely-positioned replaced `<img>` sizing `:878-884`).
9. **Empty states** are one component (`NoMatchEmptyState`, `App.tsx:2199-2215`) rendering all six variants with eyebrow / title-with-accent-em / kbd hint — consistent by construction.
10. **A11y groundwork exists**: focus traps on dialogs, `aria-pressed` on every toggle/chip/segment, `role="img"` + label on `RatingDot`, `aria-label` on strip/grid cells including verdict and role.

---

## 3. Token inventory (with counts)

### 3.1 Declared tokens (`src/App.css:53-72`)

| Category | Tokens | Count |
|---|---|---|
| Colour | `--bg --surface --surface-2 --matte --border --border-soft --text --text-2 --muted --accent --accent-soft --ok --bad --fav --accent-cool` | **15** |
| Spacing | — | **0** |
| Radius | — | **0** |
| Shadow / ring | — | **0** |
| Typography (size, tracking, leading, family) | — | **0** |
| Motion (duration, easing) | — | **0** |
| Z-index | — | **0** |
| Layout (bar heights, rail widths, cell metrics) | — | **0** (metrics live in `strip/metrics.ts` and `GridView.tsx:26-32`, restated in CSS comments) |

Runtime custom properties set from JS: `--photo-ar`, `--shimmer-delay`, `--thumb-outline`, `--thumb-outline-w` (4, all legitimate).

Note `--fav` and `--accent` are the **same hex** (`#d4af6a`, `:66` and `:70`) — the token exists but has no distinct value.

### 3.2 Values that bypass tokens

| Kind | Occurrences (outside `:root`) | Distinct | Notes |
|---|---|---|---|
| Raw hex colours | **23** | 7 | `#1a1408` ×6 (text-on-accent), `#fff` ×5, `#d49090` ×4 (bad-hover), `#000` ×4 (mask stops), `#e8c182` ×3 (accent-hover), `#2a2018`/`#1a1410` ×1 (thumb-frame gradient) |
| `rgba()` literals | **61** | **39** | accent at 7 alphas, `--bad` at 9 alphas, black scrim at 7 alphas, `rgba(8,8,10,*)` at 4, `rgba(8,8,8,*)` at 2, white at 4 |
| Hex in TS/TSX | 6 | 5 | `RATING_COLOR` `#10b981 #ef4444 #f59e0b` (`src/utils/ratingColor.ts:10-12`), glyph ink `#0a0a0c` ×3 (`verdictGlyph.tsx:21-25`), `"white"` ×3 (`App.tsx:1493-1497`), fatal panel `#16161a #c87f7f #28282e` (`main.tsx:44`), `#0c0c0d` (`index.html:13`), `#000000` (`tauri.conf.json` window background) |
| `font-size` literals | 89 | **21** | 7, 8, 9, 10, 10.5, 11, 11.5, 12, 13, 13.5, 14, 15, 16, 17, 18, 22, 24, 28, 36, 40, 56 px |
| `letter-spacing` literals | 73 | **18** | −0.025 → 0.28 em |
| `line-height` literals | 25 | 12 | includes two px values (`10px`, `14px`) |
| `font-family` declarations | **89** | 7 spellings | `'JetBrains Mono', monospace` ×68; Inter spelled 3 ways (`Inter, sans-serif` ×9, `Inter, -apple-system, system-ui, sans-serif` ×3, `Inter` ×3); one `-apple-system, "Segoe UI Symbol"` stack (`:3769`) |
| `font-weight` | 27 | 3 (400/500/600) | 600 declared in `@font-face` only — never used by a rule |
| Spacing px in `padding/margin/gap` | 279 | **33** | 1,2,3,4,5,6,7,8,9,10,11,12,13,14,16,18,20,22,24,26,28,32,36,40,44,48,56,60,68,70,80,84,148 — no grid; 7, 9, 11, 13, 26 all present |
| `border-radius` | 76 | **11** | 1,2,3,4,5,6 px; pill spelled three ways: `50%` ×6, `999px` ×12, `9999px` ×4; two asymmetric |
| `box-shadow` | 24 | **14** | focus ring `0 0 0 2px var(--accent-soft)` repeated verbatim ×7; 5 distinct elevation shadows; 3 distinct halo alphas (.55/.6/.7) at 1.5 px |
| Transition/animation durations | ~100 | **~20** | `0.12s` ×25, `150ms` ×12, `120ms` ×5 — three spellings of one intent; `ms` and `s` mixed |
| Easings | 62 | 5 | default `ease` ×31, `ease-out` ×16, `linear` ×11, `ease-in-out` ×3, `cubic-bezier(0.16,1,0.3,1)` ×1 |
| `z-index` | 31 | **16** | −1, 0, 1, 2, 3, 4, 5, 6, 7, 20, 30, 60, 80, 100, 150 |
| Fixed px `width/height/min/max` | 58 lines | — | rails 290/340, dialogs 480/560/680, hero 620, help 880, progress 420 |
| `!important` | **3** | — | `:886, :905, :917` (overlay `position`) — justified, documented |
| `@media` blocks | **0** | — | no responsive, no `prefers-reduced-motion`, no `prefers-contrast` |
| Inline `style=` in TSX | 26 sites / 11 files | — | 22 are virtualizer/transform geometry (correct); 2 are CSS overrides (`FinishDialog.tsx:405, :412`); 2 are colour (`RatingDot.tsx:22`, `App.tsx:1491`) |

### 3.3 Greys in practice

Token greys: 8 (`#0c0c0d #16161a #1d1d22 #1a1a1e #28282e #ededed #a3a3aa #7a7a84`). Ad-hoc neutrals: `#fff`, `#000`, `#0a0a0c` (JS), `rgba(235,235,235,.92)`, `rgba(8,8,8,.78/.82)`, `rgba(8,8,10,.7/.82/.85/.92)`, `rgba(0,0,0,.5/.55/.6/.65/.7/.78/.85)`, `rgba(255,255,255,.02/.14/.55)`, `#2a2018→#1a1410`. **≈ 8 tokens + 20 ad-hoc neutral values.**

### 3.4 Worst offenders (by line)

| Line | Value | Why it matters |
|---|---|---|
| `src/utils/ratingColor.ts:10-12` | `#10b981 #ef4444 #f59e0b` | A second verdict palette (Tailwind emerald/red/amber-500) used by the compare verdict chip and the rating feedback pop — see H1 |
| `src/App.css:999, 1006, 1059, 1067, 1196, 2019` | `#1a1408` | Text-on-accent restated 6× — needs `--on-accent` |
| `:1065, 1066, 1207` | `#e8c182` | Accent hover restated 3× — needs `--accent-hover` |
| `:1608, 2107, 2449, 2450` | `#d49090` | Bad hover restated 4× — needs `--bad-hover` |
| `:236, 2102, 2445, 2451, 2507` | `#fff` | Text on danger — `#fff` on `--bad` is only **3.09:1** (fails AA for 12 px text) |
| `:2937` | `linear-gradient(135deg,#2a2018,#1a1410)` | A warm brown that exists nowhere else; it is fully covered by the `<img>`/placeholder, so it is invisible dead paint |
| `:3098` | `rgba(214,178,120,.5)` | A *different* champagne (`#d6b278`) from `--accent` (`#d4af6a`) for burst boxes |
| `:3776-3778` | `color: var(--surface-2)` as text | Empty LrC stars at **1.16:1** — imperceptible on most panels |
| `:972-980` | `--muted` at `opacity .7`, 9 px | "tab · keys" hint composites to `#595960` ≈ **2.8:1** |
| `verdictGlyph.tsx:21-25` | `#0a0a0c` | Glyph ink hardcoded (not `--bg`, not a token) |
| `App.tsx:1493-1497` | `color="white"` | White glyph on the feedback pop → 2.5:1 on `#10b981`, 2.2:1 on `#f59e0b` |
| `:3678` / `:3111` | `font-size: 7px` / `8px` | Below any legibility floor at DPR 1 |

---

## 4. Findings

Severity: **HIGH** = visible inconsistency or hard-requirement gap; **MEDIUM** = drift that a designer would flag on first pass; **LOW** = craft/hygiene.

### HIGH

**H1 — Two verdict palettes ship at once.**
`src/utils/ratingColor.ts:9-13` defines `RATING_COLOR = { keep: "#10b981", reject: "#ef4444", favorite: "#f59e0b" }` and calls itself the "single source of truth". It is consumed by `RatingDot.tsx:22` (the verdict chip on the compare photo frame, `.cull-cmp-dot`) and `App.tsx:1491` (the 48 px rating feedback pop). Every other verdict surface — strip dots, grid dots, status-bar pill, EXIF suggestion row, finish-dialog stats, verdict flash — uses the CSS tokens `--ok #9ec5a4 / --bad #c87f7f / --fav #d4af6a`. So pressing Enter produces a saturated Tailwind-green pop with a white glyph (2.5:1) at the exact moment a sage dot with a near-black glyph (10.3:1) lands on the strip. In compare mode the champion's chip is Tailwind while the strip below it is sage/rose. The `RatingDot` also uses a soft drop shadow (`:2770`) where every other dot uses a hard 1.5 px halo ring.
*Fix.* Delete the hex literals. Either `RATING_COLOR = { keep: "var(--ok)", … }` (inline `backgroundColor` accepts `var()`), or drop inline colour entirely and give `RatingDot`/the pop the same modifier classes as `.cull-thumb__dot--keep` (`:3013-3026`). Change glyph ink on the pop from `"white"` to the shared `--ink` token (see M1). Delete the stale comment about "landing summary chips" (`ratingColor.ts:6-7`) — none exist.

**H2 — No `prefers-reduced-motion` anywhere.**
Zero `@media` blocks in the file; 14 `@keyframes`, six of them infinite (`cull-save-pulse` `:173`, `cull-scrub-flash` `:413`, `cull-shimmer-sweep` `:744/:2989/:3291`, `cull-spin` `:874/:1504`, `cull-indeterminate` `:1534`, `cull-finish-progress-breathe` `:2491`, `cull-trouble-pulse` `:2674`), plus the hero slide-in (`:1155`), the feedback pop scale (`:2792`), and the 300 ms zoom scale glide from `zoomTransition.ts`. ECC treats reduced-motion as a hard accessibility requirement.
*Fix.* Append one block: `@media (prefers-reduced-motion: reduce) { *, ::before, ::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: .01ms !important; scroll-behavior: auto !important; } .cull-photo-frame__shimmer, .cull-thumb__placeholder, .cull-grid__placeholder { background-color: var(--surface-2); } }` and in `zoomTransition.ts` return `"none"` when `matchMedia("(prefers-reduced-motion: reduce)").matches`. Keep the spinner (status, not decoration) via a targeted exception.

**H3 — The token layer is primitive-only and stops at colour.**
15 custom properties, all colour; nothing for spacing, radius, shadow, type, motion or layers. This is the root cause of the drift counts in §3.2 (21 sizes, 18 trackings, 33 spacings, 11 radii, 14 shadows, 20 durations, 16 z layers) and of the duplicate components in §5. Three "micro" durations (`0.12s`, `120ms`, `150ms`) and three pill radii (`50%`, `999px`, `9999px`) are the tell: the same intent, typed from memory each time.
*Fix.* Add a tier-2 sheet (see Appendix): `--space-1..8`, `--r-1/-2/-3/-pill`, `--shadow-1/-2/-3`, `--ring`, `--fs-1..9` + `--fs-display`, `--track-label/--track-eyebrow`, `--dur-fast/-base/-slow`, `--ease-out/-in-out`, `--z-*`, `--bar-top/--bar-bottom/--rail-w`. Then a mechanical replace pass. Stylelint can hold the line afterwards with `declaration-property-value-disallowed-list` for raw `px` on `font-size`/`border-radius` and raw colours outside `:root`.

**H4 — Components are restyled per screen instead of built once.**
Twelve button recipes, eleven chip/pill recipes, six keycap recipes, two dialogs, three left-border banners, two progress bars, two spinners, two inline confirm rows, three danger buttons (full list in §5). Each restatement carries its own radius, tracking, hover colour and focus ring, which is exactly where the inconsistencies in M1–M3 live. Concretely: the same "Sure? / Yes / Cancel" pattern is `.cull-settings__reset-confirm` (`:2111-2129`) and `.cull-finish__confirm` (`:2426-2452`); the same 4 px accent progress bar is `.cull-progress` (`:1513-1535`) and `.cull-finish__progress-bar` (`:2478-2497`); the same champagne left-border note is `.cull-actions__unrated` (`:2214`), `.cull-actions__pending` (`:2271`) and `.cull-finish__folder-exists` (`:2295`).
*Fix.* Eight primitives — `.btn` (+`--primary --danger --ghost --sm`), `.chip` (+`--accent --bad --ok --solid`), `.kbd`, `.dialog` (`__head __body __foot`), `.note` (+`--warn --err`), `.progress`, `.spinner` (+`--lg`), `.eyebrow` — and delete the per-screen copies. Rough fold: ~600 lines.

### MEDIUM

**M1 — Semantic colours that are not tokens.** `#1a1408` (on-accent) ×6, `#e8c182` (accent-hover) ×3, `#d49090` (bad-hover) ×4, `#fff` (on-bad) ×5, `#0a0a0c` (glyph ink, TS), `#2a2018/#1a1410` (thumb gradient, `:2937`). *Fix.* `--on-accent`, `--accent-hover`, `--bad-hover`, `--on-bad`, `--ink`; delete the thumb gradient (it is never visible).

**M2 — Alpha-tint sprawl: 39 distinct `rgba()` values.** Accent at 0.07/0.15/0.25/0.4/0.42/0.45/0.7; bad at 0.06/0.08/0.1/0.12/0.2/0.3/0.45/0.5/0.7; black scrims at 0.5/0.55/0.6/0.65/0.7/0.78/0.85; near-black chip fills at `rgba(8,8,8,.78)`, `(8,8,8,.82)`, `(8,8,10,.82)`, `(8,8,10,.85)`, `(8,8,10,.92)`. *Fix.* Three alpha steps per semantic colour via `color-mix(in srgb, var(--accent) 15%, transparent)` (WebView2/WKWebView both support it) or explicit `--accent-a10/-a25/-a50`; one `--scrim` and one `--chip-bg`.

**M3 — Mono-eyebrow tracking drift.** 34 uppercase mono labels use nine trackings: EXIF label 0.28em (`:3724`), help group/eyebrow 0.22em (`:3444, :3474`), empty-state eyebrow 0.22em (`:2561`), finish stat label 0.2em (`:2176`), verdict pill / brand / compare col 0.18em (`:306, :253, :3814`), settings nav 0.16em (`:1747`), status chip 0.16em (`:620`), scrub 0.14em (`:401`), keyhint 0.12em (`:975`), mem chip 0.1em (`:939`), trouble chip 0.08em (`:2655`). *Fix.* Two tokens: `--track-label: .14em` (10–11 px) and `--track-eyebrow: .2em` (9–10 px).

**M4 — Type scale has 21 sizes including half-pixels and sub-legible sizes.** `10.5px` (`:1457`), `11.5px` ×7 (`:1867, :2220, :2278, :2301, :2334, :2414`), `13.5px` (`:1857, :2248`); `7px` role badge (`:3678`), `8px` burst legend (`:3111`), and nine uses of `9px`. At DPR 1 a 7 px JetBrains Mono cap is ~5 device px. *Fix.* Nine-step scale `{9,10,11,12,13,14,16,18,22}` + display `{28,56}`; floor at 9 px; the 7/8 px labels become 9 px with tracking reduced from .14em to .08em to keep width.

**M5 — Footer cannot survive the 800 px `minWidth` (and is tight at 1280).** `.cull-statusbar__left/right` are `white-space: nowrap; flex-shrink: 0` (`:239-246`). Left: filename (≤240) + verdict pill + zoom chip + scrub label + 5×22 px overlay cluster + "N selected" + unsaved. Right: keyhint + `12ch` counter + four filter tabs (~70 px each + 36 px padding + borders) + finish button (~170 px). At the configured 800 px minimum (`tauri.conf.json`) this overflows by ~150 px with no collapse rule; at 1280 with the multi-select chip and an unsaved chip it is at the edge. The rails are fixed 290/340 px; a 1280-wide compare with rail on yields ~402 px panels. *Fix.* Container query on `.cull-statusbar` with a collapse order: <1100 px hide `__keyhint`; <1000 px icon-only finish; <900 px filename `min-width:0` + ellipsis on the cluster, not just the name. Consider 1024 as the real minimum window width.

**M6 — Focus indicators fail non-text contrast.** 13 `outline: none` (`:192, :231, :392, :532, :606, :1021, :1280, :1764, :1913, :1961, :2024, :2049, :2361`). Eleven substitute `box-shadow: 0 0 0 2px var(--accent-soft)` — a 15 %-alpha ring that composites to ≈1.5:1 against `--surface`; two substitute only a colour change (`.cull-filter-tabs button:focus-visible` `:531`, `.cull-filter-tab-tooltip button` `:605`); `.cull-winbtn:focus` (`:229-232`) removes focus entirely. Also `.cull-statusbar__keyhint` (2.8:1) and `.cull-exif-rail__lrc-dim` (1.16:1). *Fix.* `--ring: 0 0 0 2px var(--bg), 0 0 0 4px var(--accent)` (double ring, ≥3:1 on every surface) declared once on a `:focus-visible` utility; restore a visible state on `.cull-winbtn`; dim stars at `--muted` + `opacity .35`.

**M7 — Grid multi-select tint overhangs the photo.** `.cull-grid__multi-tint { inset: 3px }` with the comment "match .cull-grid__cell padding" (`:3370-3377`), but the cell padding is **9 px** (`:3223`). The 42 %-alpha champagne rectangle therefore extends 6 px past the frame on every side — 1 px beyond the 3 px outline + 2 px offset — into the inter-image corridor. *Fix.* `inset: 9px` (or move the tint inside `.cull-grid__frame` as `::after` so it can never drift).

**M8 — Two dialog implementations plus a hybrid.** `.cull-quitguard__box` (`:1626-1635`) and `.cull-settings` (`:1680-1692`) declare identical surface/border/6 px radius/`0 24px 60px .6` shadow. `.cull-settings__title` (`:1821-1832`) is a verbatim copy of `.cull-settings__head` kept "so other call sites don't break". `FinishDialog` mounts a quitguard box, a settings title, then patches spacing inline (`FinishDialog.tsx:405 style={{ padding: "16px 26px" }}`, `:412 style={{ padding: "0 26px 16px", margin: 0, borderTop: 0 }}`). *Fix.* One `.dialog` with `__head __body __foot` and `--wide` (560) / `--settings` (680) width modifiers; delete `.cull-settings__title` and the inline overrides.

**M9 — Icon sizes and strokes are not on a scale.** Lucide is rendered at 8, 9, 11, 12, 13, 14 and 22 px with stroke 2, 2.4, 2.5, 2.6, 3. The window-control row alone mixes gear 13@2 (`WindowControls.tsx:58`), minus 13@2.5, square 11@2.5, X 14@2.5 — four different optical weights on one line. Verdict glyphs use stroke 3 in cells but 2.6 in `RatingDot`. *Fix.* Size scale `{8,10,12,14,16,22}`; stroke rule by size (≤10: 2.6, 12–14: 2.4, ≥16: 2.2); window controls all 13 px / 2.25.

**M10 — Unicode glyphs still leak into UI after the SVG migration.** `verdictGlyph.tsx:7-8` documents that Unicode metrics drift on Windows and replaces ✓/✕/★ with Lucide — yet the file still ships `✓` at 40 px on the staged screen (`App.tsx:1402`), `✓` in recents (`:2429`), `★ ✕ ✓` as filter sub-chips (`:1825, :1879, :1890, :1901`), `★` in the finish stat (`FinishDialog.tsx:246`), `⚠` ×7 (`App.tsx:1242, :1733, :2128`, `FinishDialog.tsx:262, :274, :303, :312`), `↓` (`:1323`), `⟶` in CSS (`:411`), `•` (`:3855`), and the EXIF LrC stars as text with a `-apple-system, "Segoe UI Symbol"` fallback stack (`ExifRail.tsx:115-116`, `:3769`). *Fix.* Lucide `Check`, `X`, `Star`, `TriangleAlert`, `ArrowDown`, `ArrowRight` everywhere; EXIF stars as five `Star` glyphs with `fill` toggled.

**M11 — The accent does too many jobs, and `--fav` is the accent.** Champagne marks: brand, active tab, active nav, primary CTA fill, focus ring, current cell outline, multi-select tint, favourite verdict, burst outline, EXIF/help section labels, progress bars, scrub thumb + speed badge, zoom chip, memory-warning chip, unrated banner, the Smart tab. Because `--fav === --accent` (`:66, :70`), a favourite dot in the strip and the "current" outline are the same colour, and a champagne section label in the EXIF rail carries the same weight as a warning chip. *Fix.* Reserve `--accent` for interactive/current state; give `--fav` its own value (a warmer gold, e.g. `#e3b95a`, still ≥7:1 on `--bg`); use `--text-2` for section eyebrows and `--warn` (new, amber-leaning) for the memory chip.

**M12 — Single 3,858-line file ordered by history, not structure.** Examples: `.cull-finish__dest-seg` at `:963` sits between the composition overlay and the footer keyhint; `.cull-quitguard__danger` at `:2499` sits inside the finish section; `.cull-exif-rail__suggest--*` at `:3130` sits in the burst-box section; `.cull-statusbar__saving/__unsaved` at `:1591` sit in the staged-screen section; `.cull-settings__toggle:disabled` (`:1918`) precedes its base rule. Reading any one surface means grepping. *Fix.* Split — see recommendation 3.

### LOW

**L1 — Radius spellings.** Pill as `50%` ×6, `999px` ×12, `9999px` ×4; corners 1/2/3/4/5/6 px all live. *Fix.* `--r-1: 2px; --r-2: 4px; --r-3: 6px; --r-pill: 999px`; discs use `50%` only.

**L2 — Duration/easing hygiene.** `0.12s` ×25 vs `120ms` ×5 vs `150ms` ×12; `transition: background 200ms` ×2 with no easing (`:152, :1203`); default `ease` ×31 (the least designed curve available). Only one expressive curve exists (`cubic-bezier(0.16,1,0.3,1)` on the hero). *Fix.* `--dur-fast: 120ms; --dur-base: 180ms; --dur-slow: 320ms; --ease-out: cubic-bezier(.2,.7,.2,1)`; `HiResLayer.tsx:96` should import the release constant from `zoomTransition.ts` instead of restating `"transform 200ms ease-out"`.

**L3 — Shadow tokens.** Focus ring restated ×7; elevations `0 6px 20px .5`, `0 8px 48px .6`, `0 24px 60px .6`, `0 2px 18px .65`, `0 2px 8px .6`; halos at .55/.6/.7. *Fix.* `--shadow-1/-2/-3`, `--ring`, `--halo`.

**L4 — Z-index has 16 values and no map.** *Fix.* `--z-overlay-clip: 4; --z-overlay-peak: 5; --z-overlay-thirds: 6; --z-frame-chip: 7; --z-tooltip: 20; --z-feedback: 30; --z-wincontrols: 60; --z-hud: 80; --z-modal: 100; --z-help: 150`.

**L5 — `@font-face` under-declares the variable fonts.** Five blocks (`:10-48`) map discrete weights 400/500/600 and 400/500 onto files that carry `fvar` (verified). One block per family with `font-weight: 100 900` (Inter) / `100 800` (JBM) enables every weight and removes three blocks. `font-display: swap` is meaningless for a bundled, CSP-local font — use `block` or omit.

**L6 — Magic layout numbers cross-referenced by hand.** Top bar 36 px (`:117, :208, :213, :3423`), bottom bar 38 px (`:102`; the HUD's `bottom: 44px` at `:2740` = 38 + 6), window-button width 44 (`:212`, and `148 = 3×44+16` at `:120`), rail 290/340 (`:3695-3696, :3709-3710`, and in the `ExifRail.tsx:20` docblock). The 36/38 asymmetry between the two bars is unexplained. *Fix.* `--bar-top`, `--bar-bottom`, `--winbtn-w`, `--rail-w`, `--rail-w-compare`; make both bars 36.

**L7 — Three sources for the window background.** `tauri.conf.json` `backgroundColor: "#000000"`, `index.html:13` `#0c0c0d`, `--bg` `#0c0c0d`. First paint flashes pure black, then the page colour. *Fix.* Set the Tauri window colour to `#0c0c0d`.

**L8 — Backdrop assets.** `backdrop.jpg` is 1440×822, 133 KB, already single-channel; `desert.jpg` is 1600×889, 82 KB, **full colour** but only ever shown through `filter: grayscale(1)` — wasted bytes, and a runtime `filter` on a `position: fixed` full-viewport pseudo-element (`:2545-2556`) is a per-frame paint while the app is idle. The fixed positioning also escapes the `isolation: isolate` box the comment at `:2529` relies on. At 2560 CSS px (4K @150 %) both upscale ~1.8× with no `image-set()`. Register mismatch: the meadow is a painterly photo-illustration; the desert is a flat vector cartoon (silhouetted birds, banded dunes). At 11 % opacity the mismatch is muted but the hard dune horizon still reads as clip-art against the painterly meadow. *Fix.* Pre-bake grayscale + dim + radial vignette into both JPEGs (drop the runtime `filter` and `mask-image`), ship `@2x` via `image-set()`, and replace the desert with a scene in the same painterly register (or reuse a cropped/flipped meadow).

**L9 — App icon.** `src-tauri/icons/icon.png` (512²): dark rounded tile, champagne line-art photo frame with a tick badge, tracked "CULL" wordmark — on-brand with the chrome. The tile has a drop shadow baked into the PNG; macOS/Windows add their own, so it double-shadows. LOW.

**L10 — `user-select: none` on `html` (`:89`)** blocks copying EXIF values, paths in the scan-failure card, and the `<pre>` error body (`:2614-2627`) — the one place the user most wants to copy. *Fix.* `user-select: text` on `.cull-exif-rail__v`, `.cull-scanfail__path`, `.cull-message__body`.

**L11 — Three tooltip systems.** CSS `attr(data-tip)` pseudo (`:491-520`), the floating sub-mode tooltip (`:554-608`), and native `title=` on ~15 elements (window controls, overlay cluster, chips, recents rows). Three different delays, three looks. *Fix.* One `.tip` recipe; keep `title` only where the CSS one can't reach (native window controls).

**L12 — No-op declarations.** `.cull-hero__title { text-shadow: none; padding: 0 }` (`:1166-1167`), `.cull-cmp-label { position: static }` (`:3610`), `.cull-settings-overlay {}` empty (`:1675-1678`), `.cull-cmp-panel` receives `is-champion/is-challenger` (`CompareView.tsx:198`) that no CSS reads.

---

## 5. Duplicate-pattern list

| Pattern | Implementations (class → `src/App.css` line) | Count |
|---|---|---|
| **Button** | `.cull-pick-button` `:1026` (+`--primary` `:1057`, `--ghost` `:1052` unused) · `.cull-hero__cta` `:1190` · `.cull-statusbar__finish` `:982` · `.cull-message__retry` `:2631` · `.cull-settings__reset` `:2080` · `.cull-winbtn` `:211` · `.cull-statusbar__ov` `:363` · `.cull-filter-tabs button` `:472` · `.cull-filter-tab-tooltip button` `:580` · `.cull-settings__navitem` `:1738` · `.cull-settings__seg-opt` `:1997` · `.cull-error-chip button` `:2721` | **12** |
| **Danger button** | `.cull-settings__reset.is-armed` `:2100` · `.cull-finish__confirm-yes` `:2442` · `.cull-quitguard__danger` `:2499` — each restates `--bad` fill, `#fff`, `#d49090` hover | 3 |
| **Chip / pill** | `.cull-statusbar__chip` `:612` (r3) · `.cull-mem-chip` `:936` (r3) · `.cull-statusbar__scrubspeed` `:425` (r3) · `.cull-scrubbar__speed` `:2890` (r3) · `.cull-trouble-chip` `:2651` (r999) · `.cull-error-chip` `:2703` (r999) · `.cull-scanfail__tag` `:1442` (r999) · `.cull-statusbar__multi` `:637` (r999) · `.cull-save-status` `:139` (r999) · `.cull-cmp-label` `:3609` (r999) · `.cull-settings__chip` `:1885` (r999) | **11** |
| **Keycap** | `.cull-settings__foot kbd` `:1809` (r2) · `.cull-quitguard__hint kbd` `:2132` (r2) · `.cull-empty-state__hint kbd` `:2586` (r3) · `.cull-recent__kbd` `:1347` (r3) · `.cull-hero__how-key` `:1358` (r3) · `.cull-hero__cta-key` `:1216` (r2, tinted) | **6** |
| **Dialog surface** | `.cull-quitguard__box` `:1626` · `.cull-settings` `:1680` (+ `.cull-settings__title` `:1821` duplicating `.cull-settings__head` `:1694`) | 2 (+1) |
| **Left-border note** | `.cull-actions__unrated` `:2214` · `.cull-actions__pending` `:2271` · `.cull-finish__folder-exists` `:2295` | 3 |
| **Progress bar** | `.cull-progress` `:1513` · `.cull-finish__progress-bar` `:2478` | 2 |
| **Spinner** | `.cull-spinner` `:1498` (36/2 px) · `.cull-loading__spinner` `:865` (42/3 px + shadow) | 2 |
| **Inline confirm row** | `.cull-settings__reset-confirm/-msg` `:2111` · `.cull-finish__confirm/-msg` `:2426` | 2 |
| **Shimmer band** | `.cull-photo-frame__shimmer::after` `:732` · `.cull-thumb__placeholder::after` `:977` · `.cull-grid__placeholder::after` `:3278` — byte-identical 16-line blocks | 3 |
| **Photo matte** | `.cull-photo-frame` `:692` · `.cull-cmp-photo-frame` `:3560`; `.cull-image` `:781` · `.cull-cmp-img` `:3581` (differ only in `max-height` and `margin`) | 2×2 |
| **Verdict dot** | `.cull-thumb__dot` `:2998` (14, halo .6) · `.cull-grid__dot` `:3330` (18, halo .55) · `.cull-statusbar__verdict-glyph` `:315` (14, no halo) · `.cull-rating-dot` `:2765` (18 inline, drop shadow, JS colours) · `.cull-feedback__circle` `:2785` (48, JS colours) | 5 |
| **LrC badge** | `.cull-thumb__lrc-badge` `:3033` · `.cull-grid__lrc-badge` `:3351` | 2 |
| **Backdrop pseudo** | `.cull-chrome::before` `:1096` · `.cull-empty-state--desert::before` `:2545` — identical filter/opacity/mask | 2 |
| **Position indicator** | `.cull-scrubbar` `:2861` · `.cull-grid__scrollbar-track` `:3181` (shared fade recipe — good; geometry duplicated) | 2 |
| **Eyebrow label** (mono, uppercase, tracked) | `__label`, `__eyebrow`, `__group`, `__stat-label`, `__head-meta`, `__title-meta`, `__foot`, `__picked-label`, `__col`, `__k` … | ~14 with 9 trackings |
| **Tooltip** | `[data-tip]::after` `:495` · `.cull-filter-tab-tooltip` `:554` · native `title` | 3 |
| **Text input** | `.cull-settings__text` `:2038` · `.cull-finish__dest-sub` `:2359` (+ `.cull-settings__pinned-path` `:1974`, `.cull-finish__picked-path` `:2410` as read-only twins) | 2 (+2) |

---

## 6. Dead CSS list

Cross-check method: every `.cull-*` selector in `App.css` (293) against every `cull-*` token in `src/**/*.{ts,tsx}` (277), then reconciled by hand against the template-literal class builders (`VerdictDot.tsx:30-41`, `PhotoPane.tsx:367`, `App.tsx:2477`, `ThumbCell.tsx:103`, `ExifRail.tsx:85/:349`). All `--keep/--reject/--fav/--ghost-*`, `--flash-*`, `--saving/--failed`, `--champion/--challenger` and `__suggest--*` modifiers **are** reached dynamically and are live.

| Selector / rule | Line | Status |
|---|---|---|
| `.cull-pick-button--ghost` | `:1052-1055` | **Dead** — no reference anywhere |
| `@keyframes cull-fade-in` | `:2814-2823` | **Dead** — no `animation:` uses it |
| `.cull-statusbar__right span.is-active` | `:630-632` | **Dead** — no `<span class="… is-active">` exists; the active elements are `<button>`s |
| `.cull-settings-overlay` | `:1675-1678` | Empty rule (class is applied, body is `{}`) |
| `.cull-thumb__frame` background gradient | `:2937` | Visually dead — always covered by `<img>`/placeholder at 100 % |
| `.cull-hero__title { text-shadow: none; padding: 0 }` | `:1166-1167` | No-op resets |
| `.cull-cmp-label { position: static }` | `:3610` | No-op |
| `.cull-settings__title` | `:1821-1832` | Duplicate of `__head`; used only by `FinishDialog` — dies with M8 |
| `.cull-cmp-panel.is-champion` / `.is-challenger` | `CompareView.tsx:198` | State classes emitted, never styled |
| `cull-image--hires` | `PhotoPane.tsx:442` | Class emitted, intentionally unstyled (documented `:798-802`) — fine, but a code smell |
| `font-weight: 600` `@font-face` block | `:26-32` | No rule uses 600 |
| `.cull-devhud__row`, `.cull-save-status__label` | — | Applied in TSX, no base rule (harmless hooks) |

Undefined-but-referenced: none that matter (`cull-fatal` is an id in `main.tsx`; `cull-view` and `cull-shimmer-sweep` are comment text).

---

## 7. Top 10 prioritized recommendations

1. **One verdict palette.** Point `RATING_COLOR` at `var(--ok/--bad/--fav)` (or delete it and use the dot modifier classes) and replace `"white"`/`#0a0a0c` glyph ink with a `--ink` token. Half an hour; fixes the most visible inconsistency in the app (H1).
2. **Ship a tier-2 token sheet** (Appendix) and run a mechanical replace: sizes, tracking, spacing, radius, shadow, ring, durations, easings, z-layers, bar heights, rail widths. Add stylelint `declaration-property-value-disallowed-list` so raw `px` font sizes and raw colours outside `:root` fail CI (H3, M1–M4, L1–L4, L6).
3. **Split `App.css`** into `styles/tokens.css`, `base.css`, `primitives/{button,chip,kbd,dialog,note,progress,spinner,eyebrow}.css`, and per-surface `chrome.css`, `statusbar.css`, `loupe.css`, `strip.css`, `grid.css`, `compare.css`, `exif-rail.css`, `settings.css`, `finish.css`, `help.css`, `home.css`, imported in order from one `styles/index.css`. Vite fingerprints and concatenates; nothing changes at runtime. Do it *after* step 2 so the move and the rename are separate diffs (M12).
4. **Build the eight primitives and delete the copies** — start with `.btn` and `.chip` (23 recipes → 2), then `.kbd` (6 → 1), `.dialog` (2+1 → 1, removes the two inline style patches in `FinishDialog.tsx`), `.note` (3 → 1), `.progress`/`.spinner`/`.confirm-row` (2 → 1 each). Extract the shimmer band into one `.shimmer::after` mixin class applied to all three placeholders (H4, §5).
5. **Add the reduced-motion block** and the `matchMedia` branch in `zoomTransition.ts` (H2).
6. **Fix focus:** one `--ring` double-ring token applied through a single `:focus-visible` rule; restore focus on `.cull-winbtn`; lift the keyhint and dim-star colours above 3:1 (M6).
7. **Give the footer a collapse order** via a container query (hide keyhint → icon-only finish → ellipsis filename cluster) and raise the Tauri `minWidth` to something the layout actually survives, or make it survive 800 (M5).
8. **Finish the Unicode → Lucide migration** (✓ ✕ ★ ⚠ ↓ ⟶ • and the EXIF star row) and put icons on a size/stroke scale; even out the window-control row (M9, M10).
9. **Separate `--fav` from `--accent`** and take the accent off section labels and the memory chip so champagne means "current / interactive" again (M11). Fix the multi-select tint inset to 9 px (M7).
10. **Bake the backdrops:** pre-grayscale + vignette both JPEGs, drop the runtime `filter`/`mask-image`, add `image-set()` @2x, and replace the vector desert with a painterly scene that matches the meadow; set the Tauri window background to `#0c0c0d` (L7, L8).

---

## Appendix — proposed tier-2 token sheet (drop-in, ~40 lines)

```css
:root {
  /* semantic colour additions */
  --fav: #e3b95a;                 /* distinct from --accent */
  --warn: #d9a441;
  --on-accent: #1a1408;  --on-bad: #1a0c0c;  --ink: #0a0a0c;
  --accent-hover: #e8c182;  --bad-hover: #d49090;
  --accent-a10: color-mix(in srgb, var(--accent) 10%, transparent);
  --accent-a25: color-mix(in srgb, var(--accent) 25%, transparent);
  --accent-a50: color-mix(in srgb, var(--accent) 50%, transparent);
  --bad-a10: color-mix(in srgb, var(--bad) 10%, transparent);
  --scrim: rgba(8, 8, 10, .82);   /* chips, badges, HUD */
  --scrim-modal: rgba(8, 8, 10, .7);

  /* type */
  --font-ui: Inter, -apple-system, system-ui, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, monospace;
  --fs-1: 9px;  --fs-2: 10px; --fs-3: 11px; --fs-4: 12px; --fs-5: 13px;
  --fs-6: 14px; --fs-7: 16px; --fs-8: 18px; --fs-9: 22px;
  --fs-display: 28px; --fs-hero: 56px;
  --track-label: .14em; --track-eyebrow: .2em; --track-tight: -.015em;
  --lh-tight: 1.1; --lh-body: 1.5;

  /* space (4-based, with 2 and 6 for chips) */
  --sp-0: 2px; --sp-1: 4px; --sp-2: 6px; --sp-3: 8px; --sp-4: 12px;
  --sp-5: 16px; --sp-6: 20px; --sp-7: 24px; --sp-8: 32px; --sp-9: 48px;

  /* shape */
  --r-1: 2px; --r-2: 4px; --r-3: 6px; --r-pill: 999px;
  --shadow-1: 0 2px 8px rgba(0,0,0,.6);
  --shadow-2: 0 8px 48px rgba(0,0,0,.6);
  --shadow-3: 0 24px 60px rgba(0,0,0,.6);
  --ring: 0 0 0 2px var(--bg), 0 0 0 4px var(--accent);
  --halo: 0 0 0 1.5px rgba(0,0,0,.6);

  /* motion */
  --dur-fast: 120ms; --dur-base: 180ms; --dur-slow: 320ms;
  --ease-out: cubic-bezier(.2,.7,.2,1); --ease-in-out: cubic-bezier(.4,0,.2,1);
  --ease-spring: cubic-bezier(.16,1,.3,1);

  /* layers */
  --z-overlay: 4; --z-frame-chip: 7; --z-tooltip: 20; --z-feedback: 30;
  --z-wincontrols: 60; --z-hud: 80; --z-modal: 100; --z-help: 150;

  /* layout */
  --bar-h: 36px; --winbtn-w: 44px; --rail-w: 290px; --rail-w-compare: 340px;
  --strip-h: 82px; --cell-w: 76px; --cell-h: 54px;
}
```
