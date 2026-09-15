# Phase 1 — Clean Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the frontend's structure match its discipline — the leftover JSX out of `App.tsx`, one dispatcher per keymap concern, one compare-decide sequence instead of three, one blob-revoke loop, one verdict palette, a real token layer, a stylesheet split by surface, eight shared primitives instead of ~60 hand-rolled recipes, no dead CSS, and docs that describe the ESC model the app actually has — with behaviour unchanged except the two visual unifications the audit asked for (one verdict palette, one primitive per recipe) and the one decided behaviour change (ESC clears a grid selection first).

**Architecture:** Safest-first. Mechanical JSX extractions (no state moves) → the status bar with grouped props → a hook test harness that characterises the compare-decide trio before it is deduplicated → the keymap split → the store's revoke helper → the palette → tokens (additive, then exact-match replacement, then stylelint guards so drift cannot return) → the file split (pure move, verified by concatenation diff) → primitives (one commit each, class census after each) → dead CSS → docs. Every task ends green on `pnpm lint && pnpm lint:css && pnpm typecheck && pnpm typecheck:tests && pnpm test && pnpm build`.

**Tech Stack:** React 19 + TypeScript 5.8 strict, Vite 7, Vitest 4 (node env by default; jsdom only for the new hook tests), stylelint 17 + stylelint-config-standard, pnpm 10. Rust untouched except nothing.

**Spec:** `docs/superpowers/audits/2026-09-13-full-app-audit/audit.md` §5.3 Code cleanliness, §5.5 Design language (structure items), §6 "Phase 1 — Clean", §8 Decisions (ESC keep + "clears a grid selection first"; visual polish stays in Phase 3). Detail: `reports/frontend-architecture.md` (extraction map, `onKey` split, decide trio, revoke loops), `reports/design-system.md` (§5 duplicate patterns, §6 dead CSS, §7 recommendations 1–4, Appendix token sheet).

## Global Constraints

