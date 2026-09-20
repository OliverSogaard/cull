# Phase 3A — See and feel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the seven look-and-feel decisions Oliver picked on the design board plus the accessibility "visible minimum", with no layout or feature change.

**Architecture:** Almost everything is tokens, primitives and surface CSS under `src/styles/`, plus string/JSX edits in the chrome components. Two small new units carry logic: a `KeyCombo` component (modifier + key as separate keycaps) and a "permanent failure" split in the rating-persistence hook. Reduced motion lives in one new stylesheet imported last.

**Tech Stack:** React 19, TypeScript 5.8 strict, plain CSS with tier-2 tokens, lucide-react, Vitest 4 (jsdom per file), stylelint 17, pnpm 10.

**Spec:** `docs/superpowers/specs/2026-09-19-phase-3a-see-and-feel-design.md` (the picked options, exact values). Findings behind it: `docs/superpowers/audits/2026-09-13-full-app-audit/reports/ux-a11y-copy.md` and `reports/design-system.md`. Rule-by-rule inventory with file:line for every decision: `design-board/REPORT.md` (git-excluded, local).

## Global Constraints

- Branch `phase-3a-see-and-feel`, cut from `main` @ `31765c3`. Line numbers in this plan and in `design-board/REPORT.md` are as of that commit; symbol and selector names win if they drifted.
- Exact values come from the spec — copy them verbatim: `--fav: #b9a2dc`; ring `0 0 0 2px var(--bg), 0 0 0 4px var(--accent)` (the existing `--ring` token); `--on-bad: var(--ink)`; empty star `color-mix(in srgb, var(--text-2) 58%, var(--bg))`; button md 32 px / 13 px / `0 14px`, sm 26 px / 12 px / `0 10px`; keycap 20 px tall / 11 px mono / min-width 20 px / `0 5px` / radius 2 px; icons 12 and 14 px at `strokeWidth={1.75}`, 16 px at `strokeWidth={1.5}`.
- No layout, feature or behaviour change beyond the spec. No new dependencies. No Rust changes. No `console.log`.
- CSS: values go through tokens (`src/styles/tokens.css`); the stylelint guards (font names, z-index) must stay green; a value needed more than once becomes a token.
- Do not touch `design-board/` (it is the verification surface) and do not commit it.
- Commits: conventional (`feat:`, `fix:`, `style:`, `refactor:`, `test:`, `docs:`), **no attribution trailers**, always pathspec form `git commit -m "…" -- <files>`. Never `git add -A`, never a bare `git commit`.
- The prettier hook reformats after commits: content leftovers → a `style:` pathspec commit; line-ending-only noise → `git add <file>`.
- Gate for every task: `pnpm lint && pnpm lint:css && pnpm typecheck && pnpm typecheck:tests && pnpm test`. The final gate adds `pnpm build` and `pnpm css:census`.
- Subagents never launch the Tauri app, never touch `C:\Canon Media`, never send keystrokes. A Vite dev server is already running on port 1420 for the design board — do not start or stop one.
- The plan's code is a draft: where it contradicts the code base, the code wins — report the contradiction.

## Waves

Tasks that share files run in sequence. **Wave 1 (parallel):** Task 1 (CSS), Task 3 (new stylesheet), Task 5 (TSX). **Wave 2 (parallel):** Task 2 (CSS, after 1), Task 6 (TSX, after 5). **Wave 3:** Task 7 (TSX + two CSS rules, after 2 and 6). **Wave 4:** Task 4 (CSS + TSX, after 7). **Wave 5:** Task 8, then Task 9. **Wave 6:** Task 10.

---

### Task 1: Colour — lilac favourite, contrast lifts, selection tint

**Files:** Modify `src/styles/tokens.css`, `src/styles/dialogs.css`, `src/styles/chrome.css`, `src/styles/stage.css`, `src/styles/exif-rail.css`, `src/styles/grid.css`. Test: `src/styles/contrast.test.ts` (new).

