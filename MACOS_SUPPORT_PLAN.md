# macOS Support for CULL — Implementation Plan

## Context

CULL is a Tauri 2 app (pure-Rust backend + React 19/TS frontend) currently distributed as a Windows NSIS installer. This plan adds first-class macOS support. A full audit (backend, frontend, build config, plus a dedicated macOS edge-case hunt — all findings below carry file:line evidence) found the codebase **already essentially cross-platform**: there is no Windows-only code to port. The work is a thin layer of platform polish, one small Rust change, defensive Unicode handling for Danish folder names, and release automation.

**Decisions (firm):**
- **Personal-use Mac build** — no Apple Developer account, no code signing / notarization. Tauri ad-hoc signs the `.app` automatically at build time.
- **Native traffic lights on macOS** (`titleBarStyle: Overlay`); Windows keeps the existing custom top-right controls unchanged.
- **GitHub Actions CI** builds both installers (Windows `.exe`, macOS `.dmg`) from one `v*` tag.
- **Windows + macOS only, enforced.** Linux and mobile are deliberately unsupported and blocked at compile time (Step 8) — no edge-case handling for them anywhere in this plan, ever.

## Distribution model — "one app for everyone?"

**One codebase, one product — but two installer files.** A Windows `.exe` and a macOS `.app` are different executable formats (PE vs Mach-O); no desktop technology produces a single binary that runs on both — Chrome, Lightroom, and Photoshop all ship per-OS installers. The "detect the platform and adapt" idea is real, but it happens in two places, both inside this one shared codebase:

- **Build time:** the compiler produces the right binary per OS (CI does this automatically).
- **Runtime:** small UI differences branch on the detected platform — ⌘ vs Ctrl labels, traffic lights vs custom window buttons.

**"One thing to give everyone" = one link**: the GitHub Releases page. CI builds both installers from one version tag; each person downloads the file for their OS. (Future option: a *universal* macOS binary covers Intel + Apple Silicon Macs — "one app" within the Mac world only. Skipped for now; the aarch64 build covers the target Mac.)

## Per-platform optimization — each OS gets its native best, by construction

No extra "optimization work" is needed per platform; it falls out of the architecture:

- **Natively compiled per OS.** Each installer contains machine code compiled for that OS/CPU, both built with the same aggressive release profile already in `Cargo.toml` (`opt-level = 3`, LTO, `codegen-units = 1`, `strip = true`).
- **Native webview per OS.** Tauri does not bundle a browser (unlike Electron) — the UI renders in the OS's own engine: WebView2 on Windows, WKWebView on macOS. Each platform gets its native renderer, fonts, scrolling physics, and energy behavior.
- **Native UX per OS.** The platform layer (Steps 2–5) gives each OS its conventions: traffic lights + ⌘ on macOS, custom controls + Ctrl on Windows.
- **Windows is untouched by all of this.** The macOS window config is a separate merge-file that only loads on Mac; UI changes are gated behind `!isMac`; the one Rust change is `#[cfg(target_os = "macos")]`-compiled out of the Windows binary. The Windows build behaves identically to today.

## Why this is easy — current state (audited)

- **Backend is pure Rust.** Zero `#[cfg(windows)]` in `src-tauri/src/`; no external binaries (the CR3 parser is self-contained — no exiftool/WIC/libraw); all paths via `std::path`; cache dir via Tauri's `app_cache_dir()` (`lib.rs:37`) → resolves to `~/Library/Caches/dev.cull.app/thumbs` on macOS; atomic XMP writes are platform-portable (`xmp.rs:50-70`). The only Windows-flavored line is `windows_subsystem = "windows"` in `main.rs:2`, which is ignored elsewhere.
- **Frontend already anticipates macOS.** Every shortcut checks `e.ctrlKey || e.metaKey` (`App.tsx:2291,2299,2391,2397,2404`; `GridView.tsx:236` for ⌘-click multi-select); `src/utils/path.ts` handles both separators with tests for both (`path.test.ts`); star glyphs already use SVG to dodge font-metric quirks (`ThumbCell.tsx:89-91`).
- **Build config is ready.** `bundle.targets: "all"`, `icon.icns` present, dialog plugin is cross-platform — including the `multiple: true` directory pick (`pickFolder`, `App.tsx:652`): rfd's native macOS open panel supports ⌘-click multi-folder selection. Dev Mac toolchain verified: Rust 1.95, Xcode 26.5, pnpm 10, Node 24 — it can build today. The multi-folder open flow was verified running on the dev Mac (2026-06-10, real NAS folder).