- Branch `phase-1-clean` is stacked on `phase-0-safety` (PR #3, unmerged). The PR targets `phase-0-safety`; re-target to `main` once #3 merges. Never push or merge without Oliver's say-so beyond the agreed PR. No commit trailers.
- **Behaviour unchanged** is the rule; the three sanctioned exceptions: (1) `RATING_COLOR` moves from Tailwind hexes to the CSS tokens (audit §5.5 HIGH); (2) each primitive replaces its recipes with ONE recipe — small visual deltas (a radius, a tracking) are accepted only where this plan names them; (3) ESC clears a grid multi-selection before opening the leave-to-home confirm (decision §8). Everything else is a refactor a screenshot could not tell apart.
- Timing-sensitive code (`imageStore`, presenter, zoom choreography, the decide callbacks' setState → `dropZoomFullsExcept` ordering, the keymap's bind-once contract) gets the narrowest change; war-story comments stay in place.
- No new runtime dependencies. Dev-only additions allowed: `@testing-library/react`, `jsdom` (Task 4).
- File size guide: 200–400 typical, 800 max for NEW files; `App.tsx` lands ≈ 1,800–1,900 (its irreducible composition root — do not force it under 800).
- Tests that exist stay green unchanged unless the task says which assertion changes and why. Each task adds or updates tests where logic moves.
- Commit messages `<type>: <description>` (refactor/feat/fix/test/docs/chore/style), one commit per named step below; the repo's prettier format-on-edit hook may re-wrap after a commit — fold leftovers into the next commit or a `style:` commit so the tree ends clean.
- Gates per task: `pnpm lint && pnpm lint:css && pnpm typecheck && pnpm typecheck:tests && pnpm test`; `pnpm build` at the end of Tasks 9, 10, 11, 12 and 13.
- The live visual walk is Oliver's (memory: he wants hands-on); no GUI driving while the PC is in use. Tasks 11 and 8 list exactly what he should look at.

---

## File Structure

| File | Responsibility in this plan |
| --- | --- |
| `src/components/EmptyFilter.tsx` (new) | `NoMatchEmptyState` + `EmptyFilter`, moved verbatim from `App.tsx`. |
| `src/components/RecentFolders.tsx` (new) | `RecentFolders` + `RecentRow`, moved verbatim. |
| `src/components/SaveStatusPill.tsx` (new) | moved verbatim. |
| `src/components/QuitGuardOverlay.tsx` (new) | the quit-guard overlay JSX as a component. |
| `src/components/ConfirmHomeDialog.tsx` (new) | the confirm-home JSX as a component. |
| `src/components/StatusBar.tsx` (new) | the ~290-line footer with props grouped by concern. |
| `src/app/useDecideCallbacks.test.tsx` (new) | characterisation tests of the three compare decides (call ORDER). |
| `src/app/useDecideCallbacks.ts` | `resolveCompareDecide` helper; three callbacks become thin. |
| `src/app/useCullKeymap.ts` | `onKey` → `handleModalKeys` / `handleCompareKey` / `handleSingleModeKey`; ESC clears a grid selection first. |
| `src/image/imageStore.ts` | `revokeReadyBlobs(map)` used by `reset` / `hardReset`. |
| `src/utils/ratingColor.ts` (+test) | `RATING_COLOR` → `var(--ok/--bad/--fav)`. |
| `src/styles/tokens.css` … `src/styles/index.css` (new) | the split stylesheet; `App.tsx` imports `./styles/index.css`. |
| `src/styles/primitives/*.css` (new) | `btn`, `chip`, `kbd`, `dialog`, `note`, `progress`, `spinner`, `eyebrow`, `shimmer`. |
| `.stylelintrc.json` | guards: no raw `font-family` names / raw `z-index` numbers outside `tokens.css`. |
| `scripts/css-census.mjs` (new) | defined-vs-referenced `cull-*` class census (dead/undefined lists). |
| `ARCHITECTURE.md`, `README.md`, `src/components/HelpOverlay.tsx` | the real ESC model. |

---

### Task 1: Plan commit (controller)

- [ ] `git switch -c phase-1-clean` from `phase-0-safety` (done), commit this file: `docs: Phase 1 clean plan`.

---

### Task 2: Move the five presentational pieces out of `App.tsx`

**Files:**
- Create: `src/components/EmptyFilter.tsx`, `src/components/RecentFolders.tsx`, `src/components/SaveStatusPill.tsx`, `src/components/QuitGuardOverlay.tsx`, `src/components/ConfirmHomeDialog.tsx`
- Modify: `src/App.tsx` (anchors at HEAD 59ca200: `NoMatchEmptyState` 2236–2252, `EmptyFilter` 2260–2398, `RecentFolders` 2410–2436, `RecentRow` 2438–2482, `SaveStatusPill` 2498–2538, `const quitGuardOverlay = quitGuard && (` 1263–≈1312, `{confirmHome && (` 2158–2185)

**Interfaces:**
- Produces: `EmptyFilter`, `NoMatchEmptyState` (same props as today), `RecentFolders`, `RecentRow`, `SaveStatusPill` (same props), `QuitGuardOverlay({ failedCount, savingCount, retryFailed, onKeepCulling, onCloseAnyway })`, `ConfirmHomeDialog({ failedCount, onLeave, onStay })`.

Rules: move JSX and helper functions VERBATIM (comments included); the only edits are the import lines (`import type` for types, the same util imports App used — `modGlyph`, `pickSmartEmptyState`, `formatFolderSet`, `formatRelativeTime`, `recentKey`, `RecentEntry`, `Filter`) and, for the two overlays, turning the inline expression into a component that receives the values it read. `QuitGuardOverlay`'s "close anyway" handler stays in App (it owns `destroyedRef` and `getCurrentWindow`) and is passed as `onCloseAnyway`. Remove imports App no longer needs (lint will flag them).

- [ ] **Step 1:** Create `EmptyFilter.tsx` with `NoMatchEmptyState` (not exported unless App used it directly — check) and `export function EmptyFilter`. Replace in App with an import. Gates. Commit `refactor: move EmptyFilter and NoMatchEmptyState out of App.tsx`.
- [ ] **Step 2:** `RecentFolders.tsx` (`RecentFolders` exported, `RecentRow` local). Commit `refactor: move RecentFolders and RecentRow out of App.tsx`.
- [ ] **Step 3:** `SaveStatusPill.tsx`. Commit `refactor: move SaveStatusPill out of App.tsx`.
- [ ] **Step 4:** `QuitGuardOverlay.tsx`:

```tsx
import type { ReactNode } from "react";

type Props = {
  failedCount: number;
  savingCount: number;
  retryFailed: () => void;
  onKeepCulling: () => void;
  onCloseAnyway: () => void;
};

/** The close-request guard: shown while ratings are still being written (auto-closes
 *  when they land) or when writes failed permanently (explicit choice, never silent loss). */
export function QuitGuardOverlay({ failedCount, savingCount, retryFailed, onKeepCulling, onCloseAnyway }: Props): ReactNode {
  return (
    <div className="cull-quitguard">
      <div className="cull-quitguard__box">
        {/* … the existing two branches verbatim; `setQuitGuard(false)` → onKeepCulling;
            the destroy handler → onCloseAnyway … */}
      </div>
    </div>
  );
}
```

In App: `const quitGuardOverlay = quitGuard && (<QuitGuardOverlay failedCount={failedCount} savingCount={savingCount} retryFailed={retryFailed} onKeepCulling={() => setQuitGuard(false)} onCloseAnyway={closeAnyway} />)` where `closeAnyway` is the existing destroy handler hoisted into a `useCallback` in App. Commit `refactor: QuitGuardOverlay component`.
- [ ] **Step 5:** `ConfirmHomeDialog.tsx` (`{ failedCount, onLeave, onStay }`), rendered as `{confirmHome && <ConfirmHomeDialog failedCount={failedCount} onLeave={leaveToHome} onStay={() => setConfirmHome(false)} />}`. Commit `refactor: ConfirmHomeDialog component`.
- [ ] **Step 6:** `wc -l src/App.tsx` — expect ≈ 2,150. Report the number.

---

### Task 3: Extract the status bar

**Files:**
- Create: `src/components/StatusBar.tsx`
- Modify: `src/App.tsx` (`const bottomStatusBar = (` 1664 → `</footer>` ≈ 1958)

**Design (the one decision):** the footer reads ≈ 30 values. Group them into FOUR prop objects by concern, each a plain `type` exported next to the component; a group never exceeds 12 fields:
- `frame`: `filename: string | null`, `rating: Rating | null` (null in compare), `isZooming`, `zoomLevel`, `scrubbing`, `scrubSpeed`.
- `overlays`: `visible: boolean` (the cluster is hidden in grid), `thumbs`, `exif`, `clipping`, `peaking`, `composition` (each `{ on: boolean; toggle: () => void }`).
- `selection`: `gridVisible`, `selectedCount`, `clearSelection`.
- `save`: `savingCount`, `failedCount`, `retryFailed`.
- `filter`: `filter`, `setFilter`, `stats`, `qualityAnalyzing`, `qualityProgress`, `smartCulling: boolean`, `chipsTooltip` (the hook's return object — pass it through whole), `positionInFilter`, `visibleCount`.
- `session`: `openActions` (the finish chip), `keyhint` (the platform modifier text the bar prints).
If the JSX reads a value not covered above, add it to the group it belongs to and say so in the report. Six groups is fine if five is not enough; a flat 30-prop signature is not.

- [ ] **Step 1:** Create `StatusBar.tsx`: the footer JSX verbatim, values replaced by `frame.filename` etc.; the small local helpers it uses (`verdictCls`, `verdictLabel`, `topOf`, `verdictGlyph`) imported from where App imports them. `export const StatusBar = memo(function StatusBar(props: StatusBarProps) { … })`.
- [ ] **Step 2:** In App, build the six objects with `useMemo` where they hold only primitives/stable callbacks (they will change often anyway — do not over-memoize; a plain object literal per render is acceptable; the `memo` on the component is the win when nothing changed).
- [ ] **Step 3:** Gates. `wc -l src/App.tsx` — expect ≈ 1,850. Commit `refactor: StatusBar component with grouped props`.

---

### Task 4: Hook test harness + characterisation tests for the compare decides

**Files:**
- Modify: `package.json` (devDependencies `@testing-library/react`, `jsdom`), `pnpm-lock.yaml`
- Create: `src/app/useDecideCallbacks.test.tsx`

Why first: Task 5 collapses three near-identical 60-line callbacks into one helper whose ORDER of side effects is load-bearing (the file cites the 2026-07-07 compare-strip crash). Characterise the order before touching it.

- [ ] **Step 1:** `pnpm add -D @testing-library/react jsdom` (pin exact versions in the lockfile; no `happy-dom`). Vitest stays in node env globally; the new file opts in with the first line `// @vitest-environment jsdom`.
- [ ] **Step 2:** Write the test. Shape (the implementer reads `useDecideCallbacks.ts` lines 1–120 for the exact param list and builds `makeProps()` accordingly — one field per hook param; functions are `vi.fn()` that push their name into a shared `calls: string[]`; `*Ref` params are `{ current: … }` objects; `imageStore` is mocked with `vi.mock("../image/imageStore", () => ({ imageStore: { dropZoomFullsExcept: vi.fn() } }))` and its call also pushes to `calls`):

```tsx
// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { imageStore } from "../image/imageStore";
import { useDecideCallbacks } from "./useDecideCallbacks";
import type { Img, Rating } from "../types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../image/imageStore", () => ({ imageStore: { dropZoomFullsExcept: vi.fn() } }));

const img = (id: number): Img => ({ id, path: `/s/${id}.cr3`, filename: `${id}.cr3`, srcFolder: "/s" });
const five = [0, 1, 2, 3, 4].map(img);

describe("compare decides — side-effect order (characterisation)", () => {
  const calls: string[] = [];
  beforeEach(() => { calls.length = 0; vi.mocked(imageStore.dropZoomFullsExcept).mockImplementation(() => { calls.push("dropZoomFullsExcept"); }); });

  function setup(ratings: Record<number, Rating>, championIndex: number, challengerIndex: number) {
    const props = makeProps({ images: five, ratings, championIndex, challengerIndex, calls });
    const { result } = renderHook(() => useDecideCallbacks(props));
    return { result, props };
  }

  it("challengerLoses: recordAction → flash → persist → setRatings → setChallengerIndex → dropZoomFullsExcept", () => {
    const { result, props } = setup({ 0: "keep" }, 0, 1);
    act(() => result.current.challengerLoses());
    expect(calls).toEqual(["recordAction", "flashFeedback", "persistRating", "setRatings", "setChallengerIndex", "dropZoomFullsExcept"]);
    expect(props.persistRating).toHaveBeenCalledWith("/s/1.cr3", "reject");
    expect(imageStore.dropZoomFullsExcept).toHaveBeenCalledWith(["/s/0.cr3", "/s/2.cr3"]);
  });

  it("challengerLoses on the last unrated frame exits via goBack(champion) and drops nothing", () => {
    const { result, props } = setup({ 0: "keep", 2: "keep", 3: "reject", 4: "keep" }, 0, 1);
    act(() => result.current.challengerLoses());
    expect(calls).toEqual(["recordAction", "flashFeedback", "persistRating", "setRatings", "goBack"]);
    expect(props.goBack).toHaveBeenCalledWith(0);
  });

  it("challengerKeptBoth(true) persists favorite for the challenger and keeps the champion", () => { /* same shape; verdict "favorite"; champion untouched */ });

  it("challengerWins: two changes, persist reject then keep, setChampionIndex before setChallengerIndex, drop keeps the new pair", () => {
    const { result, props } = setup({ 0: "keep" }, 0, 1);
    act(() => result.current.challengerWins());
    expect(calls).toEqual(["recordAction", "flashFeedback", "persistRating", "persistRating", "setRatings", "setChampionIndex", "setChallengerIndex", "dropZoomFullsExcept"]);
    expect(props.persistRating).toHaveBeenNthCalledWith(1, "/s/0.cr3", "reject");
    expect(props.persistRating).toHaveBeenNthCalledWith(2, "/s/1.cr3", "keep");
    expect(imageStore.dropZoomFullsExcept).toHaveBeenCalledWith(["/s/1.cr3", "/s/2.cr3"]);
  });

  it("zoomed decide sets zoomSwapInstant (and resets pan only on a win)", () => { /* isZoomingRef.current = true; assert setZoomSwapInstant called; setPanOffset only for challengerWins */ });
});
```

The `calls` expectations MUST be derived from the current code (read it; do not guess) — the test is a characterisation, so its first green run IS the spec for Task 5. If the current order differs from the sketch above, the test follows the code and the report says so.
- [ ] **Step 3:** `pnpm vitest run src/app/useDecideCallbacks.test.tsx` green; `pnpm typecheck:tests`, `pnpm lint`. Commit `test: characterise the compare-decide side-effect order (jsdom hook harness)`.

---

### Task 5: One compare-decide sequence

**Files:**
- Modify: `src/app/useDecideCallbacks.ts` (236–449)

**Interfaces:**
- Internal `resolveCompareDecide(spec)` inside the hook (a `useCallback` the three callbacks call), where

```ts
type DecideSpec = {
  changes: { imgId: number; path: string; before: Rating | undefined; after: Rating }[];
  flash: { rating: Rating; imgId: number };
  /** Champion after the decide (unchanged for loses/kept-both; the old challenger for wins). */
  nextChampion: number;
  nextChallenger: number; // -1 = exiting
  /** Wins re-anchor both panes at the new champion's AF point. */
  resetPan: boolean;
};
```

and the body is the existing seven steps ONCE, in this exact order: `recordAction` (cursorBefore/after built from the spec) → `flashFeedback` → `persistRating` for each change in order → `setRatings(next)` → zoom-swap (`setZoomSwapInstant(true)` when zoomed and not exiting; `setPanOffset({x:0,y:0})` when `resetPan`) → `setChampionIndex(nextChampion)` only when it changed → `goBack(nextChampion)` if exiting else `setChallengerIndex(nextChallenger)` → `dropZoomFullsExcept([images[nextChampion]?.path, images[nextChallenger]?.path])` when not exiting. The war-story comment about the sync flush moves onto the helper (once).

- [ ] **Step 1:** Implement the helper; rewrite the three callbacks as spec builders (each ≤ 20 lines). Keep the `// eslint-disable-next-line react-hooks/exhaustive-deps` + "currentIndex deliberately omitted" note on the helper's dependency list.
- [ ] **Step 2:** `pnpm vitest run src/app/useDecideCallbacks.test.tsx` — every characterisation test green UNCHANGED. Full gates. Commit `refactor: one resolveCompareDecide sequence for the three compare decides`.

---

### Task 6: Split `onKey` and make ESC clear a grid selection first

**Files:**
- Modify: `src/app/useCullKeymap.ts` (`onKey` 202–560), `src/components/HelpOverlay.tsx:22` label

- [ ] **Step 1:** Inside the same `useEffect` (the bind-once contract via `cullKeyRef` is untouched), split `onKey` into three closures declared before it, each ≤ 120 lines: `handleModalKeys(e): boolean` (settings / quit-guard / phase / bare modifiers / hold interrupts / confirm-home / actions-open — returns `true` when the key was consumed), `handleCompareKey(e)` (the whole `if (compareMode) switch`), `handleSingleModeKey(e)` (the single-mode switch). `onKey` becomes: guards → undo/redo/finish/select-all/help/Space-arm/ESC (the shared universal keys stay in `onKey`) → `compareMode ? handleCompareKey(e) : handleSingleModeKey(e)`.
- [ ] **Step 2:** ESC (decision §8): before `setConfirmHome(true)`, `if (gridVisible && hasGridSelection) { clearMultiSelection(); return; }` — `hasGridSelection` and `clearMultiSelection` are App values; add them to the hook's params (both blocks) and the App call site. Update the comment: "ESC clears a grid multi-selection first; otherwise it opens the leave-to-home confirm from any site (stepping back site-by-site felt wrong). goBack is still used by the compare auto-exit flows."
- [ ] **Step 3:** `HelpOverlay.tsx`: header comment sentence → "ESC clears a grid selection if there is one; otherwise it opens the leave-to-home confirm from any site." Label → `["esc", "leave to home (clears a grid selection first)"]`.
- [ ] **Step 4:** Gates. Commit `refactor: split the cull keymap dispatcher; ESC clears a grid selection first`.

---

### Task 7: One revoke loop in the image store

**Files:**
- Modify: `src/image/imageStore.ts` (`reset` 525+, `hardReset` 695+)

- [ ] **Step 1:** Add next to `dropPath`:

```ts
  /** Revoke every READY blob in a tier map and empty it — the one shape both
   *  resets share (REVOKE SITES 5, 8, 11 and the thumb sweep). */
  private revokeReadyBlobs(map: Map<string, { status: string; url?: string } | undefined>): void {
    for (const [, state] of map) {
      if (state?.status === "ready" && state.url) URL.revokeObjectURL(state.url);
    }
    map.clear();
  }
```

(Type the parameter so `this.fulls`, `this.zoomFulls`, `this.mids` all fit; thumbs are `Map<string, ThumbEntry>` with no status — keep their loop or add a second tiny helper `revokeThumbs()`; the executor picks the typing that compiles without `any`.) Replace the four loops in `reset` and the loops in `hardReset`; keep the `// REVOKE SITE n` markers as comments at the call sites (the file's blob-lifecycle audit trail relies on them).
- [ ] **Step 2:** `pnpm vitest run src/image` (the harness tracks every createObjectURL/revokeObjectURL pair) green; gates. Commit `refactor: revokeReadyBlobs helper for reset and hardReset`.

---

### Task 8: One verdict palette

**Files:**
- Modify: `src/utils/ratingColor.ts`, `src/utils/ratingColor.test.ts`

- [ ] **Step 1:** Test: change the assertion to `toBe("var(--ok)")`, `toBe("var(--bad)")`, `toBe("var(--fav)")` and the describe name to "RATING_COLOR points at the CSS verdict tokens".
- [ ] **Step 2:** `RATING_COLOR = { keep: "var(--ok)", reject: "var(--bad)", favorite: "var(--fav)" }`; doc comment: "Points at the CSS tokens so the compare dot and the feedback pop can never drift from the strip/grid dots again (they used to be Tailwind hexes)." Inline `style={{ backgroundColor: … }}` consumers (`RatingDot.tsx:22`, `App.tsx` feedback pop) work with `var()` unchanged.
- [ ] **Step 3:** Gates. Commit `fix: one verdict palette — RATING_COLOR uses the CSS tokens`. **Oliver's walk:** press Enter/Backspace/F in the loupe — the 48 px pop and the compare dot now match the strip dots (sage/rose/champagne, not neon).

---

### Task 9: Tier-2 token sheet, exact-match replacement, stylelint guards, class census

**Files:**
- Modify: `src/App.css` (`:root` at 53–71 and every exact-match declaration), `.stylelintrc.json`
- Create: `scripts/css-census.mjs`

- [ ] **Step 1 (additive):** append the Appendix token sheet from `reports/design-system.md` to `:root` EXCEPT the two visual changes reserved for Phase 3: keep `--fav: #d4af6a` (do not add the distinct `--fav`) and do not add `--warn`. Add `--on-accent: #1a1408; --on-bad: #ffffff; --ink: #0a0a0c; --accent-hover: #e8c182; --bad-hover: #d49090;` with the CURRENT values (no visual change). Commit `feat(styles): tier-2 tokens (type, space, shape, motion, layers, layout)`.
- [ ] **Step 2 (exact-match replace, one commit per family):** replace ONLY declarations whose value equals a token's value exactly — `font-family: Inter, …` → `var(--font-ui)`, `'JetBrains Mono', monospace` → `var(--font-mono)`; `font-size: 9|10|11|12|13|14|16|18|22|28|56px` → `--fs-*`; `border-radius: 2|4|6|999|9999px|50%`(pill on pills only) → `--r-*`; `120ms|0.12s` → `--dur-fast`, `180ms` → `--dur-base`, `320ms` → `--dur-slow`; the three shadows; `z-index` numbers that match the layer table; `#1a1408` → `var(--on-accent)`, `#e8c182` → `var(--accent-hover)`, `#d49090` → `var(--bad-hover)`, `rgba(8, 8, 10, 0.7)` → `var(--scrim-modal)`, `rgba(8, 8, 10, .82)`/`rgba(8, 8, 8, 0.82)` → `var(--scrim)` (only exact matches; note near-misses in the report). Off-scale values (7, 8, 10.5, 11.5, 13.5 px…) are left as they are with a trailing `/* off-scale */` comment for Phase 3. Use `sed`/a script and review the diff; `pnpm build` must produce byte-identical CSS output modulo the `var()` indirection — verify with a spot check of `dist/assets/*.css` for a few rules. Commits: `refactor(styles): fonts → tokens`, `… sizes → tokens`, `… radii/shadows/motion/layers → tokens`, `… colours → tokens`.
- [ ] **Step 3 (guards):** `.stylelintrc.json` — add `"declaration-property-value-disallowed-list": { "font-family": ["/Inter/", "/JetBrains/"], "z-index": ["/^[0-9]+$/"] }` and an `overrides` entry for `src/styles/tokens.css` (created in Task 10 — until then `src/App.css`'s `:root` block gets `/* stylelint-disable-next-line declaration-property-value-disallowed-list */` on the token lines; the `@font-face` block is wrapped in `/* stylelint-disable declaration-property-value-disallowed-list */ … /* stylelint-enable … */`). `pnpm lint:css` green. Commit `chore(stylelint): no raw font names or z-index numbers outside the token sheet`.
- [ ] **Step 4 (census tool):** `scripts/css-census.mjs`:

```js
// Defined-vs-referenced census of `cull-*` classes. Output is a STARTING LIST, not a
// verdict: template-literal class builders (VerdictDot, PhotoPane, ThumbCell, ExifRail,
// App's feedback pop) produce names this grep cannot see — reconcile by hand.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
function walk(dir, out = []) { for (const n of readdirSync(dir)) { const p = join(dir, n); (statSync(p).isDirectory() ? walk(p, out) : out.push(p)); } return out; }
const files = walk("src");
const css = files.filter((f) => f.endsWith(".css")).map((f) => readFileSync(f, "utf8")).join("\n");
const code = files.filter((f) => /\.(tsx?|jsx?)$/.test(f) && !/\.test\./.test(f)).map((f) => readFileSync(f, "utf8")).join("\n");
const defined = new Set([...css.matchAll(/\.(cull-[a-z0-9_-]+)/g)].map((m) => m[1]));
const used = new Set([...code.matchAll(/\b(cull-[a-z0-9_-]+)/g)].map((m) => m[1]));
const unref = [...defined].filter((c) => !used.has(c)).sort();
const undef = [...used].filter((c) => !defined.has(c)).sort();
console.log(`defined ${defined.size} · referenced ${used.size}`);
console.log(`unreferenced in code (${unref.length}):\n  ${unref.join("\n  ")}`);
console.log(`undefined in css (${undef.length}):\n  ${undef.join("\n  ")}`);
```

Add `"css:census": "node scripts/css-census.mjs"` to package.json scripts. Run it; paste the two lists into the report (baseline for Tasks 11–12). Commit `chore: css class census script`.

---

### Task 10: Split `App.css` into `src/styles/`

**Files:**
- Create: `src/styles/index.css` and the files below; Modify: `src/App.tsx:25` import; Delete: `src/App.css`

Pure move, cut at the existing section headers (`/* ── … ── */`, lines 1, 50, 97, 136, 201, 610, 653, 1025, 1070, 1147, 1244, 1385, 1612, 1674, 2146, 2314, 2390, 2510, 2596, 2764, 2773, 2825, 3049, 3141, 3420, 3507, 3636, 3693):

| File | Sections (by header) |
| --- | --- |
| `tokens.css` | `:root` token block (50–71) |
| `base.css` | fonts (1–49), `html/body/#root/.cull-app` + shell (72–96) |
| `chrome.css` | window controls (201), chrome phases (1070), hero (1147), recents (1244), scan-failure card (1385), save-status pill (136) |
| `statusbar.css` | status bar (97), status-bar chips (610) |
| `stage.css` | stage + photo frame (653), buttons (1025 — moves to `primitives/btn.css` in Task 11), messages (2596), rating dot (2764), feedback popup (2773) |
| `dialogs.css` | quit guard / overlay base (1612), settings (1674), finish (2146, 2314, 2390) |
| `empty-state.css` | (2510) |
| `strip.css` | thumbnail strip (2825), advisories + burst boxes (3049) |
| `grid.css` | (3141) |
| `help.css` | (3420) |
| `compare.css` | compare mode (3507), compare strip (3636) |
| `exif-rail.css` | (3693) |

`index.css` imports them in EXACTLY the original order of first appearance so the cascade is unchanged (base, tokens? — tokens are at line 50, fonts at 1: keep `base.css` first with the `@font-face` block, then `tokens.css`, then the rest in original order; a section that was split from the middle of another (buttons at 1025 inside the stage span) keeps its original position in the import list).

- [ ] **Step 1:** Create the files by cutting at the header lines (`sed -n a,bp`), nothing edited inside. `index.css` = the `@import "./x.css";` list.
- [ ] **Step 2:** Verify the move is pure: `cat $(the files in index order) | grep -v '^@import' | diff - <(git show HEAD:src/App.css)` — the only differences allowed are the moved header comment lines. Paste the diff summary in the report.
- [ ] **Step 3:** `App.tsx`: `import "./styles/index.css";`. Delete `App.css`. `pnpm lint:css` (the disable comments from Task 9 move with their lines; the `overrides` entry now points at `src/styles/tokens.css`), `pnpm build`, all gates. Commit `refactor(styles): split App.css by surface (pure move)`.

---

### Task 11: Eight primitives (plus the shimmer mixin), one commit each

**Files:**
- Create: `src/styles/primitives/{btn,chip,kbd,dialog,note,progress,spinner,eyebrow,shimmer}.css` (imported from `index.css` right after `tokens.css`)
- Modify: the surface CSS files (delete the replaced recipes) and the TSX that carries the class names

Source of truth: `reports/design-system.md` §5 (class → line map). For each primitive: (a) the base recipe is the current most-used variant, expressed in tokens; (b) every listed recipe becomes `class="<primitive> <primitive>--<modifier>"` in the TSX and its old rule is deleted; (c) `node scripts/css-census.mjs` after each commit shows no new "undefined in css" names; (d) gates. Sanctioned visual deltas are listed per primitive; anything else must be pixel-identical (same padding, size, colour).

- [ ] **btn** — base = `.cull-pick-button` (padding 12/24, `--fs-5`, `--r-2`, `--dur-fast`); modifiers `--primary` (accent fill, `--on-accent`, hover `--accent-hover`), `--danger` (the three danger buttons: `--bad` fill, `--on-bad`, hover `--bad-hover`), `--sm` (padding 6/12 for `.cull-message__retry`, `.cull-settings__reset`, `.cull-statusbar__finish`), `--cta` (the hero CTA's larger padding). NOT folded: window controls, filter tabs, settings nav items, segmented options, error-chip inline buttons (different intents). Delete `.cull-pick-button--ghost` (dead). Commit `refactor(styles): btn primitive (5 recipes → 1)`. Sanctioned delta: none.
- [ ] **chip** — base = pill (`--r-pill`, `--fs-2`, `--track-label`, uppercase, 2/10 padding); modifiers `--soft` (`--r-2` corners for `.cull-statusbar__chip`, `.cull-mem-chip`, `.cull-statusbar__scrubspeed`, `.cull-scrubbar__speed` — keeps their squarer look), `--bad` (trouble/error chips: `--bad` ink + border), `--accent`, `--ok`. Commit `refactor(styles): chip primitive (11 recipes → 1 + modifiers)`. Sanctioned delta: none (two radii kept via `--soft`).
- [ ] **kbd** — one `.kbd` (mono, `--fs-1`, `--r-1`, `--surface-2` fill, `--border`); replaces the six keycaps; `--tint` for the hero CTA key. Sanctioned delta: the three r3 keycaps become r2.
- [ ] **dialog** — `.dialog` (the `.cull-quitguard` scrim + `.dialog__box` = `.cull-quitguard__box`), `__title`, `__title--warn`, `__body`, `__actions`, `__actions--flush` and `__hint--flush` (replace the two inline `style={{…}}` patches in `FinishDialog.tsx:405,412`), used by QuitGuardOverlay, ConfirmHomeDialog, FinishDialog and SettingsDialog (`.cull-settings__title` dies). Sanctioned delta: none.
- [ ] **note** — `.note` left-border note with `--bad`/`--accent`/`--muted` modifiers for the three (`__unrated`, `__pending`, `__folder-exists`).
- [ ] **progress** + **spinner** — `.progress`/`.progress__fill` (both bars), `.spinner` + `.spinner--lg` (36/2 and 42/3 px). Sanctioned delta: none.
- [ ] **eyebrow** — `.eyebrow` (mono, uppercase, `--track-eyebrow`, `--fs-2`, `--muted`) replacing the ~14 eyebrow labels. Sanctioned delta: the nine trackings become one (`.2em`).
- [ ] **shimmer** — `.shimmer::after` mixin with the compositor band; the three placeholders get the class and lose their copies. Sanctioned delta: none.
- [ ] After all: `pnpm build`; report the CSS line count (expect ≈ 3,250 from 3,858) and the census. **Oliver's walk:** home (hero CTA + keycaps, recents), staged, loupe with the finish dialog open (buttons, hint), settings (reset armed), an error chip (unplug a NAS or use the retry chip), grid with a selection (the multi chip), compare (the label chips), help overlay (keycaps).

---

### Task 12: Dead CSS and dead state classes

**Files:** the `src/styles/*.css` files; `src/components/CompareView.tsx:198`; `src/components/pane/PhotoPane.tsx:442`; the font files under `src/assets` if the 600 weight is unused

- [ ] From `reports/design-system.md` §6, delete: `@keyframes cull-fade-in`; `.cull-statusbar__right span.is-active`; the empty `.cull-settings-overlay {}`; the no-op resets (`.cull-hero__title { text-shadow: none; padding: 0 }`, `.cull-cmp-label { position: static }`); the invisible `.cull-thumb__frame` gradient; the `is-champion` / `is-challenger` class emission in `CompareView.tsx` (never styled); keep `cull-image--hires` (documented). Remove the `font-weight: 600` `@font-face` block AND its woff2 file only if `grep -rn "font-weight: 600\|font-weight:600" src` is empty after Task 11.
- [ ] Run the census; every remaining "unreferenced" name must be explained in the report as a template-literal builder output (list the builder). Gates + `pnpm build`. Commit `chore(styles): delete dead rules and unstyled state classes`.

---

### Task 13: Docs: the ESC model the app has

**Files:** `ARCHITECTURE.md` "Site navigation: stack-based ESC" section, `README.md:191`, this plan (implementation note)

- [ ] Rewrite the ARCHITECTURE section as "Site navigation and ESC": the three sites and `l/c/g` stay; ESC = clear a grid multi-selection if one exists, otherwise open the leave-to-home confirm from ANY site (Enter leaves, Esc stays) — stepping back site-by-site was tried and felt wrong; the nav stack is still recorded on transitions and consumed by `goBack`, which only the compare auto-exit flows call (last challenger decided → back to the site you came from, landing on the champion); undo restores ratings + cursor, never navigation. Delete the "L → C → G → C → ESC ESC ESC" walk.
- [ ] README row: ``| `esc` | clear grid selection, else leave to home (confirm) | | |``.
- [ ] Implementation note at the end of this plan: commits, `App.tsx` and CSS line counts before/after, test counts, what Oliver should walk, what was deferred.
- [ ] Gates. Commit `docs: the ESC model, Phase 1 implementation note`.

---

### Task 14: Final gates + PR (controller)

- [ ] `pnpm lint && pnpm lint:css && pnpm typecheck && pnpm typecheck:tests && pnpm test && pnpm build`; `cargo test` untouched (no Rust change) — run `cargo clippy --all-targets -- -D warnings` once anyway.
- [ ] Push `phase-1-clean`; `gh pr create --base phase-0-safety --title "Phase 1 — Clean"` with a body listing the extractions, the primitives, the sanctioned deltas, and Oliver's visual walk as the test plan. Re-target to `main` after #3 merges.

## Implementation note (2026-09-15)

Executed on the Windows PC as branch `phase-1-clean`, stacked on `phase-0-safety` (PR #3, unmerged at the time): 35 commits, suites green at the tip (`pnpm test` 522 tests / 49 files, `pnpm build`, lint, lint:css, typecheck, typecheck:tests; `npx stylelint --report-needless-disables` empty). Same subagent-driven process as Phase 0: a fresh implementer and a fresh reviewer per task, parallel implementers only on disjoint files, every parallel commit in the pathspec form after one bare commit swept another agent's staged file.

**Numbers.** `src/App.tsx` 2,538 → 1,935 (five presentational pieces + the status bar moved out; `StatusBar.tsx` 401 lines, six prop groups). `useDecideCallbacks.ts` 449 → 430 with one `resolveCompareDecide` sequence and three ≤ 20-line builders, pinned by 12 jsdom characterisation tests written first. `useCullKeymap.ts` dispatches through `handleModalKeys` / `handleCompareKey` / `handleSingleModeKey`. Stylesheet 3,858 (one file) → 3,898 across `src/styles/` (13 surface files + 9 primitives + tokens); ~172 declarations tokenised by exact match; class census 293 defined / 277 referenced → 275 / 262 (16 recipe classes retired; the two "undefined" Settings hooks are intentional). CI gates gained: font-name and z-index guards in stylelint, `pnpm css:census`.

**Deviations and rulings (full ledger: `~/.claude/plans/cull-audit-2026-09-13/phase-1-ledger.md` on the Windows PC).**
- The plan's `pruneMoved`-style closure mistakes did not recur, but three briefs were wrong on facts and the code won: `reset()` has three revoke loops, not four; the "no filename" inputs are the same as Phase 0's; `nearestUnrated` is a hook param; wins' `setChampionIndex` is unconditional (the helper's guard reproduces it exactly).
- The status bar dropped the brief's `selection.clearSelection` (never read) and added six fields the JSX reads; `frame.filename: string | null` differs from the old object check only for an empty filename, which `basename()` never produces.
- Task 9's two directed near-exact swaps (`'JetBrains Mono', monospace` → `--font-mono`, which adds an unreachable `ui-monospace` fallback; `rgba(8,8,8,.82)` → `--scrim`, ΔE ≈ 0.3 on one chip) were accepted; the z-index guard was narrowed to two-plus digits so local stacking needs no disables; the "sizes → tokens" family landed inside the radii commit.
- The split's concatenation-diff criterion was unsatisfiable given the plan's own table (it groups non-adjacent sections); purity was proven by multiset diff plus a per-block cascade adjudication, and the build gate caught the `url("./assets/…")` → `../assets/` re-path the deeper folder needs (emitted CSS byte-identical). `chrome.css` was then split into `chrome.css` + `home.css` to stay under 800 lines.
- Primitives: the audit's ≈ −600-line estimate assumed unifying sizes, which "pixels unchanged" forbids; the fold is structural (one base rule + modifiers per primitive, surface rules reduced to deltas) and the size axis is Phase 3's decision. Sanctioned deltas: three keycaps r3 → r2, eyebrow trackings → one (.2 em, footer keyhint ~7 px wider), and one accepted micro-delta — the message "retry" button gains the shared 120 ms hover fade. One fix round: the Settings dialog header had not received `dialog__head` (reduced-rule gaps are invisible to the census; the implementer re-walked all 45 reduced rules).
- `.cull-quitguard__danger:hover` is dead by pre-existing specificity; preserved and commented for Phase 3.

**Oliver's walk (no GUI driving while the PC was in use):** home (hero CTA + keycaps, recents), staged, loupe with the finish dialog open, Settings (header bar, reset armed), an error chip, grid with a multi-selection then ESC, compare (label chips), help overlay (keycaps), the footer at 1024 px, and Enter/Backspace/F for the rating pop colours.

**Left for later phases.** Phase 2: hoist the status-bar prop groups above App's phase early-return so `memo` bites; a `withChanges(ratings, changes)` helper so `next` is derived once; replace the decide tests' numeric line citations with symbol names; the reduced-rule census gap (a census that pairs class ↔ rule). Phase 3: size unification across the primitives (`btn--sm`, one keycap size), the dead danger hover, off-scale values, the 33 still-unreferenced tokens (space/track/easing/layout), `.btn--cta`/`.kbd--tint` as surface rules. Phase 4: sub-split `handleSingleModeKey` (141 lines) once the keymap has tests; a `tokens.css`-aware stylelint that flags `Inter, sans-serif` near-misses.
