# CULL — UX / Accessibility / Microcopy Review

Scope reviewed: `README.md`, `ARCHITECTURE.md`, `src/App.tsx`, `src/App.css`, `index.html`,
`src/app/useCullKeymap.ts`, `src/app/useSiteNavigation.ts`, `src/app/useQuitGuard.ts`,
`src/app/useRatingPersistence.ts`, `src/hooks/useFocusTrap.ts`, `src/hooks/useArmedConfirm.ts`,
`src/components/{SettingsDialog,FinishDialog,GridView,CompareView,ExifRail,HelpOverlay,
RatingDot,VerdictDot,verdictGlyph,ThumbCell,ThumbStrip,WindowControls,ScanFailureCard}.tsx`,
`src/components/pane/*`, `src/components/strip/*`, plus targeted greps for
`aria-*`, `role=`, `focus-visible`, `prefers-reduced-motion`, `tabIndex`, `title=`.

---

## Summary verdict

CULL is an unusually well-engineered keyboard-first tool. Its modal accessibility
foundations are genuinely better than most production web apps (real focus traps,
`role="dialog"`/`aria-modal`, non-color-coded verdict glyphs, a documented WCAG 1.4.1
decision on `RatingDot`), and its microcopy is calm, consistent, and free of vocabulary
drift (keep/reject/favorite/unrate never becomes pick/flag/star anywhere in the codebase).

That said, this is fundamentally a **sighted, mouse-or-keyboard visual tool**, and the
audit surfaced a systemic gap for assistive technology: the core rating loop (loupe,
grid, compare) has **zero live-region feedback** and **grid/strip cells that are marked
`role="button"` but are not actually reachable via Tab/Enter/Space** — they only work
through the app's own bespoke arrow-key model. Keyboard **focus visibility** is also
inconsistent: several controls suppress the native outline and never supply a
replacement, and the one replacement pattern used everywhere else (`--accent-soft`,
15% opacity) computes to roughly **1.3:1 contrast**, well under what a focus ring needs
to be seen. There is **no `prefers-reduced-motion` support anywhere** despite the core
rating action firing a 380 ms full-frame color flash on every keystroke. Two body-text
pairings on the Settings/filter-tab surface fall just under 4.5:1. Most concretely, a
real **regression** was found: ESC no longer pops the documented per-site back-stack or
clears a grid multi-selection — it now always opens the "leave to home?" dialog — and
neither `README.md` nor `ARCHITECTURE.md` have been updated to match, so the project's
own onboarding material actively misdescribes the app's most-used key.

None of this breaks the primary sighted-photographer workflow, which is polished and
fast. It matters for AA compliance and for the low-vision, motor-impaired, and
screen-reader-assisted users the checklist targets.

---

## What is genuinely excellent

- **`useFocusTrap.ts`** is a correct, complete implementation: focuses the first
  focusable element (or the dialog root) on open, wraps Tab/Shift+Tab, **re-homes focus
  if the focused control is removed from the DOM mid-dialog** (`onFocusOut`, lines
  60–73), and restores focus to the trigger on close. Both `SettingsDialog` and
  `FinishDialog` use it consistently with `role="dialog"`, `aria-modal="true"`, and a
  real `aria-label` (`SettingsDialog.tsx:46-53`, `FinishDialog.tsx:222-229`).
- **`RatingDot.tsx:15-22`** ships an explicit, *commented* accessibility decision:
  `role="img" aria-label={label}` with "Kept/Rejected/Favorite" text, citing WCAG 1.4.1
  by name in the source comment. Verdicts are never color-only anywhere: every dot,
  pill, and flash pairs its color with a distinct Lucide glyph shape (Check / X / Star),
  and smart-culling "ghost" suggestions additionally use a **dashed outline** vs the
  solid fill of a committed rating — three independent channels (shape, color, line
  style) for the same state.
- **The empty-state system** (`pickSmartEmptyState` + `EmptyFilter`, `App.tsx:2223-2361`)
  enumerates five distinct "why is this empty" states for the Smart filter alone
  (disabled / analyzing-with-live-progress / analyzed-no-hits / not-analyzed-autostart /
  not-analyzed-manual) instead of one generic "nothing here." This is the kind of
  first-time-user confusion most apps never bother eliminating.