## Implementation

### 1. macOS window config — new `src-tauri/tauri.macos.conf.json`

Tauri 2 auto-loads `tauri.<platform>.conf.json` and merges it over `tauri.conf.json` via **JSON Merge Patch (RFC 7396)**. Critical consequence: **arrays are replaced wholesale**, so this file must repeat the *entire* `app.windows[0]` object, not just changed keys:

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "app": {
    "windows": [
      {
        "title": "CULL",
        "width": 1600, "height": 1000, "minWidth": 800, "minHeight": 500,
        "backgroundColor": "#000000",
        "decorations": true,
        "titleBarStyle": "Overlay",
        "hiddenTitle": true,
        "trafficLightPosition": { "x": 14, "y": 12 }
      }
    ]
  }
}
```

- `decorations: true` is required for `Overlay` (transparent titlebar, content extends to the top, native traffic lights drawn over the webview). `hiddenTitle: true` suppresses the "CULL" text.
- The top chrome bar is **36px** (`.cull-statusbar--top`, `App.css:63`, left padding 14px). Traffic lights are ~12px tall → `y: 12` roughly centers them; `x: 14` matches the bar's inset. If positioning misbehaves (known tao quirk after fullscreen), drop `trafficLightPosition` and accept the default.
- Base `tauri.conf.json` is **unchanged** — Windows keeps `decorations: false` + custom controls. No `tauri.windows.conf.json` needed.
- Capabilities already grant `core:window:allow-start-dragging` and `core:window:allow-toggle-maximize` — no changes.
- **Maintenance caveat:** any future edit to `app.windows[0]` in `tauri.conf.json` must be mirrored here (RFC 7396 array replacement).

### 2. Platform detection — new `src/utils/platform.ts`

Navigator-based; do **not** add `@tauri-apps/plugin-os` (a UA check is synchronous and dependency-free):

```ts
/** True when running on macOS (WKWebView UA contains "Mac"). */
export const isMac: boolean =
  typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent);

/** Modifier glyph for compact kbd labels: ⌘ on macOS, ⌃ elsewhere. */
export const modGlyph = isMac ? "⌘" : "⌃";

