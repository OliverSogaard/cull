# Phase 5A — Stars and colour labels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give CULL Lightroom's other two verdicts — 1–5 stars and the five colour labels — as an **optional layer that is off by default and, when off, changes nothing**: not a key, not a pixel, not a byte written. With it on, the digit row becomes Lightroom's (`1`–`5` stars, `0` clears, `6`–`9` + `Shift+6` the five labels, the filters move to `Shift+1`–`Shift+5`), the marks render in the info rail, the grid cell and the filmstrip cell, and every value round-trips through `xmp:Rating` / `xmp:Label` so Lightroom Classic reads what CULL wrote. Ship, regardless of the setting, the one correctness fix the scout found underneath all of it: a keep applied to a frame carrying a genuine user 1★ currently reads back as a **favourite** after a reload.

**Architecture:** Three layers, in the order they must land. **The sidecar** (Rust): every rating CULL writes gains an explicit `cull:fav` marker so the legacy "pick + lone 1★ = favourite" fallback stops firing on a real user star; then two new write commands (`write_xmp_star`, `write_xmp_label`) sharing one `write_sidecar_sync` body so `require_source` — the guard behind the audit's one CRITICAL — cannot be forgotten by the next writer, plus a label value on the analyze read that already carries the Lightroom star. **The app** (TypeScript): two new maps beside `ratings` (`stars` by frame id, `labels` by frame id), a keymap with two shapes selected by one boolean, a write path where stars, labels and ratings for one photo share one serial queue because they share one file, and an undo entry that carries an optional `meta` change list so one keypress is still one Ctrl+Z. **The surface** (CSS + components): five `--label-*` tokens tuned to clear 3:1 on the dark surfaces, a star readout and a label bar in the rail / grid / strip, and every hint that names a digit following the setting.

**Tech Stack:** Tauri 2, Rust 1.98 stable (pure-Rust CR3 pipeline), React 19, TypeScript 5.8 strict, plain CSS, Vitest 4.1.11 (node env by default, jsdom per file via a first-line docblock, **no `@types/node`**), @testing-library/react 16.3.3, jsdom 30, pnpm 10.

**Spec:** `docs/superpowers/specs/2026-09-21-phase-5a-stars-and-labels-design.md` (binding — every ruling in it is a decision already taken). Background: `~/.claude/plans/cull-audit-2026-09-13/phase-5-scout.txt`. The scout is a POINTER, not truth — where this plan and the scout disagree, this plan says so explicitly and the code is what was read. Deviations from the spec are listed at the end under **Spec overrides**.

## Global Constraints

- Branch `phase-5a-stars-and-labels`, cut from `main` @ `2dfa5df` (plus `a48ed94`, the spec commit). Every file:line in this plan was read at `a48ed94`; if a symbol moved, the **name** wins over the line number, and report the drift.
- **Baseline at the tip, measured this session:** `npx vitest run` → **84 files, 931 tests, 4.59 s**. The scout's Rust figures: **166 `#[test]`**, `cargo test --lib xmp::` = **22 passed**. `sample_cr3s/` is ABSENT on this machine, so the two real-LrC sidecar tests (`classifies_real_lrc_sidecars`, `reads_lrc_rating_from_real_sidecars`) print a skip reason and prove nothing here — do not cite them as evidence.
- **CR3 only.** No other RAW format, no JPEG ingest, no format branching.
- **Scope is the spec.** No drive-by refactors, **no new dependencies at all** (JS or Rust). `pnpm add` is not needed by any task in this plan: every colour is a CSS custom property, every icon already exists in `lucide-react`, and the Rust side adds no crate. If you think you need one, **stop and report it** — that is a decision, not an implementation detail.
- **THE OFF-PROOF IS STRUCTURAL, AND IT IS THE FEATURE.** `settings.starsAndLabels` defaults to `false`; `DEFAULT_SETTINGS` is what `useCullKeymap.test.tsx`'s `props()` factory hands the hook, so **all 112 existing assertions in that file must pass UNCHANGED** — not adjusted, not re-worded. The only edit that file's existing content may receive is two new entries in the `props()` object literal (the two new callbacks), which change no assertion. A task that has to edit an existing assertion in `useCullKeymap.test.tsx` has got the design wrong: stop and report it.
- **TDD, and the Phase 4 lesson.** Write the failing test first, run it, and **quote the exact failure line** in the task report. For every new test the task also NAMES the one-line production mutation that turns it red; the implementer makes that edit **by hand**, watches the red, and **edits it back by hand**. A test that passes on its first run is a finding, not a result — report it.
- **Implementers never run `git stash` / `git checkout` / `git restore` / `git reset`.** To watch a test fail, temporarily edit the one line under test and edit it back.
- **Tests never import `node:*`.** `@types/node` is not installed. Read source files with
  `const files = import.meta.glob<string>(pattern, { query: "?raw", eager: true, import: "default" });`
  (always pass the `<string>` type argument), and first assert the glob returned readable text or the suite passes on empty strings.