- **The quit guard** (`useQuitGuard.ts` + `App.tsx:1236-1286`) never silently drops a
  rating. It distinguishes "still saving" (auto-closes the instant writes flush, with a
  350 ms minimum-visible floor so the panel doesn't flash open-and-shut) from "failed to
  save" (blocks with Retry / Keep culling / Close anyway), and mirrors the failed state
  as a small persistent pill in the top chrome too, so it's catchable even off-screen.
- **`ScanFailureCard.tsx`** replaces a raw error dump with `role="alert"`, a calm
  per-folder name+tag+dimmed-path breakdown, and one plain-language sentence about what
  "not found" usually means (moved/renamed/unmounted drive).
- **Terminology discipline**: exactly one vocabulary for the whole rating model
  (keep / reject / favorite / unrate) across the README, in-app help, ARIA labels, and
  CSS class names, with zero drift into "pick / flag / star" synonyms — see the
  Terminology Inventory below. "Shoot" is used only in developer-facing prose
  (README/ARCHITECTURE), never in UI chrome, which consistently says "folder."
- **Hold-to-scrub** (`ARCHITECTURE.md`, "Hold-to-scrub" section) replaces OS key-repeat
  with a custom rAF loop specifically because OS repeat has an inconsistent ~500 ms
  delay and uneven rate. Framed as a performance/feel decision, it also happens to give
  motor/timing-impaired users a predictable, self-throttling repeat cadence instead of
  whatever the OS does.
- **Confirmation calibration is right, not reflexive**: rating a photo (the action
  performed hundreds of times a session) needs zero confirmation; the two genuinely
  destructive-but-recoverable batch actions (Reset settings, Move rejects) get a
  two-step "Sure?" with a 4 s auto-disarm. Nothing is over- or under-confirmed.

---

## Findings

### HIGH

**H1 — ESC no longer matches its own documentation; a specific deselect behavior is now dead code.**
*File:* `src/app/useCullKeymap.ts:332-339` vs `src/app/useSiteNavigation.ts:160-216`
(`goBack`), `README.md:191`, `ARCHITECTURE.md:160-188`.
What the user experiences: `README.md`'s keyboard table says `esc` means "back, or home
confirm if no history," and `ARCHITECTURE.md` describes a whole "stack-based ESC"
design so that `L → C → G → C → ESC ESC ESC` walks back one site at a time. The shipped
keymap instead does `if (e.key === "Escape") { setConfirmHome(true); return; }`
**unconditionally**, before any site or selection check. `goBack()` — the function that
still contains the stack-pop logic, including "ESC in grid with a multi-selection
clears the selection first, instead of popping the nav stack" (`useSiteNavigation.ts:
162-168`) — is now only ever called programmatically from compare's auto-advance flow
(`useDecideCallbacks.ts:269,338,419`), never from the Escape key. Concretely: a user who
`Ctrl+A`-selects 50 grid cells and presses Esc expecting to deselect gets a jarring
"leave to home?" dialog instead, with **no keyboard-only way to clear a multi-selection**
(the only other path is the mouse click-away listener in `App.tsx:640-649`).
Fix: either restore Esc → `goBack()` for the grid/compare cases (and keep a dedicated
"leave to home" trigger elsewhere), or intentionally keep the current "Esc always
confirms home" model and (a) special-case "clear the grid selection first" before
opening the dialog, and (b) update `README.md` and `ARCHITECTURE.md` to describe the
real behavior.

**H2 — No `prefers-reduced-motion` support anywhere in the app.**
*File:* grep of `src/**` for `prefers-reduced-motion` returns zero matches; relevant
animations include `App.css:804-839` (`cull-flash-pulse`, fired on **every** keep/
reject/favorite keystroke, 380 ms full-frame color wash), `App.css:722-748` and
`:2977-2993` (shimmer sweeps), `App.css:396-419` (scrub flash), `App.css:1002-1018`
(finish-button "breathe"), `App.css:1370-1379` (hero entrance).
What the user experiences: the primary action of the app — rating a photo, performed
hundreds of times per session — triggers a colored flash animation with no way to turn
it off from inside CULL, and the OS-level "reduce motion" preference is not honored at
all. For users with vestibular disorders or migraine triggers, a fast cull session is a
sustained strobe with no escape hatch.
Fix: wrap the flash/shimmer/pulse/breathe keyframe usages in
`@media (prefers-reduced-motion: reduce)` overrides — instant opacity swap (no animated
pulse) for the verdict flash, static placeholders instead of the shimmer sweep, no
"breathe" loop on the finish button.

**H3 — Keyboard focus indicator is invisible on window controls, and low-contrast everywhere else.**
*File:* `App.css:229-232` (`.cull-winbtn:focus, .cull-winbtn:focus-visible { outline:
none; }` — no replacement rule exists anywhere for `.cull-winbtn`), vs the repeated
pattern `box-shadow: 0 0 0 2px var(--accent-soft)` used at `App.css:391-394` (overlay
chips), `:531-534`/`:605-608` (filter tabs), `:1763-1766` (settings nav), `:1912-1915`
(chips), `:1960-1963` (toggle), `:2023-2026` (segment options), `:191-194` (save-status
pill), `:1020-1023` (finish button).
What the user experiences: Tab-ing to the settings gear / minimize / maximize / close
buttons in the top chrome (`WindowControls.tsx`) shows **no visual focus indicator at
all** — a keyboard-only user cannot tell those buttons are focused. Everywhere else the
app *does* draw a focus ring, but `--accent-soft` is `rgba(212, 175, 106, 0.15)`; against
the app's dark surfaces this composites to roughly **1.3:1 contrast** (`--bg` and
`--surface` luminance ≈ 0.003–0.008; the 15%-blended ring ≈ 0.027) — far under the ~3:1 a
non-text focus indicator needs to be reliably perceivable, and under WCAG 2.2's newer
Focus Appearance guidance.
Fix: add a real `:focus-visible` rule to `.cull-winbtn` (e.g., reuse its own `:hover`
treatment), and raise the opacity/color of the focus ring token used everywhere else
(a dedicated `--focus-ring` token at ~50–60% opacity or a solid outline color, not
`--accent-soft`).

**H4 — Grid/strip cells claim `role="button"` but are not keyboard-operable as buttons.**
*File:* `GridView.tsx:465-472` (`GridCell`), `ThumbCell.tsx:69-77`.
What the user experiences: both components render `role="button"` with a full,
well-composed `aria-label` (filename + rating + selection state — this part is done
well), but neither sets `tabIndex` nor handles `Enter`/`Space` `onKeyDown`. They are
operable only by mouse click or by the app's separate global arrow-key/rating system.
A screen-reader or switch-access user navigating the accessibility tree (rather than
CULL's bespoke keyboard model) will land on hundreds of elements that are announced as
interactive buttons but do nothing when activated with the AT's own activation gesture
— a Name/Role/Value mismatch (WCAG 4.1.2).
Fix: either drop `role="button"` in favor of a non-interactive role (e.g. `role="img"`
or a plain `<figure>`) if AT users are expected to rely solely on the app's arrow-key
model, and say so in an onboarding note; or commit to the role by adding
`tabIndex={0}` plus `Enter`/`Space` handlers that call the same `onPick`.

**H5 — No `aria-live` regions anywhere except `ScanFailureCard`'s `role="alert"`.**
*File:* grep of `src/**` for `aria-live` returns zero matches.
What the user experiences: applying a rating (Enter/Backspace/F) only produces a 320 ms
visual flash (`useRatingPersistence.ts:32-36`) and a status-bar color/label swap
(`App.tsx:1645-1655`) — nothing is announced to a screen reader. The same is true for
the "N saved / N unsaved · retry" pill flipping state, the folder-unreachable chip
(`App.tsx:1985-2010`), the memory-pressure chip (`App.tsx:2011-2022`), and Smart-analysis
progress. A screen-reader-assisted user (a real, not hypothetical, audience — e.g. a
low-vision photographer who uses a screen reader alongside sight) gets no auditory
confirmation that their keystroke did anything.
Fix: add one visually-hidden `aria-live="polite"` region that mirrors the current
verdict label and the saving/failed counts; consider `aria-live="assertive"` only for
the failed-write and folder-unreachable transitions.

### MEDIUM

**M1 — Settings/nav/filter-tab text falls under the 4.5:1 AA threshold.**
*File:* `.cull-settings__row-help` (`App.css:1862-1871`), `.cull-settings__navitem`
(`App.css:1738-1752`), `.cull-filter-tabs button` default state (`App.css:472-485`) all
render in `var(--muted)` (`#7a7a84`, defined `App.css:65`) against `var(--surface)`
(`#16161a`, `App.css:55`) or `var(--surface-2)` (`#1d1d22`, `App.css:56`).
Measured: muted-on-surface ≈ **4.25:1**, muted-on-surface-2 ≈ **3.95:1** — both below the
4.5:1 required for text under 18px/14px-bold. (The CSS comment at `App.css:62-64`
documents `--muted` as "~4.6:1 on `--bg`" — that math is correct for `--bg`, but the
token is also used on the lighter `--surface`/`--surface-2`, where it no longer clears
AA.) This affects real, load-bearing copy: every Settings row's explanatory help text,
the inactive Settings tab labels, and the inactive All/Unrated/Keeps/Smart filter tab
labels most users read on every screen.
Fix: use `var(--text-2)` (≈7.9:1 on both surfaces) for these three rules, or introduce a
`--muted-on-surface` token calibrated separately from `--muted-on-bg`.

**M2 — Two-step "armed" confirms lose focus and give no live announcement.**
*File:* `SettingsDialog.tsx:542-560` (Reset), `FinishDialog.tsx:507-526` (Move rejects),
combined with `useFocusTrap.ts:63-73`.
What the user experiences: clicking "Reset" (or "Move rejects") swaps that button out
of the tree entirely for a "Sure?" message + a new "Yes, reset"/"Yes, move" button in
the same visual slot. Because the original button unmounts, `useFocusTrap`'s
`focusout` handler can't find the new control as a `relatedTarget` and re-homes focus
to the dialog's root container instead (`useFocusTrap.ts:70-72`) — a keyboard user must
Tab from the top of the dialog again to reach "Yes, …", and a screen-reader user gets no
announcement that the button they just activated changed meaning.
Fix: after arming, imperatively focus the new "Yes, …" button; add an
`aria-live="polite"` node carrying the "Sure? This moves N files" text.

**M3 — Two controls fall under the WCAG 2.2 24×24 CSS px target-size minimum.**
*File:* `.cull-settings__toggle` (`App.css:1922-1934`, 36×20px) and
`.cull-statusbar__ov` overlay chips (`App.css:363-378`, 22×22px with 3px gaps).
The overlay chips likely clear SC 2.5.8 via the spacing exception (~25px center-to-center),
but the standalone settings Toggle does not — it isn't adjacent to a competing target it
could claim spacing against, and its clickable area is exactly its 20px-tall visual knob.
Fix: keep the visual knob's size but pad the button's hit area to at least 24×24 (e.g.
`padding` plus `box-sizing` adjustments, without changing the drawn track size).

**M4 — Smart-culling suggestion state is entirely invisible to assistive tech.**
*File:* `VerdictDot.tsx:29-33,37-47` (both the solid dot and the ghost dot are
`aria-hidden`), `GridView.tsx:470-472` and `ThumbCell.tsx:74-76` (the cell's own
`aria-label` only appends the *committed* `rating`, never the `suggestion`).
Sighted users get a dashed ghost glyph, a hover tooltip with confidence % and reasons
(`ghostTitle`, `verdictGlyph.tsx:72-76`), and a whole "Suggestion" section in `ExifRail`
— none of it reaches a screen reader anywhere in the grid or filmstrip.
Fix: when a cell is unrated and carries a suggestion, append it to the cell's
`aria-label` (e.g. `", suggested reject, 82%"`), mirroring what `ExifRail` already
renders visually.

**M5 — Documentation gap for Compare's `f` key.**
*File:* `README.md:174-201` (cheat-sheet table) vs `HelpOverlay.tsx:69-76` and
`useCullKeymap.ts:357-366`.
The README table lists `f` as simply "favorite" across all three columns (Loupe /
Compare / Grid). In Compare, `f` is actually a compound action — "keep both, challenger
gets ★" — which also commits the **champion** as a keep, not just marking the currently
highlighted frame as a favorite the way `f` does everywhere else. A user skimming the
printed cheat sheet could reasonably expect `f` in Compare to be scoped to one frame.
Fix: give Compare's `f` (and `k`, which the printed README omits entirely — it only
appears in `HelpOverlay`) its own row/footnote in the README table.

### LOW

**L1 — Modifier glyph unfamiliar on Windows.**
*File:* `utils/platform.ts:6` (`modGlyph = isMac ? "⌘" : "⌃"`), used throughout chrome
copy (`App.tsx:1339,1353`, `SettingsDialog.tsx:292`, etc.).
"⌃" is macOS's own Control glyph convention; Windows UI conventions spell out "Ctrl".
A first-time Windows user may not immediately parse "⌃ O" as "Ctrl+O."
Fix: render a literal "Ctrl" label (not a glyph) when `!isMac`.

**L2 — Chrome text runs very small with no in-app scale option.**
*File:* base `font-size: 14px` (`App.css:86`) with most chrome labels at 9–11px
monospace (filter tabs, overlay cluster, key hints, EXIF rail). Combined with M1's
contrast issue on some of the same labels, low-vision users face two compounding
hurdles on the same text. No evidence of an in-app zoom/scale control; unclear whether
the Tauri webview honors OS-level zoom.
Fix: verify OS/browser zoom actually reflows this layout at 200% (WCAG 1.4.4); consider
a "UI scale" setting if not.

**L3 — `CompareExifRail` differences are marked with color + a bullet, not purely color (verified, not a violation).**
*File:* `App.css:3850-3858`. Noted here only because it was checked: a differing row
gets both `color: var(--accent)` on the value **and** a `"•"` prefix on the key
(`::before`), so this one is *not* color-only and needs no fix — flagged as a positive
confirmation, not a defect.

---

## Terminology inventory

| Concept | Terms used | Locations | Consistency |
|---|---|---|---|
| Positive rating | "Keep" / "keeps" | README.md:182,197; `App.tsx` `verdictLabel.keep`; `useCullKeymap.ts` `applyRating("keep")`; `FinishDialog.tsx` "Copy keeps" | Consistent — no "pick"/"select" ever used for this |
| Negative rating | "Reject" / "rejects" | README.md:183; `HelpOverlay.tsx`; `FinishDialog.tsx` "Move rejects" | Consistent |
| Standout rating | "Favorite" / "Fav" (status-pill abbreviation) / ★ glyph | README.md:184; `App.tsx` `verdictLabel.favorite = "Fav"`; `ExifRail.tsx` "Favorite" | Consistent; "Fav" only in the space-constrained status pill, always paired with the ★ icon |
| Clear a rating | "Unrate" | README.md:185; `HelpOverlay.tsx`; `useRatingPersistence.ts` comments | Consistent |
| Advisory ML/heuristics feature (umbrella) | "Smart culling" (section/settings title) · "Smart" (tab label) · "Suggestions" (settings toggle + README body) · "Deep analysis" (ML sub-tier toggle) · "analysis"/"analyzing"/"analyzed" (generic) | README.md "## Smart culling"; `SettingsDialog.tsx:141-207`; `App.tsx` filter-tab label "Smart · N"; `App.tsx` `EmptyFilter` "Analyzing"/"Analyzed" | Mostly used correctly per sub-concept (Smart = umbrella tab, Suggestions = master toggle + output, Deep analysis = ML sub-tier), but five near-synonymous terms for one two-layer feature is a lot for a first-time reader — consider a one-line glossary sentence in Settings |
| Container of photos | "Folder" (always, in UI copy) vs "shoot" (only in README/ARCHITECTURE prose, never UI chrome) | README.md throughout; `App.tsx` "open folders", "drop folders" | Clean separation: user-facing text never says "shoot" |
| Comparison roles | "Champion" / "Challenger" | README.md, ARCHITECTURE.md, `CompareView.tsx`, `HelpOverlay.tsx` | Consistent |
| Modifier key | "Ctrl"/"Cmd" (prose, `modName`) vs "⌃"/"⌘" (glyph, `modGlyph`) | `utils/platform.ts`; used throughout footers/hints | Internally consistent but see Finding L1 for the Windows glyph choice |
| Move-rejects destination | "subfolder" (named via Settings) vs "Trash" (OS Recycle Bin) | `FinishDialog.tsx` `MoveRejectsRow` | Correctly kept distinct from the rating vocabulary — "Trash" never collides with "Reject" |

---

## Contrast table

Computed via the WCAG relative-luminance formula from the CSS custom properties in
`App.css:53-72`.

| Foreground | Background | Ratio | AA needed (normal text) | Result | Where used |
|---|---|---|---|---|---|
| `--text` #ededed | `--bg` #0c0c0d | 16.8:1 | 4.5:1 | Pass | Primary body text |
| `--text-2` #a3a3aa | `--bg` #0c0c0d | 7.9:1 | 4.5:1 | Pass | Secondary text |
| `--muted` #7a7a84 | `--bg` #0c0c0d | 4.64:1 | 4.5:1 | Pass (documented, barely) | Home hints, chrome sub-labels |
| `--muted` #7a7a84 | `--surface` #16161a | **4.25:1** | 4.5:1 | **Fail** | Settings row-help, inactive filter tabs, Settings nav items (M1) |
| `--muted` #7a7a84 | `--surface-2` #1d1d22 | **3.95:1** | 4.5:1 | **Fail** | Some Settings nav-item states (M1) |
| `--accent` #d4af6a | `--bg` #0c0c0d | 9.5:1 | 4.5:1 | Pass | Hero emphasis, brand mark |
| `--accent` #d4af6a | `--surface` #16161a | 8.7:1 | 4.5:1 | Pass | Active tab/nav text |
| `--ok` #9ec5a4 | `--bg` #0c0c0d | 10.3:1 | 4.5:1 | Pass | Keep verdict text/glyph bg |
| `--bad` #c87f7f | `--bg` #0c0c0d | 6.4:1 | 4.5:1 | Pass | Reject verdict text |
| `--bad` #c87f7f | `--surface` #16161a | 5.8:1 | 4.5:1 | Pass | Unsaved/failed-save text |
| `--accent-soft` rgba(212,175,106,.15) composited on `--surface` | `--surface` #16161a | **~1.3:1** | ~3:1 (focus-indicator practice) | **Fail** | Every `:focus-visible` box-shadow ring (H3) |
| `--border` #28282e | `--surface` #16161a | 1.2:1 | 3:1 (only if load-bearing) | Decorative in nearly all uses; not flagged as a defect |

---

## Top 10 prioritized recommendations

1. Fix the ESC regression: restore per-site back-stack / grid-deselect behavior, or
   consciously keep "ESC always confirms home" and update `README.md` +
   `ARCHITECTURE.md` to match (H1).
2. Add `@media (prefers-reduced-motion: reduce)` overrides for the verdict flash,
   shimmer sweeps, and pulse/breathe animations — the flash fires on every rating
   keystroke, the app's single most frequent action (H2).
3. Give `.cull-winbtn` a real `:focus-visible` treatment, and raise the opacity/contrast
   of the `--accent-soft` focus ring used everywhere else to at least ~3:1 (H3).
4. Decide the intended AT model for grid/strip cells and make `role="button"` true
   (tabIndex + Enter/Space) or drop the role if arrow-key-only is intentional (H4).
5. Add an `aria-live="polite"` region mirroring rating verdicts and save/failed counts
   so a screen-reader-assisted user gets non-visual confirmation of their keystrokes (H5).
6. Swap `var(--muted)` for `var(--text-2)` on Settings row-help text and inactive
   filter/nav tab labels — both currently read below 4.5:1 on `--surface` (M1).
7. Fix focus handling on the two-step "armed" confirms (Reset, Move rejects): move
   focus onto the new "Yes, …" button and announce the state change (M2).
8. Enlarge the Settings toggle's hit target to at least 24×24 CSS px (M3).
9. Surface Smart-culling suggestion state (verdict + confidence) in the grid/strip
   cell's `aria-label` — currently invisible to AT despite being a whole feature
   surface for sighted users (M4).
10. Reconcile the README's keyboard table with Compare's compound `f`/`k` actions, and
    reconsider the "⌃" glyph on Windows in favor of a literal "Ctrl" label (M5, L1).