/** Modifier word for prose labels: "cmd" / "ctrl". */
export const modName = isMac ? "cmd" : "ctrl";
```

In `src/main.tsx`, before render: `document.documentElement.dataset.platform = isMac ? "mac" : "win"` so CSS can branch per platform.

### 3. Window controls — `src/components/WindowControls.tsx`

- Wrap the Minimize and Close buttons in `{!isMac && …}` — traffic lights own minimize/zoom/close on macOS; duplicates top-right would be wrong.
- **Keep the Settings gear top-right on both platforms.** It preserves the documented focus-restore behavior (component comment, lines 20-23: the settings dialog's focus trap returns focus to the gear), and a lone gear top-right is a natural macOS pattern.
- Line 18: `title="settings  (Ctrl + , )"` → dynamic `` `settings  (${isMac ? "Cmd" : "Ctrl"} + , )` ``.
- Close path unchanged: the (now Windows-only) X still calls `win.close()`, routing through the close-guard.

### 4. CSS — `src/App.css`

```css
/* macOS: traffic lights occupy top-left (~14+52px); only the gear sits top-right. */
:root[data-platform="mac"] .cull-statusbar--top {
  padding: 0 60px 0 84px;
}
```

Left `84px` = 14 inset + ~52px buttons + gap so the brand block clears the lights; right shrinks from 148px (3 buttons) to 60px (gear only). `.cull-wincontrols` / `.cull-winbtn` (lines 138+) need no change — the flex container just shrinks.

### 5. Dynamic modifier labels (complete verified list)

Replace hardcoded glyphs/words with `modGlyph` / `modName`:

| File | Location | Current |
|---|---|---|
| `src/components/HelpOverlay.tsx` | 17–19 | `"ctrl+z"`, `"ctrl+⇧+z"`, `"ctrl+e"` |
| `src/components/HelpOverlay.tsx` | 120 | `"⌃+click"` (add to selection) |
| `src/components/SettingsDialog.tsx` | 214 | `<kbd>⌃ ,</kbd>` |
| `src/App.tsx` | 2804 | hero CTA `⌃ O` |
| `src/App.tsx` | 2820 | home "how" hint `⌃ ,` |
| `src/App.tsx` | 2906 | staged-screen hint `drop folders anywhere to add more · ⌃ O · esc to start over` |
| `src/App.tsx` | 3384 | finish chip `⌃E · keeps` |
| `src/App.tsx` | 3632 | recents empty-state `<kbd>⌃ O</kbd>` |

(List re-verified 2026-06-10 after the multi-folder picker / combined-recents feature, which moved every `App.tsx` line and added the staged-screen hint row.)

**No keyboard handler changes** — every shortcut already accepts Cmd via `metaKey`.

### 6. Cmd+Q close-guard — `src-tauri/src/lib.rs:54-55` (the only Rust change)

> **IMPLEMENTATION NOTE (2026-06-10) — the mechanism below was verified WRONG and replaced.**
> Code review against the locked deps (tauri 2.11.2, tao 0.35.3, muda 0.19.2) found:
> (a) `ExitRequested { code: Some }` fires only for programmatic `AppHandle::exit()`, which CULL never calls — the doc's `Some`/`None` comment is inverted; and (b) worse, with the
> default macOS menu the Quit item maps to the native `terminate:` selector and tao
> implements no `applicationShouldTerminate:`, so Cmd+Q terminates NSApp directly and
> **no `ExitRequested` fires at all** — the re-route below is unreachable dead code.
> **Shipped fix instead:** a custom macOS menu (in `setup`, cfg-gated) whose Quit item
> (`CmdOrCtrl+Q`, id `cull-quit`) routes through `win.close()` — same close-request path
> as the red traffic light, so the JS guard runs. The Edit submenu is rebuilt with
> predefined roles (undo/redo/cut/copy/paste/select-all), preserving Cmd+C/V/X in
> WKWebView text fields — honoring the *intent* of the "don't touch the menu" rule below.
> Window submenu: minimize/zoom/close. The builder tail stays the original
> `.run(generate_context!())`. **Known accepted gap:** Dock-icon Quit and logout/shutdown
> still terminate natively, bypassing the guard (would need an objc app-delegate hook;
> not worth it for personal use). The original (wrong) mechanism is kept below for the
> historical record — do not implement it.

The JS close-guard (`App.tsx:1516-1530`, `onCloseRequested`; flush-then-`destroy()` at 1588-1605) fires for the red traffic light exactly like the custom X. **But Cmd+Q / menu-Quit raises app-level `RunEvent::ExitRequested`, bypassing the window's close-request path** — XMP writes could be in flight. Since Cmd+Q is the primary quit gesture on macOS, re-route it. Change the builder tail from `.run(tauri::generate_context!()).expect(…)` to:

```rust
.build(tauri::generate_context!())
.expect("error while building tauri application")
.run(|app, event| {
    #[cfg(target_os = "macos")]
    if let tauri::RunEvent::ExitRequested { code, api, .. } = &event {
        // Cmd+Q / menu Quit raises ExitRequested with Some(code) while the
        // window is still open. Re-route through window.close() so the JS
        // close-guard (pending XMP writes) gets its normal chance to object.
        // code == None is the "all windows closed" natural exit (e.g. after
        // the guard's destroy()) — leave that untouched.
        if code.is_some() {
            if let Some(win) = app.get_webview_window("main") {
                api.prevent_exit();
                let _ = win.close();
            }
        }
    }
    let _ = &event; // non-macOS: no-op
});
```

Runtime-verify the `code: Some/None` discrimination against the resolved Tauri patch version — both failure modes are benign and immediately visible in testing (guard skipped on Cmd+Q, or app lingering after close). Fallback if semantics differ: document that Cmd+Q skips the guard (acceptable for personal use).

**Do NOT remove or customize the app menu.** Tauri's default macOS menu provides the Edit roles that make Cmd+C/V/X work inside WKWebView text fields — the app has two (`FinishDialog.tsx:312` subfolder name, `SettingsDialog.tsx:395` rejected-subfolder name). No menu code exists today; keep it that way, or preserve the Edit menu if one is ever added. (Cmd+M minimize, Cmd+H hide, and double-click-titlebar zoom all come free with native decorations.)

### 7. Unicode path normalization (NFD/NFC) — the one real correctness item

macOS file APIs can return filenames in **decomposed** Unicode form (NFD: `ø` = `o` + combining stroke) while dialog picks / persisted strings may be **composed** (NFC). With Danish folder names (`København_bryllup`…) this matters. Verified raw-string comparison sites:

- XMP stem set: `scan.rs:148,172,224` — lowercased, **not** normalized. Low risk in practice: both CR3 and XMP names come from the *same* `walkdir` pass, so they share a form internally.
- Thumb-cache key: `thumb_cache.rs:19-23` hashes raw path bytes (FNV) — a form flip means a silent cache miss (re-extract, not corruption).
- Recents identity (v2, multi-folder): `recentKey` (`useRecents.ts:36`) sorts and NUL-joins each session's `paths`; `mergeRecent` (`useRecents.ts:48-51`) dedupes by that key, and `sessionRecentsKeyRef` replacement plus `removeEntry` in `App.tsx` compare the same keys. A form flip in **any one member** of a folder set forks the entire session entry — higher leverage than the old single-path `r.path !== entry.path` check this section originally described. The launch auto-open also string-matches `r.paths.includes(lastDir)` (`App.tsx:684-690`), so a flipped `cull:lastDir` silently downgrades a session restore to a single-folder open.

**Fix (cheap, frontend-only):** apply `String.prototype.normalize("NFC")` at every path *entry point* before storing or invoking. The multi-folder refactor made this easier — folder paths now funnel through a single chokepoint:

- `openFoldersByPaths` (`App.tsx:527`): normalize the `picked` array at the top of the function (next to the existing empty-string filter). This one site covers the picker, multi-folder drag-drop, recents clicks, and launch auto-open, and everything derived downstream (`srcFolder`, `cull:lastDir`, recents `paths`, `recentKey`).
- FinishDialog export-destination pick (`FinishDialog.tsx:175-192`) — separate single-folder dialog, normalize its result too.
- Scan results received over IPC (the per-file paths returned by `scan_folder`).

Everything downstream (cache keys, recents, comparisons) then sees one canonical form. No Rust changes; no new dependency. Pre-existing v2 recents entries written before normalization self-heal on the next completed cull (the session rewrite replaces the entry).

### 8. Platform safeguard — Windows + macOS only (make Linux/mobile impossible)

Three layers, so unsupported platforms are blocked rather than merely untested:

1. **Compile-time guard** at the top of `src-tauri/src/lib.rs` (the crate root — `main.rs:5` just calls `cull_lib::run()`, so this covers every build path):

   ```rust
   #[cfg(not(any(target_os = "windows", target_os = "macos")))]
   compile_error!("CULL supports Windows and macOS only.");
   ```

   Any attempt to build for Linux, iOS, Android, BSD, etc. fails instantly with that message — before a single line compiles.
2. **Bundle targets narrowed**: in `src-tauri/tauri.conf.json`, change `"targets": "all"` → `"targets": ["nsis", "msi", "app", "dmg"]`. Tauri filters the list per current OS (Windows builds nsis+msi, macOS builds app+dmg), and Linux package formats (deb/rpm/AppImage) can never be produced even by accident. Mirror nothing in `tauri.macos.conf.json` — `bundle` isn't overridden there.
3. **Declared support**: README states "Supported platforms: Windows (x64) and macOS (Apple Silicon). Linux and mobile are intentionally unsupported and blocked at compile time." CI matrix (Step 9) already contains only `windows-latest` and `macos-latest` runners.

Optional cleanup while in there: the scaffold `src-tauri/icons/android/` and `src-tauri/icons/ios/` directories are inert Tauri-init leftovers and may be deleted.

### 9. CI — new `.github/workflows/release.yml`

```yaml
name: release
on:
  push:
    tags: ["v*"]

