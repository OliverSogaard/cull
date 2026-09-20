# Phase 3A — See and feel (design decisions)

Phase 3 of the 2026-09-13 audit ("Visible polish") is split into three plans: **3A See and feel** (this document), **3B Scale and layout** (grid zoom, 4K strip, footer collapse / min width, compact rail, backdrops, window colour), **3C Navigate and review** (Home/End/PgUp/PgDn, Rejects filter tab, capture-time sort). Order 3A → 3B → 3C, Oliver's choice, 2026-09-19.

Source findings: `docs/superpowers/audits/2026-09-13-full-app-audit/audit.md` §5.4–5.6 and `reports/ux-a11y-copy.md`, `reports/design-system.md`. Accessibility depth stays at the decided "visible minimum": no live regions, no operable cells.

## Decisions (picked by Oliver on the design board, 2026-09-19)

The board was a local page built from the app's real stylesheet; options differed only in the thing being decided.

| # | Decision | Picked |
|---|---|---|
| 1 | Favourite colour, distinct from the champagne accent | **Lilac `#b9a2dc`** (8.63:1 on `--bg`, 7.96:1 on `--surface`). Accent, cursor ring, selection, brand and progress stay champagne. |
| 2 | Focus ring | **Double ring**: `0 0 0 2px var(--bg), 0 0 0 4px var(--accent)` — the existing, unused `--ring` token. Every focusable control gets it, including `.btn` and the window buttons; inset controls get an inset form. |
| 3 | Contrast lifts | `--muted` → `--text-2` for settings help text, inactive settings nav, inactive filter tabs (4.25 → 7.20:1); `--on-bad` → `var(--ink)` (3.09 → 6.40:1); footer keyhint gains `color: var(--text-2)` at its existing opacity (2.72 → 4.17:1); empty LrC stars → `color-mix(in srgb, var(--text-2) 58%, var(--bg))` (1.16 → 3.32:1). |
| 4 | Button and keycap sizes | **Two button sizes**: md 32 px tall / 13 px / `0 14px`; sm 26 px tall / 12 px / `0 10px`. The home hero CTA keeps its own size. **One keycap**: 20 px tall, 11 px mono, min-width 20 px, `0 5px`, radius 2 px. |
| 5 | Modifier key | **Two keycaps**: the modifier (`Ctrl` on Windows, `⌘` on macOS) and the letter, each its own keycap. |
| 6 | Voice and casing | **Sentence case** for titles, buttons and messages ("Begin culling →", "Leave to home?", "Stay", "Close"). Mono eyebrows stay uppercase via CSS. Proper nouns keep their capitals. |
| 7 | Icons | Remaining Unicode glyphs (✓ ✕ ★ ⚠ ↓ ⟶ •) become lucide-react icons on one scale: 12 / 14 px at stroke 1.75, 16 px at stroke 1.5. The two display glyphs (40 px staged tick, 36 px drop arrow) keep their size at stroke 1.5. |

## Included without a choice to make

- `prefers-reduced-motion: reduce`: the verdict flash becomes an instant tint with no pulse, shimmer placeholders are static, infinite pulses / breathes / scrub flash stop, the hero entrance is skipped. Spinners and the indeterminate progress bar keep moving (they communicate "working"), slowed rather than removed.
- The help sheet hides clipping / peaking / composition overlays while it is open.
- The grid multi-select tint matches the cell's 9 px padding and takes its colour from `--accent` instead of a hardcoded rgba.
- The settings toggle's hit area is at least 24 × 24 CSS px; the drawn track stays 36 × 20.
- Armed confirms ("Yes, move", "Yes, reset") receive focus when they appear.
- EXIF values and error text are selectable (`user-select: text`); chrome stays unselectable.
- A write that failed because the photo is no longer at its path says so ("photo missing") instead of offering a retry that cannot succeed.
- The dead `.cull-quitguard__danger:hover` becomes live through the danger button modifier.
- README's key table describes Compare's compound `f` / `k`.

## Out of scope for 3A

Live regions, operable grid/strip cells, suggestion state in `aria-label`s, a UI-scale setting (the audit's H4, H5, M4, L2 — beyond the decided minimum); everything listed under 3B and 3C; the class ↔ rule CSS census (3B).

## Verification

Unit tests for new logic and components; the full gate; and headless-browser screenshots of the design board, whose "today" columns render the app's real stylesheet and therefore show the shipped result. Oliver's walk in the running app remains the final check.