- [ ] **Step 1: failing test** — `src/styles/contrast.test.ts`: read `src/styles/tokens.css` through Vite's raw glob (`@types/node` is not installed, so `node:fs` fails typecheck and the type-aware lint — this applies to every test in this plan that reads source files; always pass the `<string>` type argument), parse the hex value of a custom property with a small regex helper, and assert with a local WCAG contrast function:

```ts
import { describe, expect, test } from "vitest";

const files = import.meta.glob<string>("./tokens.css", {
  query: "?raw",
  eager: true,
  import: "default",
});
const css = files["./tokens.css"];
const token = (name: string): string => {
  const m = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})\\b`).exec(css);
  if (!m) throw new Error(`token --${name} is not a plain hex`);
  return m[1];
};
const lum = (hex: string): number => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: string, b: string): number => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe("colour tokens", () => {
  test("the favourite colour is not the accent", () => {
    expect(token("fav").toLowerCase()).not.toBe(token("accent").toLowerCase());
  });
  test("verdict and text colours clear AA on both dark surfaces", () => {
    for (const fg of ["fav", "ok", "bad", "accent", "text-2"]) {
      for (const bg of ["bg", "surface", "surface-2"]) {
        expect(ratio(token(fg), token(bg)), `--${fg} on --${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
  test("ink on the danger fill clears AA", () => {
    expect(ratio(token("ink"), token("bad"))).toBeGreaterThanOrEqual(4.5);
  });
});
```

Run it: the first test fails (`--fav` equals `--accent`). The pre-flight check computed all fifteen pairs at the new values; the lowest is `--bad` on `--surface-2` at 5.43, so the rest pass once `--fav` changes.

- [ ] **Step 2: tokens.** `--fav: #b9a2dc;` and `--on-bad: var(--ink);` in `src/styles/tokens.css`. The pre-flight check found nine hardcoded champagne values (`chrome.css:309`, `:542`, `dialogs.css:345`, `grid.css:207`, `note.css:9`, `stage.css:158/159`, `:264`, `strip.css:74`) and every one means *accent*, and nothing that means "Lightroom star" uses `--fav` (the LrC badges and EXIF stars are `--accent`) — confirm with your own grep and leave them. `src/utils/ratingColor.ts` already uses `var(--fav)`.
- [ ] **Step 3: contrast lifts**, exactly these rules: `.cull-settings__row-help`, `.cull-settings__navitem` (default state only — hover/active keep their colours), `.cull-filter-tabs button` (default state) → `color: var(--text-2)`; `.cull-statusbar__keyhint` gains `color: var(--text-2)` and keeps its opacity; `.cull-exif-rail__lrc-dim` → `color: color-mix(in srgb, var(--text-2) 58%, var(--bg))`. Both hover rules (`.cull-filter-tabs button:hover:not(.is-active)`, `.cull-settings__navitem:hover:not(.is-active)`) are `--text-2` today, i.e. equal to the new default — raise both to `var(--text)`.
- [ ] **Step 4: selection tint.** `.cull-grid__multi-tint`: `inset` matches the cell padding (9 px — read `.cull-grid__cell`'s padding and use the same value; fix the comment) and `background: color-mix(in srgb, var(--accent) 42%, transparent)`.
- [ ] **Step 5:** gate green. Commit: `feat(style): lilac favourite, AA contrast lifts, selection tint sits inside the frame`.

### Task 2: One focus ring everywhere

**Files:** Modify `src/styles/tokens.css`, `src/styles/primitives/btn.css`, `src/styles/primitives/chip.css`, `src/styles/dialogs.css`, `src/styles/chrome.css`, `src/styles/stage.css`, `src/styles/home.css`, plus any other stylesheet the grep in Step 1 finds.

- [ ] **Step 1: inventory.** `grep -rn "focus" src/styles` — list every `:focus` / `:focus-visible` rule and every `outline: none`. `design-board/REPORT.md` §2 has the known ones; your grep is the authority.
- [ ] **Step 2: tokens.** Keep `--ring` as is (`0 0 0 2px var(--bg), 0 0 0 4px var(--accent)`). Add `--ring-inset: inset 0 0 0 2px var(--accent);` for controls whose ring must stay inside their box: full-width rows inside a bordered list (`.cull-recent__item`), the window buttons, and the filter tabs (`.cull-filter-tabs` has `gap: 0`, so an outer 4 px ring would overlap the neighbouring tab).
- [ ] **Step 3: apply.** Every `:focus-visible` rule that draws `0 0 0 2px var(--accent-soft)` becomes `box-shadow: var(--ring)` (inset ones `var(--ring-inset)`), keeping `outline: none`. Add `:focus-visible { outline: none; box-shadow: var(--ring); }` to `.btn` and `.chip` (only where the chip is a `button`), to `.cull-filter-tabs button` (inset form) and `.cull-filter-tab-tooltip button` (they keep their colour change too). No focusable element carries an elevation shadow today, so nothing needs composing. `.cull-settings__text:focus` (a text input's border-colour change on bare `:focus`) is correct as it is — leave it. `.cull-winbtn`: replace `.cull-winbtn:focus, .cull-winbtn:focus-visible { outline: none }` with `.cull-winbtn:focus { outline: none }` + `.cull-winbtn:focus-visible { box-shadow: var(--ring-inset); }` (inset: the buttons touch the window edge).
- [ ] **Step 4: mouse focus must not show rings.** Confirm every rule uses `:focus-visible`, never bare `:focus`, for the ring.
- [ ] **Step 5:** gate green. Commit: `feat(a11y): one visible focus ring on every control`.

### Task 3: Reduced motion

**Files:** Create `src/styles/motion.css`, `src/styles/motion.test.ts`; modify `src/styles/index.css` (import it LAST).

- [ ] **Step 1:** list every `animation:` and every `transition:` longer than 200 ms in `src/styles` with the selector that uses it (13 keyframes exist: `cull-save-pulse`, `cull-scrub-flash`, `cull-indeterminate`, `cull-flash-restore`, `cull-finish-progress-breathe`, `cull-hero-in`, `cull-flash-pulse`, `cull-spinner-reveal`, `cull-finish-done`, `cull-trouble-pulse`, `cull-feedback-pop`, `cull-shimmer-sweep`, `cull-spin`).
- [ ] **Step 2:** `src/styles/motion.css`, one `@media (prefers-reduced-motion: reduce) { … }` block with a header comment stating the policy: *decorative and attention motion stops; motion that means "working" stays, slowed.* Rules: the verdict flash (`cull-flash-pulse`) and the rating pop (`cull-feedback-pop`) show their end state with `animation: none` — the tint/pop must still be VISIBLE for its usual duration (read the keyframes: if the resting state after the animation is invisible, set the visible state explicitly, e.g. a fixed `opacity`, rather than just removing the animation); `cull-shimmer-sweep` → `animation: none` (static placeholder); `cull-save-pulse`, `cull-trouble-pulse`, `cull-scrub-flash`, `cull-finish-progress-breathe`, `cull-finish-done`, `cull-flash-restore` → `animation: none` with a sensible static state; `cull-hero-in` and `cull-spinner-reveal` → `animation: none` with the final state (element visible); `cull-spin` → `animation-duration: 1.6s`; `cull-indeterminate` → `animation-duration: 2.4s`. Zoom/pan glide transitions on the photo (`transition` on transform) → `transition: none`. **Specificity:** being imported last only wins ties — repeat each animating rule's exact selector (e.g. `.cull-save-status--saving .cull-save-status__dot`, `.cull-trouble-chip[data-state="checking"]`, `.cull-statusbar__finish.is-done`, `.cull-settings__text.is-flash`, `.cull-finish__dest-sub.is-flash`, `.cull-photo-frame--flash-*::after`). Resting states, from the pre-flight check: the verdict flash and the rating pop declare no `opacity`, so `animation: none` leaves them visible at full tint until their class clears (what we want); `cull-spinner-reveal`'s element declares `opacity: 0` and needs `opacity: 1`; the hero, shimmer, pulses and breathes rest visible/neutral.
- [ ] **Step 3:** there is no JS-driven smooth scrolling in `src/` (pre-flight grep: zero `behavior: "smooth"` / `scrollIntoView`; the grid writes `scrollTop` directly), so no helper is needed. Confirm with your own grep.
- [ ] **Step 4:** a CSS test next to it, `src/styles/motion.test.ts`: read every stylesheet under `src/styles` with `import.meta.glob<string>("./**/*.css", { query: "?raw", eager: true, import: "default" })`, collect every `@keyframes` name, and assert each name appears inside `motion.css` either in a rule's comment list or in an override — i.e. a new keyframe added later fails the test until someone decides its reduced-motion behaviour. Keep the mechanism simple: `motion.css` carries a comment line `/* reviewed: name, name, … */` that the test parses.
- [ ] **Step 5:** gate green. Commit: `feat(a11y): honour prefers-reduced-motion`.

### Task 4: Two button sizes, one keycap

**Files:** Modify `src/styles/primitives/btn.css`, `src/styles/primitives/kbd.css`, `src/styles/primitives/dialog.css`, `src/styles/home.css`, `src/styles/stage.css`, `src/styles/dialogs.css`, `src/styles/empty-state.css`, and the TSX files whose buttons need a size class.

- [ ] **Step 1:** `.btn` becomes the md size: `height: 32px; padding: 0 14px; font-size: var(--fs-5)` (13 px), `display: inline-flex; align-items: center; justify-content: center; gap` as today; add `.btn--sm { height: 26px; padding: 0 10px; font-size: var(--fs-4); }` (12 px). `.btn--cta` keeps its own geometry — it sets no `height` today, so add `height: auto` to it or the hero CTA collapses to 32 px. Remove the per-surface **padding** overrides of `.cull-settings__reset`, `.cull-message__retry` and `.cull-statusbar__finish` and give those three elements `btn--sm` in their TSX; the two mono uppercase surfaces (`.cull-statusbar__finish` 10 px, `.cull-message__retry` 11 px) KEEP their own `font-size`, font-family, letter-spacing and text-transform — sm unifies height and padding, not the mono label size (12 px mono uppercase would widen the footer pill). Decide md vs sm for every other `.btn` by role: dialog actions and screen CTAs md; footer, chips-adjacent and inline utility buttons sm. List every button and its size in the report.
- [ ] **Step 2:** `.kbd` owns the keycap geometry: `display: inline-flex; align-items: center; justify-content: center; height: 20px; min-width: 20px; padding: 0 5px; font-family: var(--font-mono); font-size: var(--fs-3); line-height: 1` (longhands — the `font` shorthand would reset weight and style), `border-radius: var(--r-1)` (2 px). Remove font-size/padding from the six surface keycap rules (`.cull-hero__cta-key`, `.cull-hero__how-key`, `.cull-recent__kbd`, `.dialog__hint kbd`, `.cull-settings__foot kbd`, `.cull-empty-state__hint kbd`), keeping their background, margin, `letter-spacing` and — for `.dialog__hint kbd` — `text-transform: none` (the hint row is uppercase; the keycaps inside it are not). Every `<kbd>` in `src` already carries the `kbd` class.
- [ ] **Step 3:** the dead `.cull-quitguard__danger:hover`: it is deliberately the app's one OUTLINE danger button (see its comment), so do not convert it to the solid `btn--danger`. Fix the specificity instead — `.cull-quitguard__danger:hover:not(:disabled)` — so the hover fill applies, and update the comment.
- [ ] **Step 4:** `pnpm css:census` — no class defined-but-unreferenced or referenced-but-undefined that this task introduced. Gate green. Commits: `refactor(style): two button sizes`, `refactor(style): one keycap`.

### Task 5: `KeyCombo` — "Ctrl" + key as separate keycaps

**Files:** Create `src/components/KeyCombo.tsx`, `src/components/KeyCombo.test.tsx`. Modify `src/utils/platform.ts` (+ its test if one exists), `src/styles/primitives/kbd.css`, `src/App.tsx` (four call sites), `src/components/StatusBar.tsx`, `src/components/SettingsDialog.tsx`, `src/components/RecentFolders.tsx`, `src/components/EmptyFilter.tsx`, `src/components/HelpOverlay.tsx`.

**Interfaces — Produces:** `modLabel: string` in `platform.ts` (`"⌘"` on macOS, `"Ctrl"` elsewhere); `KeyCombo({ keys, className, mod = modLabel }: { keys: readonly string[]; className?: string; mod?: string })` where the literal `"mod"` in `keys` renders `mod`; `modCombo(key: string): string` in `platform.ts` for plain-text contexts — `"⌘E"` on macOS, `"Ctrl+E"` elsewhere.

- [ ] **Step 1: failing test** (`// @vitest-environment jsdom`, mock `../utils/platform` per case with `vi.doMock` + dynamic import, or make `KeyCombo` take an optional `mod` prop defaulting to `modLabel` — prefer the prop, it needs no module mocking):

```tsx
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { KeyCombo } from "./KeyCombo";

afterEach(cleanup);

describe("KeyCombo", () => {
  test("renders each key as its own keycap, the modifier spelled for the platform", () => {
    const { container } = render(<KeyCombo keys={["mod", "O"]} mod="Ctrl" />);
    const caps = [...container.querySelectorAll("kbd")].map((k) => k.textContent);
    expect(caps).toEqual(["Ctrl", "O"]);
  });
  test("passes a class to every keycap and keeps the combo on one line", () => {
    const { container } = render(<KeyCombo keys={["mod", ","]} mod="⌘" className="kbd--tint" />);
    expect(container.querySelectorAll("kbd.kbd.kbd--tint")).toHaveLength(2);
    expect(container.firstElementChild?.className).toContain("keycombo");
  });
});
```

- [ ] **Step 2:** implement: a `<span className="keycombo">` wrapping one `<kbd className="kbd …">` per key; `.keycombo { display: inline-flex; gap: 3px; white-space: nowrap; }` in `src/styles/primitives/kbd.css`. `modGlyph` is replaced by `modLabel` everywhere; delete `modGlyph` when its last use is gone.
- [ ] **Step 3:** swap the call sites listed in `design-board/REPORT.md` §5, plus the fourth one it missed: `App.tsx`'s `keyhint: modGlyph` feeds `StatusBar.tsx`'s finish label as a template string (`${session.keyhint}E finish`) — with a word modifier that would read "CtrlE". That label is plain text inside a mono uppercase button, so it uses `modCombo("E")` (unit-test both platforms), not keycaps. The two hero keycaps are `<span className="kbd …">` with a `margin-right` meant for a single cap: move that margin to the `.keycombo` wrapper at those sites so two caps do not double it. The staged hint line is plain text — render it with the component too ("drop folders anywhere to add more · [Ctrl] [O] · [esc] to start over"). The help overlay's `⌃+click` row becomes `Ctrl` keycap + "click".
- [ ] **Step 4:** gate green. Commit: `feat(ui): the modifier is spelled "Ctrl" on Windows, one keycap per key`.

### Task 6: Sentence case

**Files:** Modify `src/App.tsx`, `src/components/ConfirmHomeDialog.tsx`, `src/components/FinishDialog.tsx`, `src/components/SettingsDialog.tsx`, `src/components/EmptyFilter.tsx`, `src/components/QuitGuardOverlay.tsx`, `src/components/StatusBar.tsx`, `src/components/RecentFolders.tsx`, `src/components/HelpOverlay.tsx`, and any other component the sweep finds; tests that assert on the old strings.

- [ ] **Step 1: sweep.** List every user-visible string in `src/**/*.tsx` that is a title, a button label, a message or a tooltip (`title=`). Classify: already Sentence case / needs change / rendered uppercase by CSS (eyebrows, mono chips — leave the source string alone). Put the before → after table in the report.
- [ ] **Step 2: rules.** Titles, buttons, messages, tooltips: first word capitalised, the rest lowercase, proper nouns keep capitals (CULL, Lightroom, Trash, XMP, EXIF, Canon, CR3). Trailing arrows and punctuation stay ("Begin culling →", "Leave to home?"). Key names inside keycaps keep their own convention (`esc`, `enter`, `tab` lowercase as today). Do not reword — casing only — except the three places the audit calls out as inconsistent vocabulary, which you may align and must list.
- [ ] **Step 3:** update tests that match on strings (`grep -rn "leave to home\|begin culling\|open folders" src --include=*.test.*`).
- [ ] **Step 4:** gate green. Commit: `style(copy): Sentence case across titles, buttons and messages`.

### Task 7: Lucide everywhere, one icon scale

**Files:** Create `src/components/icons.ts` (scale constants), `src/components/icons.test.ts`; modify the TSX files with Unicode glyphs (`design-board/REPORT.md` §7 lists them), `src/styles/chrome.css` (scrub arrow rule), `src/styles/exif-rail.css` (diff bullet rule) and `src/styles/motion.css` (Task 3 wrote a reduced-motion override for `.cull-statusbar__scrub::before`; it must follow the animation to the new icon element).

- [ ] **Step 1:** `src/components/icons.ts`: `export const ICON = { sm: { size: 12, strokeWidth: 1.75 }, md: { size: 14, strokeWidth: 1.75 }, lg: { size: 16, strokeWidth: 1.5 } } as const;` and `export const ICON_DISPLAY_STROKE = 1.5;`. Usage: `<Check {...ICON.md} aria-hidden />`.
- [ ] **Step 2:** replace each Unicode glyph with its lucide icon (✓ `Check`, ✕ `X`, ★ `Star` — filled where the glyph was solid: `fill="currentColor"`, ⚠ `TriangleAlert`, ↓ `ArrowDown`, ⟶ `ArrowRight`, • `Dot`), `aria-hidden`, colour via `currentColor`, vertically centred with the adjacent text (`inline-flex` + `align-items: center` + a 4–6 px gap on the parent; do not nudge with `position: relative; top`). The two CSS-generated glyphs (`.cull-statusbar__scrub::before`, the compare rail's diff `::before`) move into JSX; the scrub flash animation moves to the icon element. **Glyphs that are text, not chrome, stay characters:** `aria-label`s (`GridView.tsx:502`, `ThumbCell.tsx:115` — "LrC 3★"), and the compare rail's LrC value strings built in a row data object (`ExifRail.tsx:256-257`). The segmented-control label `"Keeps · ★"` (`SettingsDialog.tsx:91`) is a prop string: make the option label a `ReactNode` if the control allows it cheaply, otherwise keep the character. The filter sub-mode tabs (`StatusBar.tsx:297/353/364/375`) are mono, uppercase, letter-spaced buttons whose only content is the glyph — give the icon's button `letter-spacing: 0` and flex centring. `ConfirmHomeDialog.tsx:16` and `FinishDialog.tsx:272` build the glyph into a template literal and need restructuring into JSX.
- [ ] **Step 3:** bring the existing icons onto the scale: every `size=` / `strokeWidth=` in `src/components` and `src/App.tsx` maps to `ICON.sm | md | lg`, except three tuned families that keep their sizes and strokes (say so in a comment in `icons.ts`): the verdict glyphs inside the 8–9 px rating dots (`verdictGlyph.tsx`, `ThumbCell.tsx`, `GridView.tsx`, `RatingDot.tsx`); the LrC star badges on cells (`GridView.tsx:503`, `ThumbCell.tsx:111/116`); and the 22 px / stroke 3 glyphs inside the 48 px rating feedback pop (`App.tsx` `.cull-feedback__circle`). The window controls (`WindowControls.tsx`) follow the Windows caption-button metric — keep their size, align their stroke to 1.5.
- [ ] **Step 4:** a guard test `src/components/icons.test.ts`: scan `src/**/*.tsx` (via `import.meta.glob<string>("../**/*.tsx", { query: "?raw", eager: true, import: "default" })`, test files filtered out by key) for the characters `✓ ✕ ★ ⚠ ↓ ⟶` outside comments and fail listing file:line, with an explicit allowlist (file + the exact line text) for the text-not-chrome cases above, each with a one-line reason.
- [ ] **Step 5:** gate green. Commit: `refactor(ui): Lucide icons on one scale; no Unicode glyphs in the chrome`.

### Task 8: Small accessibility fixes

**Files:** Modify `src/App.tsx` (help sheet), `src/styles/dialogs.css` (toggle), `src/components/FinishDialog.tsx`, `src/components/SettingsDialog.tsx`, `src/hooks/useArmedConfirm.ts` (+ test), `src/styles/base.css`, `src/styles/exif-rail.css`, the error-text surfaces.

- [ ] **Help sheet hides overlays.** While `helpVisible`, the loupe and compare panes receive no clip / peak mask and no composition guides. Derive once in `App.tsx`: `const overlaysShown = !helpVisible;` and gate the three props at the pane call sites (not the toggles' state — closing help restores them).
- [ ] **Toggle hit area ≥ 24 × 24.** `.cull-settings__toggle` keeps its 36 × 20 drawn track; enlarge the hit area with a transparent `::before { content: ""; position: absolute; inset: -4px 0; }` (check `::after` is the knob and is not disturbed).
- [ ] **Armed confirms take focus.** `useArmedConfirm` returns a third element, a ref callback for the confirm button: when `armed` flips true the element is focused. TDD in `src/hooks/useArmedConfirm.test.tsx` (jsdom): render a tiny harness with the two-stage markup, click stage 1, expect `document.activeElement` to be the "Yes" button; after the auto-disarm timeout focus returns to the stage-1 button. Wire both dialogs.
- [ ] **Selectable values.** `user-select: text` on EXIF rail values (`.cull-exif-rail__v` or the value class in use), the compare rail values, `.cull-message__body` / error `<pre>` text, and the analyze-warning detail. Chrome stays `none`.
- [ ] Gate green. Commit per bullet (`fix(a11y): …`).

### Task 9: A missing photo is not "unsaved · retry"

**Files:** Create `src/app/useRatingPersistence.test.tsx` (none exists; jsdom + `renderHook`, `@tauri-apps/api/core` mocked — precedent: `src/app/useDecideCallbacks.test.tsx`). Modify `src/app/useRatingPersistence.ts`, `src/components/StatusBar.tsx`, `src/components/SaveStatusPill.tsx`, `src/components/QuitGuardOverlay.tsx`, `src/components/ConfirmHomeDialog.tsx`, `src/components/FinishDialog.tsx`, `src/App.tsx` (prop plumbing). Other `failedCount` consumers to read before changing anything: `src/app/useQuitGuard.ts:33,49`.

- [ ] **Step 1: failing tests** in the hook's test file: a write rejected with `"source missing: …"` is recorded as failed AND counted in a new `missingCount`; a generic failure is not; `retryFailed()` skips missing paths (no `invoke` for them); a later successful write to the same path clears it from both.
- [ ] **Step 2:** the hook tracks permanent failures beside `failedWrites` (which is internal — the hook returns counts, not the record) and returns `missingCount`. `failedCount` keeps counting both, so the quit guard and the leave-to-home warning still refuse to lose them silently. **The rule for the finish dialog:** today `FinishDialog` disables Move rejects / Copy keeps while `failedCount > 0`, and the only way out is a retry — which can never succeed for a missing photo, so the cull could never be finished. Missing-only failures warn but do NOT block the finish actions; retryable failures block as today (`failedCount - missingCount > 0`).
- [ ] **Step 3: copy.** Footer chip: all failures missing → `<TriangleAlert/> {n} photo(s) missing`, not a button, `title="The photo is no longer at its path, so its rating could not be saved."`; mixed → `{n} unsaved · retry` as today with the title adding "({m} missing photos will be skipped)". Same wording in `SaveStatusPill`, the quit guard and the leave-to-home warning. Sentence case, singular/plural handled.
- [ ] **Step 4:** gate green. Commit: `fix(ui): a rating that failed because the photo is gone says so`.

### Task 10: Docs and final verification

- [ ] README key table: Compare's `f` ("keep both, challenger gets ★") and `k` get their own row/footnote (audit M5; the Compare column for `f` is `—` at README:184 today). ARCHITECTURE/README design notes: the favourite colour, the focus ring token, the two button sizes, the icon scale, reduced motion.
- [ ] Controller: headless screenshots of `http://localhost:1420/design-board/` — the "today" columns now show the shipped stylesheet; compare against the picked options (1B, 2A, 3, 4A) and against a plain-browser render of the home screen (`http://localhost:1420/`).
- [ ] Final gate incl. `pnpm build` and `pnpm css:census`.