jobs:
  build:
    permissions:
      contents: write
    strategy:
      fail-fast: false
      matrix:
        include:
          - platform: macos-latest      # Apple Silicon runner -> aarch64 build
            args: --bundles app,dmg
          - platform: windows-latest
            args: --bundles nsis
    runs-on: ${{ matrix.platform }}
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 10
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - uses: dtolnay/rust-toolchain@stable
      - uses: swatinem/rust-cache@v2
        with:
          workspaces: src-tauri
      - run: pnpm install --frozen-lockfile
      - uses: tauri-apps/tauri-action@v0
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        with:
          tagName: ${{ github.ref_name }}
          releaseName: "CULL ${{ github.ref_name }}"
          releaseDraft: true
          prerelease: false
          args: ${{ matrix.args }}
```

- Push a `v*` tag → draft GitHub release with `CULL_x.y.z_x64-setup.exe` + `CULL_x.y.z_aarch64.dmg`. `--bundles nsis` keeps Windows output to the NSIS exe (avoids the extra MSI from `targets: "all"`).
- aarch64-only mac build (target Mac is Apple Silicon). Universal would need `args: --target universal-apple-darwin` + `rustup target add x86_64-apple-darwin` — add later only if Intel Macs matter.
- No signing env vars. **Quarantine note:** a DMG downloaded from GitHub is unsigned/un-notarized → first launch needs right-click → Open (or System Settings → Privacy & Security → "Open Anyway", or `xattr -d com.apple.quarantine /Applications/CULL.app`). Locally built apps carry no quarantine attribute and launch directly. Drag the app out of the DMG into /Applications before first run to avoid App Translocation.
- If GitHub remaps `macos-latest`, pin `macos-14`/`macos-15`.

### 10. README updates

- Supported-platforms statement up top: Windows (x64) + macOS (Apple Silicon) only; Linux and mobile intentionally unsupported and compile-blocked (Step 8).
- macOS section under "Running CULL": download `.dmg` from Releases or build locally; Apple Silicon only; the quarantine/Open-Anyway note above; expect one-time macOS permission prompts on first access to Desktop/Documents/Downloads, **SD cards (removable volumes), and NAS (network volumes)** — normal TCC behavior, no action needed.
- "Sharing the built app": add mac bundle paths (`src-tauri/target/release/bundle/dmg/`, `…/bundle/macos/CULL.app`); soften the "build on the target platform" caveat now that CI builds both.
- Keyboard reference: `ctrl` = `⌘` on macOS.
- Document the release flow (push `v*` tag → draft release) and the RFC 7396 caveat from Step 1.

## macOS edge cases — audited, with verdicts

| # | Area | Verdict |
|---|---|---|
| 1 | **Unicode NFD/NFC** in Danish folder names | The one real fix — see Step 7. Test with a `København`-named folder. |
| 2 | **Retina thumbnails** | Grid thumbs come from the CR3's fixed 160×120 THMB (`bundle.rs:88-92`); no `devicePixelRatio` handling anywhere. On 2x displays they render softer — *not a regression* (Windows at 150% scaling has the same issue). Verify visually; optional later improvement: derive grid thumbs from the 1620×1080 PRVW when cellSize × DPR exceeds the THMB. |
| 3 | **Trackpad pinch** | WebKit maps pinch to ctrl+wheel, but the app has **zero wheel handlers** (verified by grep) — no misfires possible. Film strip is keyboard-driven (pre-existing; trackpad-swipe scroll is a possible future enhancement, out of scope). |
| 4 | **Press-and-hold** | macOS shows the accent popup instead of auto-repeating held letters. Safe: hold interactions use space/arrows via keydown/keyup + the app's own rAF pacing loop (`App.tsx:2140-2170`); letter keys (F/U/P/T/O…) are single-press. **Constraint: never design a feature needing held-letter auto-repeat.** |
| 5 | **Native fullscreen** | Green button enters fullscreen (own Space); traffic lights auto-hide, leaving the 84px left padding empty — acceptable, or tighten via `:fullscreen` CSS. Verify item. |
| 6 | **Filesystem case** | APFS defaults case-insensitive like NTFS; extension checks already use `eq_ignore_ascii_case` (`scan.rs:172`), writes are lowercase `.xmp` (`xmp.rs:77`). Same behavior as today; note-only. |
| 7 | **External volumes** | `/Volumes/...` paths verified fine (`file_ops.rs:154-162`; std `Path` throughout; no drive-letter/UNC assumptions). |
| 8 | **Clipboard in text inputs** | Works via Tauri's default menu Edit roles — protected by the "don't touch the menu" rule in Step 6. |
| 9 | **Linux / mobile** | Deliberately excluded and **compile-blocked** (Step 8). Do not add Linux/mobile handling, `#[cfg(target_os = "linux")]` branches, or Linux CI runners in any future work. |

