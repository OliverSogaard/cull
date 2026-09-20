# Phase 3B — Scale and layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make CULL's chrome answer the window it is in — a grid the user can resize, a filmstrip that grows on a tall window, a footer and info rail that shed instead of clip, a home screen that uses a 2560-px window — and give the grid a sharp thumbnail to show at those sizes.

**Architecture:** Most of this is CSS: the seven layout tokens that exist but were never referenced get wired to their use sites, and four window-width / window-height breakpoints move those tokens. Three units carry real logic: a `StripMetrics` value chosen by one `matchMedia` subscription and pushed into CSS as custom properties; a `gridSize` setting with pure stepping maths driving `cols`; and a new backend tier (`gridthumb.rs` → `CacheTier::Grid` → `read_grid_thumb`) fronted by a sixth `TierLane` in `imageStore` whose blobs the grid cell paints over the THMB.

**Tech Stack:** Tauri 2, Rust (pure-Rust CR3 pipeline: zune-jpeg, fast_image_resize, jpeg-encoder), React 19, TypeScript 5.8 strict, plain CSS with tier-2 tokens, lucide-react, Vitest 4, stylelint 17, pnpm 10.

**Spec:** `docs/superpowers/specs/2026-09-20-phase-3b-scale-and-layout-design.md` (binding — the picked options and their exact values). Background: `~/.claude/plans/cull-audit-2026-09-13/phase-3b-inventory.md` (current values), `phase-3b-gridthumb-scout.md` (the grid-thumbnail design + its addendum), `phase-3b-board-report.md` (the numbers Oliver picked from). Those three are POINTERS, not truth — the code wins.

## Global Constraints

- Branch `phase-3b-scale-and-layout`, cut from `main` @ `f99c0a2` (plus `59d2a93`, the spec commit). Every file:line in this plan was read at that tip; if a symbol moved, the **name** wins over the line number, and report the drift.
- **CR3 only.** No other RAW format, no JPEG ingest, no format branching.
- **Scope is the spec.** No drive-by refactors, no new dependencies (JS or Rust), no renames outside a task's own Files list. If the code contradicts the plan, the code wins — report it rather than "fixing" the surroundings.
- **Tests never import `node:*`.** `@types/node` is not installed, so `node:fs` / `node:path` fail both `pnpm typecheck:tests` and the type-aware lint. Read source files with
  `const files = import.meta.glob<string>(pattern, { query: "?raw", eager: true, import: "default" });`
  (always pass the `<string>` type argument). `vite.config.ts`'s `test.css.include` is already scoped to `/\.css\?.*\braw\b/`, so `?raw` CSS reads return real text while ordinary CSS imports stay stubbed. Every such test must first assert the glob returned readable text (`Object.keys(files).length` > 0 and a known substring), or the suite passes on empty strings.
- **Test files are linted type-aware.** Type every `vi.fn` callback (`vi.fn((_x: T) => {})`), and hoist anything a `vi.mock` factory closes over with `vi.hoisted`. Unused bindings need a `_` prefix.
- **jsdom only via a first-line docblock**: `// @vitest-environment jsdom` as line 1 of the file. Default env is node.
- **The app has NO global CSS reset.** Any rule that sets a `height`/`width` alongside padding or a border must declare `box-sizing: border-box` itself, or the rendered box is larger than the number. Chromium's UA sheet also resets `text-transform` and `letter-spacing` on `<button>`, so a button that must inherit an ancestor's casing has to restate it.
- **Focus rings come from `--ring` / `--ring-inset`** (`src/styles/tokens.css`); never invent an outline. `--ring-inset` is for controls with less than 4 px to a neighbour or a window edge.
- **Motion rules live in `src/styles/motion.css`.** `src/styles/motion.test.ts` fails on an `@keyframes` name that no `reviewed:` marker names. Opacity-only transitions are not motion and need no entry.
- **The display is 240 Hz.** Never assume 60 Hz and never batch work "per animation frame" — a rAF coalescer drops 3 of every 4 events on this machine. Where throttling is needed, use an explicit millisecond window.
- **Immutable updates** (spread, never mutate a settings object or a profile in place). **No `console.log`.**
- **Sentence case** for every user-visible string; CSS does the uppercasing where a surface wants it.
- **Icons come from `src/components/icons.ts`'s `ICON` scale.** No Unicode chrome glyph outside `src/components/icons.test.ts`'s `ALLOWLIST`, and every allowlist entry must match a real trimmed source line.
- **TDD**: write the failing test first, watch it fail for the right reason, then implement.
- **Commits** are conventional (`feat:`, `fix:`, `refactor:`, `style:`, `perf:`, `docs:`, `test:`), always in pathspec form — `git commit -m "<type>: <desc>" -- <files>` — with **no attribution trailers**. Never `git add -A`, never a bare `git commit`. The prettier hook reformats after a commit: content leftovers go in a follow-up `style:` pathspec commit; line-ending-only noise is `git add <file>`.
- **Never run the app**, never open a real photo folder, never touch `C:\Canon Media`. Task 13 is the one task that launches a browser, and only against a local file it serves itself.
- **Gate for every task** (run from the repo root): `pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm lint:css && pnpm test`.
  **Rust tasks additionally** run, from `src-tauri/` — exactly as `.github/workflows/ci.yml` does: `cargo fmt --check`, then `cargo clippy --all-targets -- -D warnings`, then `cargo test`.
  The final task adds `pnpm build` and `pnpm css:census`.
- `design-board/` is git-excluded and is the verification surface — read it if you like, never edit or commit it.

---

### Task 1: Window colour, minimum width, title-bar reservation, layout tokens wired

**Files:** Modify `src-tauri/tauri.conf.json`, `src/styles/tokens.css`, `src/styles/statusbar.css`, `src/styles/chrome.css`, `src/styles/help.css`. Test: create `src/styles/layout.test.ts`.

**Interfaces — Produces:** in `src/styles/tokens.css`, `--bar-h: 36px`, `--winbtn-w: 44px` and a new `--winbtn-reserve: calc(var(--winbtn-w) * 4)` (the four Windows caption buttons `WindowControls.tsx` renders: settings · minimize · maximize · close). No JS interface.

- [ ] **Step 1: failing test** — `src/styles/layout.test.ts` (node env, raw glob):

```ts
import { describe, expect, test } from "vitest";

const sheets = import.meta.glob<string>("./**/*.css", {
  query: "?raw",
  eager: true,
  import: "default",
});
const sheet = (name: string): string => {
  const css = sheets[name];
  if (css === undefined) throw new Error(`no stylesheet ${name}`);
  return css;
};

/** The declarations of the first rule whose selector list matches `selector`. */
export const ruleBody = (css: string, selector: string): string => {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`no rule \`${selector}\``);
  return css.slice(at, css.indexOf("}", at));
};

describe("layout tokens are wired, not decorative", () => {
  test("the stylesheets arrive as readable text", () => {
    expect(Object.keys(sheets).length).toBeGreaterThan(10);
    expect(sheet("./tokens.css")).toContain(":root {");
  });

  test("the title bar reserves the real width of the four caption buttons", () => {
    expect(sheet("./tokens.css")).toMatch(/--winbtn-w:\s*44px/);
    expect(sheet("./tokens.css")).toMatch(/--winbtn-reserve:\s*calc\(var\(--winbtn-w\) \* 4\)/);
    expect(ruleBody(sheet("./statusbar.css"), ".cull-statusbar--top")).toContain(
      "padding: 0 var(--winbtn-reserve) 0 14px",
    );
  });

  test("the 36px chrome bar is one token, referenced everywhere it is used", () => {
    for (const [file, selector] of [
      ["./statusbar.css", ".cull-statusbar--top"],
      ["./chrome.css", ".cull-wincontrols"],
      ["./chrome.css", ".cull-winbtn"],
    ] as const) {
      expect(ruleBody(sheet(file), selector), `${file} ${selector}`).toContain("var(--bar-h)");
    }
    expect(ruleBody(sheet("./help.css"), ".cull-help")).toContain("inset: var(--bar-h) 0 0");
    expect(ruleBody(sheet("./chrome.css"), ".cull-winbtn")).toContain("width: var(--winbtn-w)");
  });
});
```

Run it: every assertion after the first fails (the tokens exist but nothing references them, and `--winbtn-reserve` does not exist).

- [ ] **Step 2: tokens.** In `src/styles/tokens.css`'s `/* layout */` block, keep `--bar-h: 36px;` and `--winbtn-w: 44px;` and add directly under them:

```css
  /* The Windows caption strip WindowControls actually draws: settings ·
     minimize · maximize · close, each --winbtn-w wide. The title bar reserves
     exactly this much on the right so the brand row can never slide under a
     button (148px reserved four 44px buttons and came up 28px short). */
  --winbtn-reserve: calc(var(--winbtn-w) * 4);
```

- [ ] **Step 3: wire them.** Mechanical edits, value-for-value:
  - `src/styles/statusbar.css` `.cull-statusbar--top`: `flex: 0 0 36px` → `flex: 0 0 var(--bar-h)`; `padding: 0 148px 0 14px` → `padding: 0 var(--winbtn-reserve) 0 14px`.
  - `src/styles/chrome.css` `.cull-wincontrols`: `height: 36px` → `height: var(--bar-h)`.
  - `src/styles/chrome.css` `.cull-winbtn`: `width: 44px` → `width: var(--winbtn-w)`; `height: 36px` → `height: var(--bar-h)`.
  - `src/styles/help.css` `.cull-help`: `inset: 36px 0 0` → `inset: var(--bar-h) 0 0`.
  - Leave the macOS overrides (`:root[data-platform="mac"] .cull-statusbar--top`, `padding: 0 60px 0 84px`) exactly as they are: on macOS only the gear renders, and those numbers are the traffic-light metric, not a multiple of `--winbtn-w`.
  - Leave `.cull-statusbar`'s `flex: 0 0 38px` alone — the bottom bar is 38 px, a different number from `--bar-h`.
- [ ] **Step 4: the window.** In `src-tauri/tauri.conf.json`, inside `app.windows[0]`: `"minWidth": 800` → `"minWidth": 1024`, and `"backgroundColor": "#000000"` → `"backgroundColor": "#0c0c0d"`. `minHeight` stays `500`, `width`/`height` stay `1600`/`1000`. `#0c0c0d` is `--bg` (`tokens.css:5`) and `index.html`'s inline `html, body { background: #0c0c0d }`, so launch and resize stop flashing black.
- [ ] **Step 5:** `zoomHotkeysEnabled` is deliberately absent from `tauri.conf.json`. Its schema default is `false` (`node_modules/@tauri-apps/cli/config.schema.json` → `WindowConfig.zoomHotkeysEnabled`), which on Windows sets WebView2's `IsZoomControlEnabled` to false — so Ctrl+wheel and Ctrl+± do NOT zoom the webview today. **Do not add the key.** Task 6's wheel handler still calls `preventDefault` on a non-passive listener, because that is what stops the grid's own scroll, not a browser zoom.
- [ ] **Step 6:** gate green. Commit: `feat(ui): first paint is --bg, the title bar reserves all four caption buttons, minimum window 1024`.

### Task 2: The footer sheds instead of clipping

