# Grand Cleanup — analysis & planning brief (2026-07-07)

> Handoff brief from Oliver (written with Claude at the end of the PhotoPane
> unification session). The next session executes THIS brief: deep analysis +
> a grand plan document. **NO code changes in that session.**

## Context

CULL is my Canon CR3 photo-culling desktop app at
`/Users/oliversogaard/ClaudeProjects/cull` (github.com/OliverSogaard/cull,
branch `main`). Stack: Tauri 2 with a pure-Rust backend (`src-tauri/`),
React 19 + TypeScript frontend, pnpm. Platforms: Windows (primary) + macOS
ONLY — Linux is deliberately compile-blocked, never add Linux handling.

**The app is feature-complete.** Everything I wanted is built, live-tested,
and pushed (origin/main `89bd192`, 2026-07-07 — the PhotoPane unification was
the last feature-side refactor). This codebase grew over several months and
hundreds of individual commits, so it has accumulated the natural mess of
iterative building. What comes now is the **final production pass: a grand
cleaning of the entire repo** — frontend, Rust backend, docs, config, repo
hygiene — so it ends up clean, minimal, smart, optimized, and professional.

## Your mission (this session)

**Deep analysis and planning ONLY. Do not edit any code.** Produce a grand
cleanup plan as a dated doc in `docs/superpowers/plans/` (the project's plan
docs are the cross-machine handoff channel — dated implementation notes get
added to them as phases complete). Use superpowers:brainstorming to pin down
scope questions with me first if needed, then superpowers:writing-plans for
the plan itself. Review the plan with me before committing it (docs-only
commit; never push without my say-so).

Recommended method: fan out parallel read-only explorer subagents to map the
codebase (App.tsx alone is ~4,700 lines; `src-tauri/src/` has a dozen+
modules), run analysis tooling read-only, and read `ARCHITECTURE.md` plus the
plan docs (`IMAGE_PIPELINE_PLAN.md`, `SMART_CULLING_PLAN.md`,
`docs/superpowers/plans/*`) — their dated implementation notes explain WHY
code is shaped the way it is.

## What the sweep should cover (expand where you find more)

1. **Dead & stale code hunt.** Unused exports/files/deps (knip, ts-prune,
   depcheck; cargo machete/udeps), unused CSS classes and assets, leftover
   feature flags, legacy fallbacks that no longer trigger (e.g. audit
   `isLegacyNav`), resolved diagnostic probes (the dlog probe families —
   check which investigations are closed), dev-only fixtures, dead
   localStorage keys, orphaned test helpers.
2. **Unification opportunities** — the PhotoPane pattern applied everywhere:
   parallel code blocks that grew as siblings and should be one
   implementation. Known suspects to evaluate (verify, don't assume): the
   strip family (ThumbStrip / CompareStrip / PhotoStrip / FilmStrip), scrub
   mechanics across loupe/compare/grid, spinner/shimmer/empty-state
   patterns, settings knob components, overlay wiring, Rust-side shared
   helpers across cr3/meta/bundle/tier_cache. Find the rest.
3. **Structure & size.** App.tsx (~4,700 lines) must decompose into focused
   hooks/modules (keyboard routing, decide callbacks, zoom state, session
   lifecycle…). ECC standards: files <800 lines, functions <50, organize by
   feature. Same lens on any oversized Rust module.
4. **Minimality & efficiency.** Re-render audit (memo boundaries, effect
   churn), bundle size (currently ~116 KB gzip — what's in it, lazy-load
   candidates), Rust hot paths (clippy + measured, not guessed), dependency
   diet on both sides, release build profile (LTO, opt levels, binary size).
5. **Consistency & standards.** Naming, TS strictness (no `any`), error
   handling patterns, immutability, Rust idioms (unwraps, error types,
   clippy pedantic triage). Consider adding the missing professional
   tooling: eslint + prettier + stylelint configs and scripts (repo
   currently has none), rustfmt/clippy in CI.
6. **Documentation.** README rewritten to production quality; ARCHITECTURE.md
   accuracy sweep; root-level plan docs archived tidily (they're history,
   not entry points); module-level doc comments where missing; comment
   accuracy sweep (see guardrail below).
7. **Repo & CI hygiene.** .gitignore/.gitattributes review, stray files,
   scripts/ documented, release.yml review (Windows+macOS matrix, tag flow,
   model fetch), asset optimization (backdrops etc.), version/identity
   strings, LICENSE decision.
8. **Test suite health.** 414 TS + 103 Rust today — find dead tests, gaps in
   pure-logic coverage worth closing cheaply, document the calibration
   harness and corpus-gated tests properly.
9. **Robustness/security quick pass.** Tauri capabilities/allowlist, CSP
   config, path handling, XMP write safety — flag anything off.

## Guardrails (non-negotiable)

- **The long comments are load-bearing.** This codebase documents hard-won
  WKWebView paint bugs, jetsam crashes, decode races, and macOS key quirks in
  place. Stale/lying comments must go; war-story comments explaining WHY
  fragile code is shaped a certain way must stay. Cleaning ≠ stripping
  institutional memory.
- **Timing-sensitive paths need proof, not confidence:** the presenter
  double-buffer (mid-scrub offers sequenced best-first), zoom choreography,
  io_gate/decode pool, tier cache VERSION contract. Any plan step touching
  them must be flagged for my live visual gate (my dev app hot-reloads).
- The plan must be **phased, each phase suites-green and independently
  gated**, ordered safest-first (docs/config → dead code → mechanical moves →
  behavior-risk unifications last), with an explicit do-not-touch list and
  honest ROI/risk ranking — I'd rather skip a low-value risky cleanup than
  chase "minimal" into a regression.
- Windows + macOS only. Never push without my say-so. Execution happens in
  later sessions, one phase at a time, me gating.

## Deliverable

`docs/superpowers/plans/<date>-grand-cleanup.md`: findings inventory (with
file:line evidence), the phased plan, ROI/risk ranking, do-not-touch list,
and per-phase verification/gates. Nothing else changes in the repo.