## Phasing

1. **Platform layer:** Steps 1–5 + 7 (config, platform.ts, controls, CSS, labels, NFC normalization). Testable immediately in `pnpm tauri dev` on the Mac.
2. **Quit semantics:** Step 6 (Cmd+Q re-route) + runtime verification.
3. **Safeguard, release automation + docs:** Steps 8–10, then a `v0.1.1-rc1` tag to prove the pipeline.

## Verification

1. `pnpm install && pnpm test`; `cargo test --manifest-path src-tauri/Cargo.toml` (CR3 fixture tests skip without `sample_cr3s/` — expected, same in CI).
2. `pnpm tauri dev` manual pass:
   - Traffic lights at top-left, centered in the 36px bar; hover shows −/＋/×; brand block not overlapped; lone gear top-right opens Settings (focus returns to it on close).
   - Window drag from the top bar (`data-tauri-drag-region`, `App.tsx:2764,2780,3424`); double-click bar zooms; green button fullscreen → check the padded gap; exit fullscreen → traffic lights still positioned correctly (tao quirk check).
   - Open CR3 folders via the **multi-select picker** (⌘-click two folders in the native open panel — one named with ø/å/æ), via multi-folder drag-drop, and via a combined recents row: the session produces ONE combined recents entry across methods (no NFD/NFC fork in `recentKey`), clicking it reopens the full set, ratings restore from sidecars, thumbs cached. Esc on the staged screen returns home leaving no recents trace.
   - Rate frames → `.xmp` sidecars written; Cmd+Z / Cmd+⇧Z / Cmd+E / Cmd+, / Cmd+O; ⌘-click add-to-selection, ⇧-click range in grid.
   - Hold Tab → help overlay shows ⌘-based labels; Cmd+V pastes into the FinishDialog subfolder input.
   - **Close-guard:** rate then immediately click the red button → "saving…" then auto-close. Repeat with **Cmd+Q** (validates Step 6).
   - WKWebView smoke (vs WebView2): virtualized grid momentum scroll with fractional scrollTop, blob-URL previews, loupe zoom/pan, first SD-card/NAS access shows the macOS permission prompt once.
   - Retina pass: grid thumb sharpness, loupe, 1:1 zoom on a 2x display.