- **`tsconfig.json` lib is `ES2020`.** No `Object.hasOwn`, no `Array.prototype.at`, no `structuredClone`. Index the last element as `arr[arr.length - 1]`. `noUncheckedIndexedAccess` is **off**, so a lookup table that can miss must be typed `Record<string, X | undefined>` by hand or the compiler will believe the result is always present.
- **Test files are linted type-aware.** Type every `vi.fn` callback (`vi.fn((_x: T) => {})`), and hoist anything a `vi.mock` factory closes over with `vi.hoisted`. Unused bindings need a `_` prefix.
- **jsdom only via a first-line docblock**: `// @vitest-environment jsdom` as line 1 of the file. Default env is node. jsdom 30 implements neither `window.matchMedia` nor `ResizeObserver`; `src/components/GridCell.layers.test.tsx:22-29` is the repo's `ResizeObserver` stub.
- **KeyboardEvents in tests are created `cancelable: true`** — without it `preventDefault()` is a silent no-op and every `defaultPrevented` assertion passes vacuously — and `bubbles: true`. `afterEach(cleanup)` is mandatory (Vitest runs without `globals`, so RTL's auto-cleanup never registers).
- **Tests never sleep.** No `await new Promise(r => setTimeout(r, n))` — use `waitFor` / `findBy*` / `vi.waitUntil`, and fake timers (`vi.advanceTimersByTimeAsync`) when the thing being proven is that a *window elapsed*.
- **Data safety is the top risk of this phase.** Three rules, all pinned by tests:
  1. **Every new sidecar write command calls `require_source` first** — `src-tauri/src/xmp.rs:85-94`, the fix behind the audit's one CRITICAL (an orphaned `.xmp` left in the folder a moved photo came from). In this plan they inherit it by construction: every write goes through `write_sidecar_sync`.
  2. **CULL never deletes a sidecar it did not create**, and never deletes one that carries user content — a star or a label CULL set IS user content (`xmp_has_user_content`, `xmp.rs:504-523`, already lists `"xmp:Label"` and any surviving 1–5★).
  3. **All three write kinds for one photo share one per-path serial queue**, because they edit one file with a read-modify-write. Two concurrent writes to the same sidecar would lose one of them.
- **Immutable updates** (spread; never mutate a settings object, a ratings map or a profile in place). **No `console.log`** (`no-console` allows `error` / `warn` only).
- **Never run the app**, never open a real photo folder, never touch `C:\Canon Media`. A vite dev server may be listening on port 1420 — leave it alone.
- **Gate for every task** (run from the repo root): `pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm lint:css && pnpm test`.
  **Rust tasks additionally** run, from `src-tauri/`: `cargo fmt` FIRST — the Rust in this plan is hand-written, not rustfmt output, so transcribing it verbatim can fail the check gate on nothing but a chain wrap — then `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test`. **Never pass a `+toolchain` argument to cargo.**
- **Commits** are conventional (`feat:`, `fix:`, `refactor:`, `style:`, `docs:`, `test:`, `chore:`), always in pathspec form — `git commit -m "<type>: <desc>" -- <files>` — with **no attribution trailers** (no `Co-Authored-By`, no session link). Never `git add -A`, never a bare `git commit`.
  A pathspec commit takes a file's **whole working-tree content**, not a hunk: never plan two commits that split different hunks of one file. One file, one commit, per task.
  The prettier hook reformats after a commit: content leftovers go in a follow-up `style:` pathspec commit; line-ending-only noise is `git add <file>`.
- **Two source-text guards will bite you if you are careless:**
  - `src/components/icons.test.ts` fails on the characters `✓ ✕ ★ ⚠ ↓ ⟶` anywhere in `src/**/*.{ts,tsx}` outside comments, unless the **exact trimmed source line** is in its `ALLOWLIST`. Four allowlist entries quote lines in `GridView.tsx`, `ThumbCell.tsx` and `ExifRail.tsx` verbatim, and a second test fails if an allowlisted line stops existing — so **do not re-indent or re-word those lines**. New marks draw their star with the Lucide `Star` component, never the character.
  - `src/styles/motion.test.ts` asserts `reviewed === declared` as a **bidirectional** set: every `@keyframes` under `src/styles` must be named in a `reviewed:` comment in `motion.css`, and a `reviewed:` name with no keyframe fails too.
- `design-board/` is git-excluded. Nothing in Phase 5A uses it.

### The names, decided once

Every task below uses these spellings. They are not negotiable per-task; if one is wrong, it is wrong everywhere and the controller changes it in one place.

| Thing | Spelling |
| --- | --- |
| Setting | `starsAndLabels` (boolean, default `false`) |
| Star value | `Star = 1 \| 2 \| 3 \| 4 \| 5` |
| Label CULL can set | `Label = "red" \| "yellow" \| "green" \| "blue" \| "purple"` |
| Label as READ from disk | `LabelValue = Label \| "custom"` |
| State maps (App) | `stars: Record<number, Star>`, `labels: Record<number, LabelValue>` (keyed by `Img.id`) |
| Undo | `UndoAction.meta?: MetaChange[]` |
| Rust commands | `write_xmp_star(path, star)`, `write_xmp_label(path, label)` |
| Rust sidecar read | `read_ratings(cr3_path) -> Result<SidecarRead, String>` |
| Wire field | `AnalyzeResult.labels: (string \| null)[]` |
| Persist API | `persistStar(path, star)`, `persistLabel(path, label)` |
| `cull:fav` values | `"star"` \| `"flag"` \| `"no"` |
| XMP label strings | `Red` `Yellow` `Green` `Blue` `Purple` |
| Colour tokens | `--label-red` `--label-yellow` `--label-green` `--label-blue` `--label-purple` |
| Shared mark classes | `.cull-mark-stars`, `.cull-mark-star--on`, `.cull-mark-star--off`, `.cull-mark-count`, `.cull-label-bar`, `.cull-label-swatch`, `.cull-label--{red,…,purple,custom}`, `.cull-mark-flash` |
| Flash keyframe | `@keyframes cull-mark-flash` |

---

### Task 1: The types, the setting, and the wire field

**Files:** Modify `src/types/rating.ts`, `src/types/settings.ts`, `src/types/ipc.ts`, `src/types/index.ts`, `src/hooks/useSettings.ts`, `src/hooks/useSettings.test.ts`, `src/utils/withChanges.ts`, `src/utils/withChanges.test.ts`. This is the ONLY task that touches any of them.

**Interfaces — Produces** (every later TS task imports from here; nothing else in the phase may re-declare these):

```ts
// src/types/rating.ts
export type Star = 1 | 2 | 3 | 4 | 5;
export type Label = "red" | "yellow" | "green" | "blue" | "purple";
export type LabelValue = Label | "custom";
export const LABELS: readonly Label[] = ["red", "yellow", "green", "blue", "purple"];
export const LABEL_NAME: Record<LabelValue, string>;   // "red" -> "Red", "custom" -> "Custom"
export function isLabel(v: unknown): v is Label;
export function isLabelValue(v: unknown): v is LabelValue;
export function isStar(v: unknown): v is Star;
export type MetaChange =
  | { imgId: number; path: string; field: "star"; before: Star | undefined; after: Star | undefined }
  | { imgId: number; path: string; field: "label"; before: LabelValue | undefined; after: LabelValue | undefined };
export type UndoAction = { changes: Change[]; meta?: MetaChange[]; cursorBefore?: CompareCursor; cursorAfter?: CompareCursor };

// src/types/settings.ts
// Settings gains: starsAndLabels: boolean;   DEFAULT_SETTINGS gains: starsAndLabels: false,

// src/types/ipc.ts
// AnalyzeResult gains: labels: (string | null)[];

// src/types/index.ts re-exports
export type { Rating, Filter, UndoAction, Star, Label, LabelValue, MetaChange } from "./rating";
export { LABELS, LABEL_NAME, isLabel, isLabelValue, isStar } from "./rating";

// src/utils/withChanges.ts — the generic sibling of withChanges, for the two
// new per-id maps. Tasks 5 and 6 both import it, which is why it is declared
// here, in the one task everything already follows.
export type MetaMapChange<T> = { imgId: number; after: T | undefined };
export function withMeta<T>(
  map: Readonly<Record<number, T>>,
  changes: readonly MetaMapChange<T>[],
): Record<number, T>;
```

**Consumes:** nothing. Fully disjoint; runs first.

**Ruling (`LabelValue`, not `Label`, in the state map).** The spec's shape line says `labels: Record<id, Label>` (spec §"The shape of it"), but its own §2 requires a sixth readable state: *"any other label string is a user's custom label: shown as 'custom', never rewritten"*. A five-member union cannot hold that, so the READ type is `LabelValue = Label | "custom"` and the SET type stays `Label` — CULL writes exactly five strings and never writes `"custom"`. Cost if wrong: none; `Label` is still the only thing a key can produce.

**Ruling (`MetaChange` carries `imgId` and `path`, not `id`).** The spec sketches `{ id, field, before, after }`. `Change` — the type it sits beside — has used `imgId` + `path` since it was written (`rating.ts:38-43`), and `path` is not optional: `applyChanges` needs it to re-persist on undo, exactly as it does for a rating. Matching the sibling wins over matching the sketch.

**Ruling (no `Rating` widening, and no new `Filter`).** The spec forbids both, and the scout's R6 explains why: `verdictGlyph.tsx` and `PhotoPane.tsx:365` fall through to a default rather than failing on an unknown `Rating`, so a widened union would ship a broken CSS class name rather than a compile error. Nothing in this task touches `Rating` or `Filter`.

**Ruling (`labels` on the wire, `lrcRatings` reused for stars).** `AnalyzeResult` already carries `lrcRatings: (number | null)[]` — the user's `xmp:Rating` 1–5 from the same sidecar read, with CULL's courtesy favourite star already filtered out at the Rust read boundary (`parse_lrc_rating`, `xmp.rs:244-254`). A star IS `xmp:Rating`, so the star layer needs **no new read wire at all**: Task 11 seeds the `stars` map from that same array. Only the label needs a new field. This is the smallest change that satisfies the spec's "stars and labels ride the same pipeline into the two new maps at open".

- [ ] **Step 1: the failing test first.** Append to `src/hooks/useSettings.test.ts`:

```ts
describe("coerceSettings — starsAndLabels (Phase 5A)", () => {
  it("defaults starsAndLabels OFF for a blob that predates the field", () => {
    // The whole feature's promise is that a user who never turns it on sees
    // no change. That starts here: an existing user's stored settings have
    // no such key, and must come back false.
    expect(coerceSettings({}).starsAndLabels).toBe(false);
    expect(DEFAULT_SETTINGS.starsAndLabels).toBe(false);
  });

  it("keeps an explicit stored value and rejects a wrong-typed one", () => {
    expect(coerceSettings({ starsAndLabels: true }).starsAndLabels).toBe(true);
    expect(coerceSettings({ starsAndLabels: "yes" }).starsAndLabels).toBe(false);
    expect(coerceSettings({ starsAndLabels: 1 }).starsAndLabels).toBe(false);
  });
});
```

  Run `npx vitest run src/hooks/useSettings.test.ts`. It must fail to COMPILE first (`Property 'starsAndLabels' does not exist on type 'Settings'`) — that is the right first red for a type that does not exist yet. Quote the exact `TS2339` line in the report.

- [ ] **Step 2: `src/types/settings.ts`.** Add the field to `Settings`, directly after the `smartCulling` block's last member `deepAnalysis: boolean;` and before the closing `};`:

```ts
  // — Stars and colour labels (Phase 5A) —
  /**
   * Lightroom's other two verdicts: 1–5 stars (`xmp:Rating`) and the five
   * colour labels (`xmp:Label`), as an optional layer ORTHOGONAL to
   * keep / reject / favorite.
   *
   * OFF by default, and off means off: the digit row keeps selecting filters,
   * no star or label renders anywhere, and no star or label byte is ever
   * written. ON, the digit row becomes Lightroom's — `1`–`5` set stars, `0`
   * clears them, `6`–`9` and `Shift+6` set Red / Yellow / Green / Blue /
   * Purple — and the five filters move to `Shift+1`–`Shift+5`.
   *
   * A starred frame with no keep/reject is still UNRATED: every count, every
   * filter and the smart pipeline keep keying on `Rating` alone.
   */
  starsAndLabels: boolean;
```

  And to `DEFAULT_SETTINGS`, after `deepAnalysis: true,`:

```ts
  starsAndLabels: false,
```

- [ ] **Step 3: `src/hooks/useSettings.ts`.** In `coerceSettings`'s returned object, after the `deepAnalysis: bool(p.deepAnalysis, d.deepAnalysis),` line, add:

```ts
    // Off is the default and the guarantee — a present-but-wrong-typed value
    // must not turn the layer on for a user who never asked for it.
    starsAndLabels: bool(p.starsAndLabels, d.starsAndLabels),
```

  Re-run `npx vitest run src/hooks/useSettings.test.ts` — 23 tests pass (21 before).
  **Watch it red for the right reason:** change that one line to `starsAndLabels: bool(p.starsAndLabels, true),` and confirm `defaults starsAndLabels OFF…` fails with `expected true to be false`; edit it back by hand.

- [ ] **Step 4: `src/types/rating.ts`.** Insert after the `Rating` type (the file's first export) and before the `Filter` docblock:

```ts
/**
 * A star rating, 1–5 — `xmp:Rating` on disk, exactly what Lightroom Classic
 * reads. ORTHOGONAL to {@link Rating}: a 3★ frame with no keep/reject is
 * still unrated, which is the truth about a second pass that only stars.
 *
 * 0 is deliberately not a member: clearing removes the property (Lightroom's
 * own `0` = "remove rating"), so the absence of a key in the `stars` map is
 * the only way "no star" is spelled.
 */
export type Star = 1 | 2 | 3 | 4 | 5;

/** The five colour labels CULL can SET. */
export type Label = "red" | "yellow" | "green" | "blue" | "purple";

/**
 * What a sidecar's `xmp:Label` reads back as. `xmp:Label` is a LOCALISED
 * free-text string, not an enum — a German Lightroom writes "Rot", and a user
 * with a custom label set writes whatever they named it. CULL understands the
 * five English defaults; anything else non-empty is the user's and comes back
 * as `"custom"`: shown, never rewritten, and never cleared by a key that did
 * not set it.
 */
export type LabelValue = Label | "custom";

/** The five labels in keyboard order — `6` `7` `8` `9` `Shift+6`. */
export const LABELS: readonly Label[] = ["red", "yellow", "green", "blue", "purple"];

/** Display name per label value. The XMP strings CULL writes are the same
 *  five words (the backend owns that mapping); this is the UI's copy. */
export const LABEL_NAME: Record<LabelValue, string> = {
  red: "Red",
  yellow: "Yellow",
  green: "Green",
  blue: "Blue",
  purple: "Purple",
  custom: "Custom",
};

/** Narrow an unknown (a restored wire value) to a settable label. */
export function isLabel(v: unknown): v is Label {
  return typeof v === "string" && (LABELS as readonly string[]).includes(v);
}

/** Narrow an unknown (a restored wire value) to a readable label value. */
export function isLabelValue(v: unknown): v is LabelValue {
  return v === "custom" || isLabel(v);
}

/** Narrow an unknown (a restored wire value) to a star. */
export function isStar(v: unknown): v is Star {
  return v === 1 || v === 2 || v === 3 || v === 4 || v === 5;
}
```

  Then, directly after the `Change` type and before `CompareCursor`, add:

```ts
/**
 * One per-image change to a frame's STAR or LABEL — the orthogonal layer, so
 * it rides beside `changes` in an {@link UndoAction} rather than widening
 * `Change`. One keypress is still one undo step: a grid multi-select produces
 * one action holding one entry per selected frame.
 *
 * `after` is never `"custom"` — CULL writes the five labels it knows and
 * nothing else — but `before` can be, because a frame may have arrived from
 * Lightroom carrying a label string CULL does not recognise.
 */
export type MetaChange =
  | {
      imgId: number;
      path: string;
      field: "star";
      before: Star | undefined;
      after: Star | undefined;
    }
  | {
      imgId: number;
      path: string;
      field: "label";
      before: LabelValue | undefined;
      after: LabelValue | undefined;
    };
```

  And add the optional slot to `UndoAction` — the whole type, replacing the existing one:

```ts
/**
 * One step in the undo stack. The `cursorBefore` snapshot lets a Ctrl+Z that
 * undoes a compare-mode rating land you back on the same champion/challenger
 * pair (not stranded mid-flow); `cursorAfter` lets a Ctrl+Y re-crown the NEW
 * champion (not the just-rejected old one) when redoing a compound compare
 * action. Single-frame rates set neither — redo then lands on the changed frame.
 *
 * `meta` is the star / colour-label layer (Phase 5A). An action carries
 * `changes`, or `meta`, or both — never neither. It is optional so every
 * existing `{ changes }` literal in the codebase still type-checks, and so an
 * action recorded before the layer existed replays unchanged.
 */
export type UndoAction = {
  changes: Change[];
  meta?: MetaChange[];
  cursorBefore?: CompareCursor;
  cursorAfter?: CompareCursor;
};
```

- [ ] **Step 5: `src/types/ipc.ts`.** In `AnalyzeResult`, after the `lrcRatings` field and before `unreadableDirs`:

```ts
  /**
   * Per input index: the frame's colour label as the lowercase key CULL uses
   * (`"red"`…`"purple"`), or `"custom"` for an `xmp:Label` string CULL does
   * not recognise, or null for none. Same sidecar pass as `ratings` and
   * `lrcRatings`, so it is free to extract on the backend.
   *
   * Stars need no field of their own: a star IS `xmp:Rating`, which
   * `lrcRatings` already carries (with CULL's own courtesy favourite star
   * filtered out at the Rust read boundary).
   */
  labels: (string | null)[];
```

- [ ] **Step 6: `src/types/index.ts`.** Replace the two rating lines with:

```ts
export type { Rating, Filter, UndoAction, Star, Label, LabelValue, MetaChange } from "./rating";
export { LABELS, LABEL_NAME, isLabel, isLabelValue, isStar } from "./rating";
```

- [ ] **Step 7: `withMeta`, test first.** Append to `src/utils/withChanges.test.ts`:

```ts
describe("withMeta — the generic map update for stars and labels", () => {
  test("sets, replaces and DELETES, never storing undefined", () => {
    // The delete is the whole point, exactly as in withChanges: an absent key
    // is how "no star" and "no label" are spelled, so a stored `undefined`
    // would make `id in stars` and Object.keys(...).length lie.
    const before = { 1: 3, 2: 5 } as Record<number, number>;
    const after = withMeta(before, [
      { imgId: 1, after: 4 },
      { imgId: 2, after: undefined },
      { imgId: 7, after: 1 },
    ]);
    expect(after).toEqual({ 1: 4, 7: 1 });
    expect(Object.keys(after)).not.toContain("2");
    expect(before).toEqual({ 1: 3, 2: 5 }); // input untouched
  });

  test("an empty change list returns an equal copy, not the same object", () => {
    const before = { 1: "red" } as Record<number, string>;
    const after = withMeta(before, []);
    expect(after).toEqual(before);
    expect(after).not.toBe(before);
  });
});
```

  Run `npx vitest run src/utils/withChanges.test.ts` — it must fail to compile (`withMeta` does not exist). Then append to `src/utils/withChanges.ts`:

```ts
/** The fields `withMeta` needs from a {@link MetaChange}. Structural, so both
 *  the star and the label change shapes fit without a cast. */
export type MetaMapChange<T> = { imgId: number; after: T | undefined };

/**
 * The stars / labels map AFTER a set of changes — the generic sibling of
 * {@link withChanges}, for the two per-id maps the star and colour-label
 * layer adds beside `ratings`.
 *
 * `after: undefined` DELETES the key rather than storing `undefined`, for
 * exactly the reason `withChanges` does: an absent key is how "no star" and
 * "no label" are spelled, so a stored `undefined` would make `id in stars`
 * true and `Object.keys(...).length` wrong.
 */
export function withMeta<T>(
  map: Readonly<Record<number, T>>,
  changes: readonly MetaMapChange<T>[],
): Record<number, T> {
  const next: Record<number, T> = { ...map };
  for (const c of changes) {
    if (c.after === undefined) delete next[c.imgId];
    else next[c.imgId] = c.after;
  }
  return next;
}
```

  Re-run: both pass. **Watch red under a named mutation:** change `delete next[c.imgId];` to `next[c.imgId] = c.after as T;` and confirm the first test fails on `expect(after).toEqual({ 1: 4, 7: 1 })`. Edit it back by hand.

- [ ] **Step 8:** gate green (`pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm lint:css && pnpm test`). `pnpm test` must report **84 files, 935 tests** (931 + 4 new). Report both numbers.
  Note: `pnpm typecheck` will NOT yet complain that `AnalyzeResult.labels` is unset anywhere — `useSessionLifecycle` only reads fields off the result. Task 11 consumes it.
- [ ] **Step 9:** commit:
  `git commit -m "feat(types): a star, a colour label, an undo meta change and the starsAndLabels setting" -- src/types/rating.ts src/types/settings.ts src/types/ipc.ts src/types/index.ts src/hooks/useSettings.ts src/hooks/useSettings.test.ts src/utils/withChanges.ts src/utils/withChanges.test.ts`

### Task 2: [RUST] Every rating carries an explicit marker — and the delete gate stops trusting a namespace

**Files:** Modify `src-tauri/src/xmp.rs`. The ONLY file this task touches. **Task 3 edits the same file and must follow this one.**

**Interfaces — Produces** (private to `xmp.rs`):

```rust
/// `cull:fav` now has THREE values: "star" | "flag" | "no".
fn created_by_cull(xmp: &str) -> bool;   // the tool stamps only; NOT xmlns:cull
```

**Consumes:** the existing `apply_rating_to_xmp`, `classify_xmp`, `cull_fav_value`, `cull_owned_fav_star`, `authored_by_cull`, `ensure_cull_ns`, `set_desc_attr`, `remove_fav_star`, `clear_xmp_rating_sync`.

**The bug, traced (scout R3, `xmp.rs:558`).** `classify_xmp`'s `pick > 0` arm reads
`let fav = cull_fav_value(content).is_some() || star == Some(1);`. Apply a KEEP to a frame that carries a genuine user 1★ from Lightroom: `apply_rating_to_xmp("keep")` sets `pick=1`/`good=true` and REMOVES `cull:fav` (`:297`), adding no marker of its own to a third-party sidecar. On the next open `classify_xmp` sees `pick=1`, no `cull:fav`, `star == Some(1)` → **favorite**. The comment at `:552-557` calls the ambiguity "safe" because detection is read-only. It stops being safe the moment a CULL user sets 1★ on purpose, which is exactly what Task 3 ships. This fix therefore ships **regardless of the setting** — it is a correctness fix, not part of the layer.

**Ruling (the marker, per spec §2).** Every rating CULL writes carries an explicit `cull:fav`: `"star"` (favourite, CULL owns the courtesy 1★), `"flag"` (favourite riding the user's star), `"no"` (keep or reject — explicitly not a favourite). The legacy `star == Some(1)` fallback then applies ONLY to a sidecar with **no `cull:fav` at all**: an LrC-authored sidecar that round-trips a flagged 1★, or a CULL sidecar written before the marker existed. Cost if wrong: none found; the fallback's only remaining job is backward compatibility, which the new test pins.

**Ruling (THE DATA-SAFETY CONSEQUENCE THE SPEC DID NOT NAME — split `created_by_cull` out of `authored_by_cull`).** Writing `cull:fav="no"` on a keep calls `ensure_cull_ns` (`:342-347`), which adds `xmlns:cull=…` to the sidecar. `authored_by_cull` (`:362-371`) returns true for **any** sidecar carrying `xmlns:cull=`, and the unrate delete gate (`clear_xmp_rating_sync:179`) is `authored && !xmp_has_user_content(&stripped)` → **`std::fs::remove_file`**. So after this change a plain keep, then an unrate, on a third-party sidecar with no recognised user-content marker would DELETE a file CULL did not write. (The same hole already exists today for the favourite path, which has always declared the namespace — this change would merely widen it from one verdict to all three.) Ruling: the delete gate uses a new, tighter `created_by_cull`, which counts only the tool stamps `fresh_xmp` writes (`x:xmptk` / `xmp:CreatorTool`). `authored_by_cull` keeps the `xmlns:cull` arm and keeps its two other jobs (the legacy-scheme classify fallback and `cull_owned_fav_star`'s pre-marker arm), where "CULL touched this" is the right question. Cost if wrong: a CULL-created sidecar that somehow lost its CreatorTool is no longer auto-deleted on unrate — it is left on disk, which is the safe direction.

**Ruling (one extra write, once, per legacy sidecar).** The unchanged-bytes fast path (`:123-129`) means a re-press of the same key still skips the disk. The first keep or reject on a sidecar written by an older CULL now differs by the added marker, so it costs one write. Bounded and one-time.

- [ ] **Step 1: the failing tests first.** Make four edits inside `mod tests`, then run `cargo test --lib xmp::` from `src-tauri/` and record EVERY failure line.

  **(a)** In `cull_favorite_star_removable_on_demote` (`:786-799`), replace the line
  `        assert!(!keep.contains("cull:fav"), "favorite marker cleared");`
  with:

```rust
        assert!(
            keep.contains("cull:fav=\"no\""),
            "a demote records an EXPLICIT not-a-favorite, so the legacy \
             `pick + lone 1star` fallback can never claim this sidecar"
        );
```

  **(b)** Rename `favorite_never_clobbers_user_2to5_star` (`:722`) to `favorite_never_clobbers_a_user_star`, change its loop header from `for n in [2, 3, 4, 5] {` to `for n in [1, 2, 3, 4, 5] {`, and append, inside the loop, after the existing `"user {n}★ survives favorite→keep"` assertion:

```rust
            // THE Phase 5A fix (scout R3): at n == 1 this read back as
            // "favorite", because classify_xmp's legacy fallback could not
            // tell a user's 1★ from CULL's own favorite stamp.
            assert_eq!(
                classify_xmp(&keep).as_deref(),
                Some("keep"),
                "a demoted favorite on a user {n}★ is a keep, not a favorite"
            );
```

  **(c)** In `genuine_user_one_star_survives_all_paths` (`:755`), after the existing
  `assert_eq!(parse_xmp_rating(&keep), Some(1), "user 1★ survives keep");` add:

```rust
        assert_eq!(
            classify_xmp(&keep).as_deref(),
            Some("keep"),
            "a KEEP on a frame carrying a genuine Lightroom 1★ must read back \
             as a keep — it used to read back as a FAVORITE (scout R3)"
        );
```

  **(d)** Append three new tests to `mod tests`:

```rust
    /// Every rating CULL writes says what it is. Without this, "no marker"
    /// meant two different things — "not a favorite" and "written before the
    /// marker existed" — and classify_xmp had to guess between them.
    #[test]
    fn every_rating_cull_writes_carries_an_explicit_marker() {
        for (rating, want) in [("keep", "no"), ("reject", "no"), ("favorite", "star")] {
            let out = apply_rating_to_xmp(&fresh_xmp(), rating).unwrap();
            assert_eq!(
                cull_fav_value(&out).as_deref(),
                Some(want),
                "{rating} must record cull:fav=\"{want}\""
            );
            assert!(out.contains("xmlns:cull="), "{rating} declares the namespace");
        }
    }

    /// The legacy fallback keeps working for the sidecars it exists for: no
    /// `cull:fav` AT ALL, a positive pick, and a lone 1★ — an LrC sidecar
    /// round-tripping a flagged favorite, or a pre-marker CULL one.
    #[test]
    fn the_legacy_one_star_favorite_fallback_still_applies_without_a_marker() {
        let legacy = "rdf:about=\"\" xmpDM:pick=\"1\" xmpDM:good=\"true\" xmp:Rating=\"1\"";
        assert_eq!(cull_fav_value(legacy), None, "the fixture has no marker");
        assert_eq!(classify_xmp(legacy).as_deref(), Some("favorite"));
        // …and a marker of "no" overrides it, which is the whole fix.
        let marked = format!("{legacy} cull:fav=\"no\"");
        assert_eq!(classify_xmp(&marked).as_deref(), Some("keep"));
    }

    /// A sidecar CULL only ANNOTATED is never deleted on unrate. Writing the
    /// new marker declares `xmlns:cull`, which `authored_by_cull` accepts —
    /// so the delete gate had to stop asking that question and start asking
    /// whether CULL CREATED the file.
    #[test]
    fn unrate_never_deletes_a_sidecar_cull_did_not_create() {
        let work = std::env::temp_dir().join(format!("cull-xmp-3p-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&work);
        std::fs::create_dir_all(&work).unwrap();
        let cr3 = work.join("third.cr3");
        std::fs::write(&cr3, b"cr3").unwrap();
        let xmp = cr3.with_extension("xmp");
        // A minimal third-party sidecar: no CULL tool stamp, and nothing in
        // xmp_has_user_content's marker list to save it.
        std::fs::write(
            &xmp,
            "<rdf:Description rdf:about=\"\"\n    xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\"\n   \
             xmp:CreatorTool=\"SomeOtherTool\">\n  </rdf:Description>",
        )
        .unwrap();
        let p = cr3.to_string_lossy().to_string();

        assert_eq!(write_xmp_rating_sync(&p, "keep"), Ok(()));
        let after_keep = std::fs::read_to_string(&xmp).unwrap();
        assert!(after_keep.contains("xmlns:cull="), "the marker declared the ns");
        assert!(!created_by_cull(&after_keep), "CULL did not create this file");
        assert!(authored_by_cull(&after_keep), "…but it did annotate it");

        assert_eq!(clear_xmp_rating_sync(&p), Ok(()));
        assert!(xmp.exists(), "a third-party sidecar must survive an unrate");
        let after_clear = std::fs::read_to_string(&xmp).unwrap();
        assert!(after_clear.contains("SomeOtherTool"), "their data is intact");
        assert_eq!(classify_xmp(&after_clear), None, "CULL's fields are gone");

        let _ = std::fs::remove_dir_all(&work);
    }
```

  Expected reds, all four, before any production edit:
  - `cull_favorite_star_removable_on_demote` — `assertion failed: keep.contains("cull:fav=\"no\"")`
  - `favorite_never_clobbers_a_user_star` — at n == 1: `assertion \`left == right\` failed: a demoted favorite on a user 1★ is a keep, not a favorite / left: Some("favorite") / right: Some("keep")`
  - `genuine_user_one_star_survives_all_paths` — same shape, `left: Some("favorite")`
  - `every_rating_cull_writes_carries_an_explicit_marker` — `left: None, right: Some("no")` for `keep`
  - `the_legacy_one_star_favorite_fallback_still_applies_without_a_marker` — the second half (`Some("keep")`) fails, `left: Some("favorite")`
  - `unrate_never_deletes_a_sidecar_cull_did_not_create` — a COMPILE error first (`cannot find function \`created_by_cull\``). That is the correct first red for a function that does not exist; quote it.

  **Paste every failure line into the task report.** If `favorite_never_clobbers_a_user_star` passes at n == 1 without the new assertion, you added the loop value but not the assertion — go back.

- [ ] **Step 2: the marker on every rating.** In `apply_rating_to_xmp` (`:268-300`), replace the whole `} else if … } else { … }` tail (`:293-298`) with:

```rust
    } else {
        // Every rating CULL writes carries an EXPLICIT marker, so a sidecar
        // with no `cull:fav` at all is the only thing classify_xmp's legacy
        // "pick + lone 1★ = favorite" fallback may still claim. Read the old
        // marker BEFORE overwriting it: cull_owned_fav_star is what decides
        // whether the visible 1★ is CULL's to remove.
        if cull_owned_fav_star(&out) {
            out = remove_fav_star(&out); // CULL's own 1★ only; never a user star
        }
        out = ensure_cull_ns(&out);
        out = set_desc_attr(&out, "cull:fav", "no");
    }
```

- [ ] **Step 3: the classify fix.** In `classify_xmp` (`:551-560`), replace the comment + `let fav = …` line with:

```rust
            // "star"/"flag" are the two favorite spellings; "no" is CULL
            // saying explicitly "this is a keep or a reject". The legacy
            // "pick + lone 1★ = favorite" fallback applies ONLY to a sidecar
            // with no marker at all — an LrC-authored one round-tripping a
            // flagged 1★, or a CULL one written before the marker existed.
            // Before this, a KEEP on a frame carrying a genuine user 1★ read
            // back as a FAVORITE after a reload (audit scout R3).
            let fav = match cull_fav_value(content).as_deref() {
                Some("star") | Some("flag") => true,
                Some(_) => false,
                None => star == Some(1),
            };
```

- [ ] **Step 4: the delete gate.** Add, immediately before `authored_by_cull` (`:362`):

```rust
/// True when CULL CREATED this sidecar, as opposed to merely annotating one
/// that was already on disk. Only the tool stamps [`fresh_xmp`] writes count.
///
/// Split out of [`authored_by_cull`] when every rating started carrying a
/// `cull:fav` marker: writing that marker calls [`ensure_cull_ns`], so even a
/// plain keep now adds `xmlns:cull` to a third-party sidecar — and the unrate
/// delete gate, which used `authored_by_cull`, would then have REMOVED a file
/// CULL did not write. (Favoriting has always declared the namespace, so the
/// hole predates this change; it just got wider.) "CULL touched this" is the
/// right question for classification and for star ownership; "CULL made this"
/// is the only one that may authorise a delete.
fn created_by_cull(xmp: &str) -> bool {
    // Two marker generations: pre-rebrand sidecars say "Cull 1.0", current
    // ones say "CULL" (the contains check is case-sensitive).
    xmp.contains("CreatorTool=\"Cull")
        || xmp.contains("x:xmptk=\"Cull")
        || xmp.contains("CreatorTool=\"CULL")
        || xmp.contains("x:xmptk=\"CULL")
}
```

  Replace `authored_by_cull`'s body (`:366-371`) with:

```rust
    created_by_cull(xmp) || xmp.contains("xmlns:cull=")
```

  And in `clear_xmp_rating_sync`, change `:176` from
  `    let authored = authored_by_cull(&existing);`
  to:

```rust
    // created_by_cull, NOT authored_by_cull: a bare `xmlns:cull` declaration
    // means CULL wrote an attribute into someone else's file, which is never
    // a licence to delete it.
    let authored = created_by_cull(&existing);
```

- [ ] **Step 5: run the whole suite and confirm the six reds are green and nothing else moved.** From `src-tauri/`: `cargo fmt`, then `cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test`. Expected: **169 tests** (166 + 3 new). Confirm by name that these pre-existing tests still pass unchanged — they are this task's regression net, and each one covers a path the marker now writes into: `fresh_states_round_trip`, `flag_encoding_matches_lrc`, `favorite_demote_and_user_star_preservation`, `preserves_lrc_content_on_rerate`, `unrate_strips_to_deletable`, `rating_application_is_idempotent`, `command_wrappers_round_trip_on_disk`, `cull_favorite_stamp_is_not_an_lrc_rating`, `write_refuses_when_cr3_is_missing`, `clear_refuses_when_cr3_is_missing_and_leaves_sidecar`.
  **Watch each new test red under a named mutation, by hand, one at a time:**
  - `every_rating_cull_writes_carries_an_explicit_marker` / `the_legacy_…_fallback…` / the two 1★ tests → change Step 2's `set_desc_attr(&out, "cull:fav", "no")` to `remove_desc_attr(&out, "cull:fav")`.
  - `unrate_never_deletes_a_sidecar_cull_did_not_create` → change Step 4's gate line back to `authored_by_cull(&existing)`; it must fail on `assertion failed: xmp.exists()`.
  Edit both back by hand. Report each red's exact line.
- [ ] **Step 6:** commit:
  `git commit -m "fix(xmp): mark every rating explicitly, so a keep on a user 1-star is not a favorite" -- src-tauri/src/xmp.rs`

### Task 3: [RUST] Stars and labels on disk — two write commands, one guarded body, and a label on the read

**Files:** Modify `src-tauri/src/xmp.rs`, `src-tauri/src/scan.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/analyze.rs`. **Follows Task 2** (same `xmp.rs`).

**Interfaces — Produces:**

```rust
// src-tauri/src/xmp.rs
#[tauri::command] pub(crate) async fn write_xmp_star(path: String, star: Option<u8>) -> Result<(), String>;
#[tauri::command] pub(crate) async fn write_xmp_label(path: String, label: Option<String>) -> Result<(), String>;
pub(crate) struct SidecarRead { pub rating: Option<String>, pub star: Option<u8>, pub label: Option<String> }
pub(crate) fn read_ratings(cr3_path: &str) -> Result<SidecarRead, String>;   // was -> (Option<String>, Option<u8>)

// src-tauri/src/scan.rs  (serde camelCase on the wire)
// AnalyzeResult gains:  labels: Vec<Option<String>>   ->  TS `AnalyzeResult.labels: (string | null)[]`
```

The frontend calls them as
`invoke("write_xmp_star", { path, star })` with `star: number | null`, and
`invoke("write_xmp_label", { path, label })` with `label: "red" | "yellow" | "green" | "blue" | "purple" | null`.

**Consumes:** Task 1's decision that the wire label key is the lowercase word; Task 2's three-valued `cull:fav`.

**Ruling (two commands, not one, and `Option` carries the clear).** One keypress changes one field, so one command per field, each taking `Option` so "set" and "clear" are the same round trip. This mirrors the existing `write_xmp_rating` / `clear_xmp_rating` pair without doubling it into four.

**Ruling (one shared body, so `require_source` cannot be forgotten).** The audit's one CRITICAL was an orphaned sidecar written beside a photo that had moved; the fix was `require_source` (`xmp.rs:85-94`), and the scout's R4 is explicit that the guard is **per command**. Rather than copy it into two new commands and hope the third one remembers, this task lifts `write_xmp_rating_sync`'s body into `write_sidecar_sync(path, what, edit)` — require_source, read-or-fresh, apply, unchanged-bytes skip, atomic write — and makes all three writers call it. `write_xmp_rating_sync` stays as a named wrapper because two existing tests call it directly.

**Ruling (the label strings are Lightroom's English defaults, and the mapping lives in Rust).** `xmp:Label` is a localised free-text string ([WEB], scout §2). The wire carries the lowercase key; Rust owns the single `LABEL_STRINGS` table that turns it into `Red` / `Yellow` / `Green` / `Blue` / `Purple` and back. Reading matches those five **case-insensitively**; any other non-empty value comes back as `"custom"` and is never rewritten or cleared. `xmp:LabelColor` is NOT written (spec §2 — unverifiable here). Cost if wrong: a non-English Lightroom shows CULL's labels as white swatches; the fix is five strings, in one table.

**Ruling (`ensure_xmp_ns`, new).** `set_desc_attr` will happily write `xmp:Label="Red"` into a sidecar that never declared `xmlns:xmp`, producing XML with an undeclared prefix that a strict reader rejects — and the star writer has the same exposure via `set_rating`. There is an `ensure_xmpdm_ns` and an `ensure_cull_ns` but no `ensure_xmp_ns`; today nothing needed one because `xmp:Rating` was only ever written by the favourite path onto sidecars that had it. A new writer must not inherit that luck. Cost: four lines and one test.

**Ruling (the star / favourite interplay, per spec §2).** The sidecar itself says whether the frame is a favourite: `cull:fav` is `"star"` or `"flag"`. So `apply_star_to_xmp` needs no rating argument.
- set 1–5 on a favourite → write the star, flip the marker to `"flag"` (the favourite now rides the user's star);
- clear on a favourite → the courtesy star comes back: `xmp:Rating="1"` + `"star"`;
- set 1–5 on anything else → write the star, touch no marker;
- clear on anything else → remove `xmp:Rating` entirely (Lightroom's `0` = "remove rating"; the user asked).

**Ruling (a star or label write never deletes a sidecar).** Only `clear_xmp_rating` deletes, and only under `created_by_cull && !xmp_has_user_content`. Clearing the last star on an unrated frame therefore leaves a bare CULL sidecar behind until the frame is unrated, which the existing gate then cleans up. Accepted: the alternative is a second delete path, and a delete path is the most dangerous code in this file.

- [ ] **Step 1: the failing tests first.** Append to `xmp.rs`'s `mod tests`, run `cargo test --lib xmp::`, and record every failure. Everything here fails to COMPILE first (the functions do not exist) — quote the first `E0425`/`E0422` line, then add the production code and watch the assertions.

```rust
    // ── Stars ────────────────────────────────────────────────────────────

    /// A star round-trips in BOTH XMP forms — LrC writes the attribute form,
    /// older packets the element form, and set_rating handles both.
    #[test]
    fn a_star_round_trips_in_both_xmp_forms() {
        for n in 1..=5u8 {
            let attr = apply_star_to_xmp(&fresh_xmp(), Some(n)).unwrap();
            assert_eq!(parse_xmp_rating(&attr), Some(i32::from(n)), "attribute form {n}");
            assert_eq!(parse_lrc_rating(&attr), Some(n), "reads back as a user star");
        }
        let element = "<rdf:Description rdf:about=\"\" xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\">\
                       <xmp:Rating>2</xmp:Rating></rdf:Description>";
        let out = apply_star_to_xmp(element, Some(4)).unwrap();
        assert!(out.contains("<xmp:Rating>4</xmp:Rating>"), "element form replaced in place");
        assert!(!out.contains("xmp:Rating=\""), "no second attribute copy was added");
    }

    /// Clearing removes the property outright — Lightroom's `0` means
    /// "remove rating", not "rating zero".
    #[test]
    fn clearing_a_star_removes_the_property() {
        let three = apply_star_to_xmp(&fresh_xmp(), Some(3)).unwrap();
        let cleared = apply_star_to_xmp(&three, None).unwrap();
        assert_eq!(parse_xmp_rating(&cleared), None);
        assert!(!cleared.contains("xmp:Rating"), "no empty attribute left behind");
    }

    /// Out of range is a refusal, not a clamp — the one strict boundary this
    /// module already applies to an unknown rating string.
    #[test]
    fn a_star_outside_one_to_five_is_refused() {
        assert!(apply_star_to_xmp(&fresh_xmp(), Some(0)).is_err());
        assert!(apply_star_to_xmp(&fresh_xmp(), Some(6)).is_err());
    }

    /// The favourite's courtesy star, both directions (spec §2). Setting a
    /// real star on a courtesy-star favourite flips the marker to "flag";
    /// clearing it brings the courtesy 1★ back. The frame stays a favourite
    /// throughout — a star is orthogonal to the verdict.
    #[test]
    fn a_star_on_a_favorite_flips_the_marker_and_clearing_restores_the_courtesy_star() {
        let fav = apply_rating_to_xmp(&fresh_xmp(), "favorite").unwrap();
        assert_eq!(cull_fav_value(&fav).as_deref(), Some("star"));

        let starred = apply_star_to_xmp(&fav, Some(4)).unwrap();
        assert_eq!(parse_xmp_rating(&starred), Some(4));
        assert_eq!(cull_fav_value(&starred).as_deref(), Some("flag"), "the star is the user's now");
        assert_eq!(classify_xmp(&starred).as_deref(), Some("favorite"), "still a favorite");
        assert_eq!(parse_lrc_rating(&starred), Some(4), "and the star is visible");

        let cleared = apply_star_to_xmp(&starred, None).unwrap();
        assert_eq!(parse_xmp_rating(&cleared), Some(1), "courtesy star restored");
        assert_eq!(cull_fav_value(&cleared).as_deref(), Some("star"), "CULL owns it again");
        assert_eq!(classify_xmp(&cleared).as_deref(), Some("favorite"));
        assert_eq!(parse_lrc_rating(&cleared), None, "a courtesy star is not a user star");
    }

    /// Favouriting a frame that ALREADY carries a CULL-set star must not
    /// overwrite it — the same promise `favorite_never_clobbers_a_user_star`
    /// makes about a Lightroom star, now that CULL is an author too.
    #[test]
    fn favoriting_a_cull_starred_frame_keeps_the_star() {
        let starred = apply_star_to_xmp(&fresh_xmp(), Some(3)).unwrap();
        let fav = apply_rating_to_xmp(&starred, "favorite").unwrap();
        assert_eq!(parse_xmp_rating(&fav), Some(3), "3★ survives the favorite");
        assert_eq!(cull_fav_value(&fav).as_deref(), Some("flag"));
        let keep = apply_rating_to_xmp(&fav, "keep").unwrap();
        assert_eq!(parse_xmp_rating(&keep), Some(3), "3★ survives the demote");
        assert_eq!(classify_xmp(&keep).as_deref(), Some("keep"));
    }

    // ── Labels ───────────────────────────────────────────────────────────

    /// Every label round-trips through both XMP forms as Lightroom's default
    /// English string, and reads back as CULL's lowercase key.
    #[test]
    fn a_label_round_trips_in_both_xmp_forms() {
        for (key, text) in LABEL_STRINGS {
            let out = apply_label_to_xmp(&fresh_xmp(), Some(key)).unwrap();
            assert!(out.contains(&format!("xmp:Label=\"{text}\"")), "{key} writes {text}");
            assert_eq!(parse_label(&out).as_deref(), Some(key), "{key} reads back");
        }
        let element = "<rdf:Description rdf:about=\"\" xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\">\
                       <xmp:Label>Blue</xmp:Label></rdf:Description>";
        assert_eq!(parse_label(element).as_deref(), Some("blue"), "element form reads");
        let out = apply_label_to_xmp(element, Some("green")).unwrap();
        assert!(out.contains("<xmp:Label>Green</xmp:Label>"), "element form replaced in place");
        assert!(!out.contains("xmp:Label=\""), "no second attribute copy was added");
    }

    /// Case-insensitive on read (LrC has shipped both "Red" and "red"), and
    /// ANY other non-empty string is the user's own label: reported as
    /// "custom", never rewritten by a read.
    #[test]
    fn an_unknown_label_string_is_custom_and_is_preserved() {
        assert_eq!(parse_label("xmp:Label=\"RED\"").as_deref(), Some("red"));
        assert_eq!(parse_label("xmp:Label=\"Urgent\"").as_deref(), Some("custom"));
        assert_eq!(parse_label("xmp:Label=\"Rot\"").as_deref(), Some("custom"));
        assert_eq!(parse_label("xmp:Label=\"\""), None, "an empty label is no label");
        assert_eq!(parse_label("no label here"), None);
        // A rating write never touches someone else's label.
        let custom = "<rdf:Description rdf:about=\"\" xmp:Label=\"Urgent\"></rdf:Description>";
        let rated = apply_rating_to_xmp(custom, "reject").unwrap();
        assert_eq!(parse_label(&rated).as_deref(), Some("custom"), "still theirs");
        assert!(rated.contains("xmp:Label=\"Urgent\""), "byte-for-byte theirs");
    }

    /// Clearing removes the property; an unknown label key is refused.
    #[test]
    fn clearing_a_label_removes_the_property_and_an_unknown_key_is_refused() {
        let red = apply_label_to_xmp(&fresh_xmp(), Some("red")).unwrap();
        let cleared = apply_label_to_xmp(&red, None).unwrap();
        assert_eq!(parse_label(&cleared), None);
        assert!(!cleared.contains("xmp:Label"), "no empty attribute left behind");
        assert!(apply_label_to_xmp(&fresh_xmp(), Some("teal")).is_err());
    }

    /// A third-party sidecar that never declared the xmp namespace must get
    /// the declaration before a prefixed attribute is written into it —
    /// otherwise CULL emits XML a strict reader rejects.
    #[test]
    fn writing_into_a_sidecar_without_the_xmp_namespace_declares_it() {
        let bare = "<rdf:Description rdf:about=\"\"\n   dc:title=\"x\">\n  </rdf:Description>";
        assert!(!bare.contains("xmlns:xmp="));
        let labelled = apply_label_to_xmp(bare, Some("blue")).unwrap();
        assert!(labelled.contains("xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\""));
        let starred = apply_star_to_xmp(bare, Some(2)).unwrap();
        assert!(starred.contains("xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\""));
    }

    // ── The delete gate, with CULL-set user content ──────────────────────

    /// A star or a label CULL set IS user content: unrating such a frame must
    /// keep the sidecar, because the sidecar still holds something the user
    /// asked for. This is the spec's "no ownership marker is needed" claim,
    /// pinned rather than assumed.
    #[test]
    fn unrate_keeps_a_sidecar_that_still_holds_a_cull_set_star_or_label() {
        for apply in [
            &(|x: &str| apply_star_to_xmp(x, Some(3)).unwrap()) as &dyn Fn(&str) -> String,
            &(|x: &str| apply_label_to_xmp(x, Some("red")).unwrap()) as &dyn Fn(&str) -> String,
        ] {
            let marked = apply(&apply_rating_to_xmp(&fresh_xmp(), "keep").unwrap());
            let stripped = strip_cull_fields(&marked);
            assert_eq!(classify_xmp(&stripped), None, "the verdict is gone");
            assert!(
                xmp_has_user_content(&stripped),
                "a CULL-set star/label keeps the sidecar alive"
            );
        }
        // …and once BOTH are cleared, the file is litter again.
        let keep = apply_rating_to_xmp(&fresh_xmp(), "keep").unwrap();
        let bare = apply_label_to_xmp(&apply_star_to_xmp(&keep, None).unwrap(), None).unwrap();
        assert!(!xmp_has_user_content(&strip_cull_fields(&bare)), "nothing left to keep");
    }

    // ── The commands ─────────────────────────────────────────────────────

    /// Every write command refuses when the CR3 is not at its path — the
    /// guard behind the audit's one CRITICAL (an orphaned sidecar left in the
    /// folder a moved photo came from). Same shape as
    /// `write_refuses_when_cr3_is_missing`, extended to the two new writers.
    #[test]
    fn star_and_label_writes_refuse_when_the_cr3_is_missing() {
        let work = std::env::temp_dir().join(format!("cull-xmp-nosrc2-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&work);
        std::fs::create_dir_all(&work).unwrap();
        let cr3 = work.join("moved.cr3"); // never created
        let p = cr3.to_string_lossy().to_string();

        let star_err = write_xmp_star_sync(&p, Some(3)).unwrap_err();
        assert!(star_err.starts_with(MISSING_SOURCE), "{star_err}");
        let label_err = write_xmp_label_sync(&p, Some("red")).unwrap_err();
        assert!(label_err.starts_with(MISSING_SOURCE), "{label_err}");
        // Clearing is a write too, and must refuse identically.
        assert!(write_xmp_star_sync(&p, None).unwrap_err().starts_with(MISSING_SOURCE));
        assert!(write_xmp_label_sync(&p, None).unwrap_err().starts_with(MISSING_SOURCE));
        assert!(!cr3.with_extension("xmp").exists(), "no orphan sidecar written");

        let _ = std::fs::remove_dir_all(&work);
    }

    /// End to end on disk: set a star and a label, read both back through the
    /// one sidecar read the analyze pass uses, then clear them.
    #[test]
    fn star_and_label_commands_round_trip_on_disk() {
        let work = std::env::temp_dir().join(format!("cull-xmp-sl-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&work);
        std::fs::create_dir_all(&work).unwrap();
        let cr3 = work.join("s.cr3");
        std::fs::write(&cr3, b"cr3").unwrap();
        let p = cr3.to_string_lossy().to_string();

        assert_eq!(
            tauri::async_runtime::block_on(write_xmp_star(p.clone(), Some(4))),
            Ok(())
        );
        assert_eq!(
            tauri::async_runtime::block_on(write_xmp_label(p.clone(), Some("green".into()))),
            Ok(())
        );
        let read = read_ratings(&p).unwrap();
        assert_eq!(read.rating, None, "a star is not a verdict — the frame is unrated");
        assert_eq!(read.star, Some(4));
        assert_eq!(read.label.as_deref(), Some("green"));

        assert_eq!(tauri::async_runtime::block_on(write_xmp_star(p.clone(), None)), Ok(()));
        assert_eq!(tauri::async_runtime::block_on(write_xmp_label(p.clone(), None)), Ok(()));
        let cleared = read_ratings(&p).unwrap();
        assert_eq!(cleared.star, None);
        assert_eq!(cleared.label, None);

        let _ = std::fs::remove_dir_all(&work);
    }

    /// Re-writing the value already on disk takes the no-write skip path —
    /// what keeps a re-pressed key off the NAS.
    #[test]
    fn re_setting_the_same_star_or_label_changes_no_bytes() {
        let once = apply_star_to_xmp(&fresh_xmp(), Some(3)).unwrap();
        assert_eq!(apply_star_to_xmp(&once, Some(3)).unwrap(), once);
        let lbl = apply_label_to_xmp(&fresh_xmp(), Some("blue")).unwrap();
        assert_eq!(apply_label_to_xmp(&lbl, Some("blue")).unwrap(), lbl);
    }
```

- [ ] **Step 2: the namespace constant and `ensure_xmp_ns`.** In `xmp.rs`, after the `CULL_NS` const (`:39`), add:

```rust
/// The core xmp namespace URI — `xmp:Rating` and `xmp:Label` live here.
const XMP_NS: &str = "http://ns.adobe.com/xap/1.0/";
```

  And beside `ensure_cull_ns` (after `:347`):

```rust
/// Ensure the core xmp namespace is declared before an `xmp:Rating` or
/// `xmp:Label` attribute is written into a sidecar that never declared it.
/// Every fresh CULL sidecar and every LrC one already do; a minimal
/// third-party one may not, and prefixed XML with no declaration is XML a
/// strict reader rejects.
fn ensure_xmp_ns(xmp: &str) -> String {
    if xmp.contains("xmlns:xmp=") {
        return xmp.to_string();
    }
    insert_after_about(xmp, &format!("\n    xmlns:xmp=\"{XMP_NS}\""))
}
```

- [ ] **Step 3: generalise the two-form property helpers.** Replace `remove_rating_from_xmp` (`:456-498`) — keep the whole body, change the signature and the three literals — with:

```rust
/// Strip a property from a sidecar (element form AND Lightroom's attribute
/// form), leaving every other field intact. The element form swallows its
/// leading indentation + trailing newline so we don't leave a dangling blank
/// line. Written once and used for `xmp:Rating` and `xmp:Label`: LrC writes
/// either form depending on version and packet, so a writer that handled only
/// one would silently leave the other behind.
fn remove_property(xmp: &str, name: &str) -> String {
    let open = format!("<{name}>");
    let close = format!("</{name}>");
    let attr = format!("{name}=\"");
    let mut out = xmp.to_string();

    if let Some(start_tag) = out.find(&open) {
        if let Some(rel) = out[start_tag..].find(&close) {
            let mut start = start_tag;
            let mut end = start_tag + rel + close.len();
            let b = out.as_bytes();
            // eat leading spaces/tabs on this line
            while start > 0 && (b[start - 1] == b' ' || b[start - 1] == b'\t') {
                start -= 1;
            }
            // eat the trailing newline (and a stray CR before it)
            if end < b.len() && b[end] == b'\r' {
                end += 1;
            }
            if end < b.len() && b[end] == b'\n' {
                end += 1;
            }
            out.replace_range(start..end, "");
        }
    }

    if let Some(open_at) = out.find(&attr) {
        let inner = open_at + attr.len();
        if let Some(rel) = out[inner..].find('"') {
            let mut start = open_at;
            let end = inner + rel + 1;
            // eat one leading space so we don't leave a double space between attrs
            let b = out.as_bytes();
            if start > 0 && b[start - 1] == b' ' {
                start -= 1;
            }
            out.replace_range(start..end, "");
        }
    }

    out
}

/// Read a property's raw string value — element form OR attribute form.
fn read_property(xmp: &str, name: &str) -> Option<String> {
    let open = format!("<{name}>");
    let close = format!("</{name}>");
    if let Some(s) = xmp.find(&open) {
        let inner = s + open.len();
        if let Some(e) = xmp[inner..].find(&close) {
            return Some(xmp[inner..inner + e].to_string());
        }
    }
    let needle = format!("{name}=\"");
    let s = xmp.find(&needle)? + needle.len();
    let rel = xmp[s..].find('"')?;
    Some(xmp[s..s + rel].to_string())
}
```

  Update `remove_fav_star`'s single call site (`:450`) from `remove_rating_from_xmp(xmp)` to `remove_property(xmp, "xmp:Rating")`.
  Its regression net is already in place: `favorite_demote_and_user_star_preservation`, `cull_favorite_star_removable_on_demote` and `unrate_strips_to_deletable` all run through `remove_fav_star`.

- [ ] **Step 4: the star and label cores.** Add after `set_rating` (`:444`):

```rust
/// Lightroom's DEFAULT (English) colour-label set, in keyboard order —
/// `6` `7` `8` `9` `Shift+6`. Left is CULL's wire key, right is the string
/// written into `xmp:Label`.
///
/// `xmp:Label` is a LOCALISED free-text string, not an enum: a German
/// Lightroom writes "Rot", and a user with a custom label set writes whatever
/// they named it. These five are right for an English LrC on the default set
/// and merely unnamed (a white swatch) anywhere else. `xmp:LabelColor` — the
/// LrC 15.0+ companion field that carries the colour independently of the
/// name — is deliberately NOT written: unverifiable from here.
const LABEL_STRINGS: [(&str, &str); 5] = [
    ("red", "Red"),
    ("yellow", "Yellow"),
    ("green", "Green"),
    ("blue", "Blue"),
    ("purple", "Purple"),
];

/// Set `xmp:Label` (replacing an existing ELEMENT form in place if present,
/// else as an attribute matching LrC's style) — the same two-form handling
/// [`set_rating`] does.
fn set_label(xmp: &str, value: &str) -> String {
    if let Some(start) = xmp.find("<xmp:Label>") {
        let inner = start + "<xmp:Label>".len();
        if let Some(rel) = xmp[inner..].find("</xmp:Label>") {
            let end = inner + rel;
            return format!("{}{}{}", &xmp[..inner], value, &xmp[end..]);
        }
    }
    set_desc_attr(xmp, "xmp:Label", value)
}

/// Apply a star (1–5) or a clear to a sidecar string, preserving everything
/// else. The sidecar says whether the frame is a favorite (`cull:fav` is
/// "star" or "flag"), so this needs no rating argument:
///   - 1–5 on a favorite      → write the star, flip the marker to "flag"
///                              (the favorite now rides the user's star);
///   - clear on a favorite    → the courtesy 1★ comes back, marker "star";
///   - 1–5 otherwise          → write the star, touch no marker;
///   - clear otherwise        → remove `xmp:Rating` entirely. Lightroom's own
///                              `0` means "remove rating", and the user asked.
fn apply_star_to_xmp(xmp: &str, star: Option<u8>) -> Result<String, String> {
    if let Some(n) = star {
        if !(1..=5).contains(&n) {
            return Err(format!("star out of range: {n}"));
        }
    }
    let is_fav = matches!(cull_fav_value(xmp).as_deref(), Some("star") | Some("flag"));
    Ok(match star {
        Some(n) => {
            let out = set_rating(&ensure_xmp_ns(xmp), i32::from(n));
            if is_fav {
                set_desc_attr(&out, "cull:fav", "flag")
            } else {
                out
            }
        }
        None if is_fav => {
            let out = set_rating(&ensure_xmp_ns(xmp), 1);
            set_desc_attr(&out, "cull:fav", "star")
        }
        None => remove_property(xmp, "xmp:Rating"),
    })
}

/// Apply a colour label, or clear it. An unknown key is refused rather than
/// written — the same strict boundary `apply_rating_to_xmp` applies to an
/// unknown rating string. A label CULL does not recognise (`"custom"`) is
/// never passed here: it is the user's, and only a real label key replaces it.
fn apply_label_to_xmp(xmp: &str, label: Option<&str>) -> Result<String, String> {
    match label {
        Some(key) => {
            let Some((_, text)) = LABEL_STRINGS.iter().find(|(k, _)| *k == key) else {
                return Err(format!("unknown label: {key}"));
            };
            Ok(set_label(&ensure_xmp_ns(xmp), text))
        }
        None => Ok(remove_property(xmp, "xmp:Label")),
    }
}

/// The colour label a sidecar carries, as CULL's lowercase wire key — or
/// `"custom"` for any other non-empty `xmp:Label` string. Matching the five
/// English defaults case-insensitively is what CULL can honestly claim to
/// understand; everything else is the user's, is shown as "custom", and is
/// never rewritten or cleared by a key that did not set it.
fn parse_label(content: &str) -> Option<String> {
    let raw = read_property(content, "xmp:Label")?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let key = LABEL_STRINGS
        .iter()
        .find(|(_, text)| text.eq_ignore_ascii_case(trimmed))
        .map(|(key, _)| *key)
        .unwrap_or("custom");
    Some(key.to_string())
}
```

- [ ] **Step 5: one guarded write body, three writers.** Replace `write_xmp_rating_sync` (`:107-133`) with the shared body plus its wrapper, and add the two new commands beside `clear_xmp_rating` (after `:159`):

```rust
/// The shared body of EVERY sidecar write. In order: refuse when the CR3 is
/// not at its path, read the existing sidecar or start a fresh one, apply
/// `edit`, skip the temp+fsync+rename when the bytes are unchanged, write
/// atomically.
///
/// Every write command goes through here so [`require_source`] — the guard
/// behind the 2026-09-13 CRITICAL, an orphaned `.xmp` written into the folder
/// a moved photo came from — cannot be forgotten by the next one.
///
/// The unchanged-bytes skip is what keeps a re-pressed key off the NAS. A
/// brand-new sidecar always differs from `fresh_xmp()` when something was
/// actually set, so that path still writes; setting nothing on a frame with
/// no sidecar (e.g. clearing a star that was never there) correctly writes
/// no file at all.
fn write_sidecar_sync(
    path: &str,
    what: &str,
    edit: &dyn Fn(&str) -> Result<String, String>,
) -> Result<(), String> {
    let cr3 = Path::new(path);
    require_source(cr3)?;
    let xmp_path = cr3.with_extension("xmp");

    let base = match std::fs::read_to_string(&xmp_path) {
        Ok(existing) => existing,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => fresh_xmp(),
        Err(e) => return Err(format!("read existing xmp: {e}")),
    };

    let contents = edit(&base)?;
    if contents == base {
        dlog!(
            "[cull] write_sidecar({}): {what} (unchanged, skipped)",
            xmp_path.display()
        );
        return Ok(());
    }
    atomic_write_xmp(&xmp_path, &contents)?;
    dlog!("[cull] write_sidecar({}): {what}", xmp_path.display());
    Ok(())
}

fn write_xmp_rating_sync(path: &str, rating: &str) -> Result<(), String> {
    write_sidecar_sync(path, rating, &|base| apply_rating_to_xmp(base, rating))
}

fn write_xmp_star_sync(path: &str, star: Option<u8>) -> Result<(), String> {
    let what = star.map_or_else(|| "star cleared".to_string(), |n| format!("{n} star"));
    write_sidecar_sync(path, &what, &|base| apply_star_to_xmp(base, star))
}

fn write_xmp_label_sync(path: &str, label: Option<&str>) -> Result<(), String> {
    let what = label.unwrap_or("label cleared");
    write_sidecar_sync(path, what, &|base| apply_label_to_xmp(base, label))
}
```

```rust
/// Set or clear the star rating (`xmp:Rating` 1–5) on the CR3's sidecar.
/// `None` clears it. Orthogonal to the pick/good verdict flags: a starred
/// frame with no verdict is still unrated.
#[tauri::command]
pub(crate) async fn write_xmp_star(path: String, star: Option<u8>) -> Result<(), String> {
    // Spawn-blocking for the same reason as write_xmp_rating: sync fs I/O
    // (including an fsync, possibly over SMB) off the async runtime.
    tauri::async_runtime::spawn_blocking(move || write_xmp_star_sync(&path, star))
        .await
        .map_err(|e| format!("write_xmp_star task failed: {e}"))?
}

/// Set or clear the colour label (`xmp:Label`) on the CR3's sidecar. `label`
/// is CULL's lowercase key ("red"…"purple"); `None` clears it.
#[tauri::command]
pub(crate) async fn write_xmp_label(path: String, label: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || write_xmp_label_sync(&path, label.as_deref()))
        .await
        .map_err(|e| format!("write_xmp_label task failed: {e}"))?
}
```

- [ ] **Step 6: the read carries the label.** Replace `read_ratings` (`:223-230`) and add its struct above it:

```rust
/// Everything one sidecar read yields. A struct rather than a tuple because
/// there are now three values and their types no longer tell them apart.
pub(crate) struct SidecarRead {
    /// CULL's verdict — "keep" / "reject" / "favorite" — or None (unrated).
    pub rating: Option<String>,
    /// The user's 1–5★ (`xmp:Rating`), with CULL's own courtesy favorite
    /// stamp filtered out. This is the star the UI shows and CULL writes.
    pub star: Option<u8>,
    /// The colour label as CULL's lowercase key, or "custom" for a string
    /// CULL does not recognise, or None.
    pub label: Option<String>,
}

pub(crate) fn read_ratings(cr3_path: &str) -> Result<SidecarRead, String> {
    let xmp = Path::new(cr3_path).with_extension("xmp");
    match std::fs::read_to_string(&xmp) {
        Ok(content) => Ok(SidecarRead {
            rating: classify_xmp(&content),
            star: parse_lrc_rating(&content),
            label: parse_label(&content),
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(SidecarRead {
            rating: None,
            star: None,
            label: None,
        }),
        Err(e) => Err(format!("{}: {e}", xmp.display())),
    }
}
```

  Extend the doc block above it (`:204-222`) with one sentence: *"The colour label rides the same bytes (`parse_label`), so the analyze pass still opens each sidecar exactly once."* Then fix the three existing call sites in the test module:
  - `:941` → `assert_eq!(read_ratings(&p).unwrap().rating.as_deref(), Some("keep"));`
  - `:966` → `let r = read_ratings(&absent.to_string_lossy()).unwrap();` followed by `assert!(r.rating.is_none() && r.star.is_none() && r.label.is_none());`
  - `:970` is unchanged (it reads `unwrap_err()`).

- [ ] **Step 7: `src-tauri/src/analyze.rs`.** One line, `:1176`. Replace

```rust
            let (user, _lrc) = crate::xmp::read_ratings(p).unwrap_or((None, None));
```

  with:

```rust
            let user = crate::xmp::read_ratings(p).ok().and_then(|r| r.rating);
```

- [ ] **Step 8: `src-tauri/src/scan.rs`.** Four edits.
  1. In `AnalyzeResult` (after the `lrc_ratings` field, `:33` of the quoted block):

```rust
    /// Per input index: the frame's colour label as CULL's lowercase key
    /// ("red"…"purple"), "custom" for an `xmp:Label` string CULL does not
    /// recognise, or null. Same sidecar pass as `ratings`, so it is free here.
    labels: Vec<Option<String>>,
```

  2. In `struct Restore`, after `lrc_ratings`:

```rust
    labels: Vec<Option<String>>,
```

  3. In `restore_ratings`: add `labels: vec![None; n],` to the `Restore` initialiser; change
     `type Read = (usize, Result<(Option<String>, Option<u8>), String>);` to
     `type Read = (usize, Result<crate::xmp::SidecarRead, String>);`
     and the fold's `Ok` arm to:

```rust
            Ok(read) => {
                out.ratings[i] = read.rating;
                out.lrc_ratings[i] = read.star;
                out.labels[i] = read.label;
            }
```

  4. Add `labels: vec![],` to the `n == 0` early-return `AnalyzeResult`, and `labels: restore.labels,` to the one at the end of `analyze_folder_sync`.
  The import at `:20` (`use crate::xmp::read_ratings;`) stays; `SidecarRead` is referenced by path so no second import is needed.

- [ ] **Step 9: `src-tauri/src/lib.rs`.** In the `invoke_handler` list, after `xmp::clear_xmp_rating,`:

```rust
            xmp::write_xmp_star,
            xmp::write_xmp_label,
```

- [ ] **Step 10: gate and watch the reds.** From `src-tauri/`: `cargo fmt`, then `cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test`. Expected **181 tests** (169 after Task 2 + 12 new). Then, one at a time, by hand:
  - `star_and_label_writes_refuse_when_the_cr3_is_missing` → delete the `require_source(cr3)?;` line from `write_sidecar_sync` and confirm all four assertions fail on the `starts_with(MISSING_SOURCE)` check. **This is the CRITICAL's guard; do not skip it.** Put the line back.
  - `a_star_on_a_favorite_flips_the_marker_…` → change `set_desc_attr(&out, "cull:fav", "flag")` to `out` and confirm `left: Some("star"), right: Some("flag")`.
  - `an_unknown_label_string_is_custom_and_is_preserved` → change `.unwrap_or("custom")` to `.unwrap_or("red")` and confirm `left: Some("red"), right: Some("custom")`.
  - `unrate_keeps_a_sidecar_that_still_holds_a_cull_set_star_or_label` → change `apply_star_to_xmp`'s `Some(n)` arm to `remove_property(xmp, "xmp:Rating")` and confirm the star half fails on `a CULL-set star/label keeps the sidecar alive`.
  - `writing_into_a_sidecar_without_the_xmp_namespace_declares_it` → drop the `ensure_xmp_ns(...)` call from `apply_label_to_xmp`.
  Report each red's exact line, and edit every mutation back by hand.
- [ ] **Step 11:** the frontend gate is unaffected by this task, but run it anyway (`pnpm test`) and report the number. Then commit — one commit, four files, since `scan.rs`, `lib.rs` and `analyze.rs` do not compile without `xmp.rs`:
  `git commit -m "feat(xmp): write and read stars and colour labels, through one guarded write body" -- src-tauri/src/xmp.rs src-tauri/src/scan.rs src-tauri/src/lib.rs src-tauri/src/analyze.rs`

### Task 4: The keymap's two shapes, and the proof that off is today

**Files:** Modify `src/app/useCullKeymap.ts`, `src/app/useCullKeymap.test.tsx`. The ONLY task that touches either. **Follows Task 1.**

**Interfaces — Produces** (two new props on the hook's single props object; Task 11 supplies them from `useDecideCallbacks`):

```ts
  /** Set the star on the current frame, or on the whole grid selection.
   *  `null` clears it (the `0` key). No-op unless settings.starsAndLabels. */
  applyStar: (star: Star | null) => void;
  /** Set the colour label on the current frame, or on the whole grid
   *  selection — TOGGLING it off when that label is already the frame's, as
   *  Lightroom does. The keymap does not know the current label, so the
   *  toggle decision lives in the callback. */
  applyLabel: (label: Label) => void;
```

**Consumes:** `Star`, `Label` from `../types` (Task 1); `settings.starsAndLabels` (Task 1); the existing `TopFilter` and `cycleFilter` from `../utils/filterModes`.

**Ruling (the setting IS the prop — the harness's factory needs no new default).** `useCullKeymap` already receives `settings: Settings`, and `useCullKeymap.test.tsx`'s `props()` factory already hands it `DEFAULT_SETTINGS`, whose `starsAndLabels` is `false` (Task 1). So the OFF shape is what every one of the 112 existing assertions exercises, unchanged, with **no edit to any of them** — that is the structural off-proof the spec asks for. The only edit that file's existing content receives is two entries in the `props()` object literal.

**Ruling (the OFF shape is byte-for-byte today's dispatch).** `0` and `6`–`9` are completely unbound in every mode today (scout §3.2, verified: `handleSingleModeKey`'s switch has no such case, and `handleCompareKey` has no digit case at all). A `case "0":` whose first statement is `if (!settings.starsAndLabels) break;` is behaviourally identical to no case: no `preventDefault`, no call, fall out of the switch. Same for `6`–`9`. Cost if wrong: none — a bare digit does nothing in a WebView either way.

**Ruling (Shift+digit on `e.code`, and only for digits).** `case "1"` matches `e.key`, and Shift+1 reports `e.key === "!"` on a US layout and a layout-specific symbol elsewhere, so no case matches today. The ON shape therefore tests `e.code` (`Digit1`…`Digit6`) in a guard ABOVE the switch, and **returns only when it recognises a digit code** — so `Shift+F` still favourites, `Shift+Arrow` still grows the grid selection, and `Shift+Space` still reaches the zoom branch above. The codebase already keys four bindings off `e.code` for exactly this reason (`:196` Comma, `:205` KeyO, `:769` Digit0/Numpad0, `:790` Space).

**Ruling (one filter dispatch, two callers).** The five `case "1"`…`case "5"` bodies become calls to one `selectFilterTop(top)` closure holding the same three statements in the same order (`setFilter` → `pulse` for keeps/suggested → `startAnalysis` for suggested when `settings.smartCulling`). The per-case `if (e.repeat) break;` stays where it is: the harness pins each digit's repeat guard separately, on purpose (`useCullKeymap.test.tsx:444-447`). Without this extraction the ON shape would need a second copy of that dispatch, and the two would drift.

**Ruling (not bound in compare).** Digits are unbound in compare today, and compare decides a pair — it does not grade. `handleCompareKey` is not touched by this task, and a test pins that the layer changes nothing there.

**Ruling (`applyLabel` toggles, `applyStar` does not).** Lightroom clears a label when its own key is pressed again, and sets the star to N when `N` is pressed again. The keymap holds neither `labels` nor `stars`, so the toggle lives in `applyLabel`'s implementation (Task 5). The keymap's contract is simply "the user pressed the red key".

- [ ] **Step 1: the two props.** In `src/app/useCullKeymap.ts`, add `applyStar,` and `applyLabel,` to the destructuring immediately after `unrateCurrent,` (`:100`), and to the type block immediately after `unrateCurrent: () => void;` (`:171`):

```ts
  /** Set the star on the current frame, or on the whole grid selection.
   *  `null` clears it (the `0` key). Only reachable with
   *  `settings.starsAndLabels` on. */
  applyStar: (star: Star | null) => void;
  /** Set the colour label on the current frame, or on the whole grid
   *  selection — toggling it OFF when that label is already the frame's, as
   *  Lightroom does. This hook does not hold the labels map, so the toggle
   *  decision lives in the callback. Only reachable with
   *  `settings.starsAndLabels` on. */
  applyLabel: (label: Label) => void;
```

  Extend the import on line 2 to `import type { Filter, Img, Label, NavSite, Phase, Rating, Settings, Star } from "../types";` and line 3 to `import { cycleFilter, type TopFilter } from "../utils/filterModes";`.
  (`TopFilter` is already exported — `src/utils/filterModes.ts:10`. This task needs no edit there.)

- [ ] **Step 2: the contract docblock.** In the hook's leading comment (`:12-43`), append one paragraph after the precedence paragraph, before the closing `*/`:

```ts
 * - TWO KEYMAP SHAPES, selected by `settings.starsAndLabels` (Phase 5A).
 *   OFF (the default) is today's keymap exactly: `1`–`5` are the filter
 *   tabs and `0`, `6`–`9` are unbound everywhere. ON, the digit row is
 *   Lightroom's — `1`–`5` set stars, `0` clears them, `6`–`9` and `Shift+6`
 *   set the five colour labels — and the filters move to `Shift+1`–`Shift+5`,
 *   matched on `e.code` because Shift+1 is `!` on his layout and something
 *   else on another. Neither shape binds a digit in COMPARE. The proof that
 *   OFF costs nothing is structural and is pinned in useCullKeymap.test.tsx:
 *   every assertion written before this feature runs against the default
 *   settings object, unchanged.
```

- [ ] **Step 3: the shared filter dispatch and the Shift guard.** Inside the big effect, immediately before `const handleSingleModeKey = (e: KeyboardEvent): void => {` (`:426`), add:

```ts
    /** One filter digit's dispatch — the three statements the five `case "1"`
     *  … `case "5"` bodies used to repeat, in the same order. Shared by the
     *  bare digits (layer off) and Shift+digit (layer on) so the two keymap
     *  shapes cannot drift apart. The per-case `if (e.repeat) break;` stays
     *  in each case: the harness pins all five separately, because each guard
     *  is its own statement and losing one is invisible from the others. */
    const selectFilterTop = (top: TopFilter): void => {
      setFilter((f) => cycleFilter(f, top));
      // Only the two tabs with sub-modes have a sub-chip tooltip to show.
      if (top === "keeps" || top === "suggested") chipsTooltip.pulse();
      // Smart is a valid filter state even with smart culling off — it lands
      // on the "disabled" empty screen. Only kick off analysis when the
      // feature is actually on.
      if (top === "suggested" && settings.smartCulling) startAnalysis();
    };
```

  Then, as the FIRST statement inside `handleSingleModeKey`'s body (before `switch (e.key) {`):

```ts
      // Stars and labels own the bare digit row while the layer is on, so the
      // five filters move to Shift+digit and Purple — which Lightroom gives
      // no key at all — takes Shift+6. Matched on `e.code`: Shift+1 reports
      // `e.key === "!"` on a US layout and a different symbol on every other
      // one, so `e.key` cannot see this row. Returns ONLY on a digit code, so
      // Shift+F, Shift+Arrow and Shift+Space fall through untouched.
      if (settings.starsAndLabels && e.shiftKey) {
        const shifted = SHIFT_DIGIT[e.code];
        if (shifted !== undefined) {
          if (e.repeat) return; // one action per press, like every digit
          if (shifted === "purple") applyLabel("purple");
          else selectFilterTop(shifted);
          return;
        }
      }
```

  And at module scope, after `const PAN_STEP = 2;` (`:5`):

```ts
/**
 * The Shift+digit row, live only while `settings.starsAndLabels` is on.
 * Keyed by `e.code` (layout-stable) rather than `e.key` (which reports the
 * shifted SYMBOL, different on every keyboard layout). Purple rides
 * `Shift+6` because Lightroom ships no default shortcut for it.
 */
const SHIFT_DIGIT: Record<string, TopFilter | "purple" | undefined> = {
  Digit1: "all",
  Digit2: "unrated",
  Digit3: "keeps",
  Digit4: "suggested",
  Digit5: "rejects",
  Digit6: "purple",
};
```

- [ ] **Step 4: the digit cases.** Replace the whole `case "1":` … `case "5":` block (`:648-679`) with:

```ts
        // The digit row has two shapes (see the contract above). OFF — the
        // default — is exactly what it has always been: the filter tabs, one
        // action per press. ON, it is Lightroom's: stars on 1–5, clear on 0,
        // labels on 6–9, and the filters up on Shift+digit.
        //
        // `e.repeat` is dropped per case, not once above: each guard is its
        // own statement and the harness pins all five separately, because a
        // held "4" that lost its guard would call startAnalysis on every OS
        // repeat tick with nothing else failing.
        case "0":
          // Unbound with the layer off — byte-for-byte today's behaviour,
          // where no `case "0"` existed at all (no preventDefault, no call).
          if (!settings.starsAndLabels) break;
          if (e.repeat) break;
          applyStar(null);
          break;
        case "1":
          if (e.repeat) break;
          if (settings.starsAndLabels) applyStar(1);
          else selectFilterTop("all");
          break;
        case "2":
          if (e.repeat) break;
          if (settings.starsAndLabels) applyStar(2);
          else selectFilterTop("unrated");
          break;
        case "3":
          if (e.repeat) break;
          if (settings.starsAndLabels) applyStar(3);
          else selectFilterTop("keeps");
          break;
        case "4":
          if (e.repeat) break;
          if (settings.starsAndLabels) applyStar(4);
          else selectFilterTop("suggested");
          break;
        case "5":
          if (e.repeat) break;
          if (settings.starsAndLabels) applyStar(5);
          else selectFilterTop("rejects");
          break;
        case "6":
          if (!settings.starsAndLabels) break;
          if (e.repeat) break;
          applyLabel("red");
          break;
        case "7":
          if (!settings.starsAndLabels) break;
          if (e.repeat) break;
          applyLabel("yellow");
          break;
        case "8":
          if (!settings.starsAndLabels) break;
          if (e.repeat) break;
          applyLabel("green");
          break;
        case "9":
          if (!settings.starsAndLabels) break;
          if (e.repeat) break;
          applyLabel("blue");
          break;
```

- [ ] **Step 5: the dependency array.** In the effect's deps (`:853-895`), add `settings.starsAndLabels,` directly after `settings.smartCulling,`, and `applyStar,` / `applyLabel,` directly after `unrateCurrent,`. Leaving any of the three out means flipping the setting mid-session would not rebuild the handler — which the `FLAG_CASES` rerender test at the end of the harness exists to catch for other flags, and which Step 7 pins for this one.

- [ ] **Step 6: the harness's two new spies.** In `src/app/useCullKeymap.test.tsx`, add to the `props()` object literal, immediately after the `unrateCurrent: vi.fn(() => {}),` entry:

```tsx
    applyStar: vi.fn((_star: Star | null) => {}),
    applyLabel: vi.fn((_label: Label) => {}),
```

  and extend the type import on line 5 to `import type { Filter, Img, Label, NavSite, Rating, Star } from "../types";`.
  **Change nothing else in this file's existing content.** Run `npx vitest run src/app/useCullKeymap.test.tsx` — **112 passed, unchanged**. If any existing assertion has moved, stop and report it: that is the off-proof failing.

- [ ] **Step 7: the new suites.** Append to `src/app/useCullKeymap.test.tsx`:

```tsx
/**
 * The stars-and-labels layer (Phase 5A). The suite above this one IS the
 * off-proof: every assertion in it runs against DEFAULT_SETTINGS, whose
 * `starsAndLabels` is false, and none of them was touched to add this
 * feature. What follows pins the other shape, and the handful of things that
 * must still be true with the layer off.
 */
const STAR_CASES: [string, Star][] = [
  ["1", 1],
  ["2", 2],
  ["3", 3],
  ["4", 4],
  ["5", 5],
];
const LABEL_CASES: [string, Label][] = [
  ["6", "red"],
  ["7", "yellow"],
  ["8", "green"],
  ["9", "blue"],
];
const SHIFT_FILTER_CASES: [string, Parameters<typeof cycleFilter>[1]][] = [
  ["Digit1", "all"],
  ["Digit2", "unrated"],
  ["Digit3", "keeps"],
  ["Digit4", "suggested"],
  ["Digit5", "rejects"],
];

/** Props with the layer ON — the ONE line that switches keymap shapes. */
function onProps(over: Partial<KeymapProps> = {}): KeymapProps {
  return props({ settings: { ...DEFAULT_SETTINGS, starsAndLabels: true }, ...over });
}

describe("stars and labels, OFF (the default)", () => {
  it("leaves 0 and 6–9 as unbound as they have always been", () => {
    const p = props();
    renderKeymap(p);
    for (const key of ["0", "6", "7", "8", "9"]) {
      const e = press(key);
      // Not even preventDefault: today there is no case for these at all,
      // and "off" has to mean the same dispatch, not a quieter one.
      expect(e.defaultPrevented, key).toBe(false);
    }
    expect(p.applyStar).not.toHaveBeenCalled();
    expect(p.applyLabel).not.toHaveBeenCalled();
    expect(p.setFilter).not.toHaveBeenCalled();
  });

  it("leaves Shift+digit alone — the filters stay on the bare row", () => {
    const p = props();
    renderKeymap(p);
    press("!", { code: "Digit1", shiftKey: true });
    press("^", { code: "Digit6", shiftKey: true });
    expect(p.setFilter).not.toHaveBeenCalled();
    expect(p.applyLabel).not.toHaveBeenCalled();
    press("1");
    expect(p.setFilter).toHaveBeenCalledTimes(1); // the bare digit still filters
  });
});

describe("stars and labels, ON", () => {
  it.each(STAR_CASES)("%s sets %d stars, once per press", (key, star) => {
    const p = onProps();
    renderKeymap(p);
    press(key);
    press(key, { repeat: true });
    expect(p.applyStar).toHaveBeenCalledTimes(1);
    expect(p.applyStar).toHaveBeenCalledWith(star);
    expect(p.setFilter).not.toHaveBeenCalled(); // the filters moved
  });

  it("0 clears the stars, once per press", () => {
    const p = onProps();
    renderKeymap(p);
    press("0");
    press("0", { repeat: true });
    expect(p.applyStar).toHaveBeenCalledTimes(1);
    expect(p.applyStar).toHaveBeenCalledWith(null);
  });

  it.each(LABEL_CASES)("%s sets the %s label, once per press", (key, label) => {
    const p = onProps();
    renderKeymap(p);
    press(key);
    press(key, { repeat: true });
    expect(p.applyLabel).toHaveBeenCalledTimes(1);
    expect(p.applyLabel).toHaveBeenCalledWith(label);
  });

  it("Shift+6 sets Purple — the one label Lightroom gives no key", () => {
    const p = onProps();
    renderKeymap(p);
    // e.key is the SHIFTED symbol, which differs per layout; e.code is not.
    press("^", { code: "Digit6", shiftKey: true });
    expect(p.applyLabel).toHaveBeenCalledWith("purple");
    expect(p.setFilter).not.toHaveBeenCalled();
  });

  it.each(SHIFT_FILTER_CASES)("Shift+%s selects the %s tab, on e.code", (code, top) => {
    const p = onProps();
    renderKeymap(p);
    // `e.key` is deliberately a value no case could ever match (a US layout
    // would say ! @ # $ %, a Danish one something else again). Whatever it
    // says, the binding must be found — that IS the reason it reads e.code.
    press("Unidentified", { code, shiftKey: true });
    const calls = vi.mocked(p.setFilter).mock.calls;
    expect(calls).toHaveLength(1);
    const updater = calls[0][0];
    if (typeof updater !== "function") throw new Error("setFilter was called with a value");
    expect(updater("all")).toBe(cycleFilter("all", top));
    expect(p.applyStar).not.toHaveBeenCalled();
  });

  it("a held Shift+digit cycles once per press, and 4 still starts analysis", () => {
    const p = onProps();
    renderKeymap(p);
    press("Unidentified", { code: "Digit4", shiftKey: true });
    press("Unidentified", { code: "Digit4", shiftKey: true, repeat: true });
    expect(p.setFilter).toHaveBeenCalledTimes(1);
    expect(p.chipsTooltip.pulse).toHaveBeenCalledTimes(1);
    expect(p.startAnalysis).toHaveBeenCalledTimes(1);
  });

  it("Shift on a NON-digit still does what it always did", () => {
    const p = onProps({ gridVisible: true });
    renderKeymap(p);
    press("F", { shiftKey: true });
    expect(p.applyRating).toHaveBeenCalledWith("favorite");
    press("ArrowRight", { shiftKey: true, code: "ArrowRight" });
    expect(p.growGridSelection).toHaveBeenCalledWith(1);
  });

  it("nothing grades behind an overlay, or in compare", () => {
    const behind = onProps({ helpVisible: true });
    const { unmount } = renderKeymap(behind);
    press("3");
    press("7");
    expect(behind.applyStar).not.toHaveBeenCalled();
    expect(behind.applyLabel).not.toHaveBeenCalled();
    unmount();

    // Compare decides a pair; it does not grade. The digits are unbound
    // there today and the layer must not change that.
    const compare = onProps({ compareMode: true });
    renderKeymap(compare);
    press("3");
    press("7");
    press("0");
    press("Unidentified", { code: "Digit2", shiftKey: true });
    expect(compare.applyStar).not.toHaveBeenCalled();
    expect(compare.applyLabel).not.toHaveBeenCalled();
    expect(compare.setFilter).not.toHaveBeenCalled();
  });

  it("the layer flips mid-session — the same key changes meaning", () => {
    // The dependency-array proof for `settings.starsAndLabels`: the handler
    // is rebuilt on ~40 deps, and a flag missing from that list keeps the
    // keymap behaving as it did at mount.
    const p = props();
    const { rerender } = renderKeymap(p);
    press("3");
    expect(p.setFilter).toHaveBeenCalledTimes(1);
    expect(p.applyStar).not.toHaveBeenCalled();
    rerender({ ...p, settings: { ...DEFAULT_SETTINGS, starsAndLabels: true } });
    press("3");
    expect(p.setFilter).toHaveBeenCalledTimes(1); // no second filter call
    expect(p.applyStar).toHaveBeenCalledWith(3);
  });
});
```

- [ ] **Step 8: run, and watch each new test red under a named mutation.** `npx vitest run src/app/useCullKeymap.test.tsx` → **130 passed** (112 + 18). Then, one at a time, by hand:
  - `stars and labels, ON > 1 sets 1 stars…` → in `case "1"`, change `if (settings.starsAndLabels) applyStar(1);` to `if (false) applyStar(1);` — expect `AssertionError: expected "spy" to be called 1 times, but got 0 times`.
  - `0 clears the stars` → change `applyStar(null)` to `applyStar(1)` — expect `expected "spy" to be called with [ null ]`.
  - `6 sets the red label` → change `applyLabel("red")` to `applyLabel("yellow")`.
  - `Shift+6 sets Purple` → delete the `Digit6: "purple",` entry from `SHIFT_DIGIT`.
  - `Shift+Digit1 selects the all tab` → change `SHIFT_DIGIT`'s lookup from `e.code` to `e.key`; every one of the five must fail.
  - `Shift on a NON-digit…` → change the Shift guard's `if (shifted !== undefined) {` to `if (true) {` — `applyRating` is then never called.
  - `nothing grades … in compare` → move the Shift guard from `handleSingleModeKey` up into `onKey`, above the `compareMode ?` line.
  - `the layer flips mid-session` → remove `settings.starsAndLabels` from the dependency array; expect the second `press("3")` to call `setFilter` a second time.
  - `leaves 0 and 6–9 as unbound…` → add `e.preventDefault();` as the first statement of `case "0"`.
  - `leaves Shift+digit alone` → change the Shift guard's condition to `if (e.shiftKey) {`.
  Edit every mutation back by hand and quote each red line in the report.
- [ ] **Step 9:** gate green. `pnpm test` → **+18 tests** over whatever the suite reported when this task started (tasks land in parallel, so quote your own before/after pair, not an absolute expected total). Commit:
  `git commit -m "feat(keymap): Lightroom's digit row behind the starsAndLabels setting" -- src/app/useCullKeymap.ts src/app/useCullKeymap.test.tsx`

### Task 5: The write path — one queue per photo, three kinds of write, one undo step per press

**Files:** Modify `src/app/useRatingPersistence.ts`, `src/app/useRatingPersistence.test.tsx`, `src/app/useDecideCallbacks.ts`, `src/app/useDecideCallbacks.test.tsx`. The ONLY task that touches any of them. **Follows Task 1.**

**Interfaces — Produces:**

```ts
// src/app/useRatingPersistence.ts — two new members on the returned object
  persistStar: (path: string, star: Star | null) => void;
  persistLabel: (path: string, label: Label | null) => void;
// (persistRating keeps its exact signature: (path: string, rating: Rating | null) => void)

// src/app/useDecideCallbacks.ts — two new members on the returned object
  applyStar: (star: Star | null) => void;
  applyLabel: (label: Label) => void;
// …and six new props on its single props object:
  stars: Record<number, Star>;
  setStars: Dispatch<SetStateAction<Record<number, Star>>>;
  labels: Record<number, LabelValue>;
  setLabels: Dispatch<SetStateAction<Record<number, LabelValue>>>;
  persistStar: (path: string, star: Star | null) => void;
  persistLabel: (path: string, label: Label | null) => void;
```

**Consumes:** `Star`, `Label`, `LabelValue`, `MetaChange` and `withMeta` (Task 1); the Rust commands `write_xmp_star` / `write_xmp_label` (Task 3 — but only at runtime: this task's tests mock `invoke`, so it does not have to wait for them).

**Ruling (one serial queue per PHOTO, one staleness counter per PROPERTY).** `writeQueue` stays keyed by path and now carries all three kinds, because a rating, a star and a label for one frame are three read-modify-writes of **one file**: letting two of them overlap loses whichever lands first. `writeSeq` and `failedWrites`, though, move to a `${kind}:${path}` key, because "a newer write superseded this one" is only true of the same property. Keyed by path alone, a successful star write would silently clear a rating write's unsaved flag — the rating still would not be in the sidecar, and the quit guard would stop warning about it. This is a data-safety change, and it is pinned.

**Ruling (`failedCount` now counts per property, not per photo).** One photo with a stuck rating AND a stuck label counts 2. That is the honest number: two things did not save, and `retryFailed` has two things to re-issue. Every existing assertion in `useRatingPersistence.test.tsx` writes one kind, so all nine keep passing unchanged — verify that, and if one moves, stop.

**Ruling (a star / label press does NOT advance, and does not fire the rating flash).** `applyRating` advances to the next visible frame because a verdict finishes with a frame. A star does not: Lightroom does not advance on `3`, and a second pass that stars is a pass you stay on the frame for. `flashFeedback` is likewise untouched — it is typed to `Rating` and paints the full-frame verdict wash, which is not what setting a 3★ means. The spec's "brief flash on set" is a mark-level animation, and it lives in Task 8's rail.

**Ruling (the label key toggles; the anchor decides it for a multi-select).** Lightroom clears a colour label when its own key is pressed again. With a grid selection the question "is this label already active?" has N answers, so one frame decides for the set: the cursor frame when it is inside the selection, else the first selected frame. One press then does one thing to the whole set instead of half-toggling it. A frame carrying a `"custom"` label is simply replaced — `"custom"` never equals the pressed label. Cost if wrong: a mixed selection needs two presses to reach all-red.

**Ruling (one keypress is one undo step, and an already-correct frame is not in it).** Both callbacks build ONE `UndoAction` whose `meta` holds one entry per frame that actually changes, and drop frames already at the target value — mirroring `applyRating`'s `filter((c) => c.before !== c.after)` and `unrateCurrent`'s guard, so no redundant sidecar write and no dead `before === after` entry that would also wipe a pending redo.

- [ ] **Step 1: the persistence tests, first.** Append to `src/app/useRatingPersistence.test.tsx`:

```tsx
describe("useRatingPersistence — stars and labels share the photo, not the verdict", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockInvoke.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it("sends each kind to its own command, with null meaning clear", async () => {
    mockInvoke.mockResolvedValue(undefined);
    const { result } = renderHook(() => useRatingPersistence());
    act(() => {
      result.current.persistStar(FLAKY, 3);
      result.current.persistLabel(FLAKY, "red");
      result.current.persistStar(FLAKY, null);
      result.current.persistLabel(FLAKY, null);
    });
    await settleWrites();
    expect(mockInvoke.mock.calls.map(([cmd]) => cmd)).toEqual([
      "write_xmp_star",
      "write_xmp_label",
      "write_xmp_star",
      "write_xmp_label",
    ]);
    expect(mockInvoke.mock.calls.map(([, args]) => args)).toEqual([
      { path: FLAKY, star: 3 },
      { path: FLAKY, label: "red" },
      { path: FLAKY, star: null },
      { path: FLAKY, label: null },
    ]);
  });

  it("serialises all three kinds for ONE photo — they edit one file", async () => {
    // The sidecar write is read-modify-write. Two of these overlapping would
    // lose whichever read first, which is why the queue is keyed by PATH and
    // not by kind.
    let release: (() => void) | null = null;
    mockInvoke.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = () => resolve();
        }),
    );
    const { result } = renderHook(() => useRatingPersistence());
    act(() => {
      result.current.persistRating(FLAKY, "keep");
      result.current.persistStar(FLAKY, 3);
      result.current.persistLabel(FLAKY, "blue");
    });
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke.mock.calls[0][0]).toBe("write_xmp_rating");
    await act(async () => {
      release?.();
    });
    expect(mockInvoke).toHaveBeenCalledTimes(2);
    expect(mockInvoke.mock.calls[1][0]).toBe("write_xmp_star");
  });

  it("a star write never clears a rating's unsaved flag for the same photo", async () => {
    // Keyed by path alone, the star's issue-time "this path has a fresh
    // write" sweep would have deleted the rating's failure — and the rating
    // still would not be on disk.
    mockInvoke.mockRejectedValue(TRANSIENT);
    const { result } = renderHook(() => useRatingPersistence());
    act(() => {
      result.current.persistRating(STUCK, "reject");
    });
    await settleWrites();
    expect(result.current.failedCount).toBe(1);

    mockInvoke.mockResolvedValue(undefined);
    act(() => {
      result.current.persistStar(STUCK, 2);
    });
    await settleWrites();
    expect(result.current.failedCount, "the rating is still unsaved").toBe(1);

    // …and a fresh RATING write to the same path still clears it.
    act(() => {
      result.current.persistRating(STUCK, "reject");
    });
    await settleWrites();
    expect(result.current.failedCount).toBe(0);
  });

  it("retryFailed re-issues each stuck write with its own command and value", async () => {
    mockInvoke.mockRejectedValue(TRANSIENT);
    const { result } = renderHook(() => useRatingPersistence());
    act(() => {
      result.current.persistStar(FLAKY, 5);
      result.current.persistLabel(GONE, "yellow");
    });
    await settleWrites();
    expect(result.current.failedCount).toBe(2);

    mockInvoke.mockClear();
    mockInvoke.mockResolvedValue(undefined);
    act(() => {
      result.current.retryFailed();
    });
    await settleWrites();
    expect(
      mockInvoke.mock.calls.map(([cmd, args]) => [cmd, args]).sort((a, b) => (a[0] < b[0] ? -1 : 1)),
    ).toEqual([
      ["write_xmp_label", { path: GONE, label: "yellow" }],
      ["write_xmp_star", { path: FLAKY, star: 5 }],
    ]);
    expect(result.current.failedCount).toBe(0);
  });
});
```

  Add `cleanup` to the `@testing-library/react` import at the top of the file if it is not already there. Run `npx vitest run src/app/useRatingPersistence.test.tsx`. First red: `Property 'persistStar' does not exist` (TS2339) — quote it.

- [ ] **Step 2: the persistence rewrite.** In `src/app/useRatingPersistence.ts`, extend the type import on line 3 to `import type { Feedback, Label, Rating, Star } from "../types";`, replace the `FailedWrite` type block (`:23-30` of the file, the `/** A write that exhausted its options… */` comment plus the type) with:

```ts
/** What one queued write is trying to do — the discriminated form, so a
 *  retry can re-issue exactly it and the failure record can say which
 *  property of the sidecar did not land. */
type PendingWrite =
  | { kind: "rating"; rating: Rating | null }
  | { kind: "star"; star: Star | null }
  | { kind: "label"; label: Label | null };

/** A write that exhausted its options, and what kind of failure it was.
 *  `rating: null` = an unrate (clear) that failed, so a stuck unrate is
 *  surfaced and guarded just like a stuck rating; the same is true of a
 *  cleared star or label. `missing` = the backend refused because the photo
 *  is not at its path (utils/writeFailure), which a timer cannot fix — only
 *  the drive coming back or the photo being put back can, so it gets one
 *  attempt per deliberate retry and no schedule. `path` rides along because
 *  the record is keyed by `kind:path`, not by path alone. */
type FailedWrite = { path: string; write: PendingWrite; missing: boolean };

/** The Tauri command and arguments for one pending write. Module scope: it
 *  closes over nothing, which is what keeps `persist`'s dependency list
 *  empty and therefore its identity stable for the whole session. */
function invocation(path: string, write: PendingWrite): [string, Record<string, unknown>] {
  if (write.kind === "star") return ["write_xmp_star", { path, star: write.star }];
  if (write.kind === "label") return ["write_xmp_label", { path, label: write.label }];
  return write.rating === null
    ? ["clear_xmp_rating", { path }]
    : ["write_xmp_rating", { path, rating: write.rating }];
}
```

  Replace the `persistRating` `useCallback` (`:74-140` of the file — the whole thing, from `const persistRating = useCallback(` to its closing `}, []);`) with:

```ts
  /**
   * Durably write ONE property of a photo's `.xmp` sidecar. Retries on
   * failure (NAS blips happen), and if every attempt fails the write is
   * recorded in `failedWrites` so the UI can flag it and the quit guard can
   * refuse to lose it. Every backend write is idempotent, so retries (and a
   * later write superseding this one) are safe.
   *
   * TWO different keys, deliberately:
   *  - `writeQueue` is keyed by PATH. A rating, a star and a label for one
   *    frame are three read-modify-writes of ONE file, so they must not
   *    overlap; different photos still run in parallel.
   *  - `writeSeq` and `failedWrites` are keyed by `kind:path`, because
   *    "a newer write superseded this one" is only true of the SAME property.
   *    Keyed by path alone, a successful star write would clear a rating
   *    write's unsaved flag while the rating was still not on disk.
   */
  const persist = useCallback((path: string, write: PendingWrite) => {
    const key = `${write.kind}:${path}`;
    const seq = (writeSeq.current.get(key) ?? 0) + 1;
    writeSeq.current.set(key, seq);
    const isLatest = () => writeSeq.current.get(key) === seq;

    // A fresh write of THIS property supersedes any earlier failure of it.
    setFailedWrites((f) => {
      if (!(key in f)) return f;
      const next = { ...f };
      delete next[key];
      failedCountRef.current = Object.keys(next).length;
      return next;
    });
    setSavingCount((c) => c + 1);
    savingRef.current += 1; // synchronous: the close guard reads this, not lagged state

    const [cmd, args] = invocation(path, write);

    // tryWrite returns a promise that resolves on success, rejects only after
    // every retry slot has been exhausted — so the queue holds the next write
    // until ALL retries of this one have finished.
    const tryWrite = (n: number): Promise<unknown> =>
      invoke(cmd, args).catch((e) => {
        // A missing-source refusal is permanent: retrying only delays the
        // honest "didn't save" by six seconds.
        if (n < WRITE_RETRY_DELAYS.length && !isPermanentWriteError(e)) {
          return new Promise((resolve, reject) =>
            window.setTimeout(() => tryWrite(n + 1).then(resolve, reject), WRITE_RETRY_DELAYS[n]),
          );
        }
        throw e;
      });

    const prev = writeQueue.current.get(path) ?? Promise.resolve();
    const next = prev
      .then(
        () => tryWrite(0),
        () => tryWrite(0),
      )
      .finally(() => {
        if (writeQueue.current.get(path) === next) writeQueue.current.delete(path);
      });
    writeQueue.current.set(path, next);

    next.then(
      () => {
        setSavingCount((c) => c - 1);
        savingRef.current -= 1;
      },
      (e) => {
        setSavingCount((c) => c - 1);
        savingRef.current -= 1;
        // Only the latest write of this property may stamp a failure; a
        // superseded older write failing must not resurrect an "unsaved" flag
        // the newer (successful) write already cleared.
        if (isLatest()) {
          console.error(`${cmd} failed permanently`, path, e);
          const missing = isPermanentWriteError(e);
          setFailedWrites((f) => {
            const nextFailed = { ...f, [key]: { path, write, missing } };
            failedCountRef.current = Object.keys(nextFailed).length;
            return nextFailed;
          });
        }
      },
    );
  }, []);

  const persistRating = useCallback(
    (path: string, rating: Rating | null) => persist(path, { kind: "rating", rating }),
    [persist],
  );
  /** Set or clear the star (`xmp:Rating` 1–5). Same queue, same retries, same
   *  failure tracking as a rating — it is the same file. */
  const persistStar = useCallback(
    (path: string, star: Star | null) => persist(path, { kind: "star", star }),
    [persist],
  );
  /** Set or clear the colour label (`xmp:Label`). */
  const persistLabel = useCallback(
    (path: string, label: Label | null) => persist(path, { kind: "label", label }),
    [persist],
  );
```

  Replace `retryFailed`'s body loop with:

```ts
  const retryFailed = useCallback(() => {
    Object.values(failedWrites).forEach((failed) => {
      persist(failed.path, failed.write);
    });
  }, [failedWrites, persist]);
```

  And add `persistStar,` and `persistLabel,` to the returned object, immediately after `persistRating,`.

- [ ] **Step 3: run and watch the reds.** `npx vitest run src/app/useRatingPersistence.test.tsx` — **13 passed** (9 existing + 4 new). The nine existing tests must pass **unchanged**; if one moved, stop and report it, because the failure bookkeeping is what the quit guard depends on. Then, by hand:
  - `serialises all three kinds for ONE photo` → change `writeQueue.current.get(path)` / `.set(path, next)` to use `key` instead of `path`; expect `expected "spy" to be called 1 times, but got 3 times`.
  - `a star write never clears a rating's unsaved flag` → change `const key = \`${write.kind}:${path}\`;` to `const key = path;`; expect `the rating is still unsaved: expected +0 to be 1`.
  - `retryFailed re-issues each stuck write…` → change `persist(failed.path, failed.write)` to `persist(failed.path, { kind: "rating", rating: null })`.
  - `sends each kind to its own command` → swap `write_xmp_star` and `write_xmp_label` in `invocation`.
  Edit each back by hand; quote each red.

- [ ] **Step 4: the decide-callback tests, first.** In `src/app/useDecideCallbacks.test.tsx`, add the six new entries to the props factory (beside `persistRating`, following that file's existing `note(...)`-instrumented spy style):

```tsx
    stars: {} as Record<number, Star>,
    setStars: vi.fn((_v: SetStateAction<Record<number, Star>>) => {}),
    labels: {} as Record<number, LabelValue>,
    setLabels: vi.fn((_v: SetStateAction<Record<number, LabelValue>>) => {}),
    persistStar: vi.fn((_path: string, _star: Star | null) => {
      note("persistStar");
    }),
    persistLabel: vi.fn((_path: string, _label: Label | null) => {
      note("persistLabel");
    }),
```

  extend that file's type import to include `Label`, `LabelValue`, `MetaChange`, `Star`, and append:

```tsx
describe("applyStar / applyLabel — the orthogonal layer", () => {
  it("stars the current frame as ONE undo step, and does not advance", () => {
    const props = makeProps();
    const { result } = renderDecides(props);
    act(() => result.current.applyStar(3));
    expect(props.recordAction).toHaveBeenCalledTimes(1);
    const action = vi.mocked(props.recordAction).mock.calls[0][0];
    expect(action.changes).toEqual([]);
    expect(action.meta).toEqual([
      { imgId: 0, path: "/s/0.cr3", field: "star", before: undefined, after: 3 },
    ]);
    expect(props.persistStar).toHaveBeenCalledWith("/s/0.cr3", 3);
    // A star is not a verdict: it finishes nothing, so the cursor stays put
    // and no verdict wash is painted.
    expect(props.setCurrentIndex).not.toHaveBeenCalled();
    expect(props.flashFeedback).not.toHaveBeenCalled();
    expect(props.setRatings).not.toHaveBeenCalled();
  });

  it("0 clears a star — one entry, `after: undefined`, and null on the wire", () => {
    const props = makeProps({ stars: { 0: 4 } });
    const { result } = renderDecides(props);
    act(() => result.current.applyStar(null));
    const action = vi.mocked(props.recordAction).mock.calls[0][0];
    expect(action.meta).toEqual([
      { imgId: 0, path: "/s/0.cr3", field: "star", before: 4, after: undefined },
    ]);
    expect(props.persistStar).toHaveBeenCalledWith("/s/0.cr3", null);
  });

  it("re-pressing the star already on the frame writes nothing at all", () => {
    const props = makeProps({ stars: { 0: 3 } });
    const { result } = renderDecides(props);
    act(() => result.current.applyStar(3));
    expect(props.recordAction).not.toHaveBeenCalled();
    expect(props.persistStar).not.toHaveBeenCalled();
    expect(props.setStars).not.toHaveBeenCalled();
  });

  it("a label toggles off when its own key is pressed again (Lightroom's rule)", () => {
    const set = makeProps();
    const { result: r1 } = renderDecides(set);
    act(() => r1.current.applyLabel("red"));
    expect(vi.mocked(set.recordAction).mock.calls[0][0].meta).toEqual([
      { imgId: 0, path: "/s/0.cr3", field: "label", before: undefined, after: "red" },
    ]);
    expect(set.persistLabel).toHaveBeenCalledWith("/s/0.cr3", "red");

    cleanup();
    const clear = makeProps({ labels: { 0: "red" } });
    const { result: r2 } = renderDecides(clear);
    act(() => r2.current.applyLabel("red"));
    expect(vi.mocked(clear.recordAction).mock.calls[0][0].meta).toEqual([
      { imgId: 0, path: "/s/0.cr3", field: "label", before: "red", after: undefined },
    ]);
    expect(clear.persistLabel).toHaveBeenCalledWith("/s/0.cr3", null);
  });

  it("a label CULL does not recognise is REPLACED, never toggled", () => {
    // "custom" is the user's own Lightroom label. Pressing a colour key
    // replaces it (that is a deliberate act); nothing else may touch it.
    const props = makeProps({ labels: { 0: "custom" } });
    const { result } = renderDecides(props);
    act(() => result.current.applyLabel("blue"));
    expect(vi.mocked(props.recordAction).mock.calls[0][0].meta).toEqual([
      { imgId: 0, path: "/s/0.cr3", field: "label", before: "custom", after: "blue" },
    ]);
  });

  it("a grid multi-select is ONE undo step, one entry per frame that changes", () => {
    const props = makeProps({
      gridVisible: true,
      selectedIndices: new Set([0, 1, 2]),
      stars: { 1: 5 },
    });
    const { result } = renderDecides(props);
    act(() => result.current.applyStar(5));
    expect(props.recordAction).toHaveBeenCalledTimes(1);
    const meta = vi.mocked(props.recordAction).mock.calls[0][0].meta as MetaChange[];
    // Frame 1 is already 5★ — no redundant write, no dead before===after entry.
    expect(meta.map((m) => m.imgId)).toEqual([0, 2]);
    expect(props.persistStar).toHaveBeenCalledTimes(2);
  });

  it("never grades a frame outside the active filter", () => {
    // Same guard as applyRating's `pos === -1` return: with the cursor
    // outside the filter the photo is not on screen, and grading something
    // you cannot see is never right.
    const props = makeProps({ visibleIndices: [1, 2] }); // currentIndex 0 is hidden
    const { result } = renderDecides(props);
    act(() => result.current.applyStar(2));
    act(() => result.current.applyLabel("green"));
    expect(props.recordAction).not.toHaveBeenCalled();
    expect(props.persistStar).not.toHaveBeenCalled();
    expect(props.persistLabel).not.toHaveBeenCalled();
  });
});
```

  (`makeProps` / `renderDecides` are this file's existing factory and render helper — use its actual names; if they differ, use the file's, and say so in the report.)

- [ ] **Step 5: the decide callbacks.** In `src/app/useDecideCallbacks.ts`, extend the type import on line 2 to `import type { Img, Label, LabelValue, MetaChange, NavEntry, Rating, Star, UndoAction } from "../types";` and line 4 to `import { withChanges, withMeta } from "../utils/withChanges";`. Add the six props to the destructuring (after `persistRating,`) and to the type block (after `persistRating: (path: string, rating: Rating | null) => void;`):

```ts
  stars: Record<number, Star>;
  setStars: Dispatch<SetStateAction<Record<number, Star>>>;
  labels: Record<number, LabelValue>;
  setLabels: Dispatch<SetStateAction<Record<number, LabelValue>>>;
  persistStar: (path: string, star: Star | null) => void;
  persistLabel: (path: string, label: Label | null) => void;
```

  Then add, after `unrateCurrent` (`:243`) and before `resolveCompareDecide`:

```ts
  /**
   * Which frames a star / colour-label keypress acts on: the whole grid
   * selection when there is one, intersected with the active filter, exactly
   * as `applyRating` does — else the current frame, and NOTHING when the
   * cursor sits outside the active filter (the loupe shows a no-match screen
   * there, and grading a frame you cannot see is never right).
   */
  const markTargets = useCallback((): Img[] => {
    if (gridVisible && selectedIndices.size >= 1) {
      const visibleSet = new Set(visibleIndices);
      return Array.from(selectedIndices)
        .filter((idx) => visibleSet.has(idx))
        .map((idx) => images[idx])
        .filter((im): im is Img => Boolean(im));
    }
    const cur = images[currentIndex];
    if (!cur) return [];
    if (visibleIndices.indexOf(currentIndex) === -1) return [];
    return [cur];
  }, [gridVisible, selectedIndices, visibleIndices, images, currentIndex]);

  /**
   * Set (or clear, with `null`) the star on the current frame or the whole
   * grid selection. ONE undo step per keypress, whatever the selection size.
   *
   * Deliberately NOT like `applyRating`: no advance and no verdict flash. A
   * star is orthogonal to keep/reject — it finishes nothing, so the cursor
   * stays where the user is looking, and the full-frame wash belongs to a
   * verdict. Frames already at the target star are dropped, so a re-press is
   * free (no sidecar round-trip, no dead before===after entry that would also
   * wipe a pending redo).
   */
  const applyStar = useCallback(
    (star: Star | null) => {
      const after = star ?? undefined;
      const meta: MetaChange[] = markTargets()
        .filter((im) => stars[im.id] !== after)
        .map((im) => ({
          imgId: im.id,
          path: im.path,
          field: "star" as const,
          before: stars[im.id],
          after,
        }));
      if (meta.length === 0) return;
      recordAction({ changes: [], meta });
      setStars((prev) => withMeta(prev, meta));
      for (const m of meta) persistStar(m.path, star);
    },
    [markTargets, stars, recordAction, setStars, persistStar],
  );

  /**
   * Set the colour label on the current frame or the whole grid selection —
   * TOGGLING it off when that label is already there, as Lightroom does.
   *
   * With a multi-select the toggle needs one answer, not N: the ANCHOR
   * decides — the cursor frame when it is inside the selection, else the
   * first selected frame — so one press does one thing to the whole set
   * instead of half-toggling it. A frame carrying a label CULL does not
   * recognise (`"custom"`, the user's own Lightroom label) is replaced, never
   * toggled: `"custom"` can never equal the pressed key.
   */
  const applyLabel = useCallback(
    (label: Label) => {
      const targets = markTargets();
      if (targets.length === 0) return;
      const cursor = images[currentIndex];
      const anchor = targets.find((im) => im.id === cursor?.id) ?? targets[0];
      const after: Label | undefined = labels[anchor.id] === label ? undefined : label;
      const meta: MetaChange[] = targets
        .filter((im) => labels[im.id] !== after)
        .map((im) => ({
          imgId: im.id,
          path: im.path,
          field: "label" as const,
          before: labels[im.id],
          after,
        }));
      if (meta.length === 0) return;
      recordAction({ changes: [], meta });
      setLabels((prev) => withMeta(prev, meta));
      for (const m of meta) persistLabel(m.path, after ?? null);
    },
    [markTargets, labels, images, currentIndex, recordAction, setLabels, persistLabel],
  );
```

  And add `applyStar, applyLabel,` to the returned object on the last line.

- [ ] **Step 6: run and watch the reds.** `npx vitest run src/app/useDecideCallbacks.test.tsx` — every existing test still passes, plus 7. By hand:
  - `stars the current frame as ONE undo step…` → change `recordAction({ changes: [], meta })` to `for (const m of meta) recordAction({ changes: [], meta: [m] });` and confirm the grid test fails on `expected "spy" to be called 1 times`.
  - `a label toggles off…` → change `labels[anchor.id] === label ? undefined : label` to just `label`; the second half fails on `after: undefined`.
  - `re-pressing the star already on the frame…` → delete the `.filter((im) => stars[im.id] !== after)` line.
  - `never grades a frame outside the active filter` → delete `markTargets`' `if (visibleIndices.indexOf(currentIndex) === -1) return [];`.
  - `a grid multi-select is ONE undo step…` → change `markTargets`' selection branch to `return [images[currentIndex]]`.
  Edit each back by hand; quote each red.
- [ ] **Step 7:** gate green. Report `pnpm test`'s before/after pair (**+11**). Commit:
  `git commit -m "feat(app): persist and decide stars and colour labels on the rating write path" -- src/app/useRatingPersistence.ts src/app/useRatingPersistence.test.tsx src/app/useDecideCallbacks.ts src/app/useDecideCallbacks.test.tsx`

### Task 6: Undo, redo, and taking a moved frame's marks with it

**Files:** Modify `src/app/useUndoRedo.ts`, `src/utils/pruneSession.ts`, `src/utils/pruneSession.test.ts`; create `src/app/useUndoRedo.test.tsx`. The ONLY task that touches any of them. **Follows Task 1.**

**Interfaces — Produces** (exactly four new props on `useUndoRedo`; Task 11 supplies them). The live `stars` / `labels` maps are deliberately NOT among them: undo replays the `before` / `after` values the action already recorded and must never consult the current state, or a double undo would read its own first result.

```ts
  setStars: Dispatch<SetStateAction<Record<number, Star>>>;
  setLabels: Dispatch<SetStateAction<Record<number, LabelValue>>>;
  persistStar: (path: string, star: Star | null) => void;
  persistLabel: (path: string, label: Label | null) => void;
```

**Consumes:** `MetaChange`, `Star`, `Label`, `LabelValue`, `withMeta` (Task 1).

**Ruling (`recordAction`'s empty check must learn about `meta`).** `useUndoRedo.ts:37` returns early on `action.changes.length === 0` — which is exactly the shape every star and label action has (`{ changes: [], meta: [...] }`). Left alone, **not one star would be undoable** and the bug would be silent. The guard becomes "neither list has an entry".

**Ruling (`undo`'s landing frame must not read `changes[length - 1]` blindly).** Both `undo` (`:60`) and `redo` (`:100`) do `action.changes[action.changes.length - 1].imgId` to land the cursor on the frame that changed. With an empty `changes` that is a `TypeError` on `undefined.imgId`. The fallback reads the last `meta` entry instead. `Array.prototype.at` is **not available** (ES2020 lib) — index by hand.

**Ruling (`pruneHistory` must carry `meta`, or a Move-rejects silently deletes every star in history).** `pruneSession.ts:90` rebuilds bare `{ changes }` literals, so any new field on `UndoAction` is dropped on the first prune — the scout names this at §1.4. Worse than dropping: an action whose `changes` are empty and whose `meta` survives would be discarded entirely by the `changes.length > 0` test. Both are fixed, and both are pinned.

**Ruling (the moved frames' marks go too).** After a Move rejects, `pruneMoved` calls `omitIds(ratings, goneIds)`; `omitIds` is already generic over `T` (`pruneSession.ts:59-69`), so the two new maps cost one call each — which Task 11 makes. This task only has to make sure `pruneHistory` does not strand a `meta` entry pointing at a frame that has left the folder: replaying one would ask the backend to write a sidecar it now refuses (`source missing:`), which is the exact class of bug `require_source` exists for.

- [ ] **Step 1: `src/app/useUndoRedo.test.tsx`, first — the file does not exist yet.** Create it:

```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { Dispatch, SetStateAction } from "react";
import type { Img, Label, LabelValue, Rating, Star } from "../types";
import { useUndoRedo } from "./useUndoRedo";

/**
 * Undo / redo, with the star and colour-label layer beside the verdicts.
 *
 * What makes these worth writing: an `UndoAction` for a star has an EMPTY
 * `changes` array, and every guard in this hook was written when that was
 * impossible. `recordAction` dropped such an action on the floor; `undo`
 * indexed `changes[length - 1]` to pick a landing frame and would have thrown.
 */

afterEach(cleanup);

const IMAGES: Img[] = [0, 1, 2].map((id) => ({
  id,
  path: `/s/${id}.cr3`,
  filename: `${id}.cr3`,
  srcFolder: "/s",
}));

function setter<T>(): Dispatch<SetStateAction<T>> {
  return vi.fn((_v: SetStateAction<T>) => {});
}

function props() {
  return {
    images: IMAGES,
    compareMode: false,
    persistRating: vi.fn((_p: string, _r: Rating | null) => {}),
    persistStar: vi.fn((_p: string, _s: Star | null) => {}),
    persistLabel: vi.fn((_p: string, _l: Label | null) => {}),
    setRatings: setter<Record<number, Rating>>(),
    setStars: setter<Record<number, Star>>(),
    setLabels: setter<Record<number, LabelValue>>(),
    setCompareMode: setter<boolean>(),
    setGridVisible: setter<boolean>(),
    setChampionIndex: setter<number>(),
    setChallengerIndex: setter<number>(),
    setCurrentIndex: setter<number>(),
    setNavStack: setter<never[]>() as unknown as Dispatch<SetStateAction<never[]>>,
  };
}

/** The hook's real props object, so a renamed prop breaks this file at
 *  compile time rather than leaving it testing yesterday's shape. */
type UndoProps = Parameters<typeof useUndoRedo>[0];

function renderUndo(p: UndoProps) {
  return renderHook(() => useUndoRedo(p));
}

describe("undo / redo of stars and colour labels", () => {
  it("records a star action at all — its `changes` list is empty", () => {
    const p = props() as unknown as UndoProps;
    const { result } = renderUndo(p);
    act(() =>
      result.current.recordAction({
        changes: [],
        meta: [{ imgId: 1, path: "/s/1.cr3", field: "star", before: undefined, after: 3 }],
      }),
    );
    act(() => result.current.undo());
    expect(p.persistStar).toHaveBeenCalledWith("/s/1.cr3", null);
  });

  it("undo restores `before`, redo re-applies `after`, on disk and in memory", () => {
    const p = props() as unknown as UndoProps;
    const { result } = renderUndo(p);
    act(() =>
      result.current.recordAction({
        changes: [],
        meta: [{ imgId: 2, path: "/s/2.cr3", field: "label", before: "red", after: "blue" }],
      }),
    );
    act(() => result.current.undo());
    expect(p.persistLabel).toHaveBeenCalledWith("/s/2.cr3", "red");
    expect(p.setLabels).toHaveBeenCalledTimes(1);
    act(() => result.current.redo());
    expect(p.persistLabel).toHaveBeenLastCalledWith("/s/2.cr3", "blue");
    expect(p.setLabels).toHaveBeenCalledTimes(2);
  });

  it("a cleared mark round-trips as null on the wire, not as a missing call", () => {
    const p = props() as unknown as UndoProps;
    const { result } = renderUndo(p);
    act(() =>
      result.current.recordAction({
        changes: [],
        meta: [{ imgId: 0, path: "/s/0.cr3", field: "star", before: 4, after: undefined }],
      }),
    );
    act(() => result.current.undo());
    expect(p.persistStar).toHaveBeenCalledWith("/s/0.cr3", 4);
    act(() => result.current.redo());
    expect(p.persistStar).toHaveBeenLastCalledWith("/s/0.cr3", null);
  });

  it("lands the cursor on the frame whose mark changed, with no rating to read", () => {
    // The old code picked the landing frame from `changes[changes.length - 1]`,
    // which is `undefined` for a star action — a TypeError, not a wrong frame.
    const p = props() as unknown as UndoProps;
    const { result } = renderUndo(p);
    act(() =>
      result.current.recordAction({
        changes: [],
        meta: [{ imgId: 2, path: "/s/2.cr3", field: "star", before: undefined, after: 1 }],
      }),
    );
    act(() => result.current.undo());
    expect(p.setCurrentIndex).toHaveBeenCalledWith(2);
  });

  it("an action carrying BOTH a verdict and a mark replays both", () => {
    const p = props() as unknown as UndoProps;
    const { result } = renderUndo(p);
    act(() =>
      result.current.recordAction({
        changes: [{ imgId: 1, path: "/s/1.cr3", before: undefined, after: "keep" }],
        meta: [{ imgId: 1, path: "/s/1.cr3", field: "star", before: undefined, after: 2 }],
      }),
    );
    act(() => result.current.undo());
    expect(p.persistRating).toHaveBeenCalledWith("/s/1.cr3", null);
    expect(p.persistStar).toHaveBeenCalledWith("/s/1.cr3", null);
  });

  it("an action with neither list is still dropped", () => {
    const p = props() as unknown as UndoProps;
    const { result } = renderUndo(p);
    act(() => result.current.recordAction({ changes: [] }));
    act(() => result.current.undo());
    expect(p.persistRating).not.toHaveBeenCalled();
    expect(p.persistStar).not.toHaveBeenCalled();
  });
});
```

  Run it: the first red is a compile error (`persistStar` is not a prop of `useUndoRedo`). Quote it.

- [ ] **Step 2: `src/app/useUndoRedo.ts`.** Extend the type import to `import type { Img, Label, LabelValue, MetaChange, NavEntry, Rating, Star, UndoAction } from "../types";` and add `import { withMeta } from "../utils/withChanges";`. Add the four props to the destructuring (after `persistRating,`) and the type block (after `persistRating: …;`):

```ts
  persistStar: (path: string, star: Star | null) => void;
  persistLabel: (path: string, label: Label | null) => void;
  setStars: Dispatch<SetStateAction<Record<number, Star>>>;
  setLabels: Dispatch<SetStateAction<Record<number, LabelValue>>>;
```

  Replace `recordAction` with:

```ts
  const recordAction = useCallback((action: UndoAction) => {
    // An action carries verdicts, or marks, or both — never neither. The
    // star/label layer's actions have an EMPTY `changes` array by design, so
    // a bare `changes.length === 0` test would drop every one of them and
    // nothing would say so.
    if (action.changes.length === 0 && (action.meta?.length ?? 0) === 0) return;
    undoStack.current.push(action);
    if (undoStack.current.length > HISTORY_LIMIT) undoStack.current.shift();
    redoStack.current = []; // a new action invalidates the redo branch
  }, []);
```

  Add, directly after `applyChanges`:

```ts
  /**
   * Replay a list of star / colour-label changes to state + durable XMP in
   * one shot — the orthogonal twin of {@link applyChanges}. `undefined`
   * deletes the key and clears the property on disk (`null` on the wire).
   */
  const applyMeta = useCallback(
    (meta: readonly MetaChange[]) => {
      const starChanges = meta.filter((m) => m.field === "star");
      const labelChanges = meta.filter((m) => m.field === "label");
      if (starChanges.length > 0) {
        setStars((prev) => withMeta(prev, starChanges as { imgId: number; after: Star | undefined }[]));
      }
      if (labelChanges.length > 0) {
        setLabels((prev) => withMeta(prev, labelChanges as { imgId: number; after: LabelValue | undefined }[]));
      }
      for (const m of meta) {
        if (m.field === "star") persistStar(m.path, m.after ?? null);
        else persistLabel(m.path, (m.after ?? null) as Label | null);
      }
    },
    [persistStar, persistLabel, setStars, setLabels],
  );

  /** The frame an undo/redo should land on: the crowned/kept frame of a
   *  compound verdict action (its LAST change), or — for a star or label
   *  action, whose `changes` list is empty — the last frame it marked.
   *  Indexed by hand: `Array.prototype.at` is not in this project's ES2020
   *  lib. */
  const landingId = (action: UndoAction): number | undefined => {
    const lastChange = action.changes[action.changes.length - 1];
    if (lastChange) return lastChange.imgId;
    const meta = action.meta;
    const lastMeta = meta && meta.length > 0 ? meta[meta.length - 1] : undefined;
    return lastMeta?.imgId;
  };
```

  In `undo`, after the `applyChanges(...)` line add:

```ts
    if (action.meta) applyMeta(action.meta.map((m) => ({ ...m, after: m.before }) as MetaChange));
```

  and replace the `} else if (!compareMode) { … }` block's three lines with:

```ts
    } else if (!compareMode) {
      const landId = landingId(action);
      if (landId !== undefined) {
        const idx = images.findIndex((im) => im.id === landId);
        if (idx !== -1) setCurrentIndex(idx);
      }
    }
```

  In `redo`, after its `applyChanges(...)` line add `if (action.meta) applyMeta(action.meta);`, and make the same `landingId` substitution in its `else if (!compareMode)` block. Add `applyMeta` to both dependency arrays.

- [ ] **Step 3: `pruneHistory` keeps the marks.** In `src/utils/pruneSession.ts`, extend the import to `import type { Img, NavEntry, UndoAction } from "../types";` (unchanged) and replace `pruneHistory`'s body with:

```ts
export function pruneHistory(
  stack: readonly UndoAction[],
  goneIds: ReadonlySet<number>,
): UndoAction[] {
  // No frame left the session: history is untouched, snapshots included.
  if (goneIds.size === 0) return stack as UndoAction[];
  const touched = stack.some(
    (a) =>
      a.cursorBefore ||
      a.cursorAfter ||
      a.changes.some((c) => goneIds.has(c.imgId)) ||
      (a.meta?.some((m) => goneIds.has(m.imgId)) ?? false),
  );
  if (!touched) return stack as UndoAction[];
  const out: UndoAction[] = [];
  for (const action of stack) {
    const changes = action.changes.filter((c) => !goneIds.has(c.imgId));
    // The star / colour-label layer rides here too. Rebuilding a bare
    // `{ changes }` literal would silently DELETE every star and label from
    // the history on the first Move rejects — and would discard a whole
    // star action, whose `changes` list is empty by design.
    const meta = action.meta?.filter((m) => !goneIds.has(m.imgId));
    if (changes.length > 0 || (meta?.length ?? 0) > 0) {
      out.push(meta && meta.length > 0 ? { changes, meta } : { changes });
    }
  }
  return out;
}
```

- [ ] **Step 4: the prune tests, written BEFORE Step 3 if you can, and in any case watched red.** Append to `src/utils/pruneSession.test.ts`:

```ts
describe("pruneHistory — the star and colour-label layer", () => {
  const meta = (imgId: number): MetaChange => ({
    imgId,
    path: `/s/${imgId}.cr3`,
    field: "star",
    before: undefined,
    after: 3,
  });

  test("a surviving frame's marks are carried, not silently dropped", () => {
    // The rebuild used to emit a bare `{ changes }` literal, so every field
    // added to UndoAction vanished on the first Move rejects.
    const stack: UndoAction[] = [
      { changes: [{ imgId: 1, path: "/s/1.cr3", before: undefined, after: "keep" }], meta: [meta(1)] },
    ];
    const out = pruneHistory(stack, new Set([9]));
    expect(out[0].meta).toEqual([meta(1)]);
  });

  test("a mark-only action survives a prune that does not touch it", () => {
    const stack: UndoAction[] = [{ changes: [], meta: [meta(1)] }];
    const out = pruneHistory(stack, new Set([9]));
    expect(out).toHaveLength(1);
    expect(out[0].meta).toEqual([meta(1)]);
  });

  test("a moved frame's marks go with it, and an emptied action is dropped", () => {
    const stack: UndoAction[] = [{ changes: [], meta: [meta(1), meta(2)] }];
    expect(pruneHistory(stack, new Set([1]))[0].meta).toEqual([meta(2)]);
    expect(pruneHistory(stack, new Set([1, 2]))).toEqual([]);
  });
});
```

  Import `MetaChange` and `UndoAction` as types at the top of that file if they are not already imported.

- [ ] **Step 5: run and watch the reds.** `npx vitest run src/app/useUndoRedo.test.tsx src/utils/pruneSession.test.ts`. By hand:
  - `records a star action at all` → change `recordAction`'s guard back to `if (action.changes.length === 0) return;`.
  - `lands the cursor on the frame whose mark changed` → change `landingId` to `return action.changes[action.changes.length - 1]?.imgId;` — expect `setCurrentIndex` never called.
  - `undo restores before, redo re-applies after` → delete `undo`'s `if (action.meta) applyMeta(...)` line.
  - `a surviving frame's marks are carried` → change `pruneHistory`'s push to `out.push({ changes });`.
  - `a mark-only action survives a prune` → change the push condition to `if (changes.length > 0)`.
  Edit each back by hand; quote each red.
- [ ] **Step 6:** gate green. Report `pnpm test`'s before/after pair (**+9**). Commit:
  `git commit -m "feat(app): undo, redo and prune the star and colour-label layer" -- src/app/useUndoRedo.ts src/app/useUndoRedo.test.tsx src/utils/pruneSession.ts src/utils/pruneSession.test.ts`

### Task 7: Five colours that are not verdict colours, and the one place a mark's look is decided

**Files:** Modify `src/styles/tokens.css`, `src/styles/index.css`, `src/styles/motion.css`, `src/styles/contrast.test.ts`; create `src/styles/marks.css`. The ONLY task that touches any of them. **No dependencies — runs in wave 1.**

**Interfaces — Produces** (every render task uses these class names verbatim and adds only POSITION rules of its own):

```css
--label-red  --label-yellow  --label-green  --label-blue  --label-purple   /* tokens.css */

.cull-mark-stars                 /* flex row of Lucide Star glyphs (the rail) */
.cull-mark-star--on              /* filled slot  → var(--accent) */
.cull-mark-star--off             /* empty slot   → the dimmed text-2 mix */
.cull-mark-count                 /* the grid cell's compact "3" + one star */
.cull-label--{red|yellow|green|blue|purple|custom}   /* sets --label-ink */
.cull-label-bar                  /* 4px bar along a cell's bottom edge */
.cull-label-swatch               /* 10px square, for the rail row */
.cull-mark-flash                 /* the brief set animation */
@keyframes cull-mark-flash
```

**Consumes:** nothing.

**Ruling (shape and place carry the meaning; hue is secondary).** Three of Lightroom's five collide with a load-bearing token here — red is `--bad` (reject), green is `--ok` (keep), purple is `--fav` (favourite) — and blue is close to `--accent-cool` ("Similar set"). Per spec §4 a verdict stays a **glyph inside a circle** and a label is a **bar or a square swatch**, so a colour-blind user reads them apart the way they already read the verdict dots apart. The five tokens are their own, never `--bad` / `--ok` / `--fav` reused, and a test pins that none of them equals a verdict colour.

**Ruling (3:1, the non-text bar, and plain 6-digit hex).** `contrast.test.ts`'s `token()` only accepts a **plain 6-digit hex** literal and throws otherwise, so none of these may be written as `color-mix()` or `rgba()`. The bar and the swatch are non-text graphics, so WCAG's bar is 3:1 (1.4.11), which is what the new test asserts — the five values below are chosen well clear of it, but **verify with the test, not with this paragraph**: if one fails, lighten it and report the number.

**Ruling (a new stylesheet, not five more rules in three files).** The rail, the grid cell and the filmstrip cell all draw the same two marks. Their POSITION differs and belongs in their own sheets; their LOOK is one decision and belongs in one file, or the grid's red and the rail's red become two reds. `marks.css` is imported from `index.css` before `motion.css` (which must stay last — its reduced-motion overrides win on source order at equal specificity).

**Ruling (the flash is `opacity` + `transform` only).** Compositor-friendly properties, on the verdict flash's own `--dur-fast` / `--ease-out` tokens, and fully disabled under `prefers-reduced-motion` — where a keyframe must also be named in a `reviewed:` comment in `motion.css` or `motion.test.ts` fails.

- [ ] **Step 1: the failing test first.** Append to `src/styles/contrast.test.ts`, inside the existing `describe("colour tokens", …)`:

```ts
  test("the five colour-label tokens clear the non-text 3:1 bar on every dark surface", () => {
    // 3:1, not 4.5:1: a label is a BAR and a SWATCH — a non-text graphic
    // (WCAG 1.4.11) — never a text colour. The verdict/text tokens above
    // keep their 4.5:1 bar.
    for (const label of LABEL_TOKENS) {
      for (const bg of ["bg", "surface", "surface-2"]) {
        expect(ratio(token(label), token(bg)), `--${label} on --${bg}`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  test("no colour label reuses a verdict or chrome colour", () => {
    // Red is reject, green is keep, purple is favourite and the cool blue is
    // the Similar-set grouping. A label that borrowed one of those hues
    // would make a red-labelled keep and a reject look alike at thumbnail
    // size — the reason labels are told apart by SHAPE and PLACE first.
    const taken = ["ok", "bad", "fav", "accent", "accent-cool"].map((n) => token(n).toLowerCase());
    for (const label of LABEL_TOKENS) {
      expect(taken, `--${label}`).not.toContain(token(label).toLowerCase());
    }
  });
```

  and, above the `describe`, the shared list:

```ts
/** The five colour-label tokens, in keyboard order (`6` `7` `8` `9` `Shift+6`). */
const LABEL_TOKENS = ["label-red", "label-yellow", "label-green", "label-blue", "label-purple"];
```

  Run `npx vitest run src/styles/contrast.test.ts`. Expected red: `Error: token --label-red is not a plain hex` — `token()` throws before any ratio is computed, which is the right first failure for a token that does not exist. Quote it.

- [ ] **Step 2: the tokens.** In `src/styles/tokens.css`, after the `--scrim-modal:` line and before the `/* type */` comment:

```css
  /* Colour labels (Phase 5A) — Lightroom's five, desaturated into this
     palette the way --ok and --bad already are, and deliberately NOT the
     verdict tokens: red means reject here, green means keep, purple means
     favourite. A label is told from a verdict by SHAPE and PLACE first (a
     verdict is a glyph in a circle, a label is a bar or a square swatch), so
     these only have to be legible and distinct from each other — not to
     carry the meaning on their own. Plain 6-digit hex, because
     contrast.test.ts reads them by name and accepts nothing else; each
     clears 3:1 (WCAG 1.4.11, non-text) on all three dark surfaces. */
  --label-red: #e08a8a;
  --label-yellow: #dcd06a;
  --label-green: #6fd39b;
  --label-blue: #74bdf2;
  --label-purple: #c98ef2;
```

  Re-run the two tests. If either ratio assertion fails, lighten that one value until it passes and **report the old value, the new value and the measured ratio** — do not lower the 3 in the test.

- [ ] **Step 3: `src/styles/marks.css`,** new file:

```css
/* ── Stars and colour labels (Phase 5A) ───────────────────────────────────
   What a mark LOOKS like, in one place. Where each one sits is its surface's
   business (exif-rail.css, grid.css, strip.css) — but the grid's red and the
   rail's red have to be one red, so the colour, the shape and the flash live
   here and nowhere else.

   Nothing below is ever rendered while `settings.starsAndLabels` is off: the
   components do not emit the elements at all, which is what makes "off costs
   nothing" structural rather than careful. */

/* The rail's five-glyph meter. Lucide <Star> SVGs, never the ★ character —
   a character is rendered by whatever font the OS picks and drifts from the
   icons beside it (see icons.ts, and icons.test.ts which fails on one). */
.cull-mark-stars {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-0);
  line-height: 1;
}

.cull-mark-star--on {
  color: var(--accent);
}

/* Same dimming the LrC meter already uses, so the two read as one family. */
.cull-mark-star--off {
  color: color-mix(in srgb, var(--text-2) 58%, var(--bg));
}

/* The grid cell's compact readout — the NUMBER plus one filled star, in the
   muted token, because five glyphs do not survive a contact-sheet cell. */
.cull-mark-count {
  display: inline-flex;
  align-items: center;
  gap: 1px; /* off-scale: pairs a digit with an 11px glyph, not two blocks */
  font-family: var(--font-mono);
  font-size: var(--fs-1);
  font-variant-numeric: tabular-nums;
  line-height: 1;
  color: var(--muted);
}

/* One hue per label, read by BOTH the bar and the swatch through one local
   custom property — so a new surface picks the colour up by adding the
   modifier class, with no second colour table anywhere. */
.cull-label--red {
  --label-ink: var(--label-red);
}

.cull-label--yellow {
  --label-ink: var(--label-yellow);
}

.cull-label--green {
  --label-ink: var(--label-green);
}

.cull-label--blue {
  --label-ink: var(--label-blue);
}

.cull-label--purple {
  --label-ink: var(--label-purple);
}

/* A label string CULL did not write — the user's own Lightroom label set, or
   a non-English one. Shown, never guessed at, never rewritten: neutral ink,
   and the swatch below draws it as an outline so it cannot be mistaken for
   one of the five. */
.cull-label--custom {
  --label-ink: var(--text-2);
}

/* The cell bar — a 4px band along the bottom edge. A BAR, never a dot: the
   verdict dot is a glyph in a circle at the bottom-right, so shape and place
   separate the two before hue has to. */
.cull-label-bar {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 4px;
  background: var(--label-ink);
  z-index: 3;
  pointer-events: none;
}

/* The rail swatch — a square beside the label's name. */
.cull-label-swatch {
  width: 10px;
  height: 10px;
  border-radius: var(--r-1);
  background: var(--label-ink);
  flex-shrink: 0;
}

.cull-label-swatch.cull-label--custom {
  background: transparent;
  box-shadow: inset 0 0 0 1.5px var(--label-ink);
}

/* A brief confirmation when a mark is SET — the verdict flash's own duration
   and easing tokens, on compositor-friendly properties only. */
.cull-mark-flash {
  animation: cull-mark-flash var(--dur-fast) var(--ease-out);
}

@keyframes cull-mark-flash {
  from {
    opacity: 0.35;
    transform: scale(1.18);
  }

  to {
    opacity: 1;
    transform: scale(1);
  }
}
```

- [ ] **Step 4: the import.** In `src/styles/index.css`, insert directly after the `@import url("./exif-rail.css");` line and before the two-line `/* LAST: … */` comment:

```css
@import url("./marks.css");
```

- [ ] **Step 5: the reduced-motion ruling.** `npx vitest run src/styles/motion.test.ts` must now FAIL with `expected [ … ] to deeply equal [ … ]` naming `cull-mark-flash` as declared-but-not-reviewed — quote it; that gate is the reason it exists. Then, in `src/styles/motion.css`, inside the `@media (prefers-reduced-motion: reduce)` block, immediately before its closing `}` (after the `cull-spinner-reveal` comment):

```css

  /* Setting a star or a colour label is a change the user just asked for;
     the pop only confirms it, and the mark stays exactly where it was. Pure
     decoration (distinction 1's opposite) → off.
     reviewed: cull-mark-flash */
  .cull-mark-flash {
    animation: none;
  }
```

  Re-run: green.

- [ ] **Step 6: run, then watch each new test red under a named mutation.**
  - `the five colour-label tokens clear the non-text 3:1 bar` → change `--label-blue` to `#1b3d5c` and confirm `--label-blue on --surface-2: expected 1.6… to be greater than or equal to 3` (the exact number will differ; quote what you get).
  - `no colour label reuses a verdict or chrome colour` → set `--label-green: #9ec5a4;` (the `--ok` literal) and confirm it fails.
  - `every keyframe in src/styles has a reviewed reduced-motion behaviour` → delete the `reviewed: cull-mark-flash` words from the comment.
  Edit each back by hand; quote each red.
- [ ] **Step 7:** gate green — including `pnpm lint:css`, which this task is the only one likely to trip (stylelint's BEM-ish `selector-class-pattern`; `.cull-label-swatch.cull-label--custom` is two classes on one element and is allowed, `z-index: 3` is under its 2-digit ban). Report `pnpm test`'s before/after pair (**+2**). Commit:
  `git commit -m "feat(styles): five colour-label tokens and the one place a mark's look is decided" -- src/styles/tokens.css src/styles/marks.css src/styles/index.css src/styles/motion.css src/styles/contrast.test.ts`

### Task 8: The info rail — the one surface with room, and the only one that flashes

**Files:** Modify `src/components/ExifRail.tsx`, `src/styles/exif-rail.css`; create `src/components/ExifRail.marks.test.tsx`. The ONLY task that touches any of them. **Follows Task 1.**

**Interfaces — Produces** (six new props on `ExifRail`, all OPTIONAL — Task 11 supplies them):

```tsx
  /** Phase 5A. Absent or false: the rail renders exactly what it rendered
   *  before, read-only "LrC rating" row included. */
  starsAndLabels?: boolean;
  /** The frame the rail is describing — only used to tell "the user set a
   *  star" apart from "the cursor moved to a starred frame". */
  frameId?: number;
  star?: Star;
  label?: LabelValue;
  onSetStar?: (star: Star | null) => void;
  onSetLabel?: (label: Label) => void;
```

**Consumes:** `Star`, `Label`, `LabelValue`, `LABELS`, `LABEL_NAME` (Task 1); the `.cull-mark-*` / `.cull-label-*` classes (Task 7).

**Ruling (EVERY new component prop in this phase is optional, and absent means render nothing).** The render tasks and the App wiring cannot land in one commit without one file having two owners, and a REQUIRED prop would make each render task's own `pnpm typecheck` fail until App caught up. Optional props with an "absent → render nothing" gate are also exactly the pattern this codebase already uses at three sites (`hasLrcRating`, `ratingColor.ts:25-28`, guarding `{showLrc && …}` in `GridView`, `ThumbCell` and `ExifRail`) and in `GridView`'s own `metadata?.[…] ?? null` / `selectedIndices?.has(idx) ?? false`. Each render task pins BOTH shapes — present and absent — so an unwired prop is a failing test in Task 11, not a silent blank.

**Ruling (with the layer on, the star row REPLACES the read-only "LrC rating" row).** They are the same property on disk: `xmp:Rating`, which `parse_lrc_rating` already hands the UI. The difference is that `metadata.lrcRating` is a snapshot taken at open and never updated, while `stars[id]` is live. Rendering both would show a stale second number beside the live one the moment the user presses a key. So: layer off → today's row, untouched; layer on → the interactive row, and the old one is not emitted. Cost if wrong: the rail names the row "Rating" instead of "LrC rating" when the layer is on.

**Ruling (five swatches, with the active one named).** The spec says "a label swatch with its name. Clickable". A single swatch showing the current label is not clickable into any other label, so the row draws all five (plus the active one's NAME as the row's value); the active swatch takes a ring. A `"custom"` label — the user's own Lightroom label — is drawn as a sixth, outlined swatch, and is never one of the five a click can produce. Cost if wrong: the row is 60 px wider than a single swatch, in the one column that scrolls.

**Ruling (the flash lives HERE and only here).** Spec §4 asks for "a brief flash on set". A per-cell flash in the grid or the strip would also fire every time a cell scrolls into the viewport — cells mount and unmount constantly — and telling a mount from a change per cell is state the grid deliberately does not keep. The rail describes one frame at a time and already re-renders on exactly the two inputs that matter, so `useChangeFlash` can tell "the user just set this" from "the cursor moved to a frame that already had it". See **Spec overrides**.

**Ruling (do not touch the four lines `icons.test.ts` quotes).** Two of its ALLOWLIST entries are `ExifRail.tsx` lines built as `` `${lrcA}★` `` in the compare rail's row-data object. This task does not edit the compare rail at all — `CompareExifRail` keeps its plain-text LrC row, because compare decides a pair and does not grade (the digits are unbound there).

- [ ] **Step 1: the failing test first.** Create `src/components/ExifRail.marks.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { EMPTY_METADATA, type ImageMetadata } from "../types";
import { ExifRail } from "./ExifRail";

/**
 * The rail's star and colour-label row. The `absent` half of every test is
 * the point: with `starsAndLabels` unset the rail must render EXACTLY what
 * it rendered before this feature, read-only LrC row included.
 */

afterEach(cleanup);

const META: ImageMetadata = { ...EMPTY_METADATA, lrcRating: 2 };

function renderRail(over: Partial<Parameters<typeof ExifRail>[0]> = {}) {
  return render(<ExifRail metadata={META} histogramUrl={undefined} {...over} />);
}

describe("the rail with the layer OFF", () => {
  it("renders the read-only LrC row and no mark row at all", () => {
    const { container } = renderRail();
    expect(container.querySelector(".cull-exif-rail__lrc")).not.toBeNull();
    expect(container.querySelector(".cull-mark-stars")).toBeNull();
    expect(container.querySelector(".cull-label-swatch")).toBeNull();
  });

  it("ignores a star and a label it was handed anyway", () => {
    // Off is off: a wiring mistake must render nothing, not a half-feature.
    const { container } = renderRail({ star: 4, label: "red" });
    expect(container.querySelector(".cull-mark-stars")).toBeNull();
    expect(container.querySelector(".cull-label-swatch")).toBeNull();
  });
});

describe("the rail with the layer ON", () => {
  it("replaces the read-only LrC row with the live star meter", () => {
    const { container } = renderRail({ starsAndLabels: true, star: 3 });
    // The same property on disk — rendering both would show a snapshot from
    // open beside the live value.
    expect(container.querySelector(".cull-exif-rail__lrc")).toBeNull();
    const meter = container.querySelector(".cull-mark-stars");
    expect(meter).not.toBeNull();
    expect(meter?.getAttribute("aria-label")).toBe("3 of 5 stars");
    expect(container.querySelectorAll(".cull-mark-star--on")).toHaveLength(3);
    expect(container.querySelectorAll(".cull-mark-star--off")).toHaveLength(2);
  });

  it("clicking a star sets it; clicking the one already set clears it", () => {
    const onSetStar = vi.fn((_s: number | null) => {});
    const { container } = renderRail({ starsAndLabels: true, star: 3, onSetStar });
    const stars = container.querySelectorAll<HTMLButtonElement>(".cull-mark-stars button");
    expect(stars).toHaveLength(5);
    fireEvent.click(stars[4]);
    expect(onSetStar).toHaveBeenCalledWith(5);
    fireEvent.click(stars[2]);
    expect(onSetStar).toHaveBeenLastCalledWith(null);
  });

  it("names the active label and rings its swatch", () => {
    const { container } = renderRail({ starsAndLabels: true, label: "blue" });
    expect(container.querySelectorAll(".cull-label-swatch")).toHaveLength(5);
    expect(container.querySelector(".cull-exif-rail__label-name")?.textContent).toBe("Blue");
    expect(container.querySelector(".cull-label-swatch.is-active")?.className).toContain(
      "cull-label--blue",
    );
  });

  it("shows a label CULL did not write as a sixth, outlined swatch", () => {
    const { container } = renderRail({ starsAndLabels: true, label: "custom" });
    expect(container.querySelectorAll(".cull-label-swatch")).toHaveLength(6);
    expect(container.querySelector(".cull-exif-rail__label-name")?.textContent).toBe("Custom");
    // …and it is not something a click can produce.
    const buttons = container.querySelectorAll<HTMLButtonElement>(".cull-exif-rail__labels button");
    expect(buttons).toHaveLength(5);
  });

  it("clicking a swatch sends the label key", () => {
    const onSetLabel = vi.fn((_l: string) => {});
    const { container } = renderRail({ starsAndLabels: true, onSetLabel });
    const buttons = container.querySelectorAll<HTMLButtonElement>(".cull-exif-rail__labels button");
    fireEvent.click(buttons[1]);
    expect(onSetLabel).toHaveBeenCalledWith("yellow");
  });

  it("flashes when the value CHANGES on one frame, not when the frame changes", () => {
    vi.useFakeTimers();
    try {
      const { container, rerender } = render(
        <ExifRail metadata={META} histogramUrl={undefined} starsAndLabels frameId={1} star={3} />,
      );
      const meter = () => container.querySelector(".cull-mark-stars");
      expect(meter()?.className).not.toContain("cull-mark-flash");

      // Same frame, new star → flash.
      rerender(
        <ExifRail metadata={META} histogramUrl={undefined} starsAndLabels frameId={1} star={4} />,
      );
      expect(meter()?.className).toContain("cull-mark-flash");
      vi.advanceTimersByTime(200);
      rerender(
        <ExifRail metadata={META} histogramUrl={undefined} starsAndLabels frameId={1} star={4} />,
      );
      expect(meter()?.className).not.toContain("cull-mark-flash");

      // New frame that happens to carry a different star → NO flash. A
      // per-cell version of this could not tell the two apart, which is why
      // the grid and the strip do not flash at all.
      rerender(
        <ExifRail metadata={META} histogramUrl={undefined} starsAndLabels frameId={2} star={1} />,
      );
      expect(meter()?.className).not.toContain("cull-mark-flash");
    } finally {
      vi.useRealTimers();
    }
  });
});
```

  Run it: red on `starsAndLabels` not being a prop (TS2322). Quote it.

- [ ] **Step 2: `src/components/ExifRail.tsx`.** Change line 1 to `import { memo, useEffect, useMemo, useRef, useState } from "react";`, extend the type import to `import type { ImageMetadata, Label, LabelValue, Rating, Star } from "../types";`, and add `import { LABELS, LABEL_NAME } from "../types";`.

  Add, after the `LRC_STAR_SLOTS` const:

```tsx
/** How long the set-flash lasts. Mirrors `--dur-fast` (tokens.css); the CSS
 *  owns the animation, this only owns how long the class stays on. */
const MARK_FLASH_MS = 120;

/**
 * True for one flash window after `value` changes while the FRAME stays the
 * same — "the user just set this", as opposed to "the cursor moved to a
 * frame that already had it". Mount never flashes.
 */
function useChangeFlash(frameId: number | undefined, value: unknown): boolean {
  const [flash, setFlash] = useState(false);
  const prev = useRef({ frameId, value });
  useEffect(() => {
    const was = prev.current;
    prev.current = { frameId, value };
    if (was.frameId !== frameId || was.value === value) return;
    setFlash(true);
    const t = window.setTimeout(() => setFlash(false), MARK_FLASH_MS);
    return () => window.clearTimeout(t);
  }, [frameId, value]);
  return flash;
}
```

  Add the six props to the destructuring and the type block (after `similar,` / `similar?: SimilarCtx | null;`) using the Interfaces block above verbatim. Then, in the body, after `const showLrc = hasLrcRating(lrc);`:

```tsx
  // The star row and the read-only LrC row are the SAME property on disk
  // (`xmp:Rating`). `lrcRating` is a snapshot taken at open; `star` is live.
  // With the layer on, only the live one is drawn.
  const marks = starsAndLabels === true;
  const starFlash = useChangeFlash(frameId, star);
  const labelFlash = useChangeFlash(frameId, label);
```

  Replace the `{showLrc && lrc != null && ( … )}` block inside the Frame section with:

```tsx
          {marks && (
            <div className="cull-exif-rail__row">
              <span className="cull-exif-rail__k">Rating</span>
              <span
                className={`cull-exif-rail__v cull-mark-stars${starFlash ? " cull-mark-flash" : ""}`}
                role="img"
                aria-label={`${star ?? 0} of 5 stars`}
              >
                {LRC_STAR_SLOTS.map((slot) => (
                  <button
                    key={slot}
                    type="button"
                    className="cull-exif-rail__star-btn"
                    // Clicking the star already set clears the rating, which
                    // is both Lightroom's behaviour and the only mouse route
                    // to what `0` does.
                    onClick={() => onSetStar?.(star === slot ? null : (slot as Star))}
                    aria-label={star === slot ? "Clear the rating" : `${slot} stars`}
                  >
                    <Star
                      className={slot <= (star ?? 0) ? "cull-mark-star--on" : "cull-mark-star--off"}
                      {...ICON.sm}
                      fill="currentColor"
                      aria-hidden
                    />
                  </button>
                ))}
              </span>
            </div>
          )}
          {marks && (
            <div className="cull-exif-rail__row">
              <span className="cull-exif-rail__k">Label</span>
              <span className="cull-exif-rail__v cull-exif-rail__labels">
                <span className="cull-exif-rail__label-name">
                  {label ? LABEL_NAME[label] : "—"}
                </span>
                {LABELS.map((key) => (
                  <button
                    key={key}
                    type="button"
                    className={`cull-label-swatch cull-label--${key}${
                      label === key ? ` is-active${labelFlash ? " cull-mark-flash" : ""}` : ""
                    }`}
                    onClick={() => onSetLabel?.(key)}
                    aria-label={LABEL_NAME[key]}
                    aria-pressed={label === key}
                  />
                ))}
                {label === "custom" && (
                  // The user's own Lightroom label. Shown so it is never a
                  // surprise, outlined so it cannot be mistaken for one of
                  // the five, and not a button: CULL does not write it.
                  <span
                    className="cull-label-swatch cull-label--custom is-active"
                    aria-label="Custom label"
                  />
                )}
              </span>
            </div>
          )}
          {!marks && showLrc && lrc != null && (
            <div className="cull-exif-rail__row">
              <span className="cull-exif-rail__k">LrC rating</span>
              <span
                className="cull-exif-rail__v cull-exif-rail__lrc"
                role="img"
                aria-label={`${lrc} of 5 stars`}
              >
                {LRC_STAR_SLOTS.map((slot) => (
                  <Star
                    key={slot}
                    className={
                      slot <= lrc ? "cull-exif-rail__lrc-filled" : "cull-exif-rail__lrc-dim"
                    }
                    {...ICON.sm}
                    fill="currentColor"
                    aria-hidden
                  />
                ))}
              </span>
            </div>
          )}
```

  In the "Reading…" fallback condition on the next lines, add `&& !marks` so the rail does not print "Reading…" beside a live Rating row on a frame whose EXIF has not landed:
  `{!body && !lens && !timeStr && !dateStr && !imageSize && !showLrc && !marks && (`

- [ ] **Step 3: `src/styles/exif-rail.css`.** Append:

```css
/* ── Stars and colour labels (Phase 5A) ───────────────────────────────────
   POSITION and hit area only; the look of every mark is in marks.css. */

/* The star slots are buttons so the rail is the one mouse route to a rating,
   but they must not look or measure like buttons. */
.cull-exif-rail__star-btn {
  appearance: none;
  background: none;
  border: none;
  padding: 0;
  margin: 0;
  line-height: 0;
  cursor: pointer;
  color: inherit;
}

.cull-exif-rail__star-btn:focus-visible {
  border-radius: var(--r-1);
  box-shadow: var(--ring-inset);
  outline: none;
}

/* The label row: the active label's NAME, then the five swatches. */
.cull-exif-rail__labels {
  display: inline-flex;
  align-items: center;
  align-self: center;
  gap: var(--sp-1);
  line-height: 1;
}

.cull-exif-rail__label-name {
  color: var(--text-2);
  margin-right: var(--sp-1);
}

.cull-exif-rail__labels button {
  appearance: none;
  border: none;
  padding: 0;
  margin: 0;
  cursor: pointer;
}

.cull-exif-rail__labels button:focus-visible {
  box-shadow: var(--ring-inset);
  outline: none;
}

/* The active swatch wears a ring, so which one is set survives a
   screenshot, a colour-blind reader and a dark room. */
.cull-label-swatch.is-active {
  box-shadow: 0 0 0 1.5px var(--bg), 0 0 0 3px var(--text-2);
}
```

- [ ] **Step 4: run and watch the reds.** `npx vitest run src/components/ExifRail.marks.test.tsx` — 8 pass. By hand:
  - `renders the read-only LrC row and no mark row at all` → change `const marks = starsAndLabels === true;` to `const marks = true;`.
  - `replaces the read-only LrC row with the live star meter` → change the `{!marks && showLrc && …}` guard back to `{showLrc && …}`; expect the `.cull-exif-rail__lrc` assertion to fail.
  - `clicking the one already set clears it` → change `star === slot ? null : slot` to just `slot`.
  - `shows a label CULL did not write as a sixth, outlined swatch` → delete the `{label === "custom" && …}` block.
  - `flashes when the value CHANGES on one frame` → change `useChangeFlash`'s early return to `if (was.value === value) return;` (dropping the frame check) and confirm the last assertion fails.
  Edit each back by hand; quote each red. Also re-run `npx vitest run src/components/icons.test.ts` and `src/components/memoBailout.test.tsx` — the rail is still a `memo` component and still contains no `★` character outside the two allowlisted compare-rail lines.
- [ ] **Step 5:** gate green. Report `pnpm test`'s before/after pair (**+8**). Commit:
  `git commit -m "feat(rail): a live star meter and a colour-label row behind the setting" -- src/components/ExifRail.tsx src/components/ExifRail.marks.test.tsx src/styles/exif-rail.css`

### Task 9: The grid cell and the filmstrip cell

**Files:** Modify `src/components/GridView.tsx`, `src/styles/grid.css`, `src/components/ThumbCell.tsx`, `src/styles/strip.css`; create `src/components/cellMarks.test.tsx`. The ONLY task that touches any of them. **Follows Task 1.**

**Interfaces — Produces** (all OPTIONAL; Task 11 supplies them):

```tsx
// GridView (the exported component App renders)
  starsAndLabels?: boolean;
  stars?: Record<number, Star>;
  labels?: Record<number, LabelValue>;

// ThumbCell (App builds these per cell in its strip renderer)
  /** Phase 5A. Absent or false: the cell renders exactly as before. */
  starsAndLabels?: boolean;
  label?: LabelValue;
```

**Consumes:** `Star`, `LabelValue` (Task 1); `.cull-mark-count`, `.cull-label-bar`, `.cull-label--*` (Task 7).

**Ruling (the grid takes the one free corner, and gives up the LrC badge).** Top-left is the LrC badge, bottom-right the verdict dot, bottom-left the hover filename pill; **top-right is free** (scout §5.2). The star readout goes there as the NUMBER plus one filled Lucide `Star` — not five glyphs, which do not survive a contact-sheet cell, and not the `★` character, which `icons.test.ts` bans from the chrome. With the layer on the LrC badge is not emitted, for the same reason as in the rail: it is the same property on disk, snapshotted at open.

**Ruling (the filmstrip gets the bar only).** A 76×54 cell already carries a top-left badge and a bottom-right dot at 3 px insets; a third marker is the tightest render surface in the app (scout §5.3). Per spec §4 the strip shows the label bar and no star. The bar is 4 px and sits inside `.cull-thumb__frame`, which already has `overflow: hidden` and a 1 px radius, so it clips cleanly and needs **no new rule in `strip.css`** — if it turns out one is needed, add it there and say so; `strip.css` is this task's to own either way.

**Ruling (the label bar hugs the FRAME, not the cell).** `.cull-grid__cell` carries 9 px of padding that draws the inter-image corridor and the burst boxes' room. A bar at the cell's edge would cross that corridor, so the grid overrides the shared bar's three offsets by exactly that padding.

**Ruling (do not re-word the two lines `icons.test.ts` quotes).** `GridView.tsx`'s `<div className="cull-grid__lrc-badge" aria-label={\`LrC ${lrcRating}★\`}>` and `ThumbCell.tsx`'s twin are in the ALLOWLIST **as exact trimmed source lines**, and a second test fails if an allowlisted line stops existing. Gate them by changing the CONDITION on the line above, never the line itself.

- [ ] **Step 1: the failing test first.** Create `src/components/cellMarks.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { createRef, type RefObject } from "react";

const thumb = vi.hoisted(() => ({
  value: {
    url: "blob:thmb",
    gridUrl: undefined as string | undefined,
    shimmerDelayMs: 0,
    probeOnLoad: undefined,
  },
}));
vi.mock("../image/useThumb", () => ({
  useThumb: () => thumb.value,
  thumbDisplayUrl: (i: { thumbUrl?: string }) => i.thumbUrl,
}));

import { GridView } from "./GridView";
import { ThumbCell } from "./ThumbCell";
import type { Img, LabelValue, Star } from "../types";

// jsdom has no ResizeObserver; GridView's tracking effects only need
// observe/disconnect to exist for this fixed-size fixture.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverStub);

const images: Img[] = [{ id: 1, path: "/a.cr3", filename: "IMG_0001.CR3", srcFolder: "/" }];

function renderGrid(over: { starsAndLabels?: boolean; stars?: Record<number, Star>; labels?: Record<number, LabelValue>; metadata?: Record<string, { lrcRating: number | null }> } = {}) {
  const ref: RefObject<HTMLDivElement | null> = createRef<HTMLDivElement>();
  return render(
    <GridView
      images={images}
      visibleIndices={[0]}
      currentIndex={0}
      cols={2}
      contentWidth={600}
      ratings={{}}
      selectedIndices={new Set<number>()}
      onPick={vi.fn((_i: number, _m: { shift: boolean; ctrl: boolean }) => {})}
      containerRef={ref}
      onViewportChange={vi.fn((_f: number, _l: number) => {})}
      {...(over as object)}
    />,
  );
}

afterEach(cleanup);

describe("the grid cell with the layer OFF", () => {
  test("draws neither a star count nor a label bar, and keeps the LrC badge", () => {
    const { container } = renderGrid({
      stars: { 1: 3 },
      labels: { 1: "red" },
      metadata: { "/a.cr3": { lrcRating: 2 } },
    });
    expect(container.querySelector(".cull-mark-count")).toBeNull();
    expect(container.querySelector(".cull-label-bar")).toBeNull();
    expect(container.querySelector(".cull-grid__lrc-badge")).not.toBeNull();
  });
});

describe("the grid cell with the layer ON", () => {
  test("puts the count in the free corner and the bar on the bottom edge", () => {
    const { container } = renderGrid({ starsAndLabels: true, stars: { 1: 3 }, labels: { 1: "blue" } });
    const count = container.querySelector(".cull-grid__star");
    expect(count?.textContent).toBe("3");
    expect(count?.getAttribute("aria-label")).toBe("3 of 5 stars");
    // The number is text; the star beside it is a Lucide SVG, never the ★
    // character (icons.test.ts fails on one in the chrome).
    expect(count?.querySelector("svg")).not.toBeNull();
    const bar = container.querySelector(".cull-label-bar");
    expect(bar?.className).toContain("cull-label--blue");
    expect(bar?.className).toContain("cull-grid__label-bar");
  });

  test("drops the read-only LrC badge — it is the same property, snapshotted", () => {
    const { container } = renderGrid({
      starsAndLabels: true,
      stars: { 1: 4 },
      metadata: { "/a.cr3": { lrcRating: 2 } },
    });
    expect(container.querySelector(".cull-grid__lrc-badge")).toBeNull();
    expect(container.querySelector(".cull-grid__star")?.textContent).toBe("4");
  });

  test("an unstarred, unlabelled frame draws nothing extra", () => {
    const { container } = renderGrid({ starsAndLabels: true });
    expect(container.querySelector(".cull-grid__star")).toBeNull();
    expect(container.querySelector(".cull-label-bar")).toBeNull();
  });
});

describe("the filmstrip cell", () => {
  const cell = (over: { starsAndLabels?: boolean; label?: LabelValue } = {}) =>
    render(
      <ThumbCell
        img={images[0]}
        index={0}
        isCurrent={false}
        rating={undefined}
        dimmed={false}
        onPick={vi.fn((_i: number) => {})}
        {...over}
      />,
    );

  test("draws no bar with the layer off, even when handed a label", () => {
    const { container } = cell({ label: "green" });
    expect(container.querySelector(".cull-label-bar")).toBeNull();
  });

  test("draws the bar and NOTHING else — 76x54 has no room for a third mark", () => {
    const { container } = cell({ starsAndLabels: true, label: "green" });
    const bar = container.querySelector(".cull-label-bar");
    expect(bar?.className).toContain("cull-label--green");
    expect(container.querySelector(".cull-mark-count")).toBeNull();
    expect(container.querySelector(".cull-mark-stars")).toBeNull();
  });

  test("a label CULL did not write still shows, in the neutral ink", () => {
    const { container } = cell({ starsAndLabels: true, label: "custom" });
    expect(container.querySelector(".cull-label-bar")?.className).toContain("cull-label--custom");
  });
});
```

  Run it: red on the unknown props. Quote the TS error.

- [ ] **Step 2: `src/components/GridView.tsx`.** Extend the type import to include `LabelValue` and `Star`. Add the three optional props to `GridView`'s props type and destructuring, and pass two per-cell values down in the `cells.map` call (after `lrcRating={…}`):

```tsx
            starsAndLabels={starsAndLabels}
            star={stars?.[images[idx].id]}
            label={labels?.[images[idx].id]}
```

  Add the matching three to `GridCell`'s props type and destructuring:

```tsx
  starsAndLabels?: boolean;
  star?: Star;
  label?: LabelValue;
```

  In `GridCell`'s body, replace `const showLrc = hasLrcRating(lrcRating);` with:

```tsx
  // With the star layer on, the LrC badge and the star readout are the SAME
  // property on disk (`xmp:Rating`) — but `lrcRating` is a snapshot taken at
  // open while `star` is live, so drawing both would show a stale second
  // number beside the current one.
  const marks = starsAndLabels === true;
  const showLrc = !marks && hasLrcRating(lrcRating);
```

  And insert, between the `{showLrc && ( … )}` block and the hover filename block:

```tsx
      {/* The one free corner (top-left is the LrC badge, bottom-right the
          verdict dot, bottom-left the hover filename). The NUMBER plus one
          filled star — five glyphs do not survive a contact-sheet cell — and
          the star is a Lucide SVG, never the ★ character (icons.ts). */}
      {marks && star !== undefined && (
        <div className="cull-grid__star cull-mark-count" aria-label={`${star} of 5 stars`}>
          {star}
          <Star size={11} strokeWidth={2.4} fill="currentColor" aria-hidden />
        </div>
      )}
      {/* A BAR along the bottom edge, never a dot: the verdict is a glyph in
          a circle, so shape and place tell the two apart before hue has to. */}
      {marks && label !== undefined && (
        <div
          className={`cull-label-bar cull-grid__label-bar cull-label--${label}`}
          aria-label={`${label} label`}
        />
      )}
```

- [ ] **Step 3: `src/styles/grid.css`.** Append:

```css
/* ── Stars and colour labels (Phase 5A) ───────────────────────────────────
   POSITION only; the look is in marks.css. */

/* The free corner. Same dark pill as the LrC badge it replaces, so the two
   marks never look like two different systems. */
.cull-grid__star {
  position: absolute;
  top: 5px;
  right: 5px;
  background: rgba(0, 0, 0, 0.55);
  padding: 2px 4px;
  border-radius: var(--r-1);
  z-index: 3;
  pointer-events: none;
}

/* The bar hugs the FRAME's bottom edge, not the cell's: the cell's 9px
   padding is the inter-image corridor (and the burst boxes' room), and a bar
   drawn across it would read as belonging to the gap. */
.cull-grid__label-bar {
  left: 9px;
  right: 9px;
  bottom: 9px;
}
```

- [ ] **Step 4: `src/components/ThumbCell.tsx`.** Extend the type import to include `LabelValue`, add two optional props to `ThumbCellProps` and the destructuring:

```tsx
  /** Phase 5A. Absent or false: the cell renders exactly as it did before. */
  starsAndLabels?: boolean;
  label?: LabelValue;
```

  and insert, as the last child INSIDE `<div className={frameClass} …>` (after the LrC / role badge ternary, before that div closes):

```tsx
        {/* The colour label, and only the colour label: this cell is 76x54
            with two badges already on it at 3px insets, so a third marker is
            the tightest surface in the app. The star lives in the grid and
            the rail. */}
        {starsAndLabels === true && label !== undefined && (
          <div className={`cull-label-bar cull-label--${label}`} aria-label={`${label} label`} />
        )}
```

- [ ] **Step 5: run and watch the reds.** `npx vitest run src/components/cellMarks.test.tsx` — 7 pass. Also re-run `npx vitest run src/components/GridCell.layers.test.tsx src/components/icons.test.ts`: the layer tests must be untouched, and `icons.test.ts`'s "every allowlisted character still matches a line that is there" must still pass — if it does not, you re-worded one of the two badge lines. By hand:
  - `draws neither a star count nor a label bar…` → change `const marks = starsAndLabels === true;` to `const marks = true;` in `GridCell`.
  - `drops the read-only LrC badge` → change `const showLrc = !marks && hasLrcRating(lrcRating);` back to `hasLrcRating(lrcRating)`.
  - `puts the count in the free corner…` → change the bar's class template to drop `cull-label--${label}`.
  - `draws no bar with the layer off` (strip) → change `starsAndLabels === true && label !== undefined` to `label !== undefined`.
  Edit each back by hand; quote each red.
- [ ] **Step 6:** gate green. Report `pnpm test`'s before/after pair (**+7**). Commit:
  `git commit -m "feat(cells): a star count in the grid's free corner and a label bar on both cells" -- src/components/GridView.tsx src/styles/grid.css src/components/ThumbCell.tsx src/styles/strip.css src/components/cellMarks.test.tsx`
  (Drop `src/styles/strip.css` from the pathspec if it needed no change.)

---

## Implementation note (2026-09-21)

**A lean run.** Two days of the full pipeline had used most of Oliver's weekly limit, so this phase ran on a fraction of it: the planner was stopped before its self-review (this plan's Tasks 1–9 are its first draft; nobody fact-checked them), implementers were told so and verified every step against the code, there were no per-task reviewers, and the careful review went where data can be lost — ONE data-safety review of the Rust sidecar writer, ONE whole-branch review, one fix wave, one scoped re-review of the last Rust commit, and a live run on scratch copies. Six multi-task implementers instead of ten; the integration task (App wiring, restore at open, hints, Settings, docs) was briefed by the controller in prose. Gates at the tip: 1,051 tests in 91 files (931 in 84 before), lint, lint:css, typecheck, typecheck:tests, build, prod audit; `cargo fmt --check`, clippy, 202 Rust tests (166 before).

### What shipped

- **Stars and colour labels as an optional layer, off by default.** `starsAndLabels` switches the keymap's shape: off is today, byte for byte; on is Lightroom's row — `1`–`5` stars, `0` clears, `6`–`9` red / yellow / green / blue (re-press clears), `Shift+6` purple, and the filters move to `Shift+1`–`Shift+5`, matched on `e.code`. Not bound in compare. One action per press; one undo step per press, including a multi-select.
- **Orthogonal to the verdict.** `Rating` is not widened: `stars` and `labels` are two maps beside `ratings`. A starred frame with no verdict is still unrated; a reject keeps its marks and Move rejects carries them.
- **On disk**: `xmp:Rating` and `xmp:Label` (English strings), through the same guarded writer — `require_source` first, one per-path queue for all three write kinds, latest-wins per path and per kind. No bulk migration of existing sidecars. Marks read back at open, validated at the boundary.
- **Looks**: a star row and five swatches in the info rail (clickable), a compact count in the grid cell's free corner, a 4 px label bar on grid and filmstrip cells. Five `--label-*` tokens (lowest contrast 6.5:1); a label is told from a verdict by shape and place.
- **Every key hint follows the setting** — footer tips, empty-filter hints, the help sheet, Settings, the README.

### Where the spec was wrong, and what was ruled instead

- **CULL never overwrites a custom Lightroom label.** The spec let a label key replace one. The frontend only knows such a label as `"custom"`, so undo could not put the user's text back: data lost through press + undo. Now refused in the frontend AND the backend (`custom label kept` — not a failed save), the file's bytes untouched.
- **The legacy "lone 1★ = favourite" reader is gated on the pre-rebrand tool stamp**, not on a namespace declaration. See below — this one mattered with the setting OFF.
- A star written into a sidecar that has a verdict and no marker stamps `cull:fav="no"`; ownership of the favourite's courtesy star is decided from the file as it was, never from the half-edited output.
- A star or label cleared on a frame that then holds nothing sends the existing clear, so CULL leaves no empty sidecar on the NAS.
- Setting or clearing a label removes a stale `xmp:LabelColor`.

### What review caught — all of it before any real photo was touched

- **A false reject.** The `cull:fav="no"` marker declared CULL's namespace in a Lightroom-written sidecar; an unrate stripped the marker but not the declaration; the legacy reader then turned THEIR `xmp:Rating` of `5` / `0` / `-1` into favourite / keep / **reject** — and a false reject feeds Move rejects and the trash. With the setting off. Found by the data-safety review; the suite was green with the fix applied by hand, i.e. entirely unpinned.
- **Star 1, then keep, deleted the star** while reporting it saved (ownership read from the half-written output). Found by the whole-branch review; also unpinned.
- **A save that did not happen** (pre-existing): on a single-quoted sidecar every insert was a no-op and the unchanged-bytes path returned Ok. The writer now verifies the intent landed and errors otherwise.
- Star 5 on an unrated frame read back as a favourite; a star on a keep written by the shipped build was refused forever or turned it into a favourite; with two `rdf:Description` blocks a prefix could land unbound; the grid's label bar rendered in the gap between images (dead CSS by import order); an undone star could have cleared a kept frame's verdict with 1,044 tests green; `created_by_cull` — which gates the file DELETE — matched `CreatorTool="CULLIGAN Water"`.
- The draft plan itself opened one of these (the marker's namespace residue); the implementer caught the first half of it before any review.

### Verification

Tests and gates; the Rust transforms driven as a state machine by two reviewers against byte-exact copies of what main writes; and a live run, PC idle, **scratch copies only**: star 1 then keep → `pick=1 Rating=1 cull:fav=no` on disk; star 5 + red + reject → Move rejects carried the sidecar with both marks, no orphan left behind; star then clear and label then re-press on one frame → no sidecar; undo ×3 removed the marks and deleted the two now-empty CULL sidecars, leaving the keep's untouched; `Shift+1`, `Shift+6`, `8` behaved; the label bar sits on the thumbnail. Screenshots: `~/.claude/plans/cull-audit-2026-09-13/phase-5a-shots/`. Driver lesson: `SendKeys` injects keys with no scan code, so `KeyboardEvent.code` arrives empty and every `e.code` binding looks dead — send with real scan codes.
Not verified: a real Lightroom import of these sidecars (no Lightroom run here; `sample_cr3s/` is absent, so the two real-Lightroom fixture tests skip); whether Lightroom 15 writes `xmp:LabelColor`.

### Left for later

- Clearing the star on a favourite that rides a user's 5★ writes CULL's courtesy 1★ (the spec's rule; Lightroom then shows 1★).
- A pre-rebrand Rating-only sidecar still treats the star as the verdict until its first rating write.
- No `keyCode` fallback when `e.code` is empty (remote-desktop and macro tools); `Shift+Numpad` misses the filters, as on main.
- Filtering by stars; stars in compare; localised label strings.
- A few keymap tests are timing-sensitive under heavy machine load (seen only while `cargo test` ran beside Vitest).