**Files:** Modify `src/components/StatusBar.tsx`, `src/utils/path.ts` (+ `src/utils/path.test.ts`), `src/utils/saveStatusCopy.ts` (+ `src/utils/saveStatusCopy.test.ts`), `src/styles/base.css`, `src/styles/chrome.css`, `src/styles/statusbar.css`, `src/styles/stage.css`. Test: create `src/components/StatusBar.shed.test.tsx`; extend `src/styles/layout.test.ts` (Task 1's file).

**Interfaces — Consumes:** `layout.test.ts`'s `ruleBody` helper (Task 1). **Produces:**
- `src/utils/path.ts`: `export function extOf(filename: string): string` — the extension *including* its dot (`"IMG_0001.CR3"` → `".CR3"`), `""` when there is none. Exact complement of the existing `stripExt`.
- `src/utils/saveStatusCopy.ts`: `export function unsavedCountLabel(failedCount: number): string` (`"3 unsaved"`), `export const UNSAVED_ACTION_TAIL = " · retry"`, `export const MISSING_ACTION_TAIL = " · check again"`. `unsavedLabel` and `missingCheckAgainLabel` keep their signatures and their exact output (other surfaces use them).
- **No new `StatusBarProps` fields.** Every shed label is derived inside `StatusBar` from props it already has, so the Phase-2 grouped-props memo (`statusFrame` / `statusSave` / … in `App.tsx:1306-1388`) is untouched and still bails.

**The arithmetic (why these breakpoints, and what else had to shed).** Widths from the real CSS; mono advance is `0.6em` per character plus the rule's `letter-spacing`.

| Right cluster at < 1100 | px |
| --- | --- |
| `.cull-statusbar__pos` (`width: 12ch`, 11 px mono) | 79 |
| gap | 14 |
| `.cull-filter-tabs`: 38 (padding 18+18, borders 1+1) + ALL 47 + UNRATED 77 + KEEPS 62 + `SMART · 4194` 115 + margins 8 | 347 |
| gap | 14 |
| `.cull-statusbar__finish` = `btn--sm`, label `FINISH` (10 px mono, `--track-label`) | 66 |
| **right total** | **520** |

Available content width at 1024 = 1024 − 36 (`.cull-statusbar` padding `0 18px`) − 36 (two 18 px gaps around the spacer) = **952**. Left budget = 952 − 520 = **432**.

Left cluster, worst case, after the spec's shedding — the mutually exclusive pairs are collapsed to their larger member (zoom XOR scrub: `useCullKeymap.ts:382` pans instead of scrubbing while zoomed; overlay cluster XOR "N selected": `statusOverlays.visible = !gridVisible`, `App.tsx:1336`, and `selection.gridVisible` gates the counter):

| Left item at < 1200 | px |
| --- | --- |
| verdict pill, word shown (glyph 14 + gap 7 + `REJECT` 71) | 92 |
| max(zoom chip `1:1` 39, scrub icon 12 + gap 4 + `10×` chip 42 — the chip's `margin-left: 8` (`chrome.css:323`), 1 px border, `1px 6px` padding and 3 tracked characters) | 58 |
| max(overlay cluster 133, `4194 SELECTED` chip 122) | 133 |
| save chip `4194 photos missing · check again` (icon 12 + gap 6 + 33 chars × 6.6) | 236 |
| four 14 px gaps | 56 |
| **subtotal, filename at zero** | **575** |

575 > 432, so **the spec's three breakpoints are not enough**. Two more sheds, both information-preserving, bring it inside:

- the **verdict pill drops its word** below 1200 and keeps the coloured glyph; its `aria-label` already carries "Keep" / "Reject" / "Fav" (`StatusBar.tsx:134`). 92 → 14.
- the **save chip drops its action tail** below 1200 — `4194 photos missing` is 19 characters at `--fs-2` mono + `letter-spacing: 0.06em` (`chrome.css:710-724`) = 125, + icon 12 + `gap: var(--sp-2)` 6. 236 → **143**.

New subtotal = 14 + 58 + 133 + 143 + 56 = **404**, leaving **28 px** for the filename stem in the absolute worst case — every one of 4,194 photos missing, while scrubbing at 10×, with the overlay cluster up. The stem ellipses to about four characters there and **nothing is clipped**. In every ordinary state (nothing failed, not scrubbing) the stem has its full 240 px `max-width`.

**Ruling:** the guarantee this task ships is *nothing is ever clipped*, enforced structurally — `.cull-statusbar__left` becomes shrinkable and the filename stem is the only shrinkable child (it already has `overflow: hidden; text-overflow: ellipsis`). The arithmetic above is the justification for the breakpoints, not a runtime assertion: jsdom has no layout, so a width test would assert on numbers it cannot measure. The table lives in a comment in `statusbar.css`; Oliver's 1024-px walk is the verification.

**Ruling (the save chip keeps its accessible name):** a `display: none` subtree is excluded from accessible-name computation, and `title` is only a fallback when an element has no text content — so hiding the tail that way would silently shorten the button's name to `"4194 photos missing"`. It is hidden **visually** instead, with a new one-off `.visually-hidden` utility in `base.css`: the name stays `"4194 photos missing · check again"` at every width, and `StatusBar.saveChip.test.tsx:105` keeps passing for the right reason. The verdict pill and the scrub label need no such care — both carry their own `aria-label` on the wrapper (`StatusBar.tsx:134`, `:148`), so `display: none` on the inner word costs nothing.

**Ruling:** the two extra sheds are recorded here as a deliberate extension of spec §3B, taken under its own instruction — *"Nothing is ever clipped at 1024 … if it does not fit, the plan must say what else sheds."*

- [ ] **Step 1: failing tests for the two pure helpers.** Append to `src/utils/path.test.ts`:

```ts
describe("extOf", () => {
  it("returns the extension with its dot, complementing stripExt", () => {
    expect(extOf("IMG_0001.CR3")).toBe(".CR3");
    expect(stripExt("IMG_0001.CR3") + extOf("IMG_0001.CR3")).toBe("IMG_0001.CR3");
  });
  it("handles a dotted stem and a bare name", () => {
    expect(extOf("a.b.CR3")).toBe(".CR3");
    expect(extOf("README")).toBe("");
    expect(stripExt("README") + extOf("README")).toBe("README");
  });
});
```

**`it`, not `test`:** both host files are `import { describe, expect, it } from "vitest";` (`path.test.ts:1`, `saveStatusCopy.test.ts:1`) — a `test(` here is undefined and throws at collection, which is not failing for the right reason. Add `extOf` to `path.test.ts`'s existing import from `./path`. Append to `src/utils/saveStatusCopy.test.ts`:

```ts
describe("the footer's short forms", () => {
  it("the count phrase plus the action tail is the full label, character for character", () => {
    expect(unsavedCountLabel(3) + UNSAVED_ACTION_TAIL).toBe(unsavedLabel(3));
    expect(missingPhotosLabel(2) + MISSING_ACTION_TAIL).toBe(missingCheckAgainLabel(2));
  });
});
```

(add `MISSING_ACTION_TAIL`, `UNSAVED_ACTION_TAIL` and `unsavedCountLabel` to that file's import from `./saveStatusCopy`; `missingPhotosLabel`, `unsavedLabel` and `missingCheckAgainLabel` are already there.)

- [ ] **Step 2: implement the helpers.** In `src/utils/path.ts`, directly under `stripExt`:

```ts
/** The extension INCLUDING its dot ("IMG_0001.CR3" → ".CR3"), "" when there is
 *  none. The exact complement of stripExt: stripExt(n) + extOf(n) === n. The
 *  footer hides this half on a narrow window rather than truncating the stem. */
export function extOf(filename: string): string {
  const m = /\.[^.]+$/.exec(filename);
  return m ? m[0] : "";
}
```

In `src/utils/saveStatusCopy.ts`, beside `unsavedLabel`:

```ts
/** The retryable chip's count phrase WITHOUT its action tail: "3 unsaved".
 *  The footer drops the tail below 1200px of window width — the button's
 *  title still says what clicking it does, and it is the only button there. */
export function unsavedCountLabel(failedCount: number): string {
  return `${failedCount} unsaved`;
}

/** The action tails the narrow footer drops. Kept beside the full labels so
 *  the two halves can never drift (saveStatusCopy.test asserts they compose). */
export const UNSAVED_ACTION_TAIL = " · retry";
export const MISSING_ACTION_TAIL = " · check again";
```

and rewrite the two full labels in terms of them, so composition is structural rather than asserted-and-hoped:

```ts
export function missingCheckAgainLabel(count: number): string {
  return `${missingPhotosLabel(count)}${MISSING_ACTION_TAIL}`;
}

export function unsavedLabel(failedCount: number): string {
  return `${unsavedCountLabel(failedCount)}${UNSAVED_ACTION_TAIL}`;
}
```

- [ ] **Step 3: failing component test** — `src/components/StatusBar.shed.test.tsx` (first line is the jsdom docblock). It proves both label forms are in the DOM for CSS to choose between, and that the accessible names the existing suite pins are unchanged:

```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { StatusBar, type StatusBarProps } from "./StatusBar";

/**
 * Below 1360 / 1200 / 1100 px of window width the footer sheds, in CSS. jsdom
 * has no layout and evaluates no media query, so what is testable here is the
 * CONTRACT the CSS needs: every shed label is rendered in BOTH forms, each in
 * its own element, and nothing the accessible name is built from moved.
 */
function props(over: Partial<StatusBarProps["frame"]> = {}): StatusBarProps {
  return {
    frame: {
      filename: "IMG_0042.CR3",
      rating: "reject",
      isZooming: true,
      zoomLevel: 2,
      scrubbing: true,
      scrubSpeed: 10,
      compareMode: false,
      comparePos: -1,
      compareCount: 0,
      ...over,
    },
    overlays: {
      visible: true,
      exif: { on: false, toggle: vi.fn((): void => {}) },
      clipping: { on: false, toggle: vi.fn((): void => {}) },
      peaking: { on: false, toggle: vi.fn((): void => {}) },
      composition: { on: false, toggle: vi.fn((): void => {}) },
      thumbs: { on: true, toggle: vi.fn((): void => {}) },
    },
    selection: { gridVisible: false, selectedCount: 0 },
    save: { savingCount: 0, failedCount: 4194, missingCount: 4194, retryFailed: vi.fn((): void => {}) },
    filter: {
      filter: "all",
      setFilter: vi.fn(),
      stats: { total: 4194, unrated: 0, keeps: 4194 },
      qualityAnalyzing: false,
      qualityProgress: null,
      smartCulling: false,
      startAnalysis: vi.fn((): void => {}),
      suggestionCount: 0,
      chipsTooltip: {
        visible: false,
        pulse: vi.fn((): void => {}),
        hoverProps: { onPointerEnter: vi.fn(), onPointerLeave: vi.fn() },
      },
      positionInFilter: 0,
      visibleCount: 4194,
    },
    session: { openActions: vi.fn((): void => {}), actionsOpen: false, rejectedCount: 0 },
  };
}

const q = (container: HTMLElement, sel: string): HTMLElement => {
  const el = container.querySelector<HTMLElement>(sel);
  if (!el) throw new Error(`no element matching ${sel}`);
  return el;
};

afterEach(cleanup);

describe("the footer renders both label forms", () => {
  it("splits the filename into a shrinkable stem and a droppable extension", () => {
    const { container } = render(<StatusBar {...props()} />);
    expect(q(container, ".cull-statusbar__filename-name").textContent).toBe("IMG_0042");
    expect(q(container, ".cull-statusbar__filename-ext").textContent).toBe(".CR3");
  });

  it("splits the zoom chip's word from its value", () => {
    const { container } = render(<StatusBar {...props()} />);
    expect(q(container, ".cull-statusbar__chip-label").textContent).toBe("zoom");
    expect(q(container, ".cull-statusbar__chip-value").textContent).toBe("2:1");
  });

  it("gives the scrub word and the verdict word their own elements", () => {
    const { container } = render(<StatusBar {...props()} />);
    expect(q(container, ".cull-statusbar__scrub-label").textContent).toBe("Scrubbing");
    expect(q(container, ".cull-statusbar__verdict-label").textContent).toBe("Reject");
    // The name stays on the pill, so dropping the word costs nothing to AT.
    expect(screen.getByLabelText("Reject")).toBeTruthy();
  });

  it("gives the save chip a droppable action tail without changing its name", () => {
    const { container } = render(<StatusBar {...props()} />);
    const chip = screen.getByRole("button", { name: "4194 photos missing · check again" });
    expect(q(chip, ".cull-statusbar__unsaved-tail").textContent).toBe(" · check again");
    expect(container.querySelector(".cull-statusbar__unsaved")).toBe(chip);
  });

  it("renders the long finish label and a short one beside it", () => {
    const { container } = render(<StatusBar {...props()} />);
    expect(q(container, ".cull-statusbar__finish-long").textContent).toContain("All 4194 rated");
    expect(q(container, ".cull-statusbar__finish-short").textContent).toBe("Finish");
  });
});
```

- [ ] **Step 4: `StatusBar.tsx` — render both forms.** Add `import { extOf } from "../utils/path";` and extend the `saveStatusCopy` import with `MISSING_ACTION_TAIL`, `UNSAVED_ACTION_TAIL`, `missingPhotosLabel`, `unsavedCountLabel`. Five edits, each replacing the existing markup:

```tsx
        {frame.filename && (
          <span className="cull-statusbar__filename">
            <span className="cull-statusbar__filename-name">{stripExt(frame.filename)}</span>
            <span className="cull-statusbar__filename-ext">{extOf(frame.filename)}</span>
          </span>
        )}
```

(add `import { stripExt } from "../utils/path";` — one import statement with `extOf`.)

```tsx
            <span className="cull-statusbar__verdict-glyph" aria-hidden>
              {verdictGlyph(frame.rating, 9)}
            </span>
            <span className="cull-statusbar__verdict-label">{verdictLabel[frame.rating]}</span>
```

```tsx
        {frame.isZooming && (
          <span className="chip chip--soft chip--accent cull-statusbar__chip">
            <span className="cull-statusbar__chip-label">zoom</span>
            <span className="cull-statusbar__chip-value">{frame.zoomLevel}:1</span>
          </span>
        )}
```

```tsx
            <ArrowRight className="cull-statusbar__scrub-arrow" {...ICON.sm} aria-hidden />
            <span className="cull-statusbar__scrub-label">Scrubbing</span>
```

```tsx
            {failureKind !== "none" && <TriangleAlert {...ICON.sm} aria-hidden />}
            {failureKind === "missing" ? (
              <>
                {missingPhotosLabel(save.missingCount)}
                <span className="cull-statusbar__unsaved-tail">{MISSING_ACTION_TAIL}</span>
              </>
            ) : failureKind === "retry" ? (
              <>
                {unsavedCountLabel(save.failedCount)}
                <span className="cull-statusbar__unsaved-tail">{UNSAVED_ACTION_TAIL}</span>
              </>
            ) : (
              `Saving ${save.savingCount}…`
            )}
```

and the finish button's children:

```tsx
            <span className="cull-statusbar__finish-long">
              {filter.stats.unrated === 0 && filter.stats.total > 0
                ? `All ${filter.stats.total} rated · ${modCombo("E")} finish`
                : `${modCombo("E")} · ${totalKeeps} keeps`}
            </span>
            <span className="cull-statusbar__finish-short">Finish</span>
```

Nothing else in the file changes. `missingCheckAgainLabel` / `unsavedLabel` stop being imported here — drop them from the import list; they stay in use in `SaveStatusPill.tsx` and the dialogs.

- [ ] **Step 5: the CSS.** In `src/styles/chrome.css`:
  - `.cull-statusbar__left, .cull-statusbar__right` currently share `flex-shrink: 0`. Split them: the right cluster keeps `flex-shrink: 0`; the left gets `flex-shrink: 1; min-width: 0`.
  - `.cull-statusbar__filename`: `gap: 8px` → `gap: 0` (it has one child today, and the stem and its extension must sit flush); add `flex-shrink: 1;`.
  - `.cull-statusbar__filename-name`: add `flex-shrink: 1;` (it already has `min-width: 0`'s effect via `overflow: hidden` + `max-width: 240px`; add `min-width: 0` explicitly).
  - `.cull-statusbar__filename-ext`: new rule, `flex: 0 0 auto; color: var(--text-2);`.
  - `.cull-statusbar__verdict-label`: new rule, `flex: 0 0 auto;` (it exists so the media query has something to hide).
  - `.cull-statusbar__unsaved` (`chrome.css:710`) is the one left-cluster child with NO `flex-shrink` — add `flex-shrink: 0`. The other three that live here already have it: `.cull-statusbar__verdict` (`:195`), `.cull-statusbar__overlay-cluster` (`:247`), `.cull-statusbar__scrub` (`:296`).

  Then in **`src/styles/statusbar.css`** — these two rules live there, NOT in `chrome.css`:
  - `.cull-statusbar__chip` (`statusbar.css:43`): add `display: inline-flex; align-items: center; gap: 4px;` (the two spans must not lose the space the old `zoom 2:1` text node had) and `flex-shrink: 0`.
  - `.cull-statusbar__multi` (`statusbar.css:53`): add `flex-shrink: 0`.

  The filename stem must end up the ONLY shrinkable thing in the left cluster.
- [ ] **Step 6: the visually-hidden utility.** In `src/styles/base.css`, after the focus-ring safety net:

```css
/* Visually hidden, still in the accessibility tree. The app has exactly one
   user: the footer's save chip, whose action tail ("· check again") is hidden
   below 1200px of window width. `display: none` would ALSO remove it from the
   button's accessible name — and `title` only stands in for an element with no
   text content at all — so the chip would quietly stop announcing what
   clicking it does. This keeps the name whole while the pixels go. */
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}
```

- [ ] **Step 7: the breakpoints.** One block at the END of `src/styles/statusbar.css`, headed by the arithmetic table from this task, written in stylelint's range notation (`stylelint-config-standard` sets `media-feature-range-notation: "context"`, so `(max-width: …)` is a lint error). A media query cannot add a class, so the tail's rule repeats `.visually-hidden`'s declarations rather than sharing the class — the comment says why, and the guard test in Step 8 pins the pair:

```css
/* ── the footer sheds as the window narrows ───────────────────
   Pure CSS on the window width — the webview's viewport IS the window, so
   no resize listener is needed. Every label below is rendered in both forms
   by StatusBar; only one is ever displayed.

   Budget at the 1024px minimum: 1024 − 36 (bar padding) − 36 (two 18px
   gaps) = 952 of content. Right cluster at <1100 = 79 (pos, 12ch) + 347
   (filter tabs, worst "SMART · 4194") + 66 ("FINISH") + 28 gaps = 520.
   Left, with every chip present and the two mutually exclusive pairs
   collapsed (zoom XOR scrub; overlay cluster XOR "N selected") = 14
   (verdict glyph) + 58 (scrub + ×10) + 133 (overlay cluster) + 143
   ("4194 photos missing") + 56 gaps = 404 → 28px for the filename stem in
   the absolute worst case (all-missing chip + scrub + overlay cluster at
   once); the stem ellipses there and nothing is clipped. In every ordinary
   state the stem has its full 240px max-width. */
@media (width < 1360px) {
  .cull-statusbar__keyhint {
    display: none;
  }
}

@media (width < 1200px) {
  /* The name is enough; every file in a cull is a .CR3. */
  .cull-statusbar__filename-ext,
  /* "zoom 1:1" → "1:1". */
  .cull-statusbar__chip-label,
  /* aria-label="scrubbing" on the wrapper keeps the word for AT. */
  .cull-statusbar__scrub-label,
  /* aria-label on the pill keeps the word for AT. */
  .cull-statusbar__verdict-label {
    display: none;
  }

  /* The save chip's tail is hidden VISUALLY, not removed: `display: none`
     would drop it from the button's accessible name, and the button would
     stop announcing what clicking it does. Same declarations as
     base.css's .visually-hidden — a media query cannot add a class. */
  .cull-statusbar__unsaved-tail {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
    border: 0;
  }
}

@media (width < 1100px) {
  .cull-statusbar__finish-long {
    display: none;
  }
}

/* The short finish label is the exception: hidden by default, shown only
   under 1100 (the reverse of every rule above). */
.cull-statusbar__finish-short {
  display: none;
}

@media (width < 1100px) {
  .cull-statusbar__finish-short {
    display: inline;
  }
}
```

- [ ] **Step 8: extend the stylesheet guard.** Append to `src/styles/layout.test.ts`:

```ts
describe("the footer's breakpoints", () => {
  const statusbar = sheet("./statusbar.css");

  test("the three picked widths are there, in range notation", () => {
    for (const w of [1360, 1200, 1100]) {
      expect(statusbar, `${w}px breakpoint`).toContain(`@media (width < ${w}px)`);
    }
    expect(statusbar, "range notation only").not.toMatch(/@media\s*\(max-width/);
  });

  test("every shed label is hidden at the width the spec picked", () => {
    const block = (w: number): string => {
      const at = statusbar.indexOf(`@media (width < ${w}px) {`);
      return statusbar.slice(at, statusbar.indexOf("\n}", at));
    };
    expect(block(1360)).toContain(".cull-statusbar__keyhint");
    for (const cls of [
      ".cull-statusbar__filename-ext",
      ".cull-statusbar__chip-label",
      ".cull-statusbar__scrub-label",
      ".cull-statusbar__verdict-label",
      ".cull-statusbar__unsaved-tail",
    ]) {
      expect(block(1200), cls).toContain(cls);
    }
    expect(block(1100)).toContain(".cull-statusbar__finish-long");
  });

  test("only the filename may shrink, so nothing else can be squeezed into a clip", () => {
    expect(ruleBody(sheet("./chrome.css"), ".cull-statusbar__left")).toMatch(
      /flex-shrink:\s*1/,
    );
    expect(ruleBody(sheet("./chrome.css"), ".cull-statusbar__filename-name")).toMatch(
      /text-overflow:\s*ellipsis/,
    );
  });

  test("the save chip's tail is hidden visually, never removed from the name", () => {
    // `display: none` would shorten the button's accessible name; the tail is
    // clipped instead, with the same declarations base.css's utility uses.
    const block = statusbar.slice(
      statusbar.indexOf("@media (width < 1200px) {"),
      statusbar.indexOf("@media (width < 1100px) {"),
    );
    const tail = block.slice(block.indexOf(".cull-statusbar__unsaved-tail {"));
    expect(tail).toMatch(/clip-path:\s*inset\(50%\)/);
    expect(tail.slice(0, tail.indexOf("}"))).not.toMatch(/display:\s*none/);
    expect(ruleBody(sheet("./base.css"), ".visually-hidden")).toMatch(
      /clip-path:\s*inset\(50%\)/,
    );
  });
});
```

- [ ] **Step 9:** `pnpm test` — the existing `src/components/StatusBar.saveChip.test.tsx` must stay green untouched: the accessible name is built from the concatenated text, and `"4194 photos missing"` + `" · check again"` is character-identical to `missingCheckAgainLabel(4194)`. If it fails, the split is wrong, not the test.
- [ ] **Step 10:** gate green. Commit: `feat(ui): the footer sheds labels instead of clipping below 1360 / 1200 / 1100`.

### Task 3: The info rail goes compact below 1200

**Files:** Modify `src/styles/tokens.css`, `src/styles/exif-rail.css`. Test: extend `src/styles/layout.test.ts`.

**Interfaces — Produces:** `--rail-w` (290px), `--rail-w-compare` (340px) become live; new `--rail-col-k: 90px` for the compare rows' fixed first column.

- [ ] **Step 1: failing test.** Append to `src/styles/layout.test.ts`:

```ts
describe("the info rail", () => {
  const rail = sheet("./exif-rail.css");

  test("its widths come from the tokens, not literals", () => {
    expect(ruleBody(rail, ".cull-exif-rail")).toContain("flex: 0 0 var(--rail-w)");
    expect(ruleBody(rail, ".cull-exif-rail")).toContain("width: var(--rail-w)");
    expect(ruleBody(rail, ".cull-exif-rail--compare")).toContain("var(--rail-w-compare)");
    expect(ruleBody(rail, ".cull-cr-rail__row")).toContain(
      "grid-template-columns: var(--rail-col-k) 1fr 1fr",
    );
    expect(ruleBody(rail, ".cull-cr-rail__head")).toContain(
      "grid-template-columns: var(--rail-col-k) 1fr 1fr",
    );
  });

  test("below 1200 the tokens step down to the picked numbers", () => {
    const at = rail.indexOf("@media (width < 1200px) {");
    expect(at, "no 1200px breakpoint in exif-rail.css").toBeGreaterThan(-1);
    const block = rail.slice(at);
    expect(block).toMatch(/--rail-w:\s*232px/);
    expect(block).toMatch(/--rail-w-compare:\s*288px/);
    expect(block).toMatch(/--rail-col-k:\s*76px/);
    expect(block).toMatch(/padding:\s*28px 20px/);
    expect(block).toMatch(/gap:\s*28px/);
  });
});
```

- [ ] **Step 2: tokens.** `src/styles/tokens.css`, in the `/* layout */` block, keep `--rail-w: 290px;` and `--rail-w-compare: 340px;` and add `--rail-col-k: 90px;` under them with the comment `/* the compare rows' fixed key column; narrows with the rail */`.
- [ ] **Step 3: wire `exif-rail.css`.** Mechanical: `.cull-exif-rail` `flex: 0 0 290px` → `flex: 0 0 var(--rail-w)`, `width: 290px` → `width: var(--rail-w)`; `.cull-exif-rail--compare` `flex: 0 0 340px` → `flex: 0 0 var(--rail-w-compare)`, `width: 340px` → `width: var(--rail-w-compare)`; `.cull-cr-rail__head` and `.cull-cr-rail__row` `grid-template-columns: 90px 1fr 1fr` → `grid-template-columns: var(--rail-col-k) 1fr 1fr`.
- [ ] **Step 4: the breakpoint**, at the end of `exif-rail.css`:

```css
/* ── compact rail below 1200px of window width ────────────────
   The loupe rail gives 58px back to the photo (290 → 232) by tightening its
   own padding and gap, not by dropping a row: nothing inside it wraps at
   232. The compare rail follows in proportion (340 → 288) and its fixed key
   column with it (90 → 76), so the two value columns keep their share. */
@media (width < 1200px) {
  :root {
    --rail-w: 232px;
    --rail-w-compare: 288px;
    --rail-col-k: 76px;
  }

  /* :not(--compare) is load-bearing. ExifRail renders the compare rail as
     `cull-exif-rail cull-exif-rail--compare` (ExifRail.tsx:314), and a media
     query adds no specificity — a bare `.cull-exif-rail` here would sit at
     the end of the file at the same (0,1,0) weight as the `--compare` rule
     above and steal its 32px/24px padding. Spec §4B narrows the compare
     rail's WIDTH only. */
  .cull-exif-rail:not(.cull-exif-rail--compare) {
    padding: 28px 20px;
    gap: 28px;
  }
}
```

The compare rail's own `padding: 32px 24px; gap: 28px` is left alone — the spec changes only the loupe rail's inner spacing.

- [ ] **Step 5:** gate green. Commit: `feat(ui): the info rail goes compact below 1200px of window width`.

### Task 4: The home screen grows with the window

**Files:** Modify `src/styles/tokens.css`, `src/styles/home.css`. Test: extend `src/styles/layout.test.ts`.

**Interfaces — Produces:** `--home-col: 620px` (hero + recents column), `--home-measure: 500px` (sub / how-it-works line length), `--home-sub: 17px`, `--home-path: 14px`, `--home-row-pad: 13px`. `--fs-hero` (56px, already in `tokens.css:51`) is overridden in the breakpoint.

- [ ] **Step 1: failing test.** Append to `src/styles/layout.test.ts`:

```ts
describe("the home screen at 2000px and wider", () => {
  const home = sheet("./home.css");

  test("its sizes come from tokens", () => {
    expect(ruleBody(home, ".cull-hero")).toContain("max-width: var(--home-col)");
    expect(ruleBody(home, ".cull-recent")).toContain("max-width: var(--home-col)");
    expect(ruleBody(home, ".cull-hero__sub")).toContain("font-size: var(--home-sub)");
    expect(ruleBody(home, ".cull-hero__sub")).toContain("max-width: var(--home-measure)");
    expect(ruleBody(home, ".cull-hero__how")).toContain("max-width: var(--home-measure)");
    expect(ruleBody(home, ".cull-recent__path")).toContain("font-size: var(--home-path)");
    expect(ruleBody(home, ".cull-recent__item")).toContain("padding: var(--home-row-pad) 0");
  });

  test("the step is the one the board picked", () => {
    const at = home.indexOf("@media (width >= 2000px) {");
    expect(at, "no 2000px breakpoint in home.css").toBeGreaterThan(-1);
    const block = home.slice(at);
    expect(block).toMatch(/--home-col:\s*780px/);
    expect(block).toMatch(/--fs-hero:\s*72px/);
    expect(block).toMatch(/--home-sub:\s*19px/);
    expect(block).toMatch(/--home-measure:\s*620px/);
    expect(block).toMatch(/--home-path:\s*15px/);
    expect(block).toMatch(/--home-row-pad:\s*16px/);
  });
});
```

- [ ] **Step 2: tokens.** In `tokens.css`'s `/* layout */` block:

```css
  /* home screen — one column, one measure, stepped up on a wide window */
  --home-col: 620px;
  --home-measure: 500px;
  --home-sub: 17px; /* off-scale */
  --home-path: 14px;
  --home-row-pad: 13px;
```

- [ ] **Step 3: wire `home.css`.** Mechanical: `.cull-hero` `max-width: 620px` → `var(--home-col)`; `.cull-hero__sub` `font-size: 17px; /* off-scale */` → `font-size: var(--home-sub);` and `max-width: 500px` → `var(--home-measure)`; `.cull-hero__how` `max-width: 500px` → `var(--home-measure)`; `.cull-recent` `max-width: 620px` → `var(--home-col)`; `.cull-recent__item` `padding: 13px 0` → `padding: var(--home-row-pad) 0`; `.cull-recent__path` `font-size: var(--fs-6)` → `font-size: var(--home-path)` (`--fs-6` is 14px — same number, now a home token so the breakpoint can move it).
- [ ] **Step 4: the breakpoint**, at the end of `home.css`:

```css
/* ── a wide window gets a bigger home ─────────────────────────
   At 2560 × 1440 the 620px column is 24% of the width and the screen reads
   as a small page floating in a lot of nothing. From 2000px the same
   left-aligned editorial layout steps up — column, title, sub, measure,
   recents row — and nothing moves or re-flows. Below 2000 nothing changes,
   so the 1600 × 1000 default window is untouched. */
@media (width >= 2000px) {
  :root {
    --home-col: 780px;
    --home-measure: 620px;
    --fs-hero: 72px;
    --home-sub: 19px; /* off-scale */
    --home-path: 15px; /* off-scale */
    --home-row-pad: 16px;
  }
}
```

- [ ] **Step 5:** confirm nothing else reads `--fs-hero` (`grep -rn "fs-hero" src/styles`): only `.cull-hero__title`. If a second consumer appeared, move the override onto `.cull-hero__title` instead and say so.
- [ ] **Step 6:** gate green. Commit: `feat(ui): the home screen scales up from 2000px of window width`.

### Task 5: The filmstrip gets two steps, and a box model that is the number it declares

**Files:** Modify `src/components/strip/metrics.ts`, `src/components/strip/PhotoStrip.tsx`, `src/components/strip/BurstBoxes.tsx`, `src/styles/strip.css`, `src/styles/tokens.css`. Create `src/components/strip/useStripMetrics.ts`, `src/components/strip/metrics.test.ts`.

**Interfaces — Produces** (in `src/components/strip/metrics.ts`):

```ts
export type StripMetrics = {
  /** Cell width in CSS px. */
  cellW: number;
  /** Cell height in CSS px. */
  cellH: number;
  /** Per-cell horizontal stride: cellW + CELL_GAP. */
  stride: number;
  /** `.cull-thumbs` BORDER-box height: top pad + cellH + bottom pad + border. */
  stripH: number;
};
export const CELL_GAP = 4;
export const STRIP_TOP_PAD = 20;
export const STRIP_BOTTOM_PAD = 8;
export const STRIP_BORDER = 1;
export const STRIP_BUFFER = 4;
export const STRIP_SMALL: StripMetrics;  // 76 × 54, stride 80, stripH 83
export const STRIP_LARGE: StripMetrics;  // 104 × 74, stride 108, stripH 103
export const STRIP_TALL_QUERY = "(min-height: 1200px)";
export function stripMetricsFor(tall: boolean): StripMetrics;
```

`src/components/strip/useStripMetrics.ts`: `export function useStripMetrics(): StripMetrics` — one `matchMedia(STRIP_TALL_QUERY)` subscription via `useSyncExternalStore`, returning `STRIP_SMALL` / `STRIP_LARGE` by reference (so the value is identity-stable across renders and safe in `useMemo` deps and as a `FilmStrip` prop).

`src/components/strip/BurstBoxes.tsx`: `burstBoxOverlays(segs, prefix, m: StripMetrics)` — a third parameter, replacing the module-level `CELL_STRIDE` / `CELL_W` imports.

**Consumers verified:** `CELL_W` / `CELL_H` / `CELL_STRIDE` / `STRIP_BUFFER` are imported in exactly two files — `PhotoStrip.tsx:8` and `BurstBoxes.tsx:2`. No test imports them (`gridWindow.ts:15` and `ThumbCell.tsx:87` only *mention* `STRIP_BUFFER` in comments). `computeWindow.ts` and `useStripVirtualizer.ts` already take `stride` / `cellWidth` / `buffer` as arguments and need no change. **`CELL_GAP` is `const`, not `export const`, today (`metrics.ts:5`)** — the Step 1 test imports it, so exporting it is part of this task, not an accident. `src/components/memoBailout.test.tsx:18` mocks `./strip/PhotoStrip`, so no existing test mounts the new `matchMedia` subscription; the `typeof window.matchMedia !== "function"` guard in the hook is belt-and-braces.

**A note on the two `ruleBody` helpers:** this file and Task 1's `layout.test.ts` each define their own four-line `ruleBody`. That duplication is deliberate — there is no shared test-helper module in `src/`, and inventing one would put a non-source file in the type-checked tree for two callers. Neither copy's `indexOf("}")` is at risk: every rule body these tests slice was read and contains no literal `}`.

**Re-centring on a metric change — verified, do not rebuild:** `useStripVirtualizer`'s `center` callback lists `stride` and `cellWidth` in its deps (`useStripVirtualizer.ts:57`), and the layout effect at `:67-69` re-runs on `center`'s identity. Changing the step therefore re-centres and recomputes the window in the same commit. The `ResizeObserver` at `:93-99` covers the strip's own height change as well.

**Burst legend headroom — verified, unchanged:** `.cull-thumbs`' 20 px top padding is the space the `×N` legend sits in, and `.cull-burst-box`'s `top: -10px; bottom: -6px` are relative to the FilmStrip track (whose height is `cellH`), so the 4 px of air around a run is the same at both steps. Neither number moves.

**Scrub-bar geometry — verified, unchanged:** `.cull-scrubbar` is `left: 14px; right: 14px; bottom: 3px; height: 2px` inside `.cull-strip-wrap`, which is sized by the strip inside it. It tracks the taller strip automatically.

**Ruling (the box model, spec §2B):** `.cull-thumbs` declares `height: 82px; padding: 20px 0 8px; border-top: 1px` with no `box-sizing`, so its rendered box is 111 px — 28 px of dead space under the cells, although its own comment does the sum as a border box (`20 + 54 + 8 = 82`). This task makes the declaration true: `box-sizing: border-box` and `height: var(--strip-h)` = `20 + cellH + 8 + 1` → **83 / 103 px**. The photo gains 28 px of height. This is the single most visible change in Phase 3B and it is on Oliver's walk.

- [ ] **Step 1: failing test** — `src/components/strip/metrics.test.ts`. It is the JS↔CSS agreement net: the numbers in the stylesheet are read raw and compared against the module.

```ts
import { describe, expect, test } from "vitest";
import {
  CELL_GAP,
  STRIP_BORDER,
  STRIP_BOTTOM_PAD,
  STRIP_LARGE,
  STRIP_SMALL,
  STRIP_TOP_PAD,
  stripMetricsFor,
} from "./metrics";

const sheets = import.meta.glob<string>("../../styles/*.css", {
  query: "?raw",
  eager: true,
  import: "default",
});
const strip = sheets["../../styles/strip.css"] ?? "";
const tokens = sheets["../../styles/tokens.css"] ?? "";

const ruleBody = (css: string, selector: string): string => {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`no rule \`${selector}\``);
  return css.slice(at, css.indexOf("}", at));
};
const px = (css: string, name: string): number => {
  const m = new RegExp(`${name}:\\s*(\\d+)px`).exec(css);
  if (!m) throw new Error(`no ${name} in that rule`);
  return Number(m[1]);
};

describe("strip metrics", () => {
  test("the stylesheets arrive as readable text", () => {
    expect(strip).toContain(".cull-thumbs {");
    expect(tokens).toContain(":root {");
  });

  test("the two steps are the ones the board picked", () => {
    expect([STRIP_SMALL.cellW, STRIP_SMALL.cellH]).toEqual([76, 54]);
    expect([STRIP_LARGE.cellW, STRIP_LARGE.cellH]).toEqual([104, 74]);
    expect(stripMetricsFor(false)).toBe(STRIP_SMALL);
    expect(stripMetricsFor(true)).toBe(STRIP_LARGE);
  });

  test("stride is the cell plus one gap, and the strip height is its real border box", () => {
    for (const m of [STRIP_SMALL, STRIP_LARGE]) {
      expect(m.stride).toBe(m.cellW + CELL_GAP);
      expect(m.stripH).toBe(STRIP_TOP_PAD + m.cellH + STRIP_BOTTOM_PAD + STRIP_BORDER);
    }
    expect(STRIP_SMALL.stripH).toBe(83);
    expect(STRIP_LARGE.stripH).toBe(103);
  });

  test("the CSS declares the SAME padding and border the height is summed from", () => {
    const thumbs = ruleBody(strip, ".cull-thumbs");
    // border-box is load-bearing: without it the rendered box is height +
    // padding + border, which is exactly the 28px of dead space this fixed.
    expect(thumbs).toMatch(/box-sizing:\s*border-box/);
    expect(thumbs).toMatch(/height:\s*var\(--strip-h\)/);
    expect(px(thumbs, "padding")).toBe(STRIP_TOP_PAD);
    expect(thumbs).toContain(`0 ${STRIP_BOTTOM_PAD}px`);
    expect(px(thumbs, "border-top")).toBe(STRIP_BORDER);
  });

  test("the cells read their size from the custom properties, never a literal", () => {
    expect(ruleBody(strip, ".cull-thumb")).toContain("flex: 0 0 var(--cell-w)");
    expect(ruleBody(strip, ".cull-thumb")).toContain("height: var(--cell-h)");
    expect(ruleBody(strip, ".cull-thumb__frame")).toContain("width: var(--cell-w)");
    expect(ruleBody(strip, ".cull-thumb__frame")).toContain("height: var(--cell-h)");
  });

  test("the :root fallbacks are the SMALL step, so a strip that never mounts still measures", () => {
    expect(px(ruleBody(tokens, ":root"), "--cell-w")).toBe(STRIP_SMALL.cellW);
    expect(px(ruleBody(tokens, ":root"), "--cell-h")).toBe(STRIP_SMALL.cellH);
    expect(px(ruleBody(tokens, ":root"), "--strip-h")).toBe(STRIP_SMALL.stripH);
  });
});
```

- [ ] **Step 2: `metrics.ts`** — replace the file:

```ts
// src/components/strip/metrics.ts
/**
 * Filmstrip cell geometry — ONE source of truth, shared by FilmStrip, the
 * virtualizer math, the burst overlays and (as custom properties pushed onto
 * the strip's wrapper by PhotoStrip) the stylesheet. metrics.test.ts reads
 * styles/strip.css raw and fails if the two ever disagree.
 *
 * Two steps: the standard cell, and a bigger one on a tall window (≥1200 CSS
 * px of window height — a maximized 1440p or 4K screen). The THMB behind a
 * cell is 160×120, so even the big step is still a downscale at DPR 1.5
 * (104 × 1.5 = 156 device px) — the strip never needs the grid tier.
 */
export type StripMetrics = {
  /** Cell width in CSS px. */
  cellW: number;
  /** Cell height in CSS px. */
  cellH: number;
  /** Per-cell horizontal stride: the frame plus one gap. */
  stride: number;
  /** `.cull-thumbs`' BORDER-box height. The 20px top padding is the burst
   *  legend's headroom (the ×N count sits OUTSIDE the box's top-left corner),
   *  the 8px bottom is the scrub bar's, and the 1px is the border-top. */
  stripH: number;
};

/** Horizontal gap between cells. Lives in `stride`, never in CSS. */
export const CELL_GAP = 4;
/** Burst-legend headroom above the cells (see styles/strip.css). */
export const STRIP_TOP_PAD = 20;
/** Breathing room under the cells, where the scrub bar rides. */
export const STRIP_BOTTOM_PAD = 8;
/** The strip's 1px border (top, or bottom when the strip sits above the photo). */
export const STRIP_BORDER = 1;
/** Cells rendered beyond the visible viewport on each side (manual-drag margin). */
export const STRIP_BUFFER = 4;

const step = (cellW: number, cellH: number): StripMetrics => ({
  cellW,
  cellH,
  stride: cellW + CELL_GAP,
  stripH: STRIP_TOP_PAD + cellH + STRIP_BOTTOM_PAD + STRIP_BORDER,
});

/** The standard step. Also the `:root` fallback in styles/tokens.css. */
export const STRIP_SMALL: StripMetrics = step(76, 54);
/** The tall-window step. */
export const STRIP_LARGE: StripMetrics = step(104, 74);

/** The one media query that chooses the step (see useStripMetrics). */
export const STRIP_TALL_QUERY = "(min-height: 1200px)";

/** Identity-stable: returns one of the two module constants, never a fresh
 *  object — the value is a FilmStrip prop and a useMemo dependency. */
export function stripMetricsFor(tall: boolean): StripMetrics {
  return tall ? STRIP_LARGE : STRIP_SMALL;
}
```

- [ ] **Step 3: `useStripMetrics.ts`** — new file:

```ts
// src/components/strip/useStripMetrics.ts
import { useCallback, useSyncExternalStore } from "react";
import { STRIP_TALL_QUERY, stripMetricsFor, type StripMetrics } from "./metrics";

/**
 * The strip's step, from ONE matchMedia subscription. useSyncExternalStore
 * rather than a resize listener: the query fires only when the window crosses
 * the threshold, so a drag from 1000 to 1400px of height costs one event, not
 * one per frame (and this machine paints at 240 Hz — a per-frame listener
 * would be 240 needless renders a second).
 *
 * The server snapshot is the small step, which is also styles/tokens.css's
 * `:root` fallback, so a render without a window agrees with the stylesheet.
 */
export function useStripMetrics(): StripMetrics {
  const subscribe = useCallback((onChange: () => void) => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return () => {};
    }
    const mql = window.matchMedia(STRIP_TALL_QUERY);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  const isTall = useCallback(
    () =>
      typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia(STRIP_TALL_QUERY).matches
        : false,
    [],
  );
  return stripMetricsFor(useSyncExternalStore(subscribe, isTall, () => false));
}
```

- [ ] **Step 4: `BurstBoxes.tsx`** — take the metrics instead of importing constants:

```tsx
import { cellX } from "./computeWindow";
import type { StripMetrics } from "./metrics";
import type { BurstSegment } from "./burstSegments";

export function burstBoxOverlays(
  segs: readonly BurstSegment[],
  prefix: number[] | undefined,
  m: StripMetrics,
): React.ReactNode[] {
  const x = (i: number) => cellX(i, m.stride, prefix);
  return segs.map((s) => (
    <fieldset
      key={`${s.kind}-${s.group}-${s.start}`}
      className={`cull-burst-box${s.kind === "similar" ? " cull-burst-box--similar" : ""}`}
      style={{
        // 4px air from cell edge to the line's INNER face on both sides
        // (box-sizing: border-box; 2px border ⇒ ±6 outside the cells).
        left: x(s.start) - 6,
        width: x(s.end) - x(s.start) + m.cellW + 12,
      }}
      aria-hidden
    >
      {s.labeled && (
        <legend className="cull-burst-box__count">
          {s.kind === "similar" ? "Similar" : "Burst"} ×{s.len}
        </legend>
      )}
    </fieldset>
  ));
}
```

- [ ] **Step 5: `PhotoStrip.tsx`** — read the metrics once and push them both ways. Replace the `metrics` import with `import { STRIP_BUFFER } from "./metrics";` plus `import { useStripMetrics } from "./useStripMetrics";`, add `const m = useStripMetrics();` at the top of the body, change the `burstBoxes` memo to `useMemo(() => (segs.length > 0 ? burstBoxOverlays(segs, prefix, m) : null), [segs, prefix, m])`, and replace the wrapper + FilmStrip props:

```tsx
    <div
      className="cull-strip-wrap"
      // The stylesheet's single source for the cell box. Set HERE rather than
      // on .cull-thumbs because FilmStrip owns that element's className only;
      // custom properties inherit, so the strip and every cell inside it read
      // the same three numbers metrics.ts just handed us.
      style={
        {
          "--cell-w": `${m.cellW}px`,
          "--cell-h": `${m.cellH}px`,
          "--strip-h": `${m.stripH}px`,
        } as React.CSSProperties
      }
    >
      <FilmStrip
        className="cull-thumbs"
        count={indices.length}
        stride={m.stride}
        cellWidth={m.cellW}
        trackHeight={m.cellH}
        centerOffset={centerPos}
        buffer={STRIP_BUFFER}
        overlays={burstBoxes}
        prefix={prefix}
```

(the `keyForItem` / `renderItem` props below are unchanged). Add `import type { CSSProperties } from "react";` if the file's lint prefers it over the inline `React.CSSProperties` cast — either is fine, the cast is needed because custom properties are not in `CSSProperties`.

- [ ] **Step 6: `strip.css`.** Three rules:

```css
.cull-thumbs {
  flex: 0 0 auto;
  /* border-box is LOAD-BEARING: the app has no global box-sizing reset, so a
     content-box height of 82px rendered as 111px — 28px of dead air under the
     cells, although the sum below always read as a border box. --strip-h IS
     that sum (metrics.ts), and metrics.test.ts fails if the two disagree. */
  box-sizing: border-box;
  height: var(--strip-h);
  /* Cells are absolutely positioned inside the inner track (see FilmStrip); the
     4px gap lives in the stride, not CSS. Top padding is deliberately deeper
     (20px vs 8px): the burst run box extends 4px above the cells and its ×N
     count sits OUTSIDE the box's top-left corner in that headroom. Overflow
     clips at the padding box, so overlays drawn into the padding render fine. */
  padding: 20px 0 8px;
  overflow: auto hidden;
  background: var(--bg);
  border-top: 1px solid var(--border);
  scrollbar-width: none;
}
```

```css
.cull-thumb {
  position: relative;
  flex: 0 0 var(--cell-w);
  height: var(--cell-h);
  cursor: pointer;
  transition: opacity 150ms ease-out;
}

.cull-thumb__frame {
  position: relative;
  width: var(--cell-w);
  height: var(--cell-h);
  box-sizing: border-box;
  border-radius: 1px; /* off-scale */
  overflow: hidden;
}
```

Everything else in `strip.css` (dots, badges, burst boxes, scrub bar) is size-independent and stays exactly as it is.

- [ ] **Step 7: tokens.** In `tokens.css`'s `/* layout */` block, keep the three strip tokens and re-comment them as fallbacks, with `--strip-h` corrected from 82 to the real border-box number:

```css
  /* The strip's SMALL step, as a fallback: PhotoStrip overrides all three on
     .cull-strip-wrap at runtime (see strip/metrics.ts). Kept in :root so the
     stylesheet still measures if a rule outside a mounted strip reads them. */
  --strip-h: 83px;
  --cell-w: 76px;
  --cell-h: 54px;
```

- [ ] **Step 8:** gate green. `pnpm test` must keep `src/components/strip/computeWindow.test.ts` green untouched (it passes `stride` explicitly and never imported the constants). Commit: `feat(ui): the filmstrip steps up on a tall window, and its box is the height it declares`.

### Task 6: Grid size — the setting, the keys, the wheel, the Settings row

**Files:** Create `src/utils/gridSize.ts`, `src/utils/gridSize.test.ts`. Modify `src/types/settings.ts`, `src/types/index.ts`, `src/hooks/useSettings.ts` (+ `src/hooks/useSettings.test.ts`), `src/components/GridView.tsx`, `src/App.tsx`, `src/app/useCullKeymap.ts`, `src/components/SettingsDialog.tsx`.

**Interfaces — Produces:**

```ts
// src/types/settings.ts
export type GridSize = "small" | "medium" | "large";
// Settings gains:  gridSize: GridSize;   DEFAULT_SETTINGS gains:  gridSize: "medium",

// src/utils/gridSize.ts
export const GRID_SIZES: readonly GridSize[];                 // ["small","medium","large"]
export const GRID_CELL_TARGET: Record<GridSize, number>;      // 128 / 168 / 256
export const DEFAULT_GRID_SIZE: GridSize;                     // "medium"
export function isGridSize(v: unknown): v is GridSize;
export function stepGridSize(current: GridSize, dir: 1 | -1): GridSize; // clamps, never wraps
export function gridColsFor(contentWidth: number, size: GridSize): number;
export function gridCellWidth(contentWidth: number, cols: number): number;
```

`GRID_CELL_TARGET` (the `number` constant currently exported from `GridView.tsx:26`) is **removed** from `GridView.tsx`; its only consumer is `App.tsx:32,441`. The new map takes its name — `grep -rn "GRID_CELL_TARGET" src` must show no stale import.

**Ruling (Medium is 168, not the board's 176):** at the maximized 2560 window both give 14 columns, but at the 1600 × 1000 default 176 drops a column. Medium must be *today's grid at every window size*, which is what the option promised. Spec §1A already rules this; it is restated here because the board report says 176.

**Ruling (Ctrl+wheel "under the cursor"):** the step is applied on the grid's own wheel; the frame kept in view is the CURRENT frame, via the auto-scroll that already runs. Anchoring the cell under the pointer is not implemented, because `GridView`'s auto-scroll layout effect (`GridView.tsx:229-241`) re-runs on every `rowH` change and would immediately overwrite any pointer anchor — honouring both would mean rebuilding that effect, which spec §1A explicitly forbids ("the existing auto-scroll does this when `cols` changes — verify, do not rebuild").

**Verified:** that auto-scroll effect's dependency array is `[currentIndex, visibleIndices, cols, rowH, containerRef]`, and `rowH === cellW`, so a size change re-runs it and scrolls the current cell back into view inside the same commit. Nothing to build.

**Verified:** `useCullKeymap.ts:543` (`if (e.ctrlKey || e.metaKey || e.altKey) return;`) drops every Ctrl combination that has not already returned. New Ctrl bindings go ABOVE it, beside the `Z` / `Y` / `E` / `A` block at `:489-514`. `+`, `=`, `-` and the numpad keys are unbound today.

**Verified:** there is no `wheel` listener anywhere in `src/` — this is the first one.

- [ ] **Step 1: failing test** — `src/utils/gridSize.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import {
  DEFAULT_GRID_SIZE,
  GRID_CELL_TARGET,
  GRID_SIZES,
  gridCellWidth,
  gridColsFor,
  isGridSize,
  stepGridSize,
} from "./gridSize";

describe("grid size", () => {
  test("three steps, the numbers the board picked, medium in the middle", () => {
    expect(GRID_SIZES).toEqual(["small", "medium", "large"]);
    expect(GRID_CELL_TARGET).toEqual({ small: 128, medium: 168, large: 256 });
    expect(DEFAULT_GRID_SIZE).toBe("medium");
  });

  test("medium is TODAY's grid at both the default and the maximized window", () => {
    // 1600-wide window → .cull-grid content 1600 − 48 padding = 1552.
    expect(gridColsFor(1552, "medium")).toBe(9);
    // 2560-wide window → 2512 of content; today's 168 target gives 14 columns.
    expect(gridColsFor(2512, "medium")).toBe(14);
    expect(gridCellWidth(2512, 14)).toBe(179);
  });

  test("small and large land where the board said", () => {
    expect(gridColsFor(2512, "small")).toBe(19);
    expect(gridCellWidth(2512, 19)).toBe(132);
    expect(gridColsFor(2512, "large")).toBe(9);
    expect(gridCellWidth(2512, 9)).toBe(279);
  });

  test("never fewer than two columns, however narrow", () => {
    expect(gridColsFor(100, "large")).toBe(2);
    expect(gridColsFor(0, "medium")).toBe(2);
  });

  test("stepping clamps at both ends — no wrap", () => {
    expect(stepGridSize("small", 1)).toBe("medium");
    expect(stepGridSize("medium", 1)).toBe("large");
    expect(stepGridSize("large", 1)).toBe("large");
    expect(stepGridSize("large", -1)).toBe("medium");
    expect(stepGridSize("medium", -1)).toBe("small");
    expect(stepGridSize("small", -1)).toBe("small");
  });

  test("the guard accepts exactly the three values", () => {
    expect(GRID_SIZES.every(isGridSize)).toBe(true);
    expect(isGridSize("huge")).toBe(false);
    expect(isGridSize(168)).toBe(false);
    expect(isGridSize(undefined)).toBe(false);
  });

  test("the cell width falls back to the medium target before anything is measured", () => {
    expect(gridCellWidth(0, 6)).toBe(GRID_CELL_TARGET.medium);
  });
});
```

- [ ] **Step 2: the type.** In `src/types/settings.ts`, beside `ThumbsPosition`:

```ts
/** Contact-sheet cell size. Drives the column-target maths in utils/gridSize;
 *  `medium` is today's grid at every window size. */
export type GridSize = "small" | "medium" | "large";
```

add `gridSize: GridSize;` to `Settings` (directly under `thumbsPosition`, with the comment `/** Contact-sheet cell size. +/− in the grid, Ctrl+0 back to medium. */`), and `gridSize: "medium",` to `DEFAULT_SETTINGS` under `thumbsPosition: "bottom",`. Add `GridSize` to the re-export list in `src/types/index.ts:13`.

`SETTINGS_STORAGE_KEY` does **not** change: `Settings` is mostly flat and `coerceSettings` gives an absent field its default, which is exactly the migration a new field needs (`types/settings.ts:9-13`). Settings are localStorage-only — `grep -rn "settings" src-tauri/src` confirms nothing crosses the IPC boundary as a typed struct, so there is no Rust side to keep in sync.

- [ ] **Step 3: the module** — `src/utils/gridSize.ts`:

```ts
import type { GridSize } from "../types/settings";

/**
 * Contact-sheet sizing. Pure: GridView and App both derive their numbers from
 * here so `cols` and `cellW` can never come from two different formulas.
 *
 * cols = max(2, floor(contentW / target)); cellW = floor(contentW / cols);
 * rows are square (GridView sets rowH = cellW). Unchanged from the single-size
 * version — only the target moved from a constant to a three-way choice.
 */
export const GRID_SIZES = ["small", "medium", "large"] as const satisfies readonly GridSize[];

/**
 * Column target per step. MEDIUM IS 168, not the board's 176: at 2560 both
 * give 14 columns, but at the 1600 default window 176 drops one — and Medium
 * has to be today's grid at EVERY window size, which is what it promised.
 */
export const GRID_CELL_TARGET: Record<GridSize, number> = {
  small: 128,
  medium: 168,
  large: 256,
};

export const DEFAULT_GRID_SIZE: GridSize = "medium";

export function isGridSize(v: unknown): v is GridSize {
  return typeof v === "string" && (GRID_SIZES as readonly string[]).includes(v);
}

/** One step, clamped at both ends — the grid never wraps small↔large. */
export function stepGridSize(current: GridSize, dir: 1 | -1): GridSize {
  const at = GRID_SIZES.indexOf(current);
  const next = Math.min(GRID_SIZES.length - 1, Math.max(0, at + dir));
  return GRID_SIZES[next];
}

/** Columns for a measured content width (padding already subtracted). */
export function gridColsFor(contentWidth: number, size: GridSize): number {
  return Math.max(2, Math.floor(contentWidth / GRID_CELL_TARGET[size]));
}

/** Cell width for a measured content width and column count. Before the first
 *  measurement (contentWidth 0) it answers the medium target, so the very
 *  first paint is the size the grid is about to become. */
export function gridCellWidth(contentWidth: number, cols: number): number {
  return contentWidth > 0 ? Math.floor(contentWidth / cols) : GRID_CELL_TARGET[DEFAULT_GRID_SIZE];
}
```

- [ ] **Step 4: coercion.** In `src/hooks/useSettings.ts`, add `import { isGridSize } from "../utils/gridSize";` and one field in the returned object, next to `thumbsPosition`:

```ts
    gridSize: isGridSize(p.gridSize) ? p.gridSize : d.gridSize,
```

Test first — append to `src/hooks/useSettings.test.ts`:

```ts
describe("coerceSettings — gridSize", () => {
  it("defaults to medium on a blob that predates the field", () => {
    expect(coerceSettings({}).gridSize).toBe("medium");
    expect(DEFAULT_SETTINGS.gridSize).toBe("medium");
  });

  it("keeps a valid stored value and rejects anything else", () => {
    expect(coerceSettings({ gridSize: "large" }).gridSize).toBe("large");
    expect(coerceSettings({ gridSize: "small" }).gridSize).toBe("small");
    expect(coerceSettings({ gridSize: "huge" }).gridSize).toBe("medium");
    expect(coerceSettings({ gridSize: 256 }).gridSize).toBe("medium");
  });
});
```

- [ ] **Step 5: `GridView.tsx`.** Delete the `GRID_CELL_TARGET` export and its doc block (`:21-26`), add `import { gridCellWidth } from "../utils/gridSize";`, and replace `:185`:

```ts
  const cellW = gridCellWidth(contentWidth, cols);
```

Update the component's doc comment where it says "App's outer ResizeObserver picks `cols = floor(width / GRID_CELL_TARGET)`" to point at `utils/gridSize.ts` instead.

- [ ] **Step 6: `App.tsx` — cols, the step callbacks, the wheel.** Change the import at `:32` to `import { GridView } from "./components/GridView";` and add `import { gridCellWidth, gridColsFor, stepGridSize } from "./utils/gridSize";`. In the cols effect (`:429-447`), replace `:441`:

```ts
      setGridCols(gridColsFor(w, settings.gridSize));
```

and add `settings.gridSize` to that effect's dependency array (so a size change re-measures immediately, not on the next resize). Then, directly below that effect:

```tsx
  // Grid size: the setting is the source of truth, so + / − / Ctrl+0 and the
  // Settings row all write the same field and all persist. useSettings's
  // setter takes a WHOLE Settings, not an updater, so these close over the
  // current object and change identity on any settings write.
  const stepGridSizeBy = useCallback(
    (dir: 1 | -1) => setSettings({ ...settings, gridSize: stepGridSize(settings.gridSize, dir) }),
    [settings, setSettings],
  );
  const resetGridSize = useCallback(
    () => setSettings({ ...settings, gridSize: "medium" }),
    [settings, setSettings],
  );

  // Ctrl + wheel over the grid steps the size. NON-PASSIVE on purpose: the
  // preventDefault is what stops the grid scrolling under the gesture (and,
  // belt and braces, any webview zoom — WebView2's zoom hotkeys are already
  // off, since tauri.conf.json leaves `zoomHotkeysEnabled` at its `false`
  // default and that maps to IsZoomControlEnabled). No rAF coalescing: this
  // display runs at 240 Hz, and there are only three steps — a fast trackpad
  // flick simply saturates at Small or Large, which is the right answer.
  useEffect(() => {
    if (!gridVisible || compareMode) return;
    const el = gridContainerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      if (e.deltaY === 0) return;
      stepGridSizeBy(e.deltaY < 0 ? 1 : -1);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [gridVisible, compareMode, gridHasCells, stepGridSizeBy]);
```

`setSettings` is the `update` callback from `useSettings` (`App.tsx:183` destructures `const [settings, setSettings] = useSettings()`; `useSettings.ts:87` types it `(next: Settings) => void` and `:115` wraps it in `useCallback(…, [])`). **There is no updater overload** — `setSettings((s) => …)` is a type error, which is why the two callbacks above spread `settings` and list it in their deps.

**The identity consequence, stated:** `setSettings` itself is stable, but `settings` is not — so `stepGridSizeBy` and `resetGridSize` change identity on *every* settings write. The wheel effect therefore detaches and re-attaches its listener, and the big keymap effect rebuilds its closures, whenever any setting changes. Both are harmless: a settings write is a user action, not a hot path (the keymap already rebuilds on `settings.smartCulling`), and the listener swap is one `removeEventListener`/`addEventListener` pair. Do **not** "optimise" this with a ref — the scrub hot path is already protected by `cullKeyRef`, and a ref here would only hide the dependency.

`gridHasCells` is in the wheel effect's deps for the same reason the cols effect has it: under a no-match filter `GridView` is not mounted and `gridContainerRef.current` is null, so the effect must re-run once cells appear.

- [ ] **Step 7: the keymap.** In `src/app/useCullKeymap.ts`:
  - add `stepGridSizeBy` and `resetGridSize` to the destructured parameters and to the prop type: `stepGridSizeBy: (dir: 1 | -1) => void;` and `resetGridSize: () => void;`
  - **above** the Ctrl-drop at `:543`, directly after the Ctrl+A block (`:510-514`):

```ts
      // Ctrl/Cmd+0 → grid size back to Medium. Above the Ctrl drop below, like
      // every other Ctrl binding. `e.code` covers the numpad zero and the
      // layouts where `0` reports differently.
      if (
        (e.ctrlKey || e.metaKey) &&
        (e.key === "0" || e.code === "Digit0" || e.code === "Numpad0")
      ) {
        e.preventDefault();
        if (gridVisible) resetGridSize();
        return;
      }
```

  - in `handleSingleModeKey`'s `switch (e.key)`, after the `case "g": case "G":` block:

```ts
        // Grid size, grid only. Bare + / = (the unshifted key on most
        // layouts) and − , numpad included via e.key, which reports the same
        // characters for NumpadAdd / NumpadSubtract.
        case "+":
        case "=":
          if (gridVisible) {
            e.preventDefault();
            stepGridSizeBy(1);
          }
          break;
        case "-":
          if (gridVisible) {
            e.preventDefault();
            stepGridSizeBy(-1);
          }
          break;
```

  - add `stepGridSizeBy` and `resetGridSize` to the big effect's dependency array (`:610-647`).
  - pass both from `App.tsx`'s `useCullKeymap({ … })` call (`:1201`).
- [ ] **Step 8: the Settings row.** In `src/components/SettingsDialog.tsx`, add `GridSize` to the type import from `"../types"`, and insert a row in the `general` tab directly after the "Thumb strip position" row:

```tsx
                <SettingRow
                  label="Grid size"
                  help={`Contact-sheet cell size. + / − in the grid, ${modCombo("0")} for medium.`}
                >
                  <SegmentToggle<GridSize>
                    value={settings.gridSize}
                    options={[
                      { value: "small", label: "Small" },
                      { value: "medium", label: "Medium" },
                      { value: "large", label: "Large" },
                    ]}
                    onChange={(v) => set("gridSize", v)}
                  />
                </SettingRow>
```

The modifier is plain text, not a keycap: `SettingRow`'s `help` prop is typed `string`, and the row is prose (the keycaps live in the help sheet — Task 7). `modCombo` makes it read "⌘0" on macOS and "Ctrl+0" on Windows — add `import { modCombo } from "../utils/platform";` (`SettingsDialog.tsx` imports `KeyCombo` at `:12` but not `modCombo` today).

- [ ] **Step 9:** gate green, plus `grep -rn "GRID_CELL_TARGET" src` shows only `src/utils/gridSize.ts` and its test. Commit: `feat(grid): three grid sizes, remembered, on + / − / Ctrl+wheel / Ctrl+0`.

### Task 7: The help sheet draws keycaps

**Files:** Modify `src/types/nav.ts`, `src/components/HelpOverlay.tsx`, `src/styles/help.css`, `src/components/icons.test.ts`. Create `src/components/HelpOverlay.test.tsx`.

**Ordering ruling:** this task runs AFTER Task 6, and absorbs its two new grid rows. The alternative — define the structured row type first and let Task 6 append to it — would have Task 6 editing `HelpOverlay.tsx` and `icons.test.ts` too, which puts the allowlist churn in a task that has nothing else to do with it. One task owns the help sheet, top to bottom.

**Interfaces — Produces** (in `src/types/nav.ts`, re-exported by `src/types/index.ts`, which already lists `HelpGroup`):

```ts
/** One drawn shortcut. `keys` are keycap labels in order; the literal "mod"
 *  renders the platform modifier (Ctrl / ⌘) via KeyCombo. */
export type HelpRow = {
  keys: readonly string[];
  /** Draw the two keys as a range — `1` – `4` — with a muted en dash. */
  range?: boolean;
  /** Muted word after the caps. "hold" is never inside a cap. */
  hold?: boolean;
  desc: string;
};
export type HelpGroup = { title: string; rows: readonly HelpRow[] };
```

`HelpGroup` changes shape (`keys: [string, string][]` → `rows: readonly HelpRow[]`). Its only consumer is `HelpOverlay.tsx` (`grep -rn "HelpGroup" src` to confirm before editing).

**Where the caps come from:** `KeyCombo` (`src/components/KeyCombo.tsx`) already renders one `<kbd className="kbd">` per key and maps `"mod"` through `modLabel` (`"⌘"` / `"Ctrl"`, `src/utils/platform.ts:5`). Pass **no** `className` — the sheet's scrim is dark and `.kbd`'s own `--surface-2` fill reads correctly on it, and adding a `__kbd` class would pull the rule into `src/styles/keycap.test.ts`'s cap-rule scan for no gain.

**`modName` vs `modLabel`:** `HelpOverlay.tsx:2` imports `modName` (`platform.ts:8` — the lowercase PROSE word `"ctrl"` / `"cmd"`) to build strings like `` `${modName}+z` ``; `modLabel` (`platform.ts:5`) is the keycap label `"Ctrl"` / `"⌘"`. Those prose strings disappear with this task — the modifier becomes the `"mod"` token and `KeyCombo` spells it with `modLabel`. `modName`'s only consumers today are `HelpOverlay.tsx:2` and `src/utils/platform.test.ts`, so **after this task it is dead: delete `modName` from `platform.ts` and its assertion from `platform.test.ts`.** Re-run `grep -rn "modName" src` first to confirm nothing landed in between, and report if it did.

**The 132 px key column, and the one row that would overflow it.** From `primitives/kbd.css`: `.kbd` is `min-width: 20px; padding: 0 5px; border: 1px; font-size: var(--fs-3)` (11 px mono, `letter-spacing: 0.04em`), and `.keycombo` is `gap: 3px; white-space: nowrap`. The grid group's `{ keys: ["Shift","←","→","↑","↓"] }` measures ≈47 (the `Shift` cap) + 4 × 20 + 4 × 3 = **139 px** — over the column, and `.cull-help__row` is `white-space: nowrap` (`help.css:63`), so it would bleed into the description. `flex-wrap` on `.cull-help__key` cannot save it while all five caps sit inside ONE nowrap `.keycombo`. **Ruling:** keep the 132 px the spec picked and let that row wrap, by rendering its modifier as its own combo — see Step 3. The row still exposes all five caps, in order, which Step 1 asserts.

- [ ] **Step 1: failing test** — `src/components/HelpOverlay.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { HelpOverlay } from "./HelpOverlay";
import { modLabel } from "../utils/platform";

afterEach(cleanup);

const caps = (root: HTMLElement): string[] =>
  [...root.querySelectorAll("kbd")].map((k) => k.textContent ?? "");

const rowFor = (container: HTMLElement, desc: string): HTMLElement => {
  const row = [...container.querySelectorAll<HTMLElement>(".cull-help__row")].find((r) =>
    r.querySelector(".cull-help__desc")?.textContent?.startsWith(desc),
  );
  if (!row) throw new Error(`no help row described "${desc}"`);
  return row;
};

describe("the help sheet draws keycaps", () => {
  test("every shortcut is a keycap — no plain-text key column left", () => {
    const { container } = render(<HelpOverlay mode="loupe" />);
    for (const row of container.querySelectorAll<HTMLElement>(".cull-help__row")) {
      expect(row.querySelector("kbd"), row.textContent ?? "").not.toBeNull();
    }
  });

  test("the modifier is spelled for the platform, one cap per key", () => {
    const { container } = render(<HelpOverlay mode="loupe" />);
    expect(caps(rowFor(container, "Undo"))).toEqual([modLabel, "Z"]);
    expect(caps(rowFor(container, "Redo"))).toEqual([modLabel, "Shift", "Z"]);
  });

  test('"hold" is a muted word beside the caps, never inside one', () => {
    const { container } = render(<HelpOverlay mode="loupe" />);
    const row = rowFor(container, "This help");
    expect(caps(row)).toEqual(["Tab"]);
    expect(row.querySelector(".cull-help__hold")?.textContent).toBe("hold");
  });

  test("a range is two caps with a muted en dash between them", () => {
    const { container } = render(<HelpOverlay mode="loupe" />);
    const row = rowFor(container, "Filter:");
    expect(caps(row)).toEqual(["1", "4"]);
    expect(row.querySelector(".cull-help__range")?.textContent).toBe("–");
  });

  test("the grid group teaches the new size keys", () => {
    const { container } = render(<HelpOverlay mode="grid" />);
    expect(caps(rowFor(container, "Bigger / smaller cells"))).toEqual(["+", "−"]);
    expect(caps(rowFor(container, "Medium cells"))).toEqual([modLabel, "0"]);
  });

  test("the five-cap row still shows all five, in order, across two combos", () => {
    // Split so the 132px key column can wrap (one nowrap combo would bleed
    // into the description) — the caps and their order must not change.
    const { container } = render(<HelpOverlay mode="grid" />);
    const row = rowFor(container, "Grow selection");
    expect(caps(row)).toEqual(["Shift", "←", "→", "↑", "↓"]);
    expect(row.querySelectorAll(".keycombo")).toHaveLength(2);
  });
});
```

- [ ] **Step 2: the type.** Replace `src/types/nav.ts`'s last declaration with the `HelpRow` / `HelpGroup` pair above (keep the surrounding doc comments' voice).
- [ ] **Step 3: `HelpOverlay.tsx`.** Rewrite `helpGroupsFor` so every entry is a `HelpRow`, and the renderer draws caps. The vocabulary, verbatim from spec §7B: `Ctrl` `Z` · `Ctrl` `Shift` `Z` · `Shift` `Space` · `Esc` · `Enter` · `Backspace` · `Tab` · `Space` · `Click` · arrows as `←` `→` `↑` `↓` caps · letters upper-case inside the cap · a range as `1` – `4` · "hold" as a muted word after the caps.

  The session group becomes:

```ts
  const session: HelpGroup = {
    title: "session",
    rows: [
      { keys: ["mod", "Z"], desc: "Undo" },
      { keys: ["mod", "Shift", "Z"], desc: "Redo" },
      { keys: ["mod", "E"], desc: "Finish actions" },
      { keys: ["Tab"], hold: true, desc: "This help" },
      { keys: ["Esc"], desc: "Leave to home (clears a grid selection first)" },
    ],
  };
```

  and every other group follows the same mapping, one row per existing pair:
  - `["enter", …]` → `{ keys: ["Enter"], … }`; `backspace` → `["Backspace"]`; `f` → `["F"]`; `u` → `["U"]`; `k` → `["K"]`; `i` `h` `p` `o` `t` `c` `g` `l` → their upper-case cap.
  - `["← →", …]` → `{ keys: ["←", "→"], … }` and the description loses its "(hold to scrub)" parenthesis in favour of `hold: true`? **No** — `hold` means the KEY is held; "hold to scrub" is a second sentence about the same key. Keep those descriptions exactly as they are and set no `hold` flag. Only the four rows that literally read `(hold)` today get `hold: true`: `tab (hold)`, `space (hold)` (loupe and compare) and `click (hold)`.
  - `["space (hold)", …]` → `{ keys: ["Space"], hold: true, … }`; `["click (hold)", …]` → `{ keys: ["Click"], hold: true, … }`; `["shift+space", …]` → `{ keys: ["Shift", "Space"], … }`.
  - `["1 – 4", …]` → `{ keys: ["1", "4"], range: true, … }`.
  - `["↑ ↓", …]` → `{ keys: ["↑", "↓"], … }`; `["click", …]` → `{ keys: ["Click"], … }`; `["⇧+click", …]` → `{ keys: ["Shift", "Click"], … }`; `["⇧+← → ↑ ↓", …]` → `{ keys: ["Shift", "←", "→", "↑", "↓"], … }`; `` [`${modName}+click`, …] `` → `{ keys: ["mod", "Click"], … }`; `` [`${modName}+a`, …] `` → `{ keys: ["mod", "A"], … }`.
  - **New, in the grid mode's `navigate` group**, after the `↑ ↓` row:

```ts
        { keys: ["+", "−"], desc: "Bigger / smaller cells" },
        { keys: ["mod", "0"], desc: "Medium cells" },
```

    (the minus cap is U+2212 MINUS SIGN, not a hyphen — it reads as a key, and it is not in `icons.test.ts`'s `CHROME_GLYPHS`.)

  The renderer replaces `:170-182`:

```tsx
        <div className="cull-help__grid">
          {groups.map((g) => (
            <div key={g.title}>
              <div className="eyebrow cull-help__group">{g.title}</div>
              {g.rows.map((row) => (
                <div key={`${row.keys.join("+")}·${row.desc}`} className="cull-help__row">
                  <span className="cull-help__key">
                    {row.range ? (
                      <>
                        <KeyCombo keys={[row.keys[0]]} />
                        <span className="cull-help__range">–</span>
                        <KeyCombo keys={[row.keys[1]]} />
                      </>
                    ) : row.keys.length > 3 ? (
                      // Four or more caps overflow the 132px key column inside
                      // one `white-space: nowrap` combo. Splitting the leading
                      // modifier off gives .cull-help__key's flex-wrap a seam
                      // to break at, without changing the caps or their order.
                      <>
                        <KeyCombo keys={[row.keys[0]]} />
                        <KeyCombo keys={row.keys.slice(1)} />
                      </>
                    ) : (
                      <KeyCombo keys={row.keys} />
                    )}
                    {row.hold && <span className="cull-help__hold">hold</span>}
                  </span>
                  <span className="cull-help__desc">{row.desc}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
```

  with `import { KeyCombo } from "./KeyCombo";` and `import type { HelpGroup, HelpMode } from "../types";`.

- [ ] **Step 4: `help.css`.** `.cull-help__row`'s `grid-template-columns: 110px 1fr` → `132px 1fr`, and its `white-space: nowrap` stays (the key column must not wrap; the description has its own `white-space: normal`). Replace `.cull-help__key`'s type declarations — the caps own their font now:

```css
.cull-help__key {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--sp-1);
}

/* The en dash inside a range — a separator between two caps, not a key. */
.cull-help__range {
  color: var(--muted);
}

/* "hold" stands beside the caps, never inside one: it is an instruction about
   the key, not part of its name. */
.cull-help__hold {
  color: var(--muted);
  font-size: var(--fs-3);
}
```

  The old `font-family: var(--font-mono); color: var(--text); font-size: var(--fs-3); letter-spacing: 0.04em; font-weight: 400;` all go — `.kbd` sets each of them. (`src/styles/keycap.test.ts`'s cap-rule regex matches `.kbd`, `__kbd`, ` kbd` and `-key`; `.cull-help__key` matches none of those, so that suite is unaffected either way.)

- [ ] **Step 5: the icons allowlist.** Five `ALLOWLIST` entries in `src/components/icons.test.ts` pin HelpOverlay source lines verbatim; all five lines are rewritten by this task, so the entries go stale in the same commit that breaks them. Procedure — do NOT hand-guess the new text:
  1. Delete the five `file: "src/components/HelpOverlay.tsx"` entries.
  2. Let the prettier hook format `HelpOverlay.tsx` (or run `pnpm format`) — the allowlist matches the TRIMMED line as prettier leaves it, and `printWidth` is 100.
  3. Run `pnpm test -- icons`. The "every chrome glyph is drawn by a Lucide icon" test fails and prints `src/components/HelpOverlay.tsx:<line>  <glyphs>  <trimmed line>` for each remaining `↓` / `★`. (`CHROME_GLYPHS`, `icons.test.ts:18`, contains only `↓` and `★` of the marks involved — `←`, `→` and `↑` are not guarded, so a row carrying only those is not reported and needs no entry.)
  4. Paste each printed trimmed line back as a new `ALLOWLIST` entry with its reason. Expect **five**, matching the five that were deleted: the two `←↑↓→ pan` descriptions (loupe and compare), the `["↑", "↓"]` row-up/down keys, the `["Shift", "←", "→", "↑", "↓"]` grow-selection keys, and `"Keep both · challenger ★"`. Prettier breaks the loupe Space row past `printWidth: 100`, so its pinned line is the trimmed `desc: "1:1 zoom · ←↑↓→ pan · rating carries zoom to the next frame",`; the compare one (~90 columns) stays on one line — which is exactly why the lines are copied from the failure output rather than predicted. Reasons, reusing the existing voice:
     - arrows in a description → `"Names the arrow KEYS being pressed — key names, like the caps on the row above."`
     - arrows in `keys` → `"The key cap itself — this row IS the arrow keys."`
     - the star → `"Prose describing what the f key does; the help table is text, not chrome."`
  5. The "every allowlisted character still matches a line that is there" test is what proves the paste was exact. Both must be green before committing — they are one commit.
- [ ] **Step 6:** gate green. Commit: `feat(ui): the help sheet draws every shortcut as a keycap`.

### Task 8: Rust — the grid-thumbnail generator

**Files:** Create `src-tauri/src/gridthumb.rs`. Modify `src-tauri/src/lib.rs` (one `mod` line + the module-map table row).

**Interfaces — Produces:**

```rust
// src-tauri/src/gridthumb.rs
pub const GRID_LONG_EDGE: u32 = 512;
pub const GRID_QUALITY: u8 = 82;
pub struct GridThumb { pub jpeg: Vec<u8>, pub width: u32, pub height: u32 }
pub fn grid_dims(w: u32, h: u32) -> Option<(u32, u32)>;
pub fn generate_grid_thumb_jpeg(
    preview_jpeg: &[u8],
    orientation: u32,
    cancelled: &dyn Fn() -> bool,
) -> Result<GridThumb, String>;
```

**Why a new module rather than a parameter on `midtier`:** `midtier.rs`'s constants are `pub` and referenced by name in `bundle.rs`, its tests assert the 2560/q80 numbers directly, and its `MidGen` gate is sized for a 250–400 ms CPU job. A 512-px thumb from a 1620 × 1080 preview is ~20 ms. Keeping them apart costs one near-copy of a 45-line function and keeps both tier's numbers readable at their own use site. **The concurrency gate is shared** — `MidGen`'s semaphore and pending set are generic over "a CPU generation job keyed by path", and a second semaphore would let the two tiers oversubscribe the CPU together. Task 10 reuses `MidGen`.

**The orientation splice is mandatory.** `jpeg_rgb::decode_rgb` ignores the source's EXIF APP1, so the decoded pixels are in the unrotated sensor frame and the re-encode emits no EXIF. Without `cr3::with_exif_orientation` (`cr3.rs:360`) every portrait frame in the grid is sideways. Note the source here is the PRVW, which `read_preview_bundle` already spliced (`cr3.rs:674`) — that splice is invisible to the decoder, so the output needs its own.

- [ ] **Step 1: failing tests.** Write `src-tauri/src/gridthumb.rs`'s `#[cfg(test)] mod tests` first, mirroring `midtier.rs:198-272`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::synth_jpeg;

    fn decode_rgb(jpeg: &[u8]) -> (Vec<u8>, u32, u32) {
        let (px, w, h) = crate::jpeg_rgb::decode_rgb(jpeg).expect("decode");
        (px, w as u32, h as u32)
    }

    #[test]
    fn grid_dims_scales_long_edge_to_512_preserving_aspect() {
        // The PRVW this tier is generated from: 1620×1080 (3:2) → 512×341.
        assert_eq!(grid_dims(1620, 1080), Some((512, 341)));
        // A portrait-shaped source transposes.
        assert_eq!(grid_dims(1080, 1620), Some((341, 512)));
        assert_eq!(grid_dims(1000, 1000), Some((512, 512)));
        // Rounding: 513×200 → short = 200*512/513 = 199.6 → 200.
        assert_eq!(grid_dims(513, 200), Some((512, 200)));
        // At or under the cap (and degenerate inputs): no grid thumb.
        assert_eq!(grid_dims(512, 342), None);
        assert_eq!(grid_dims(160, 120), None);
        assert_eq!(grid_dims(0, 1080), None);
    }

    #[test]
    fn generate_resizes_reencodes_and_preserves_pixels() {
        let input = synth_jpeg(1620, 1080, 90);
        let g = generate_grid_thumb_jpeg(&input, 1, &|| false).expect("generate");
        assert_eq!((g.width, g.height), (512, 341));
        assert_eq!(&g.jpeg[..2], &[0xFF, 0xD8], "SOI");
        assert_eq!(&g.jpeg[g.jpeg.len() - 2..], &[0xFF, 0xD9], "EOI");
        // Orientation 1 splices nothing: jpeg-encoder's JFIF APP0 leads.
        assert_eq!(g.jpeg[3], 0xE0, "no APP1 for upright frames");

        let (px, w, h) = decode_rgb(&g.jpeg);
        assert_eq!((w, h), (512, 341));
        // Channel sanity at an asymmetric point — grid (384, 85) maps back to
        // source (1215, 269): R = 1215·255/1620 ≈ 191, G = 269·255/1080 ≈ 64,
        // B = 1484·255/2700 ≈ 140. A swapped channel order would put ~64
        // where ~191 belongs. Tolerance covers q82 + resampling + synth noise.
        let i = (85usize * 512 + 384) * 3;
        let (r, g_, b) = (px[i] as i32, px[i + 1] as i32, px[i + 2] as i32);
        assert!((r - 191).abs() < 20, "R at 3/4-x should be ≈191, got {r}");
        assert!((g_ - 64).abs() < 20, "G at 1/4-y should be ≈64, got {g_}");
        assert!((b - 140).abs() < 20, "B on the diagonal should be ≈140, got {b}");
    }

    #[test]
    fn generate_refuses_sources_not_larger_than_the_tier() {
        let input = synth_jpeg(400, 300, 85);
        let err = generate_grid_thumb_jpeg(&input, 1, &|| false).unwrap_err();
        assert!(err.contains("not larger"), "got: {err}");
    }

    /// A rotated source must come out with OUR orientation APP1 spliced right
    /// after SOI — unrotated pixels, webview rotates — like every other tier.
    /// Without this, every portrait frame in the grid is sideways.
    #[test]
    fn generate_splices_source_orientation_app1() {
        let input = synth_jpeg(1620, 1080, 90);
        for orient in [3u32, 6, 8] {
            let g = generate_grid_thumb_jpeg(&input, orient, &|| false).expect("generate");
            assert_eq!(&g.jpeg[2..4], &[0xFF, 0xE1], "orient {orient}: APP1 marker");
            assert_eq!(&g.jpeg[6..12], b"Exif\0\0", "orient {orient}: EXIF header");
            assert_eq!(g.jpeg[30] as u32, orient, "orient {orient}: tag value");
            let (_, w, h) = decode_rgb(&g.jpeg);
            assert_eq!((w, h), (512, 341), "orient {orient}: pixels never rotate");
        }
    }

    #[test]
    fn generate_bails_on_cancellation() {
        let input = synth_jpeg(1620, 1080, 90);
        let err = generate_grid_thumb_jpeg(&input, 1, &|| true).unwrap_err();
        assert_eq!(err, "cancelled");
    }

    #[test]
    fn generate_refuses_undecodable_bytes() {
        let err = generate_grid_thumb_jpeg(b"not a jpeg", 1, &|| false).unwrap_err();
        assert!(err.starts_with("grid thumb "), "got: {err}");
    }
}
```

- [ ] **Step 2: the module.** `src-tauri/src/gridthumb.rs`:

```rust
//! Grid-thumbnail generation (Phase 3B): the sharp contact-sheet tier.
//!
//! The grid used to paint the CR3's embedded THMB (160×120). At DPR 1.5 a
//! 161-px frame is already a 1.5× upscale, and the Large grid size would make
//! it 2.4× — visibly soft on exactly the screen this app is used on. This tier
//! is [`GRID_LONG_EDGE`] px on the long edge, q[`GRID_QUALITY`], generated from
//! the CR3's embedded 1620×1080 PRVW preview (which `read_preview` has already
//! read and cached, so the grid tier costs CPU, not a second source read).
//!
//! Same pure pipeline as [`crate::midtier`], one tier down: `zune-jpeg` decode
//! → `fast_image_resize` SIMD Lanczos3 → `jpeg-encoder` → splice the SOURCE's
//! EXIF orientation with [`crate::cr3::with_exif_orientation`]. The decoder
//! ignores the PRVW's own APP1 and the re-encode emits none, so THE SPLICE IS
//! MANDATORY — without it every portrait frame in the grid is sideways.
//!
//! A separate module rather than a parameter on `midtier`: that tier's numbers
//! are `pub` and asserted by name, and it serves a 250–400 ms job where this is
//! ~20 ms. The generation-concurrency GATE is shared ([`crate::midtier::MidGen`])
//! so the two tiers cannot oversubscribe the CPU against each other.

use fast_image_resize::images::Image;
use fast_image_resize::{FilterType, PixelType, ResizeAlg, ResizeOptions, Resizer};
use jpeg_encoder::{ColorType, Encoder};

use crate::cr3::with_exif_orientation;

/// Long-edge cap of the grid tier. 512 covers the Large grid cell (279 CSS px
/// frame → 419 device px at DPR 1.5) with headroom, at ~35 KB per frame.
pub const GRID_LONG_EDGE: u32 = 512;
/// JPEG quality of the grid tier. A notch above the mid tier's 80: these are
/// small files where a little extra quality costs kilobytes, not megabytes.
pub const GRID_QUALITY: u8 = 82;

/// A generated grid-tier JPEG plus its (unrotated) pixel dimensions.
#[derive(Debug)]
pub struct GridThumb {
    /// q82 JPEG with the source's orientation APP1 spliced in.
    pub jpeg: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

/// Target dimensions for a grid thumb from a `w`×`h` source: long edge scaled
/// to exactly [`GRID_LONG_EDGE`], short edge rounded, aspect preserved. `None`
/// when the source's long edge is already ≤ the cap — such a source needs no
/// grid thumb (the command answers the quiet sentinel and the cell keeps its
/// THMB), and re-encoding it would only burn CPU for a quality loss.
pub fn grid_dims(w: u32, h: u32) -> Option<(u32, u32)> {
    let long = w.max(h);
    if long <= GRID_LONG_EDGE || w == 0 || h == 0 {
        return None;
    }
    let short = w.min(h);
    // Round-half-up in u64 for symmetry with midtier::mid_dims (no overflow
    // risk at this size, but the two formulas must not drift).
    let scaled = ((short as u64 * GRID_LONG_EDGE as u64 + long as u64 / 2) / long as u64) as u32;
    let scaled = scaled.max(1);
    Some(if w >= h {
        (GRID_LONG_EDGE, scaled)
    } else {
        (scaled, GRID_LONG_EDGE)
    })
}

/// Decode → resize → encode → orientation splice. `cancelled` is polled
/// between the pipeline stages (each is indivisible) — a superseded generation
/// dies at the next stage boundary and returns the `"cancelled"` sentinel the
/// command layer drops quietly.
pub fn generate_grid_thumb_jpeg(
    preview_jpeg: &[u8],
    orientation: u32,
    cancelled: &dyn Fn() -> bool,
) -> Result<GridThumb, String> {
    if cancelled() {
        return Err("cancelled".into());
    }
    let (pixels, w, h) =
        crate::jpeg_rgb::decode_rgb(preview_jpeg).map_err(|e| format!("grid thumb {e}"))?;
    let (w, h) = (w as u32, h as u32);
    let Some((tw, th)) = grid_dims(w, h) else {
        return Err(format!("source not larger than grid tier ({w}x{h})"));
    };

    if cancelled() {
        return Err("cancelled".into());
    }
    let src = Image::from_vec_u8(w, h, pixels, PixelType::U8x3)
        .map_err(|e| format!("grid thumb resize src: {e}"))?;
    let mut dst = Image::new(tw, th, PixelType::U8x3);
    Resizer::new()
        .resize(
            &src,
            &mut dst,
            &ResizeOptions::new().resize_alg(ResizeAlg::Convolution(FilterType::Lanczos3)),
        )
        .map_err(|e| format!("grid thumb resize: {e}"))?;
    drop(src);

    if cancelled() {
        return Err("cancelled".into());
    }
    let mut out = Vec::new();
    Encoder::new(&mut out, GRID_QUALITY)
        .encode(dst.buffer(), tw as u16, th as u16, ColorType::Rgb)
        .map_err(|e| format!("grid thumb encode: {e}"))?;

    let jpeg = with_exif_orientation(out, orientation);
    Ok(GridThumb {
        jpeg,
        width: tw,
        height: th,
    })
}
```

- [ ] **Step 3: register it.** `src-tauri/src/lib.rs`: add the module in the alphabetical `mod` block (between `file_ops` and `io_gate`) — **with the dead-code attribute, which is what lets this task's gate go green on its own**:

```rust
// Consumed by `bundle::read_grid_thumb` (Task 10); until that lands the
// module's only callers are its own tests.
#[cfg_attr(not(test), allow(dead_code))]
mod gridthumb;
```

Without it, `cargo clippy --all-targets -- -D warnings` also builds the plain lib target with `cfg(test)` off, where `generate_grid_thumb_jpeg`, `grid_dims`, `GridThumb`, `GRID_LONG_EDGE` and `GRID_QUALITY` have no caller → `function is never used` → the gate fails. Repo precedent for exactly this shape: `src-tauri/src/phash.rs:50` (`#[cfg_attr(not(test), allow(dead_code))]`) and `lib.rs:53`/`:55` (`#[cfg_attr(not(feature = "smart-ml"), allow(dead_code))]`). Task 10 deletes the attribute when it adds the caller.

Add a row to the module-map table in the crate doc:

```
//! | [`gridthumb`] | Phase 3B grid tier: PRVW → SIMD resize ≤512 → q82 encode + orientation splice. |
```

- [ ] **Step 4:** Rust gate green (`cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test` from `src-tauri/`). The frontend gate is unaffected but run it too. Commit: `feat(backend): grid-thumbnail generator — 512px q82 from the embedded preview`.

### Task 9: Rust — a fourth cache tier

**Files:** Modify `src-tauri/src/tier_cache.rs` only.

**Interfaces — Produces:** `CacheTier::Grid` (tier byte **3**, subdir `grid/`, caps **512 MiB total / 512 KiB per entry**). `TierCache::stores` grows from `[TierStore; 3]` to `[TierStore; 4]`. `VERSION` stays **3** — this is purely additive, and a bump would needlessly regenerate every thumb, prvw and mid entry on disk.

**Every `[TierStore; 3]` / tier-byte site that must grow** (read at `f99c0a2`):
- `tier_cache.rs:57-63` — the `CacheTier` enum.
- `:66-72` — `byte()`'s match (exhaustive; the compiler will point at it).
- `:73-79` — `subdir()`'s match.
- `:83-89` — `caps()`'s match.
- `:405` — `stores: [TierStore; 3]`.
- `:415-419` — the array literal in `TierCache::new`.
- `:423-425` — `store()` indexes by `byte() as usize`; correct as long as the bytes stay 0..=3 and the array is in byte order. Keep the literal in byte order.
- `clear()` (`:466-470`) and `size_bytes()` (`:472-475`) iterate `&self.stores`, so they pick the new tier up for free — the tests below prove it rather than assuming it.

- [ ] **Step 1: failing tests.** Add to `tier_cache.rs`'s test module, and extend two existing ones:

```rust
    /// Phase 3B: the grid tier roundtrips through the REAL production caps,
    /// is INDEPENDENT of every other tier (its own subdir + tier byte), and
    /// refuses an entry past its 512 KiB per-entry ceiling.
    #[test]
    fn grid_tier_roundtrips_independently_and_refuses_oversized_entries() {
        let work = tmp("grid");
        std::fs::create_dir_all(&work).unwrap();
        let cache = TierCache::new(work.join("tiers"));
        let src = src_file(&work, "a.cr3", b"cr3");
        let jpeg = vec![0xFFu8; 40_000]; // a realistic q82 512px payload
        cache.put(
            CacheTier::Grid,
            &src,
            1000,
            3,
            b"{\"gridLen\":40000}",
            &jpeg,
        );
        let (h, p) = cache.get(CacheTier::Grid, &src, 1000, 3).expect("grid hit");
        assert_eq!(h.as_slice(), b"{\"gridLen\":40000}");
        assert_eq!(p.len(), jpeg.len());
        // A grid entry can never serve another tier's request, and vice versa.
        assert!(cache.get(CacheTier::Thumb, &src, 1000, 3).is_none());
        assert!(cache.get(CacheTier::Mid, &src, 1000, 3).is_none());
        // Over the 512 KiB cap → refused outright (put bails before the disk).
        // Bound first, like the mid tier's test does — an inline `&vec![…]`
        // reads worse and invites a clippy argument nobody needs to have.
        let huge = vec![0u8; 512 * 1024];
        let before = cache.size_bytes();
        cache.put(CacheTier::Grid, &src, 2000, 4, b"{}", &huge);
        assert_eq!(cache.size_bytes(), before, "oversized put must be a no-op");
        assert!(cache.get(CacheTier::Grid, &src, 2000, 4).is_none());
        let _ = std::fs::remove_dir_all(&work);
    }
```

  In `roundtrips_header_and_payload_per_tier_independently` (`:499`), add after the mid assertion:

```rust
        // Grid never written → miss.
        assert!(cache
            .get(CacheTier::Grid, &src, 1_700_000_000_123, 3)
            .is_none());
```

  In `clear_empties_all_tiers` (`:692`), put and then assert the grid tier alongside thumb and prvw:

```rust
        cache.put(CacheTier::Grid, &src, 1000, 3, b"{}", b"g");
```

```rust
        assert!(cache.get(CacheTier::Grid, &src, 1000, 3).is_none());
```

- [ ] **Step 2: implement.** Four matches and one array:

```rust
pub enum CacheTier {
    Thumb,
    Prvw,
    /// Generated ≤2560px tier (Phase 8) — written by `read_mid` misses, the
    /// opportunistic generator, and the local-profile idle sweep.
    Mid,
    /// Generated 512px contact-sheet tier (Phase 3B) — written by
    /// `read_grid_thumb` misses. Small entries, many of them: a 2,726-frame
    /// shoot is ~95 MB, so the total cap is sized to hold several shoots.
    Grid,
}
```

```rust
    fn byte(self) -> u8 {
        match self {
            CacheTier::Thumb => 0,
            CacheTier::Prvw => 1,
            CacheTier::Mid => 2,
            CacheTier::Grid => 3,
        }
    }
    fn subdir(self) -> &'static str {
        match self {
            CacheTier::Thumb => "thumb",
            CacheTier::Prvw => "prvw",
            CacheTier::Mid => "mid",
            CacheTier::Grid => "grid",
        }
    }
    fn caps(self) -> (u64, u64) {
        match self {
            CacheTier::Thumb => (500 * 1024 * 1024, 256 * 1024),
            CacheTier::Prvw => (2 * 1024 * 1024 * 1024, 2 * 1024 * 1024),
            CacheTier::Mid => (4 * 1024 * 1024 * 1024, 4 * 1024 * 1024),
            CacheTier::Grid => (512 * 1024 * 1024, 512 * 1024),
        }
    }
```

```rust
pub struct TierCache {
    stores: [TierStore; 4],
}
```

```rust
            stores: [
                store(CacheTier::Thumb),
                store(CacheTier::Prvw),
                store(CacheTier::Mid),
                store(CacheTier::Grid),
            ],
```

  And extend the module doc's tier list (`tier_cache.rs:4-6`) with `` `grid/` (the generated 512px contact-sheet tier — Phase 3B) ``. Leave `VERSION` at 3 and add a line to its comment: `/* Phase 3B added CacheTier::Grid additively: a new tier byte cannot collide with an existing entry (the subdirs are disjoint and the byte is checked), so no bump. */`

- [ ] **Step 3:** Rust gate green. Commit: `feat(backend): a fourth cache tier for the grid thumbnail`.

### Task 10: Rust — the `read_grid_thumb` command, and the TS side of the wire

**Files:** Modify `src-tauri/src/bundle.rs`, `src-tauri/src/lib.rs` (the handler list + the module-map row for `bundle`), `src/utils/bundle.ts`.

**Interfaces — Consumes:** `gridthumb::{generate_grid_thumb_jpeg, GridThumb}` (Task 8); `CacheTier::Grid` (Task 9); the existing private `preview_parts(path, session, cache, cancelled) -> Result<(Vec<u8>, Vec<u8>, bool), String>` (`bundle.rs:172`) and `PreviewHeader` (`:124`), both already in this module; `midtier::MidGen` (`try_begin` / `end` / `acquire`); `gated` (`bundle.rs:68`) and `Tier::Small` (`io_gate.rs:52`).

**Produces:**

```rust
// bundle.rs — the acquisition split (see the prvw ruling below)
fn preview_parts_opt(
    path: &str,
    session: &SessionGate,
    cache: &TierCache,
    cancelled: &dyn Fn() -> bool,
    put_on_miss: bool,
) -> Result<(Vec<u8>, Vec<u8>, bool), String>;
// preview_parts(…) stays, as the put_on_miss: true wrapper — read_preview and
// fetch_decoded_preview are untouched. read_grid_thumb passes false.

#[tauri::command]
pub(crate) async fn read_grid_thumb(
    path: String,
    gen: u64,
    cache: State<'_, Arc<TierCache>>,
    gate: State<'_, Arc<IoGate>>,
    session: State<'_, Arc<SessionGate>>,
    midgen: State<'_, Arc<MidGen>>,
) -> Result<Response, String>;
```

Wire frame: the app's usual `u32 LE headerLen + JSON header + JPEG`, header `{ "gridLen": u32, "width": u32, "height": u32 }` (unrotated dims, `serde(rename_all = "camelCase")`). **Two** error sentinels, deliberately distinct:
- **`"grid thumb unavailable"`** + a parenthesised reason — permanent for this file. The frontend latches it and never asks again.
- **`"grid thumb pending"`** — transient: another producer holds this path's `MidGen` claim. The frontend must be able to ask again.

```ts
// src/utils/bundle.ts
export const GRID_THUMB_UNAVAILABLE_RE: RegExp; // /grid thumb unavailable/i
export const GRID_THUMB_PENDING_RE: RegExp;     // /grid thumb pending/i
export async function fetchGridThumb(
  path: string,
  gen: number,
): Promise<{ url: string; width: number; height: number }>;
```

**Design notes, each verified against the code:**
- **No `fullOffset` / `fullLen` / `orientation` arguments.** Unlike `read_mid`, this tier's source is the PRVW, not the mdat full — the acquisition reads the `prvw/` cache or takes one ~2 MiB head read, and the orientation comes out of the stored `PreviewHeader` (`bundle.rs:124-130`). Two arguments, not five.
- **Ruling (the spec wins): the grid path does NOT fill the prvw cache.** `preview_parts` piggybacks a miss into `CacheTier::Prvw` (`bundle.rs:195-197`), and the grid visits frames the loupe never opens — so grid scrolling at Large genuinely would write every visited frame's ~0.3–0.8 MB PRVW across the shoot. At 2,726 frames that is ~2.2 GB against a 2 GiB cap: the store would shed 10–20 % of itself, and each shed loupe preview costs a fresh ~2 MiB head read on the next navigation. That is exactly what spec §"the sharper grid thumbnail" forbids — *"The grid path must NOT fill the preview cache."* So the reader is split rather than forked: `preview_parts_opt(…, put_on_miss)` holds the one copy of the acquisition logic, `preview_parts(…)` is the `true` wrapper (so `read_preview` and `fetch_decoded_preview` are byte-for-byte unchanged), and `read_grid_thumb` passes `false`. **A prvw cache HIT is still served** — zero source I/O when the user has already navigated to that frame; only the *write-back on a miss* is suppressed.
- **Two sentinels, and why they must not be one.** `"grid thumb unavailable"` covers the three permanent causes: no PRVW (`cr3::read_preview_bundle` → `Err("… no PRVW")` — HEVC/HDR bodies and other firmware), an undecodable preview, and a preview not larger than 512 on its long edge. `"grid thumb pending"` is separate because `MidGen`'s pending set is SHARED with `maybe_generate_mid_opportunistic` (`bundle.rs:423`) and `generate_mid` (`:593`) — the local-profile idle sweep that walks the whole shoot. A grid scroll racing that sweep bounces often, and folding it into the latching sentinel would permanently strand those cells on the soft THMB.
- **`Tier::Small` and a `MidGen` permit.** The read is a head read or a cache hit (Small's 8 s local / 20 s network timeout is right); the CPU work takes a generation permit from the SHARED `MidGen` so grid and mid generation cannot oversubscribe the CPU together.
- **`generate_mid`-style local-only gating does NOT apply.** Spec has no such rule for this tier, the source is a ~2 MiB head read rather than a ~10 MB full, and on the network profile the grid is exactly where a NAS user needs the sharpening. The lane's own network concurrency (1) is the throttle.

- [ ] **Step 1: split the prvw acquisition.** In `bundle.rs`, rename the existing `preview_parts` (`:172`) to `preview_parts_opt`, add the flag, and gate the one `cache.put` behind it. Nothing else in the body moves:

```rust
/// The one prvw acquisition path (shared by [`read_preview`],
/// [`fetch_decoded_preview`] and [`read_grid_thumb`], so cache/read behavior
/// can never drift): validated cache hit returns the stored wire header +
/// payload VERBATIM; a miss is ONE head read.
///
/// `put_on_miss` decides whether that miss is written back to the prvw tier.
/// Navigation says yes — it is the tier's own filler. The GRID says no: it
/// visits frames the loupe never opens, and writing every one of them would
/// push ~2.2 GB through a 2 GiB cap and evict the previews the user is
/// actually navigating (spec: "the grid path must NOT fill the preview
/// cache"). A cache HIT still serves the grid, at zero source I/O.
///
/// Returns `(header_json, preview_jpeg, was_cache_hit)`.
fn preview_parts_opt(
    path: &str,
    session: &SessionGate,
    cache: &TierCache,
    cancelled: &dyn Fn() -> bool,
    put_on_miss: bool,
) -> Result<(Vec<u8>, Vec<u8>, bool), String> {
    let stat = resolve_stat(session, path);
    if let Some((ms, size)) = stat {
        if let Some((header, payload)) = cache.get(CacheTier::Prvw, path, ms, size) {
            return Ok((header, payload, true));
        }
    }
    let b = cr3::read_preview_bundle(path, cancelled).map_err(|e| format!("cr3 preview: {e}"))?;
    let mut meta = ImageMetadata::from(b.meta);
    meta.file_size = Some(b.file_size);
    let header = PreviewHeader {
        meta,
        orientation: b.orientation,
        preview_len: b.preview.len() as u32,
        full_offset: b.full_hint.map(|h| h.0),
        full_len: b.full_hint.map(|h| h.1),
    };
    let header_json = serde_json::to_vec(&header).map_err(|e| format!("preview header: {e}"))?;
    if put_on_miss {
        if let Some((ms, size)) = stat {
            cache.put(CacheTier::Prvw, path, ms, size, &header_json, &b.preview);
        }
    }
    Ok((header_json, b.preview, false))
}

/// The navigation form: a miss piggy-backs into the prvw cache, as it always
/// has. `read_preview` and `fetch_decoded_preview` call this and are unchanged.
fn preview_parts(
    path: &str,
    session: &SessionGate,
    cache: &TierCache,
    cancelled: &dyn Fn() -> bool,
) -> Result<(Vec<u8>, Vec<u8>, bool), String> {
    preview_parts_opt(path, session, cache, cancelled, true)
}
```

- [ ] **Step 2: the Rust command.** In `bundle.rs`, after the mid-tier section and before `// ── Thumbnail ──`:

```rust
// ── Grid tier (Phase 3B): the sharp contact-sheet thumbnail ────────────────

/// Header for [`read_grid_thumb`]: JPEG length + the thumb's (unrotated) pixel
/// dims. Stored VERBATIM in the tier cache (the bump-VERSION-on-header-change
/// contract applies to this shape from now on).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GridThumbHeader {
    grid_len: u32,
    width: u32,
    height: u32,
}

/// PERMANENT: this file will never have a grid thumb (no PRVW, an undecodable
/// one, or one already ≤512px). The frontend latches it per path and leaves
/// the cell on its THMB — never a shimmer, never a retry loop, never an error
/// chip (grid cells have no error state).
const GRID_THUMB_UNAVAILABLE: &str = "grid thumb unavailable";

/// TRANSIENT: another producer holds this path's [`MidGen`] claim. NOT the
/// quiet sentinel — the pending set is SHARED with the opportunistic mid
/// generator and the whole-shoot idle sweep, so this bounce is common, and
/// latching it would strand a cell on the soft THMB for the session.
const GRID_THUMB_PENDING: &str = "grid thumb pending";

/// Map a generation failure onto the wire. Permanent causes become the ONE
/// quiet sentinel the frontend latches; a cancellation stays itself so the
/// frontend drops it silently; anything else is a real error with backoff.
fn grid_thumb_error(e: String) -> String {
    if e == "cancelled" || e.ends_with(": cancelled") {
        e
    } else if e.contains("no PRVW") {
        format!("{GRID_THUMB_UNAVAILABLE} (no preview)")
    } else if e.contains("not larger") || e.starts_with("grid thumb ") {
        format!("{GRID_THUMB_UNAVAILABLE} ({e})")
    } else {
        e
    }
}

/// Generate the grid thumb from an in-memory PRVW and publish it to the cache.
/// Returns (header JSON, jpeg) exactly as cached — `read_grid_thumb` frames them.
fn generate_and_cache_grid_thumb(
    cache: &TierCache,
    path: &str,
    stat: (i64, u64),
    preview_jpeg: &[u8],
    orientation: u32,
    cancelled: &dyn Fn() -> bool,
) -> Result<(Vec<u8>, Vec<u8>), String> {
    let g = gridthumb::generate_grid_thumb_jpeg(preview_jpeg, orientation, cancelled)?;
    let header = GridThumbHeader {
        grid_len: g.jpeg.len() as u32,
        width: g.width,
        height: g.height,
    };
    let header_json = serde_json::to_vec(&header).map_err(|e| format!("grid thumb header: {e}"))?;
    cache.put(CacheTier::Grid, path, stat.0, stat.1, &header_json, &g.jpeg);
    Ok((header_json, g.jpeg))
}

/// The grid's sharp thumbnail (Phase 3B). Serves the generated 512px JPEG from
/// the `grid/` disk cache; a hit costs ZERO source-file round-trips and replays
/// the stored wire header verbatim. On a miss it acquires the PRVW through
/// [`preview_parts_opt`] with `put_on_miss: false` — a prvw cache hit is used,
/// but a miss's head read is NOT written back, because the grid visits frames
/// the loupe never opens and would evict the previews navigation depends on
/// (spec: "the grid path must NOT fill the preview cache") — then resizes it
/// under a [`MidGen`] permit.
///
/// A source that has no PRVW, whose PRVW will not decode, or whose PRVW is not
/// larger than the tier answers [`GRID_THUMB_UNAVAILABLE`]: the frontend
/// latches it and the cell keeps the THMB it is already showing. A path whose
/// generation claim is held elsewhere answers [`GRID_THUMB_PENDING`], which the
/// frontend must NOT latch.
#[tauri::command]
pub(crate) async fn read_grid_thumb(
    path: String,
    gen: u64,
    cache: State<'_, Arc<TierCache>>,
    gate: State<'_, Arc<IoGate>>,
    session: State<'_, Arc<SessionGate>>,
    midgen: State<'_, Arc<MidGen>>,
) -> Result<Response, String> {
    let cache = Arc::clone(&cache);
    let session = Arc::clone(&session);
    let label = format!("read_grid_thumb({path})");
    // Stage 1 — cache probe (app-cache disk, cheap).
    let (hit, stat) = {
        let (cache, session, path) = (Arc::clone(&cache), Arc::clone(&session), path.clone());
        gated(&gate, Tier::Small, label.clone(), move || {
            let stat = resolve_stat(&session, &path);
            let hit = stat.and_then(|(ms, size)| cache.get(CacheTier::Grid, &path, ms, size));
            Ok((hit, stat))
        })
        .await?
    };
    if let Some((header, payload)) = hit {
        return Ok(Response::new(frame(header, &payload)));
    }
    let Some(stat) = stat else {
        return Err(format!("{label}: source stat failed"));
    };
    // Claim the path against a concurrent mid/grid generation on the SAME
    // shared gate (the opportunistic generator and the idle sweep use it too,
    // so this bounce is common). TRANSIENT sentinel — the frontend must keep
    // its THMB but stay free to ask again.
    if !midgen.try_begin(&path) {
        return Err(GRID_THUMB_PENDING.to_string());
    }
    let permit = midgen.acquire().await;
    let result = {
        let (cache, session, path) = (Arc::clone(&cache), Arc::clone(&session), path.clone());
        gated(&gate, Tier::Small, label.clone(), move || {
            let _permit = permit;
            let start = Instant::now();
            let cancelled = || session.is_cancelled(gen);
            // put_on_miss: false — a prvw HIT is used (zero source I/O), but a
            // miss is not written back. See preview_parts_opt.
            let (header_json, prvw, _hit) =
                preview_parts_opt(&path, &session, &cache, &cancelled, false)
                    .map_err(grid_thumb_error)?;
            let header: PreviewHeader = serde_json::from_slice(&header_json)
                .map_err(|e| format!("grid thumb prvw header parse: {e}"))?;
            let (out_header, payload) = generate_and_cache_grid_thumb(
                &cache,
                &path,
                stat,
                &prvw,
                header.orientation,
                &cancelled,
            )
            .map_err(grid_thumb_error)?;
            dlog!(
                "[cull] read_grid_thumb({}): generated {}B in {:?}",
                path,
                payload.len(),
                start.elapsed()
            );
            Ok(frame(out_header, &payload))
        })
        .await
    };
    midgen.end(&path);
    result.map(Response::new)
}
```

  Add `use crate::gridthumb;` to the module's `use` block, beside `use crate::midtier::{self, MidGen};`.

- [ ] **Step 3: register.** `src-tauri/src/lib.rs`: add `bundle::read_grid_thumb,` to `generate_handler!` (after `bundle::generate_mid,`), extend the `bundle` module-map row to name it, and **delete the `#[cfg_attr(not(test), allow(dead_code))]` line above `mod gridthumb;`** — the command is now its caller, and leaving the attribute would hide a future real dead-code warning. (This is why Tasks 8 and 10 are strictly serial on `lib.rs`.) **No capability change is needed** — `src-tauri/capabilities/default.json` lists plugin permissions only; app commands are registered here and nowhere else (verify by reading that file before assuming).
- [ ] **Step 4: the Rust tests.** `bundle.rs`'s test module opens with `use super::*`, so everything above is in scope, and it has no Tauri `State` — so test the two pieces of logic this task adds that the command wrapper only plumbs.

  **(a) the sentinel mapping** — a pure function, no fixtures:

```rust
    #[test]
    fn grid_thumb_errors_map_onto_the_right_sentinel() {
        for permanent in [
            "cr3 preview: no PRVW".to_string(),
            "source not larger than grid tier (400x300)".to_string(),
            "grid thumb invalid jpeg".to_string(),
        ] {
            assert!(
                grid_thumb_error(permanent.clone()).starts_with(GRID_THUMB_UNAVAILABLE),
                "should latch: {permanent}"
            );
        }
        // A cancellation is not a failure and must not latch anything — in
        // either of its two shapes (preview_parts wraps it as "cr3 preview:
        // cancelled", cr3.rs:684 + bundle.rs:184).
        assert_eq!(grid_thumb_error("cancelled".into()), "cancelled");
        assert_eq!(
            grid_thumb_error("cr3 preview: cancelled".into()),
            "cr3 preview: cancelled"
        );
        // A real I/O failure stays a real failure (backoff + retry apply) and
        // must NOT be confusable with either sentinel.
        let io = "read_grid_thumb(x): read timed out after 8s".to_string();
        assert_eq!(grid_thumb_error(io.clone()), io);
        assert!(!io.contains(GRID_THUMB_UNAVAILABLE) && !io.contains(GRID_THUMB_PENDING));
        // The two sentinels must never prefix-match each other, or the
        // frontend's latch test would catch the transient one.
        assert!(!GRID_THUMB_PENDING.starts_with(GRID_THUMB_UNAVAILABLE));
        assert!(!GRID_THUMB_UNAVAILABLE.starts_with(GRID_THUMB_PENDING));
    }
```

  **(b) the prvw write-back flag** — the whole point of the split. Two tests, because the honest assertion needs a real CR3 and the repo's answer to that is a corpus gate (`TESTING.md` §"Pass-by-skip philosophy"; precedent in this very module at `thumb_phash_over_sample_dir_is_well_formed`, and in `tier_cache.rs`'s tests for the temp-dir harness):

```rust
    /// A temp dir + a real TierCache, the shape tier_cache.rs's own tests use.
    fn grid_tmp(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("cull-gridprvw-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// Ungated: a prvw cache HIT still serves the grid, at zero source I/O —
    /// `put_on_miss: false` suppresses the write-back, never the read.
    #[test]
    fn grid_acquisition_uses_a_prvw_hit_without_writing_anything() {
        let work = grid_tmp("hit");
        let cache = TierCache::new(work.join("tiers"));
        let session = SessionGate::new();
        // Any file will do: the cache validates against ITS stat, and a hit
        // returns before cr3 parsing is ever reached.
        let src = work.join("a.cr3");
        std::fs::write(&src, b"not really a cr3").unwrap();
        let src = src.to_string_lossy().to_string();
        let (ms, size) = resolve_stat(&session, &src).expect("stat");
        cache.put(CacheTier::Prvw, &src, ms, size, b"{\"orientation\":1}", b"\xFF\xD8prvw");

        let before = cache.size_bytes();
        let (header, payload, hit) =
            preview_parts_opt(&src, &session, &cache, &|| false, false).expect("hit");
        assert!(hit, "a current prvw entry must be served");
        assert_eq!(payload.as_slice(), b"\xFF\xD8prvw");
        assert_eq!(header.as_slice(), b"{\"orientation\":1}");
        assert_eq!(cache.size_bytes(), before, "a hit writes nothing");
        let _ = std::fs::remove_dir_all(&work);
    }

    /// The real assertion, corpus-gated like every other test here that needs
    /// pixels: a grid-tier acquisition on a prvw MISS reads the file and
    /// leaves the prvw store empty, while the navigation form fills it.
    /// `CULL_TEST_CR3_DIR=path cargo test -- --nocapture`.
    #[test]
    fn grid_acquisition_never_fills_the_prvw_cache_on_a_miss() {
        let Ok(dir) = std::env::var("CULL_TEST_CR3_DIR") else {
            eprintln!("skip: set CULL_TEST_CR3_DIR to a folder of .CR3 files");
            return;
        };
        let src = std::fs::read_dir(&dir)
            .expect("read dir")
            .flatten()
            .map(|e| e.path())
            .find(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("cr3")))
            .expect("a CR3 under CULL_TEST_CR3_DIR")
            .to_string_lossy()
            .to_string();

        let work = grid_tmp("miss");
        let cache = TierCache::new(work.join("tiers"));
        let session = SessionGate::new();

        // The grid's form: reads the preview, caches nothing.
        let (_, prvw, hit) =
            preview_parts_opt(&src, &session, &cache, &|| false, false).expect("grid read");
        assert!(!hit, "cold store must be a miss");
        assert!(!prvw.is_empty(), "the preview really was read");
        assert_eq!(
            cache.size_bytes(),
            0,
            "the grid path must not write the prvw tier"
        );

        // The navigation form, same file, same store: fills it.
        let (_, _, hit2) = preview_parts(&src, &session, &cache, &|| false).expect("nav read");
        assert!(!hit2);
        assert!(cache.size_bytes() > 0, "navigation still fills prvw");
        let _ = std::fs::remove_dir_all(&work);
    }
```

- [ ] **Step 5: the TS side.** In `src/utils/bundle.ts`, after `invokeGenerateMid`:

```ts
/** Header for `read_grid_thumb` (Phase 3B): JPEG length + (unrotated) dims. */
type GridThumbHeader = { gridLen: number; width: number; height: number };

/** PERMANENT: this file has no usable preview to sharpen from — none embedded,
 *  undecodable, or already ≤512px. The store LATCHES it per path and the grid
 *  cell keeps the THMB it is already showing — no shimmer, no retry loop, no
 *  error chip. */
export const GRID_THUMB_UNAVAILABLE_RE = /grid thumb unavailable/i;

/** TRANSIENT: another producer holds this path's generation claim on the
 *  backend's shared MidGen gate (the opportunistic mid generator and the
 *  whole-shoot idle sweep use the same pending set, so a grid scroll racing
 *  the sweep hits this often). Must NOT latch — ordinary backoff only, and the
 *  next viewport report asks again. */
export const GRID_THUMB_PENDING_RE = /grid thumb pending/i;

/** Grid-tier read (Phase 3B): the generated 512px JPEG from the disk cache,
 *  generated from the CR3's embedded preview on a miss. Two arguments only —
 *  unlike the mid tier this reads the PRVW, not the mdat full, so there is no
 *  exact-range hint to pass. */
export async function fetchGridThumb(
  path: string,
  gen: number,
): Promise<{ url: string; width: number; height: number }> {
  const buf = await invoke<ArrayBuffer>("read_grid_thumb", { path, gen });
  const view = new DataView(buf);
  const headerLen = view.getUint32(0, true);
  const header = JSON.parse(
    new TextDecoder().decode(new Uint8Array(buf, 4, headerLen)),
  ) as GridThumbHeader;
  const bytes = new Uint8Array(buf, 4 + headerLen, header.gridLen);
  logBlobIntegrity("gridThumb", bytes);
  const url = URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
  return { url, width: header.width, height: header.height };
}
```

- [ ] **Step 6:** both gates green. Commit: `feat(backend): read_grid_thumb serves the sharp contact-sheet tier`.

### Task 11: The sixth lane — grid thumbnails in `imageStore`

**Files:** Create `src/image/gridThumbRule.ts`, `src/image/gridThumbRule.test.ts`. Modify `src/image/stage.ts` (+ `src/image/stage.test.ts`), `src/image/imageStore.ts` (+ `src/image/imageStore.test.ts`), `src/image/useThumb.ts`, `src/image/pressureProfile.ts` (+ `src/image/pressureProfile.test.ts`), `src/types/settings.ts`, `src/app/useImageStoreWiring.ts`, `src/image/devStats.ts`.

**Serial with Task 6:** both edit `src/types/settings.ts`. Task 6 goes first.

**Interfaces — Consumes:** `fetchGridThumb`, `GRID_THUMB_UNAVAILABLE_RE`, `GRID_THUMB_PENDING_RE` (Task 10). **Produces:**

```ts
// src/image/gridThumbRule.ts
export const GRID_CELL_PADDING = 9;   // .cull-grid__cell's padding (styles/grid.css)
export const THMB_LONG_EDGE = 160;    // the embedded THMB's long edge (src-tauri/src/cr3.rs)
export function gridFrameDevicePx(cellW: number, dpr: number): number;
export function wantsGridThumb(cellW: number, dpr: number): boolean;

// src/image/stage.ts
//   ImageState gains:  gridThumb?: { status: "loading" } | { status: "ready"; url: string };
//   Resolved  gains:   gridThumbUrl: string | undefined;

// src/types/settings.ts — PerformanceProfile gains:
//   gridThumbConcurrency: number;   // network 1, local 4
//   gridThumbKeep: number;          // cells kept each side of the grid range: 120 / 120

// src/image/imageStore.ts — public:
setGridCellW(cellW: number): void;      // 0 = grid closed; the lane goes dormant
reevaluateGridThumbs(): void;           // DPR flip
// debugStats() gains:
//   counts.gridThumbLoads, counts.gridThumbEvicts
//   gridThumb: { lane: string; cached: number; cellW: number; wanted: boolean; unavailable: number }

// src/image/useThumb.ts
export function useThumb(path: string): {
  url: string | undefined;
  /** The sharp grid tier, when it has landed. Layered OVER `url`, never
   *  instead of it — see the 8-away flash note. */
  gridUrl: string | undefined;
  shimmerDelayMs: number;
  probeOnLoad: (() => void) | undefined;
};
```

**Ruling (layer, do not switch):** the scout's addendum suggested `thumbDisplayUrl` become a three-way choice. It must not. `thumbDisplayUrl` is pinned by the 8-away-flash invariant (`imageStore.test.ts:1307-1364`): the value a cell's `<img src>` binds must be IDENTICAL across foreign-tier landings, or React swaps the blob and the cell blanks while the engine decodes. Spec §"the sharper grid thumbnail" says the same thing from the design side — *"The THMB stays underneath and paints first; the grid thumbnail fades in over it."* So `thumbDisplayUrl` is untouched, and the grid thumb is a SECOND `<img>` (Task 12). Grid cells have no error state; a grid-thumb failure is simply the absence of that second layer.

**Ruling (the store owns the request, not the cell):** `useThumb` does not request the grid tier. `GridView` reports the cell width and the visible range; the store applies the rule once per range change and requests for the cells inside it. One entry point means one tombstone check, one latch check, one place the DPR flip re-evaluates — and no per-cell effect firing 60 times on every grid scroll.

**Request rule, verified against the code:** `.cull-grid__cell` has `padding: 9px` (`grid.css:83`), so the painted image box is `cellW − 18`. The THMB is 160 × 120 (`cr3.rs:12`). Request only when `(cellW − 18) × devicePixelRatio > 160`. At DPR 1.5 that is `cellW > 124.6` — Small (132) is in, and today's Medium (179) is already a 1.4× upscale.

**Eviction window:** `[gridStart − gridThumbKeep, gridEnd + gridThumbKeep]`, `displayRefs`-protected. **Never reuse `THUMB_LRU_CAP`**: `enforceThumbLru` (`imageStore.ts:1217-1243`) has no recency tracking at all — it early-returns below 15 000 entries and otherwise evicts in Map insertion order — and thumbs survive `reset()`. The grid tier ships its own windowed eviction from day one.

**Tombstones:** `forgotten` gates the lane at its entry point (`requestGridThumb`) and at BOTH landings of `fetchGridThumbInto`, exactly like the other four tiers (`imageStore.ts:1135-1140`, `:1170`).

- [ ] **Step 1: failing test for the rule** — `src/image/gridThumbRule.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { GRID_CELL_PADDING, THMB_LONG_EDGE, gridFrameDevicePx, wantsGridThumb } from "./gridThumbRule";

const sheets = import.meta.glob<string>("../styles/grid.css", {
  query: "?raw",
  eager: true,
  import: "default",
});

describe("the grid-thumb request rule", () => {
  test("the painted box is the cell minus its padding on both sides", () => {
    expect(gridFrameDevicePx(179, 1)).toBe(161);
    expect(gridFrameDevicePx(179, 1.5)).toBe(241.5);
  });

  test("asks only when the painted box needs more than the THMB has", () => {
    // Oliver's screen: DPR 1.5. The break-even cell is 160/1.5 + 18 ≈ 124.7.
    expect(wantsGridThumb(124, 1.5)).toBe(false);
    expect(wantsGridThumb(125, 1.5)).toBe(true);
    // Small / Medium / Large at the maximized 2560 window.
    expect(wantsGridThumb(132, 1.5)).toBe(true);
    expect(wantsGridThumb(179, 1.5)).toBe(true);
    expect(wantsGridThumb(279, 1.5)).toBe(true);
    // At DPR 1 the THMB still covers the two smaller steps.
    expect(wantsGridThumb(132, 1)).toBe(false);
    expect(wantsGridThumb(179, 1)).toBe(true);
  });

  test("a closed grid (cellW 0) never asks", () => {
    expect(wantsGridThumb(0, 3)).toBe(false);
    expect(wantsGridThumb(-1, 3)).toBe(false);
  });

  test("the padding constant is the padding the stylesheet actually draws", () => {
    const css = sheets["../styles/grid.css"] ?? "";
    expect(css, "grid.css must arrive as readable text").toContain(".cull-grid__cell {");
    const rule = css.slice(css.indexOf(".cull-grid__cell {"));
    const m = /padding:\s*(\d+)px/.exec(rule.slice(0, rule.indexOf("}")));
    expect(Number(m?.[1])).toBe(GRID_CELL_PADDING);
    expect(THMB_LONG_EDGE).toBe(160);
  });
});
```

- [ ] **Step 2: the rule module** — `src/image/gridThumbRule.ts`:

```ts
/**
 * When a grid cell needs more pixels than the embedded THMB has.
 *
 * The grid paints the CR3's 160×120 THMB. A cell's painted image box is the
 * cell minus its own padding on both sides (.cull-grid__cell { padding: 9px },
 * styles/grid.css — gridThumbRule.test.ts reads that rule and fails if it
 * moves), so the demand in DEVICE pixels is (cellW − 18) × devicePixelRatio.
 * Above 160 the THMB is being upscaled and the grid tier is worth fetching;
 * at or below it, the THMB is still a downscale and the sharper tier would be
 * bytes for nothing.
 *
 * Pure, so the one number that decides whether 2,726 files get read is a
 * tested function rather than an inline comparison.
 */

/** `.cull-grid__cell`'s padding, per side. */
export const GRID_CELL_PADDING = 9;
/** The embedded THMB's long edge (src-tauri/src/cr3.rs — 160×120). */
export const THMB_LONG_EDGE = 160;

/** The painted image box in device pixels for a cell of `cellW` CSS px. */
export function gridFrameDevicePx(cellW: number, dpr: number): number {
  return (cellW - GRID_CELL_PADDING * 2) * dpr;
}

/** True when the cell is painting the THMB larger than it is. */
export function wantsGridThumb(cellW: number, dpr: number): boolean {
  return cellW > 0 && gridFrameDevicePx(cellW, dpr) > THMB_LONG_EDGE;
}
```

- [ ] **Step 3: `stage.ts`.** Add to `ImageState`, after `mid`:

```ts
  /** Grid tier (Phase 3B): the generated 512px contact-sheet JPEG. Errors are
   *  tracked in the store's gridThumbErrors and NEVER displayed — a grid cell
   *  has no error state; its THMB is the fallback and it is already painted. */
  gridThumb?: { status: "loading" } | { status: "ready"; url: string };
```

  and to `Resolved`, after `thumbUrl`:

```ts
  /** The grid tier, exposed INDEPENDENTLY like `thumbUrl`. The grid cell
   *  layers this OVER the THMB; it never replaces the value `thumbDisplayUrl`
   *  returns, because swapping a live <img src> is the 8-away flash. */
  gridThumbUrl: string | undefined;
```

  In `resolveStage`, add `const gridThumbUrl = s.gridThumb?.status === "ready" ? s.gridThumb.url : undefined;` beside the existing `const thumbUrl = …` and include `gridThumbUrl` in all three returned objects. Add a test to `src/image/stage.test.ts`:

```ts
  test("the grid tier is exposed independently of the nav stage", () => {
    const base = { thumb: undefined, full: undefined } satisfies Partial<ImageState>;
    const withGrid = { ...base, gridThumb: { status: "ready" as const, url: "blob:g" } };
    expect(resolveStage(withGrid as ImageState).gridThumbUrl).toBe("blob:g");
    expect(resolveStage(withGrid as ImageState).stage).toBe("shimmer");
    expect(resolveStage({ ...base } as ImageState).gridThumbUrl).toBeUndefined();
    // Loading is not ready — a half-arrived tier must not be offered.
    expect(
      resolveStage({ ...base, gridThumb: { status: "loading" } } as ImageState).gridThumbUrl,
    ).toBeUndefined();
  });
```

  (match the file's existing helper style for building an `ImageState`; the above is the shape, not necessarily the spelling.)

- [ ] **Step 4: the profile knobs.** In `src/types/settings.ts`'s `PerformanceProfile`:

```ts
  /** Grid-tier (Phase 3B) concurrency: the store's `read_grid_thumb` lane cap.
   *  A 512px resize from an already-cached preview is ~20 ms of CPU, so this
   *  is a CPU knob like midGenConcurrency, not an I/O one. */
  gridThumbConcurrency: number;
  /** Grid-tier blobs kept each side of the VISIBLE GRID RANGE (not the
   *  cursor). ~35 KB on disk but ~0.7 MB decoded each, so the window is what
   *  bounds the tier's memory; displayRefs additionally protect a mounted cell. */
  gridThumbKeep: number;
```

  `network`: `gridThumbConcurrency: 1, gridThumbKeep: 120`. `local`: `gridThumbConcurrency: 4, gridThumbKeep: 120`.

- [ ] **Step 5: the pressure clamp.** `src/image/pressureProfile.ts` — add to the `warn` object `gridThumbConcurrency: Math.min(base.gridThumbConcurrency, 1), gridThumbKeep: Math.min(base.gridThumbKeep, 40),` and to the `critical` object `gridThumbConcurrency: 0, gridThumbKeep: 0,`. Update the doc comment's bullet list to name the grid tier. **There is no safety net here:** both levels are built as `{ ...base, … }` (`pressureProfile.ts:31`, `:44`), so an unclamped new knob simply equals `base` and `pressureProfile.test.ts:34`'s whole-profile `toBeLessThanOrEqual(base[k])` loop *passes*. The explicit case below is the only thing that can catch a forgotten knob — write it:

```ts
  it("sheds the grid tier: its window first, then the lane entirely", () => {
    expect(clampProfileForPressure(base, "warn").gridThumbKeep).toBe(40);
    expect(clampProfileForPressure(base, "warn").gridThumbConcurrency).toBe(1);
    expect(clampProfileForPressure(base, "critical").gridThumbKeep).toBe(0);
    expect(clampProfileForPressure(base, "critical").gridThumbConcurrency).toBe(0);
  });
```

- [ ] **Step 6: the store.** In `src/image/imageStore.ts`:

  **Imports:** add `fetchGridThumb, GRID_THUMB_PENDING_RE, GRID_THUMB_UNAVAILABLE_RE` to the `../utils/bundle` import and `import { wantsGridThumb } from "./gridThumbRule";`.

  **Header comment:** extend the revoke-site list with `14. grid tier (Phase 3B): reset/hardReset + fetchGridThumbInto stale/replace, gridThumbLane.evictAround window eviction` and add the grid lane to the "fetch*Into landing sites" line (site 13 becomes "all five").

  **Fields**, beside the mid tier's:

```ts
  // ── Grid tier (Phase 3B): the sharp contact-sheet thumbnail ─────────────
  /** path → grid-thumb state. Windowed on the VISIBLE GRID RANGE, not the
   *  cursor: the grid is the only consumer and it scrolls independently. */
  private gridThumbs = new Map<string, ImageState["gridThumb"]>();
  private requestedGridThumb = new Set<string>();
  private gridThumbInFlightPaths = new Set<string>();
  private gridThumbErrors = new Map<string, TierError>();
  /** Paths whose preview can never produce a grid thumb (none embedded,
   *  undecodable, or already ≤512px) — the backend's one quiet sentinel,
   *  LATCHED per path. The cell keeps the THMB it is already showing: no
   *  shimmer, no retry loop, no error chip. Cleared only by reset()/
   *  hardReset(); retry() deliberately does NOT clear it, because nothing
   *  about the file will have changed. */
  private gridThumbUnavailable = new Set<string>();
  /** Latched once `read_grid_thumb` is rejected as an unknown command (a
   *  3B frontend on an older backend): the tier stays dormant for the session. */
  private gridThumbUnsupported = false;
  /** The grid's current cell width in CSS px, 0 while the grid is closed.
   *  With the DPR it decides whether the tier is worth asking for at all. */
  private gridCellW = 0;
```

  **The lane**, after `midLane`:

```ts
  /** Grid-tier lane (Phase 3B): the 512px contact-sheet thumbnails. */
  private readonly gridThumbLane: TierLane<ImageState["gridThumb"]> = new TierLane({
    cap: () => this.profile.gridThumbConcurrency,
    generation: () => this.generation,
    isReady: (p) => this.gridThumbs.get(p)?.status === "ready",
    markLoading: (p) => {
      this.gridThumbs.set(p, { status: "loading" });
      this.invalidate(p);
    },
    fetch: (p, gen) => this.fetchGridThumbInto(p, gen),
    afterSettle: () => {
      this.gridThumbLane.pump();
    },
    requested: this.requestedGridThumb,
    inFlightPaths: this.gridThumbInFlightPaths,
    errors: this.gridThumbErrors,
    // Windowed eviction — REVOKE SITE 14. The window is the VISIBLE GRID
    // RANGE ± gridThumbKeep, so the `centerIndex` TierLane passes is ignored
    // here (the store hands it this.cursor purely to clear evictAround's
    // `centerIndex < 0` guard). Leaving the grid sets the range to -1/-1,
    // which empties the window and frees every unmounted blob.
    cache: this.gridThumbs,
    isEvictionProtected: (p) => {
      if (this.displayRefs.has(p)) return true;
      if (this.gridStart < 0) return false;
      const idx = this.indexOf(p);
      const keep = this.profile.gridThumbKeep;
      return idx !== -1 && idx >= this.gridStart - keep && idx <= this.gridEnd + keep;
    },
    onEvict: (p) => {
      this.stats.counts.gridThumbEvicts++;
      this.invalidate(p);
    },
  });
```

  **Lane bookkeeping — every place the other five lanes are named:** add `this.gridThumbLane` to `setProfile`'s evict cascade and pump list (`:446-457`), to `reset()`'s and `hardReset()`'s `lane.reset()` calls (`:565-569`, `:754-758`), and to `forget()`'s queue filter (`:667`). In `setCursor` do NOT add it — this lane does not follow the cursor.

  **Blobs:** `reset()` and `hardReset()` gain `this.revokeReadyBlobs(this.gridThumbs);` (site 14) next to the mid tier's, plus `this.gridThumbUnavailable.clear();`. `dropPath` (`:710-744`) gains

```ts
    const g = this.gridThumbs.get(p);
    if (g?.status === "ready") URL.revokeObjectURL(g.url);
    this.gridThumbs.delete(p);
```

  and `this.requestedGridThumb` / `this.gridThumbUnavailable` join the `for (const set of […])` list, `this.gridThumbErrors` the `for (const map of […])` list.

  **State plumbing:** `buildState` and `invalidate` both build an `ImageState`; add `gridThumb: this.gridThumbs.get(path),` to each, and add `old.gridThumbUrl !== newResolved.gridThumbUrl ||` to `invalidate`'s change test (`:1100-1110`) — without it a landed grid thumb notifies nobody.

  **The public surface:**

```ts
  /**
   * The grid's cell width in CSS px (0 = the grid is closed). With the device
   * pixel ratio this decides whether the sharp tier is worth asking for at
   * all — see gridThumbRule. A size change re-runs the decision for every
   * visible cell; closing the grid lets the window eviction free the blobs.
   */
  setGridCellW(cellW: number): void {
    if (cellW === this.gridCellW) return;
    this.gridCellW = cellW;
    this.gridThumbLane.evictAround(this.cursor);
    this.requestGridThumbsInRange();
  }

  /** DPR flip (window dragged 4K ↔ 1440p): the same cell can cross the rule
   *  in either direction without the grid itself changing. */
  reevaluateGridThumbs(): void {
    this.requestGridThumbsInRange();
  }

  /** True when the painted grid cell needs more pixels than the THMB has. */
  private gridThumbWanted(): boolean {
    return !this.gridThumbUnsupported && wantsGridThumb(this.gridCellW, this.dpr());
  }

  private dpr(): number {
    return typeof window === "undefined" ? 1 : window.devicePixelRatio;
  }

  /** Request the grid tier for every cell inside the reported grid viewport.
   *  The ONE entry point — so the tombstone check, the sentinel latch and the
   *  rule live in one place and a scroll costs one pass, not one effect per
   *  mounted cell. */
  private requestGridThumbsInRange(): void {
    if (!this.gridThumbWanted() || this.gridStart < 0) return;
    const last = Math.min(this.gridEnd, this.paths.length - 1);
    for (let i = Math.max(0, this.gridStart); i <= last; i++) {
      this.requestGridThumb(this.paths[i]);
    }
    this.gridThumbLane.pump();
  }

  private requestGridThumb(path: string): void {
    if (!path) return;
    // Tombstoned (Move rejects) — never take a lane slot for a gone frame.
    if (this.forgotten.has(path)) return;
    // The file will never have one; the cell keeps its THMB for the session.
    if (this.gridThumbUnavailable.has(path)) return;
    const existing = this.gridThumbs.get(path);
    if (existing?.status === "ready" || existing?.status === "loading") return;
    if (this.requestedGridThumb.has(path) || this.gridThumbInFlightPaths.has(path)) return;
    if (inCooldown(this.gridThumbErrors.get(path), Date.now())) return;
    if (!this.gridThumbLane.queue.includes(path)) this.gridThumbLane.queue.push(path);
  }
```

  `setGridRange` (`:826-833`) gains `this.gridThumbLane.evictAround(this.cursor);` and `this.requestGridThumbsInRange();` after the existing body; `clearGridRange` (`:836-841`) gains `this.gridThumbLane.evictAround(this.cursor);` after setting the range to -1/-1 (which empties the window).

  **The fetch interior**, beside `fetchMidInto`:

```ts
  private async fetchGridThumbInto(path: string, gen: number): Promise<void> {
    try {
      const result = await fetchGridThumb(path, gen);
      if (this.generation !== gen) {
        URL.revokeObjectURL(result.url); // REVOKE SITE 14 (stale session)
        return;
      }
      if (this.forgotten.has(path)) {
        URL.revokeObjectURL(result.url); // REVOKE SITE 13 (forgotten mid-flight)
        return;
      }
      const existing = this.gridThumbs.get(path);
      if (existing?.status === "ready") URL.revokeObjectURL(existing.url);
      this.gridThumbs.set(path, { status: "ready", url: result.url });
      this.gridThumbErrors.delete(path);
      this.stats.counts.gridThumbLoads++;
      this.invalidate(path);
      this.gridThumbLane.evictAround(this.cursor);
    } catch (e) {
      if (this.generation !== gen) return;
      // Forgotten mid-flight — dropPath already cleared the markers and the
      // entry this branch would rewrite, and skipping spares the unsupported
      // latch a false positive from a moved file's "not found".
      if (this.forgotten.has(path)) return;
      const msg = e instanceof Error ? e.message : String(e);
      this.requestedGridThumb.delete(path);
      this.gridThumbs.delete(path);
      if (/(^|: )cancelled$/i.test(msg)) {
        // Superseded by a session change the backend saw first — quiet drop.
        // Two shapes: the bare sentinel, and preview_parts's wrapped
        // "cr3 preview: cancelled" (bundle.rs:184 + cr3.rs:684).
      } else if (GRID_THUMB_PENDING_RE.test(msg)) {
        // TRANSIENT: another producer holds the backend's shared MidGen claim
        // (the opportunistic mid generator and the whole-shoot idle sweep use
        // the same pending set). Ordinary backoff — NEVER the latch, or a grid
        // scroll that raced the sweep would strand those cells on the soft
        // THMB for the rest of the session.
        this.noteTierError(this.gridThumbErrors, path, msg);
      } else if (GRID_THUMB_UNAVAILABLE_RE.test(msg)) {
        // PERMANENT, and not a failure: this file has no preview to sharpen
        // from. LATCH it — the cell keeps its THMB for the session, with no
        // shimmer, no retry and no error chip.
        this.gridThumbUnavailable.add(path);
      } else if (/command\s+\S*\s*not found|unknown command|no handler/i.test(msg)) {
        // A 3B frontend on an older backend: the tier stays dormant.
        this.gridThumbUnsupported = true;
      } else {
        this.noteTierError(this.gridThumbErrors, path, msg);
      }
      this.invalidate(path);
    }
  }
```

  **`retry(path)`** (`:955-988`): add `this.gridThumbErrors.delete(path);` beside the other four, and `this.gridThumbLane.pump();` beside the two pumps at the end — without it the error-panel retry clears the cooldown but nothing re-requests until the next viewport change. Do **not** clear `gridThumbUnavailable` — record why in a comment: *the sentinel is a fact about the file, not a transient failure; a retry cannot change it. A `pending` bounce is a plain tier error and clears with the rest.*

  **`debugStats()`** carries an inline **return-type annotation** (`imageStore.ts:1714-1741`), so every addition lands twice. In the annotation: `gridThumbLoads: number;` and `gridThumbEvicts: number;` inside the `counts:` object type, and beside `mid`:

```ts
    gridThumb: { lane: string; cached: number; cellW: number; wanted: boolean; unavailable: number };
```

  In `devStats.ts`, add `gridThumbLoads: 0,` and `gridThumbEvicts: 0,` to the `counts` initialiser. In the returned value, beside `mid`:

```ts
      gridThumb: {
        lane: `${this.gridThumbLane.inFlight}/${this.profile.gridThumbConcurrency} q${this.gridThumbLane.queue.length}`,
        cached: [...this.gridThumbs.values()].filter((s) => s?.status === "ready").length,
        cellW: this.gridCellW,
        wanted: this.gridThumbWanted(),
        unavailable: this.gridThumbUnavailable.size,
      },
```

  and fold the grid blobs into `decodedMB`: a 512 × 341 RGBA raster is ~0.7 MB, so `+ gridCached * 0.7`.

- [ ] **Step 7: `useThumb.ts`.** Return the new field; the display url is untouched:

```ts
export function useThumb(path: string): {
  url: string | undefined;
  gridUrl: string | undefined;
  shimmerDelayMs: number;
  probeOnLoad: (() => void) | undefined;
} {
  const img = useImage(path, { wantFull: false });
  const url = thumbDisplayUrl(img);
  // The sharp grid tier is LAYERED over `url` by GridCell, never swapped into
  // it: `thumbDisplayUrl` must stay identical across foreign-tier landings
  // (the 8-away flash). Undefined everywhere but the grid, which is the only
  // surface whose cells are large enough for the store to request it.
  const gridUrl = img.gridThumbUrl;
```

  (the rest of the body is unchanged; add `gridUrl` to the returned object.)

- [ ] **Step 8: the DPR wiring.** In `src/app/useImageStoreWiring.ts`, the `matchMedia('(resolution: Xdppx)')` handler (`:85-98`) calls `imageStore.reevaluateMid()`; add `imageStore.reevaluateGridThumbs();` beside it and extend the comment: *"…and the grid tier: the same cell can cross the (cellW − 18) × DPR > 160 rule in either direction when only the DPR moves."*

- [ ] **Step 9: the lane-parity net.** The grid lane does **not** join the `LANES` array (`imageStore.test.ts:1417-1451`): every entry there is driven per PATH, and this lane is driven by RANGE, because the store owns the request so that the rule, the tombstone check and the sentinel latch live in one place. **Ruling:** it gets its own `describe` covering the same three invariants plus the four things only it has. Place that `describe` **inside** `describe("lane parity net (Phase 8 TierLane collapse)")` — `laneDeferreds` is defined in that scope, not at module scope — directly after the `for (const lane of LANES)` loop:

```ts
  // The grid lane's parity tests. Driven by RANGE, not by path — the store
  // owns the request, so the rule, the tombstone check and the two sentinels
  // live in one place. Same three invariants as every other lane, plus the
  // four that are this lane's alone.
  describe("grid thumb", () => {
    function makeGridThumbBuf(): ArrayBuffer {
      const header = JSON.stringify({ gridLen: 3, width: 512, height: 341 });
      const headerBytes = new TextEncoder().encode(header);
      const buf = new ArrayBuffer(4 + headerBytes.length + 3);
      new DataView(buf).setUint32(0, headerBytes.length, true);
      new Uint8Array(buf, 4, headerBytes.length).set(headerBytes);
      new Uint8Array(buf, 4 + headerBytes.length).set([0xff, 0xd8, 0x00]);
      return buf;
    }

    async function armed(paths: string[]) {
      const StoreClass = await getStoreClass();
      const store = new StoreClass();
      store.setProfile(PERFORMANCE_PROFILES.network); // gridThumbConcurrency 1
      store.reset(paths);
      store.setGridCellW(400); // (400 − 18) × 1 = 382 > 160
      return store;
    }

    it("single-flight — re-reporting the same range never duplicates the fetch", async () => {
      const store = await armed(["/net/a.cr3"]);
      const deferreds = laneDeferreds("read_grid_thumb");
      store.setGridRange(0, 0);
      store.setGridRange(0, 0);
      await flush();
      expect(deferreds).toHaveLength(1);
      deferreds[0].resolve(makeGridThumbBuf());
      await vi.waitUntil(() => store.snapshot("/net/a.cr3").gridThumbUrl !== undefined);
      store.setGridRange(0, 0);
      await flush();
      expect(deferreds).toHaveLength(1);
    });

    it("stale completion is gen-scoped — nothing leaks, the blob is revoked", async () => {
      const store = await armed(["/old/0.cr3"]);
      const deferreds = laneDeferreds("read_grid_thumb");
      store.setGridRange(0, 0);
      await flush();
      expect(deferreds).toHaveLength(1);
      store.hardReset();
      deferreds[0].resolve(makeGridThumbBuf());
      await flush();
      expect(store.snapshot("/old/0.cr3").gridThumbUrl).toBeUndefined();
      expect(liveUrls.size).toBe(0);
    });

    it("error → cooldown blocks re-requests → retry() re-arms", async () => {
      const store = await armed(["/net/err.cr3"]);
      const deferreds = laneDeferreds("read_grid_thumb");
      store.setGridRange(0, 0);
      await flush();
      deferreds[0].reject(new Error("boom"));
      await flush();
      store.setGridRange(0, 0);
      await flush();
      expect(deferreds).toHaveLength(1);
      store.retry("/net/err.cr3");
      store.setGridRange(0, 0);
      await vi.waitUntil(() => deferreds.length === 2, { timeout: 2000 });
      deferreds[1].resolve(makeGridThumbBuf());
      await vi.waitUntil(() => store.snapshot("/net/err.cr3").gridThumbUrl !== undefined);
    });

    it("the rule gates the lane: a cell the THMB already covers asks for nothing", async () => {
      const store = await armed(["/net/a.cr3"]);
      store.setGridCellW(120); // (120 − 18) × 1 = 102 ≤ 160
      const deferreds = laneDeferreds("read_grid_thumb");
      store.setGridRange(0, 0);
      await flush();
      expect(deferreds).toHaveLength(0);
    });

    it("the UNAVAILABLE sentinel latches per path: one miss, then never again", async () => {
      const store = await armed(["/net/noprvw.cr3"]);
      const deferreds = laneDeferreds("read_grid_thumb");
      store.setGridRange(0, 0);
      await flush();
      deferreds[0].reject(new Error("grid thumb unavailable (no preview)"));
      await flush();
      // No error recorded, no cooldown to expire, and no second request ever.
      store.setGridRange(0, 0);
      store.setGridCellW(500);
      await flush();
      expect(deferreds).toHaveLength(1);
      expect(store.snapshot("/net/noprvw.cr3").gridThumbUrl).toBeUndefined();
      // The THMB underneath is untouched — the cell simply keeps showing it.
      expect(store.snapshot("/net/noprvw.cr3").stage).toBe("shimmer");
    });

    it("the PENDING sentinel does NOT latch: it is a plain cooldown, then asked again", async () => {
      // The backend's MidGen pending set is shared with the whole-shoot mid
      // sweep, so this bounce is common. Latching it would strand the cell on
      // the soft THMB for the session — the bug this sentinel exists to avoid.
      const store = await armed(["/net/busy.cr3"]);
      const deferreds = laneDeferreds("read_grid_thumb");
      store.setGridRange(0, 0);
      await flush();
      deferreds[0].reject(new Error("grid thumb pending"));
      await flush();

      // Inside the backoff: no re-fetch (a cooldown, not a latch).
      store.setGridRange(0, 0);
      await flush();
      expect(deferreds).toHaveLength(1);

      // retry() clears the tier error — the path is NOT in the unavailable set,
      // so the very next range report asks again.
      store.retry("/net/busy.cr3");
      store.setGridRange(0, 0);
      await vi.waitUntil(() => deferreds.length === 2, { timeout: 2000 });
      deferreds[1].resolve(makeGridThumbBuf());
      await vi.waitUntil(() => store.snapshot("/net/busy.cr3").gridThumbUrl !== undefined);
    });

    it("eviction follows the GRID RANGE, and leaving the grid frees everything", async () => {
      const paths = Array.from({ length: 400 }, (_, i) => `/win/${i}.cr3`);
      const store = await armed(paths);
      const deferreds = laneDeferreds("read_grid_thumb");
      store.setGridRange(0, 0);
      await flush();
      deferreds[0].resolve(makeGridThumbBuf());
      await vi.waitUntil(() => store.snapshot(paths[0]).gridThumbUrl !== undefined);

      store.setGridRange(100, 110); // inside gridThumbKeep (120) — survives
      expect(store.snapshot(paths[0]).gridThumbUrl).toBeDefined();
      store.setGridRange(300, 310); // far outside — evicted
      expect(store.snapshot(paths[0]).gridThumbUrl).toBeUndefined();
      expect(liveUrls.size).toBe(0);
    });

    it("a mounted cell's displayRef protects its blob even outside the window", async () => {
      const paths = Array.from({ length: 400 }, (_, i) => `/win/${i}.cr3`);
      const store = await armed(paths);
      const deferreds = laneDeferreds("read_grid_thumb");
      store.setGridRange(0, 0);
      await flush();
      deferreds[0].resolve(makeGridThumbBuf());
      await vi.waitUntil(() => store.snapshot(paths[0]).gridThumbUrl !== undefined);
      store.registerDisplay(paths[0]);
      store.setGridRange(300, 310);
      expect(store.snapshot(paths[0]).gridThumbUrl).toBeDefined();
      store.unregisterDisplay(paths[0]);
      store.setGridRange(301, 311);
      expect(store.snapshot(paths[0]).gridThumbUrl).toBeUndefined();
    });

    it("a tombstoned path never takes a lane slot", async () => {
      const store = await armed(["/net/a.cr3", "/net/b.cr3"]);
      const deferreds = laneDeferreds("read_grid_thumb");
      store.forget(new Set(["/net/a.cr3"]));
      store.setGridRange(0, 1);
      await flush();
      // forget() re-indexes, so only the survivor may be fetched.
      expect(deferreds).toHaveLength(1);
    });
  });
```

  Note `forget()` sets `gridStart`/`gridEnd` to -1 (`imageStore.ts:677-678`), so the test re-reports the range afterwards — that is the real sequence too (GridView's `onViewportChange` fires again after the list shrinks).

- [ ] **Step 10:** gate green. `pnpm test` must keep the 8-away-flash suite green untouched. Commit: `feat(image): a sixth lane for the sharp grid thumbnail`.

### Task 12: The grid cell paints the sharp thumbnail

**Files:** Modify `src/components/GridView.tsx`, `src/styles/grid.css`, `src/App.tsx`, `src/components/DevHud.tsx`. Test: create `src/components/GridCell.layers.test.tsx`.

**Follows Tasks 6 and 11** (it edits `GridView.tsx` after Task 6 and consumes `useThumb`'s `gridUrl` from Task 11).

**Interfaces — Consumes:** `useThumb(path) → { url, gridUrl, … }` (Task 11); `gridCellWidth` (Task 6); `imageStore.setGridCellW` (Task 11). **Produces:** no new exports.

- [ ] **Step 1: failing test** — `src/components/GridCell.layers.test.tsx`. `GridCell` is not exported, so drive it through `GridView` with `useThumb` mocked:

```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { createRef } from "react";

const thumb = vi.hoisted(() => ({
  value: {
    url: "blob:thmb" as string | undefined,
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
import type { Img } from "../types";

const images: Img[] = [{ id: 1, path: "/a.cr3", filename: "IMG_0001.CR3" } as Img];

function renderGrid() {
  const ref = createRef<HTMLDivElement>();
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
    />,
  );
}

afterEach(cleanup);

describe("the grid cell layers the sharp tier over the THMB", () => {
  test("with no grid thumb it paints exactly one image — the THMB", () => {
    thumb.value = { ...thumb.value, url: "blob:thmb", gridUrl: undefined };
    const { container } = renderGrid();
    const imgs = [...container.querySelectorAll("img")];
    expect(imgs.map((i) => i.getAttribute("src"))).toEqual(["blob:thmb"]);
  });

  test("with a grid thumb it paints BOTH, the sharp one on top, decoded async", () => {
    thumb.value = { ...thumb.value, url: "blob:thmb", gridUrl: "blob:grid" };
    const { container } = renderGrid();
    const imgs = [...container.querySelectorAll("img")];
    expect(imgs.map((i) => i.getAttribute("src"))).toEqual(["blob:thmb", "blob:grid"]);
    // The THMB keeps its synchronous decode; the overlay must not block paint.
    expect(imgs[0].getAttribute("decoding")).toBe("sync");
    expect(imgs[1].getAttribute("decoding")).toBe("async");
    // It fades in only once it has decoded — an undecoded layer would flash.
    expect(imgs[1].className).not.toContain("is-on");
    fireEvent.load(imgs[1]);
    expect(
      container.querySelector(".cull-grid__img--hi")?.className,
    ).toContain("is-on");
  });

  test("a grid thumb that never loads leaves the THMB untouched — cells have no error state", () => {
    thumb.value = { ...thumb.value, url: "blob:thmb", gridUrl: "blob:broken" };
    const { container } = renderGrid();
    const imgs = [...container.querySelectorAll("img")];
    fireEvent.error(imgs[1]);
    expect(imgs[0].getAttribute("src")).toBe("blob:thmb");
    expect(container.querySelector(".cull-grid__img--hi")?.className).not.toContain("is-on");
  });
});
```

  (match `Img`'s real shape from `src/types/image.ts` when writing the fixture; the cast above is a placeholder for whatever fields it requires.)

  **Re-read `GridView`'s prop type before writing this fixture.** Task 6 owns `GridView.tsx` and runs first, so a required prop added there would break the render. Today's required set — verified at `GridView.tsx:50-100` — is `images`, `visibleIndices`, `currentIndex`, `cols`, `contentWidth`, `ratings`, `onPick`, `containerRef`, `onViewportChange`; everything else (`metadata`, `selectedIndices`, `suggestions`, `bursts`, `similar`, `scrubSpeed`) is optional.

- [ ] **Step 2: `GridCell`.** Replace the `useThumb` call and the `url ? … : …` block:

```tsx
  const { url, gridUrl, shimmerDelayMs, probeOnLoad } = useThumb(img.path);
  // The sharp 512px tier fades in OVER the THMB once it has decoded. Never
  // instead of it: swapping a live <img src> blanks the cell while the engine
  // decodes (the 8-away flash), and a grid cell has no error state — if the
  // sharp layer never loads, the THMB underneath is simply what stays.
  const [hiLoaded, setHiLoaded] = useState<string | undefined>(undefined);
```

```tsx
      <div className="cull-grid__frame">
        {url ? (
          <>
            {/* decoding="sync": tiny JPEG — decode with layout/paint once
                loaded. See ThumbCell's fuller note; visibility is covered by
                mounting rows in the overscan buffer + same-frame windowing. */}
            <img className="cull-grid__img" src={url} alt="" decoding="sync" onLoad={probeOnLoad} />
            {gridUrl && (
              <img
                key={gridUrl}
                className={`cull-grid__img cull-grid__img--hi${
                  hiLoaded === gridUrl ? " is-on" : ""
                }`}
                src={gridUrl}
                alt=""
                decoding="async"
                onLoad={() => setHiLoaded(gridUrl)}
              />
            )}
          </>
        ) : (
          <div
            className="shimmer cull-grid__placeholder"
            …unchanged…
          >
            <span className="cull-grid__placeholder-name">{stripExt(img.filename)}</span>
          </div>
        )}
      </div>
```

  `hiLoaded` holds the URL that loaded rather than a boolean, so a new blob for the same cell starts hidden again with no effect and no reset — `key={gridUrl}` remounts the element and the class only turns on when the two agree.

  Add `useState` to the React import if the file does not already have it (it imports `useState` at `:1` — confirm).

- [ ] **Step 3: `grid.css`.** After `.cull-grid__img`'s existing rule (find it around `:110-130` and keep its declarations):

```css
/* The sharp 512px grid tier, layered over the THMB. It is absolutely
   positioned so both images occupy the same box, and it starts transparent:
   an undecoded layer would flash. Opacity only — a fade is not motion, so
   reduced motion leaves it alone (see styles/motion.css's policy). */
.cull-grid__img--hi {
  position: absolute;
  inset: 0;
  opacity: 0;
  transition: opacity var(--dur-base) var(--ease-out);
}

.cull-grid__img--hi.is-on {
  opacity: 1;
}
```

  `.cull-grid__frame` is already `position: relative` (`grid.css:96-107`), so the inset resolves against the frame.

- [ ] **Step 4: `App.tsx` — tell the store the cell width.** Beside the wheel effect from Task 6:

```tsx
  // The grid's cell width decides whether the sharp tier is worth fetching
  // ((cellW − 18) × DPR > 160). 0 while the grid is closed, which lets the
  // store's window eviction free every grid blob.
  useEffect(() => {
    imageStore.setGridCellW(
      gridVisible && !compareMode ? gridCellWidth(gridContentW, gridCols) : 0,
    );
  }, [gridVisible, compareMode, gridContentW, gridCols]);
```

  `imageStore` is already imported in `App.tsx` (`:75`). `gridCellWidth` arrives with Task 6's `import { gridCellWidth, gridColsFor, stepGridSize } from "./utils/gridSize";` — nothing new to add here.

- [ ] **Step 5: `DevHud.tsx`.** One row after the `mid` row:

```tsx
      {/* Phase 3B: the grid tier. `cellW` and `want` are the request rule's
          two inputs, so a grid that looks soft can be diagnosed without a
          debugger: want=off means the THMB still covers the cell. */}
      <div className="cull-devhud__row">
        grid&nbsp; {stats.gridThumb.lane} · cache {stats.gridThumb.cached} · cellW{" "}
        {stats.gridThumb.cellW} {stats.gridThumb.wanted ? "WANT" : "off"} · load{" "}
        {stats.counts.gridThumbLoads} · evict {stats.counts.gridThumbEvicts} · n/a{" "}
        {stats.gridThumb.unavailable}
      </div>
```

- [ ] **Step 6:** gate green. Commit: `feat(grid): the contact sheet paints the sharp 512px thumbnail over the THMB`.

### Task 13: Bake the backdrop tone, keep the vignette in CSS

**Files:** Create `scripts/bake-backdrop.mjs`, `scripts/bake-backdrop/bake.html`, `scripts/bake-backdrop/sources/backdrop.jpg`, `scripts/bake-backdrop/sources/desert.jpg`. Modify `src/assets/backdrop.jpg`, `src/assets/desert.jpg` (regenerated in place), `src/styles/chrome.css`, `src/styles/empty-state.css`. Test: extend `src/styles/layout.test.ts`.

**What is baked and what is not** (spec §"Included without a choice"): `grayscale(1) brightness(0.85) contrast(1.05)` at `opacity: 0.11` over `--bg` (`#0c0c0d`) is baked into each JPEG at 2560 px wide. The radial mask stays in CSS — it is sized to the WINDOW, not the image, so baking it would fix the vignette at one aspect ratio. Both backdrops keep the identical recipe.

**Why 2560 and why a resampler in the page:** the sources are 1440 × 822 and 1600 × 889, so there is no true 2× — the upscale only has to beat the browser's own. `ctx.drawImage` is bilinear-ish even at `imageSmoothingQuality: "high"`, so the page does a separable Lanczos3 pass in JS first (3.7 Mpx, well inside a headless budget), then applies the tone chain through `ctx.filter`, then composites at alpha 0.11 over a `#0c0c0d` fill.

**No new dependency — the route, and why each piece is needed:**
1. `node scripts/bake-backdrop.mjs` (built-ins only: `node:http`, `node:child_process`, `node:fs`, `node:path`, `node:buffer`) starts a one-file static server on `127.0.0.1:<random port>`. **HTTP, not `file://`, is load-bearing**: a `file://` image taints the canvas in Chromium, and `toDataURL` on a tainted canvas throws `SecurityError`. Serving over loopback makes the image same-origin.
2. It spawns headless Edge — `msedge --headless=new --disable-gpu --virtual-time-budget=30000 --dump-dom "http://127.0.0.1:<port>/bake.html?src=…&w=2560&q=0.82"` — and captures stdout. `--dump-dom` prints the serialized DOM, so the ~300 kB base64 payload comes back in a `<script type="text/plain" id="out">`. `--virtual-time-budget` makes the dump wait for the image load, decode, resize and encode instead of racing them.
3. The script regexes the data URL out of the dump, decodes the base64 and writes the JPEG.
   *If `msedge` is not on PATH, try `chrome` and then the well-known Edge install path, and fail with the exact command to run by hand. Do not add a dependency to solve this.*

**Verification the implementer must record:** `bake.html` renders a SECOND canvas the same size, produced by drawing the ORIGINAL through `ctx.drawImage` at 2560 with the same tone chain and alpha — i.e. what the live CSS does today — and prints `mean` and `max` per-channel `|Δ|` over a 32 × 32 sample grid into the dump, alongside the byte length. **Expected: mean ≤ 2/255, max ≤ 8/255.** The two differ only in the resampler, and at 0.11 alpha over `#0c0c0d` the whole image occupies ~28 levels, so resampler differences are sub-level almost everywhere. A larger mean means the tone chain is wrong (wrong filter order, alpha applied twice, the fill missing) — fix that, not the threshold. Paste both numbers and both byte lengths into the task report.

- [ ] **Step 1: preserve the sources.** `git mv` is wrong here (the assets must keep their paths). Copy the current `src/assets/backdrop.jpg` and `src/assets/desert.jpg` to `scripts/bake-backdrop/sources/` FIRST and commit that copy on its own, so the bake is re-runnable from a committed input and the originals are never lost behind an overwrite.
- [ ] **Step 2: `scripts/bake-backdrop/bake.html`.** One self-contained page, no imports. Skeleton (the implementer fills the Lanczos kernel; the structure and the chain are fixed):

```html
<!doctype html>
<meta charset="utf-8" />
<title>CULL backdrop bake</title>
<script type="text/plain" id="out"></script>
<script type="text/plain" id="diff"></script>
<script>
  // Baked recipe, verbatim from styles/chrome.css .cull-chrome::before:
  //   filter: grayscale(1) brightness(0.85) contrast(1.05); opacity: 0.11
  // over --bg. The radial mask is NOT baked — it is sized to the window.
  const TONE = "grayscale(1) brightness(0.85) contrast(1.05)";
  const ALPHA = 0.11;
  const BG = "#0c0c0d";

  const p = new URLSearchParams(location.search);
  const W = Number(p.get("w") ?? 2560);
  const Q = Number(p.get("q") ?? 0.82);

  /** Separable Lanczos3 resample of an ImageData to w×h. */
  function lanczos(src, w, h) { /* … a = 3; horizontal pass then vertical … */ }

  function compose(imageData, w, h) {
    const tmp = new OffscreenCanvas(w, h);
    tmp.getContext("2d").putImageData(imageData, 0, 0);
    const out = document.createElement("canvas");
    out.width = w;
    out.height = h;
    const ctx = out.getContext("2d");
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, w, h);
    ctx.filter = TONE;
    ctx.globalAlpha = ALPHA;
    ctx.drawImage(tmp, 0, 0);
    return out;
  }

  const img = new Image();
  img.onload = () => {
    const h = Math.round((img.naturalHeight / img.naturalWidth) * W);
    const read = document.createElement("canvas");
    read.width = img.naturalWidth;
    read.height = img.naturalHeight;
    const rctx = read.getContext("2d", { willReadFrequently: true });
    rctx.drawImage(img, 0, 0);
    const srcData = rctx.getImageData(0, 0, img.naturalWidth, img.naturalHeight);

    const baked = compose(lanczos(srcData, W, h), W, h);

    // Reference: exactly what the live CSS does — the browser's own upscale
    // through the same tone chain and alpha.
    const ref = document.createElement("canvas");
    ref.width = W;
    ref.height = h;
    const rc = ref.getContext("2d");
    rc.fillStyle = BG;
    rc.fillRect(0, 0, W, h);
    rc.imageSmoothingQuality = "high";
    rc.filter = TONE;
    rc.globalAlpha = ALPHA;
    rc.drawImage(img, 0, 0, W, h);

    // 32×32 sample grid, per-channel absolute difference. TWO whole-canvas
    // reads, not 2,048 single-pixel ones — same numbers, a fraction of the
    // time inside the virtual-time budget.
    const A = baked.getContext("2d").getImageData(0, 0, W, h).data;
    const B = rc.getImageData(0, 0, W, h).data;
    let sum = 0, max = 0, n = 0;
    for (let gy = 0; gy < 32; gy++) {
      for (let gx = 0; gx < 32; gx++) {
        const x = Math.floor(((gx + 0.5) / 32) * W);
        const y = Math.floor(((gy + 0.5) / 32) * h);
        const i = (y * W + x) * 4;
        for (let c = 0; c < 3; c++) {
          const d = Math.abs(A[i + c] - B[i + c]);
          sum += d;
          if (d > max) max = d;
          n++;
        }
      }
    }
    const url = baked.toDataURL("image/jpeg", Q);
    document.getElementById("out").textContent = url;
    document.getElementById("diff").textContent = JSON.stringify({
      w: W, h, q: Q, bytes: Math.round((url.length - url.indexOf(",") - 1) * 0.75),
      meanAbsDiff: +(sum / n).toFixed(3), maxAbsDiff: max,
    });
  };
  img.src = p.get("src");
</script>
```

- [ ] **Step 3: `scripts/bake-backdrop.mjs`.** Node built-ins only. It serves `scripts/bake-backdrop/` (the page) and `scripts/bake-backdrop/sources/` (the images), spawns the browser once per asset, parses `#out` and `#diff` out of the dumped DOM, prints the diff JSON, and writes `src/assets/<name>.jpg`. Give it a header comment stating the recipe, the 2560 width, the q it shipped with, and the re-run command. Refuse to write if `maxAbsDiff > 8` unless `--force` is passed, and print why.
- [ ] **Step 4: run it** for both assets and record the numbers. Target ≤ 320 kB per file; if q 0.82 overshoots, step q down by 0.02 until it fits and record the final q in the script header.
- [ ] **Step 5: the CSS.** Read each rule in full before touching it — confirm nothing else depends on the `opacity` you are about to delete (an `opacity` below 1 creates a stacking context, and `.cull-chrome::before` sits at `z-index: -1` inside a parent with `isolation: isolate`; the parent's isolation is what contains it, so removing `opacity` is safe — verify that is still true, and report if a rule has drifted). Then in `src/styles/chrome.css` `.cull-chrome::before` and `src/styles/empty-state.css` `.cull-empty-state--desert::before`, delete the `filter:` and `opacity:` declarations and keep everything else. Replace each rule's comment tail with:

```css
  /* The tone is BAKED into the JPEG (scripts/bake-backdrop.mjs): grayscale +
     brightness .85 + contrast 1.05, composited at .11 over --bg, at 2560px
     wide. Only the vignette stays here — it is sized to the WINDOW, not the
     image, so baking it would fix the falloff at one aspect ratio. */
```

- [ ] **Step 6: the guard.** Append to `src/styles/layout.test.ts`:

```ts
describe("the backdrops", () => {
  const rules = [
    [sheet("./chrome.css"), ".cull-chrome::before"],
    [sheet("./empty-state.css"), ".cull-empty-state--desert::before"],
  ] as const;

  test("the tone is baked, so neither rule dims or desaturates at runtime", () => {
    for (const [css, selector] of rules) {
      const body = ruleBody(css, selector);
      expect(body, `${selector} filter`).not.toMatch(/\bfilter:/);
      expect(body, `${selector} opacity`).not.toMatch(/\bopacity:/);
    }
  });

  test("the vignette stays in CSS, identical in both", () => {
    const mask = "radial-gradient(115% 90% at 50% 42%, #000 30%, transparent 78%)";
    for (const [css, selector] of rules) {
      const body = ruleBody(css, selector);
      expect(body, `${selector} mask`).toContain(`mask-image: ${mask}`);
      expect(body, `${selector} -webkit-mask`).toContain(`-webkit-mask-image: ${mask}`);
    }
  });
});
```

- [ ] **Step 7:** gate green. Two commits: `chore(assets): keep the backdrop sources for re-baking`, then `perf(ui): bake the backdrop tone into the JPEGs at 2560px`.

### Task 14: Documentation and the final gate

**Files:** Modify `ARCHITECTURE.md`, `README.md`, `TESTING.md`.

- [ ] **Step 1: `ARCHITECTURE.md` → "Read pipeline".** Add the grid tier to the stage paragraph (it is not a display stage — say so: it is a second image layered over the THMB in the contact sheet, not a `resolveStage` stage), to the lane list in the ASCII diagram (`preview / zoom-full / mid / thumb / grid / bg`), to "What the store owns" (its window is the GRID RANGE ± `gridThumbKeep`, not the cursor — the one lane that does not follow the cursor, and why), and to the "On-disk tier cache" paragraph: `grid/` (512 MB) behind `read_grid_thumb`, filled on miss from the PRVW, `VERSION` unchanged because the addition is a new tier byte in a disjoint subdir.
- [ ] **Step 2: `ARCHITECTURE.md` → "Design language".** Add a **Scale and layout** subsection covering: the seven layout tokens now wired, the four breakpoints and what each does (1360 / 1200 / 1100 window width, 2000 window width, 1200 window height), the rule that a responsive step moves a TOKEN and never a scattered literal, stylelint's range notation (`width < 1360px`, not `max-width`), the strip's `StripMetrics` as the single source shared by JS and CSS via custom properties and guarded by `metrics.test.ts`, and the footer's "nothing is clipped — the filename ellipses last" contract with the budget arithmetic in one line.
- [ ] **Step 3: `README.md` → "Keyboard reference".** Add three rows to the cheat-sheet table:

```
| `+` `−`    | —                   | —                    | bigger / smaller cells |
| `Ctrl+0`   | —                   | —                    | medium cells       |
```

  and a line under the table: `Ctrl + wheel` over the contact sheet steps the grid size too. Also add "Grid size" to the `## Settings` list.
- [ ] **Step 4: `TESTING.md`.** Add a short section, **Stylesheet guards**, describing the pattern this phase leaned on hardest: a test reads a stylesheet with the `?raw` glob and asserts that a number the JS also knows (`strip/metrics.ts`, `gridThumbRule.ts`'s `GRID_CELL_PADDING`) matches the rule that draws it, and that each picked breakpoint exists at its picked width. Name `src/styles/layout.test.ts`, `src/components/strip/metrics.test.ts` and `src/image/gridThumbRule.test.ts`. If nothing in the "Reading source files in tests" section changed, say so and leave it.
- [ ] **Step 5: the implementation note.** Append an `## Implementation note` section to THIS plan file, in the shape Phase 3A's has (what shipped · where the plan was wrong and what was ruled instead · verification · Oliver's walk · left for later). Its first paragraph is the **Pre-flight** one already written below under `## Pre-flight corrections (2026-09-20)` — move it into the note verbatim and add a line for every further correction the implementers hit, one line each.
- [ ] **Step 6: final gate** — `pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm lint:css && pnpm test && pnpm build && pnpm css:census`, plus the Rust three from `src-tauri/`. `css:census` is a starting list, not a verdict: reconcile any new name by hand and report it.
- [ ] **Step 7:** commit: `docs: Phase 3B — scale, layout and the grid tier`.

---

## Pre-flight corrections (2026-09-20)

Two fresh reviewers fact-checked this plan against the code before any of it was executed; every finding below was applied here, so an implementer reads only corrected text. Recorded so the record survives even if the session is interrupted — Task 14 moves this paragraph into the implementation note.

- **Two footer CSS rules named the wrong file.** `.cull-statusbar__chip` and `.cull-statusbar__multi` live in `statusbar.css` (`:43`, `:53`), not `chrome.css`. Task 2 Step 5 now splits the edits by file, and names `.cull-statusbar__unsaved` as the one left-cluster child with no `flex-shrink`.
- **The compact rail would have stolen the compare rail's padding.** `ExifRail.tsx:314` renders both classes and a media query adds no specificity, so Task 3's block is now `.cull-exif-rail:not(.cull-exif-rail--compare)`.
- **Two appended test blocks used `test(` in files that import only `it`.** Task 2's snippets are `it(`, with the exact imports to add.
- **The grid-size callbacks used an updater form that does not exist.** `useSettings` returns `(next: Settings) => void` (`useSettings.ts:87`, `:115`); Task 6's code block spreads `settings` and lists it in the deps, and the identity consequence (the wheel effect re-attaches, the keymap rebuilds, on any settings write) is stated.
- **The footer budget was wrong by ~50 px.** `"4194 photos missing"` is 19 characters = 143 px, not 97, and the scrub cluster is 58, not 54. Corrected table, corrected CSS comment: the worst case leaves 28 px for the filename stem, which ellipses — the structural "nothing is clipped" guarantee is unchanged, the "fits with room" claim was false and is gone.
- **`display: none` on the save chip's tail would have shortened its accessible name.** Ruled: a new one-off `.visually-hidden` in `base.css`, with the same declarations repeated in the `< 1200` rule (a media query cannot add a class). The name stays whole at every width.
- **The help sheet's five-cap row overflows the 132 px key column** (139 px inside one `nowrap` combo). Ruled: keep the spec's 132 and split any row of four or more caps into two combos so the column can wrap; a test pins that all five caps still render in order.
- **The `gridSize` Settings help string was written twice, contradictorily.** One `modCombo("0")` template, with the import named.
- **`mod gridthumb;` cannot pass `clippy -D warnings` before its caller exists.** Task 8 adds `#[cfg_attr(not(test), allow(dead_code))]` (precedent: `phash.rs:50`), Task 10 deletes it — which makes 8 → 10 strictly serial on `lib.rs`.
- **One sentinel would have permanently stranded cells.** `MidGen`'s pending set is shared with the opportunistic mid generator and the whole-shoot idle sweep, so a `try_begin` bounce is common — folding it into the latching sentinel meant a grid scroll racing the sweep left those cells soft forever. Split into `"grid thumb unavailable"` (latches) and `"grid thumb pending"` (cooldown only), on both sides, with a test for each behaviour.
- **The spec's "the grid path must NOT fill the preview cache" was overridden on a false premise** and is reinstated: the grid visits frames the loupe never opens, so it genuinely would push ~2.2 GB through a 2 GiB cap. `preview_parts_opt(…, put_on_miss)` now holds the one copy of the acquisition logic; `preview_parts` is the `true` wrapper (navigation unchanged) and `read_grid_thumb` passes `false`. A prvw cache HIT still serves the grid at zero source I/O. Two Rust tests: an ungated hit-path test, and the corpus-gated miss-path assertion that the prvw store stays empty.
- **The plan told the implementer to write `grid_thumb_error` twice.** It is defined once, in Step 2, and both `map_err` sites call it.
- **A claimed safety net in `pressureProfile.test.ts` does not exist** — both levels spread `...base`, so an unclamped knob passes the whole-profile loop. The explicit grid-tier case is the only net, and the plan now says so.
- **A dead `LANES` entry** for the grid lane (immediately overruled by the plan's own ruling, and calling a helper defined later) is deleted; the lane's own `describe` is placed inside the parity-net `describe`, where `laneDeferreds` is in scope.
- **`debugStats()` has an inline return-type annotation**, so the new `gridThumb` block and the two counters land twice; the plan now says both places.
- **Smaller:** `retry()` gains `gridThumbLane.pump()`; the cancelled-shape regex becomes `/(^|: )cancelled$/i` (`preview_parts` wraps it as `"cr3 preview: cancelled"`); the oversized-put test binds its buffer; Task 12 re-reads `GridView`'s prop type after Task 6; the bake page does two whole-canvas reads instead of 2,048 single-pixel ones; Task 13 reads each backdrop rule in full before deleting its `opacity`; `modName` is confirmed dead after Task 7 and deleted; the icons allowlist is exactly five entries.
- **One finding rejected:** a reviewer placed `GridView.tsx`'s `GRID_CELL_TARGET` doc block at `:20`. It is `:21-25` with the export at `:26` (`:20` is blank), so Task 6's `:21-26` stands.

## Not in this plan

- **3C, by the spec's own scope line:** Home / End / PgUp / PgDn, the Rejects tab, capture-time sort.
- **Phase 4 and 5:** test/CI work, stars and colour labels, installers.
- **`minHeight` stays 500** (spec §"Rulings on scope"). The strip's tall step is a *window height ≥ 1200* choice, not a minimum.
- **No DPR-driven layout, no `zoom`, no user font-size setting** (spec §"Rulings on scope"). `zoomHotkeysEnabled` stays absent from `tauri.conf.json`, at its `false` default.
- **The class ↔ rule CSS census is closed** (spec §"Rulings on scope"): 329 classes defined, 0 dead, 3 harmless hooks. No guard test — a regex census is ~90 % noise on this codebase.
- **Settings stays 680 px wide** (option 6A — no change), so no task touches `dialogs.css`.
- **Ctrl+wheel does not anchor the cell under the pointer.** Ruled in Task 6: `GridView`'s auto-scroll effect re-runs on every `rowH` change and would overwrite the anchor, and spec §1A forbids rebuilding it.
- **The grid tier does not prefill.** The scout suggested a `bgLane` idle sweep behind the visible cells; the spec says "requested lazily" and "only for cells inside the visible grid range". A sweep over 2,726 frames is 27–41 s of CPU for pixels nobody is looking at. Left out deliberately; revisit only if Oliver's walk shows visible fill lag at Large.
- **The grid tier keeps no recency LRU.** Its windowed eviction is the whole policy. `THUMB_LRU_CAP`'s mechanism is deliberately NOT reused (it has no recency tracking at all).
- **`thumbDisplayUrl` is not a three-way choice.** Ruled in Task 11: layering preserves the 8-away-flash invariant; switching would reintroduce it.
- **The filmstrip stays on the THMB.** 104 CSS px at DPR 1.5 is 156 device px — still a downscale of 160. The grid tier is never requested for a strip cell.
- **The grid path does not write the prvw cache** (spec §"the sharper grid thumbnail"). Ruled in Task 10: the reader is *split*, not forked — `preview_parts_opt(…, put_on_miss)` is the one copy of the acquisition logic, `preview_parts` is its `true` wrapper so navigation is unchanged, and `read_grid_thumb` passes `false`. A prvw cache HIT still serves the grid at zero source I/O; only the write-back on a miss is suppressed. The cost accepted in exchange is one ~2 MiB head read per grid thumb whose frame the loupe has not visited — bounded by the request rule, which only asks for cells inside the visible grid range.
- **No ICC / colour management.** An AdobeRGB frame renders slightly flatter than its THMB in the grid, exactly as it already does in the mid tier. Pre-existing, unchanged, out of scope.
- **The verdict-word and save-tail sheds are new** (Task 2) — an extension of spec §3B taken under its own "say what else sheds" instruction, not a silent reinterpretation.

## Parallelism map

The controller runs implementers in parallel **only** on disjoint file sets. Wave = everything in the row may run concurrently.

| Wave | Task | Files it owns | May run with | Must follow |
| --- | --- | --- | --- | --- |
| 1 | **1** Window, tokens, title bar | `src-tauri/tauri.conf.json`, `styles/tokens.css`, `styles/statusbar.css`, `styles/chrome.css`, `styles/help.css`, **creates** `styles/layout.test.ts` | — (owns `tokens.css`; every other token task queues behind it) | — |
| 1 | **5** Strip metrics | `components/strip/*`, `styles/strip.css`, `styles/tokens.css`† | 8, 9 | — |
| 1 | **8** Rust generator | `src-tauri/src/gridthumb.rs`, `src-tauri/src/lib.rs`‡ | 5, 9 | — (never with 10) |
| 1 | **9** Rust cache tier | `src-tauri/src/tier_cache.rs` | 5, 8 | — |
| 2 | **2** Footer sheds | `components/StatusBar.tsx`, `utils/path.ts`, `utils/saveStatusCopy.ts`, `styles/base.css`, `styles/chrome.css`, `styles/statusbar.css`, `styles/stage.css`, `styles/layout.test.ts` | 6 | 1 |
| 2 | **3** Compact rail | `styles/exif-rail.css`, `styles/tokens.css`, `styles/layout.test.ts` | — (shares `tokens.css` + `layout.test.ts` with 2 and 4) | 1 |
| 2 | **4** Home at 2000 | `styles/home.css`, `styles/tokens.css`, `styles/layout.test.ts` | — (same two shared files) | 1 |
| 2 | **6** Grid size | `utils/gridSize.ts`, `types/settings.ts`, `types/index.ts`, `hooks/useSettings.ts`, `components/GridView.tsx`, `App.tsx`, `app/useCullKeymap.ts`, `components/SettingsDialog.tsx` | 2 | — |
| 2 | **10** Rust command + TS fetch | `src-tauri/src/bundle.rs`, `src-tauri/src/lib.rs`, `utils/bundle.ts` | 2, 6 | 8, 9 |
| 3 | **7** Help sheet | `types/nav.ts`, `components/HelpOverlay.tsx`, `styles/help.css`, `components/icons.test.ts` | 11 | 6 (absorbs its rows), 1 (`help.css`) |
| 3 | **11** imageStore grid lane | `image/gridThumbRule.ts`, `image/stage.ts`, `image/imageStore.ts`, `image/useThumb.ts`, `image/pressureProfile.ts`, `image/devStats.ts`, `types/settings.ts`, `app/useImageStoreWiring.ts` | 7, 13 | 6 (`types/settings.ts`), 10 |
| 3 | **13** Backdrop bake | `scripts/bake-backdrop*`, `src/assets/*.jpg`, `styles/chrome.css`, `styles/empty-state.css`, `styles/layout.test.ts` | 7, 11 | 1, 2 (both touch `chrome.css`), and after 2/3/4 for `layout.test.ts` |
| 4 | **12** Grid cell layers | `components/GridView.tsx`, `styles/grid.css`, `App.tsx`, `components/DevHud.tsx` | — | 6, 11 |
| 5 | **14** Docs + final gate | `ARCHITECTURE.md`, `README.md`, `TESTING.md` | — | everything |

† Task 5 touches `tokens.css` only to re-comment the three strip tokens and correct `--strip-h` 82 → 83. If the controller runs it alongside Task 1, hand Task 1 that edit instead and say so.

‡ Tasks 8 and 10 are **strictly serial** on `src-tauri/src/lib.rs`, not merely in different waves: Task 8 adds `mod gridthumb;` *with* `#[cfg_attr(not(test), allow(dead_code))]` (that attribute is what lets its own clippy gate pass with no caller yet), and Task 10 *deletes* that attribute in the same file when it registers the command. Running them concurrently would lose one edit or the other.

**Serial chains to respect:** 1 → {2, 3, 4}; 6 → 7; 8 → 10 and 9 → 10, then 10 → 11; {6, 11} → 12; everything → 14. **Never parallel:** 8 and 10 (`lib.rs`, see ‡); 6 and 11 (`types/settings.ts`); 2, 3, 4 and 13 (`styles/layout.test.ts`); 6 and 12 (`GridView.tsx`, `App.tsx`); 2 and 13 (`chrome.css`). Task 2 is the only owner of `styles/base.css`, so that file adds no new overlap.

---

## Implementation note (2026-09-20)

Executed with subagent-driven development. Before any code: two fresh checkers fact-checked this plan against the repository (6 blockers, 10 should-fixes, 11 nits — listed under "Pre-flight corrections" above, all applied). Then a fresh implementer and a fresh reviewer per task, up to five tasks in parallel on disjoint files; fix rounds on Tasks 2 (three), 6, 10 and 11; a whole-branch review on the strongest model split in two (layout/UI/docs; the grid-thumbnail pipeline end to end); ONE fix wave by four implementers; ONE scoped re-review; two wording-and-number corrections by the controller. Gates at the tip: 736 tests in 76 files (661 before), lint, lint:css, typecheck, typecheck:tests, build (JS ≈ 125.5 kB gzip, CSS ≈ 10.6 kB gzip); `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, 136 Rust tests (122 before).

### What shipped

- **Grid sizes** Small / Medium / Large — column targets 128 / 168 / 256. `+` / `=` / `-` (numpad too) in the grid, `Ctrl+0` back to Medium, `Ctrl`+wheel at most one step per 160 ms; a `gridSize` setting with a row in Settings; help-sheet rows. A clamped step writes nothing; a held key steps once.
- **The grid thumbnail** — 512 px on the long edge, q82, made in Rust from the CR3's embedded 1620 × 1080 preview (`gridthumb.rs`), a fourth cache tier (`grid/`, 512 MiB), `read_grid_thumb`, a sixth lane in `imageStore`, and a second `<img>` layered over the THMB in `GridCell`, faded in on `load`. Requested only for MOUNTED cells in the reported range and only when `(cellW − 18) × devicePixelRatio > 160`.
- **Filmstrip** 76 × 54, and 104 × 74 when the window is at least 1200 px tall; the strip's box is border-box now — 83 / 103 px where it declared 82 and rendered 111.
- **Footer** sheds instead of clipping; minimum window width 1024.
- **Info rail** 232 px (compare 288) below 1200 px of window width.
- **Home** grows from 2000 px of window width. **Settings** unchanged.
- **Help sheet** draws keycaps from structured rows.
- Window first-paint colour `#0c0c0d`; the title bar reserves 176 px; dead layout tokens wired; backdrops tone-baked at 2560 px by `node scripts/bake-backdrop.mjs` (max channel difference 2 of 255 against the old runtime recipe; 133 + 82 kB → 88 + 32 kB).

### Where the spec or the plan was wrong, and what was ruled instead

- **The footer's breakpoints are not the design board's.** The board said 1360 / 1200 / 1100. The worst case (scrubbing + overlay cluster + a four-digit missing-photos chip + the finish button) did not fit with those, and each recount found another always-shown piece the sums had left out (the save chip's tail, the all-rated finish label, the `.CR3` extension, the scrub chip's margin). Shipped: below **1360** the key hint, the save chip's action tail (visually hidden — the button keeps its full accessible name), the file extension and the ALL-RATED finish label; below **1240** the zoom, scrub and verdict words; below **1120** the ordinary finish label. The rail's own breakpoint stays 1200. The sums live in `statusbar.css`'s comment; slack is positive at every pinned width, 14 px at the tightest. They rest on estimated glyph advances and have never been measured in a live render.
- **Medium is 168, not the board's 176** — 176 equals today's grid only at 2560 px of width.
- **The wheel has a 160 ms cooldown**, where the plan said "saturate": a touchpad pinch slammed to an end and made Medium unreachable.
- **The preview cache.** The planner overrode the spec and reused `preview_parts`, which fills the preview cache; the spec was reinstated — `preview_parts_opt(.., put_on_miss)`, the grid passes `false`, with an ungated test (the first test of the flag could not fail, and the one that could is skipped in CI).
- **Two sentinels, not one.** `"grid thumb unavailable"` latches a path for the session; `"grid thumb pending"` (another producer holds the shared generation claim) is quiet backoff. A pending bounce fed the folder-trouble latch in the first implementation — four of them would have shown "folder unreachable" on a healthy folder.
- **Found only by the whole-branch review, all four "sharp thumbnails arrive slowly or never":** the idle mid sweep (about 11 minutes on a 2,726-frame shoot) never yielded to the grid lane; the lane's queue was never pruned, so a scrollbar drag queued a thousand stale cells ahead of the visible ones; under a filter the min..max absolute range requested every hidden frame in between; the single pending timer used the first bounce's delay and stranded later ones. All fixed in the wave.
- **The strip's box fix had a casualty:** the ×5 / ×50 scrub-speed chip would have sat on the thumbnails. It is anchored in the strip's top headroom now, in terms of `--cell-h`.
- A cached preview header is parsed for its orientation only, so an unrelated field can never cost a cell its sharp thumbnail.

### Verification

Tests and static gates only. **Nothing in this phase has been seen running**: the click-only live check (`~/.claude/plans/cull-audit-2026-09-13/live-check/phase3b-shots.ps1`: home default and maximized, loupe at both strip steps, the grid at three sizes, the loupe at 1100 and 1024 px — navigation keys only, no rating key, scratch folder only) was not run because the PC was in use.

### Oliver's walk

1. Grid (`g`), then `+` and `-`: at Large the thumbnails should turn sharp within a second or two of landing on a screenful; scroll fast, then stop — the visible cells should sharpen first.
2. Loupe, default window vs maximized: the filmstrip is 28 px shorter than it used to be at the default size (the photo is taller), and steps up to bigger frames when maximized.
3. Hold Shift-scrub over the strip: the ×5 / ×50 chip now sits ABOVE the thumbnails. Where a burst bracket is, the bracket and its ×N legend paint over the chip — say if that bothers you. The thin scrub bar also runs along a burst box's bottom border now.
4. Drag the window narrow (to its new 1024 minimum): the footer loses words in steps and nothing is cut off; the info rail goes compact below 1200. `.CR3` is dimmer than the file name at every width.
5. Home, maximized: the composition is bigger. Tab (hold): keycaps in the help sheet.
6. If a save ever fails: hovering the footer chip underlines its two parts separately.

### Left for later

- 3C: Home / End / PgUp / PgDn, the Rejects tab, capture-time sort.
- Phase 4: the imageStore test file's stores run on real timers unless a test opts out — a suite-level teardown now hard-resets them, which also hides a class of timer leak; `App.tsx` and `useCullKeymap.ts` have no test harness, so the wheel, key-repeat and cell-width changes were verified by reading.
- `recordPendingBounce` rewrites the attempt count unconditionally, so a path alternating real errors and pending bounces never reaches the terminal cap (theoretical).
- `read_grid_thumb` takes its generation permit before the IoGate wait (parity with `read_mid`); with the sweep yielding it no longer matters in practice.
- Ctrl+wheel steps the size in place, not under the cursor (the grid's auto-scroll would fight it).
- Grid-tier prefill was left out: lazy-visible proved enough on paper; revisit after the live check.
- Still owed from earlier phases: the Phase 0 live check of Move rejects on a scratch copy.