3. `pnpm tauri build` → launch `src-tauri/target/release/bundle/macos/CULL.app`; quick repeat pass; mount the `.dmg`. Confirm no Linux bundle dirs appear under `bundle/`.
4. Safeguard proof (optional, ~1 min): `rustup target add x86_64-unknown-linux-gnu && cargo check --manifest-path src-tauri/Cargo.toml --target x86_64-unknown-linux-gnu` → must fail immediately with "CULL supports Windows and macOS only."
5. Push `v0.1.1-rc1` → draft release contains both `.exe` and `.dmg`; download the dmg on the Mac and confirm the documented right-click → Open flow works.

## Critical files

- **New:** `src-tauri/tauri.macos.conf.json`; `src/utils/platform.ts`; `.github/workflows/release.yml`.
- `src-tauri/src/lib.rs` — builder tail (:54-55) → Cmd+Q re-route; compile-time platform guard at the very top (Step 8).
- `src-tauri/tauri.conf.json` — `bundle.targets`: `"all"` → `["nsis", "msi", "app", "dmg"]` (Step 8). Nothing else changes in the base config.
- `src/components/WindowControls.tsx` — hide minimize/close on mac (:29-50), tooltip (:18).
- `src/App.tsx` — labels (:2804, :2820, :2906, :3384, :3632); NFC at the `openFoldersByPaths` chokepoint (:527) — covers picker, drag-drop, recents clicks, auto-open; close-guard context (:1516-1605, no changes — verify only).
- `src/App.css` — `.cull-statusbar--top` mac padding (:63-70 context); `.cull-wincontrols` (:138+, unchanged).
- `src/components/HelpOverlay.tsx` (:17-19, :120), `src/components/SettingsDialog.tsx` (:214), `src/main.tsx` (dataset.platform), `src/components/FinishDialog.tsx` (:175-192, NFC on the export pick).
- `src/hooks/useRecents.ts` (:36 `recentKey`, :48-51 `mergeRecent`) — benefits from NFC entry-point normalization (no direct change needed).
- `README.md` — run/build/distribution sections.

## Risks / open questions

- **`trafficLightPosition` quirks:** some tao versions reset the custom position after fullscreen/appearance changes. Fallback: drop the key, accept default inset (a few px high in a 36px bar).
- **`ExitRequested { code }` semantics** must be runtime-verified against the resolved Tauri 2.x patch version. Both failure modes are benign and visible in testing.
- **WKWebView vs WebView2 rendering:** no known blockers (no wheel handlers, blob URLs are standard), but the smoke pass above is deliberate — fractional scroll values and image scaling quality during zoom are the places differences would show.
- **CI cost:** macOS runners consume Actions minutes at 10× on private repos; public repos are free.
- **Out of scope (decided):** code signing/notarization, auto-updater, universal/Intel binary, trackpad-swipe film-strip scrolling, Retina-sharp thumbnail upgrade — all are clean later additions and none block daily personal use. **Linux and mobile are not "later additions": they are deliberately compile-blocked (Step 8) and must stay that way.**
