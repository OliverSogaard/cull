# CULL

Keyboard-fast culling for Canon CR3 RAW photos.

Open a folder of CR3s, judge each frame by keyboard, and your picks/rejects
save into LrC-compatible XMP sidecars — so the verdicts round-trip into
Lightroom Classic. Three views share one keyboard vocabulary:

- **LOUPE** — one image at a time
- **COMPARE** — champion vs challenger, side by side
- **GRID** — contact sheet

CULL never touches your CR3 files. The only thing it writes is a
`{basename}.xmp` sidecar next to each image.

**Supported platforms: Windows (x64) and macOS (Apple Silicon).** Linux and
mobile are intentionally unsupported and blocked at compile time.

## Running CULL

### Windows

If you have a built `CULL.exe` (Windows), double-click it.

The first launch may show a SmartScreen warning ("Windows protected your PC")
because CULL isn't code-signed. Click **More info → Run anyway**. This is a
one-time thing per machine.

If WebView2 isn't already installed (it ships with Windows 10 21H2+ and all
Windows 11), the installer will fetch it the first time. After that, CULL
launches normally.

### macOS

Download the `.dmg` from the GitHub Releases page (Apple Silicon only), or
build locally. Drag the app out of the DMG into `/Applications` before first
run (avoids App Translocation).

A downloaded DMG is unsigned and un-notarized, so the first launch needs
**right-click → Open** (or System Settings → Privacy & Security → "Open
Anyway", or `xattr -d com.apple.quarantine /Applications/CULL.app`). Locally
built apps carry no quarantine attribute and launch directly.

Expect one-time macOS permission prompts on first access to
Desktop/Documents/Downloads, SD cards (removable volumes), and NAS (network
volumes) — normal TCC behavior, no action needed.

## Building from source

You'll need:

- **Node 20+** and **pnpm 9+** (`npm i -g pnpm`)
- **Rust stable** (`rustup toolchain install stable`)
- A Tauri-supported toolchain. Windows: Visual Studio Build Tools with the
  Desktop C++ workload. macOS: Xcode Command Line Tools. See
  [tauri.app/start/prerequisites](https://tauri.app/start/prerequisites).
  (Linux is compile-blocked — builds fail by design.)

Then:

```bash
pnpm install        # JS deps + Rust crates fetched on first build
pnpm tauri dev      # dev mode with hot reload
pnpm tauri build    # release binary in src-tauri/target/release/bundle/
```

The first Rust build takes ~15 minutes. Incremental builds are fast.

## Sharing the built app

After `pnpm tauri build`, the installers live at:

```
src-tauri/target/release/bundle/nsis/CULL_0.1.0_x64-setup.exe   (Windows)
src-tauri/target/release/bundle/dmg/CULL_0.1.0_aarch64.dmg      (macOS)
src-tauri/target/release/bundle/macos/CULL.app                  (macOS, raw app)
```

The Windows `.exe` is self-contained — it bundles the WebView2 bootstrapper,
so a fresh PC without WebView2 will still install cleanly. Hand it to anyone
on Windows 10/11 (x64) and they can install and run it.

Caveats:

- Neither installer is code-signed: SmartScreen warns on Windows, and macOS
  needs the right-click → Open dance (see "Running CULL" above).
- Windows on ARM and Intel Macs are not supported by these builds.
- A local `pnpm tauri build` produces only the current platform's installer;
  CI (below) builds both from one tag.

## Releases

Push a `v*` tag and GitHub Actions builds both installers into a draft
release:

```bash
git tag v0.1.1 && git push origin v0.1.1
```

The workflow (`.github/workflows/release.yml`) runs `tauri build` on
`windows-latest` (NSIS `.exe`) and `macos-latest` (aarch64 `.app` + `.dmg`),
then attaches both to a draft GitHub release named after the tag. Review and
publish the draft manually.

Config note: `src-tauri/tauri.macos.conf.json` overrides the window config on
macOS via JSON Merge Patch (RFC 7396) — **arrays are replaced wholesale**, so
any future edit to `app.windows[0]` in `tauri.conf.json` must be mirrored
there.

## Test

```bash
pnpm test                                          # frontend (Vitest)
cargo test --manifest-path src-tauri/Cargo.toml    # backend
```

The XMP tests validate against real Lightroom Classic 15.3 sidecars in
`sample_cr3s/sample_LrCFlaggedCR3s/`. CR3-parser tests are env-var-gated
against the real CR3 fixtures in `sample_cr3s/` and only run when those
files are present.

## Keyboard reference

Hold **Tab** at any time inside the cull view for a context-aware reference.
On macOS, `ctrl` means `⌘` throughout (every shortcut accepts either).
Cheat sheet:

| Key | Loupe | Compare | Grid |
| --- | ----- | ------- | ---- |
| `enter`    | keep                | challenger wins      | keep selected      |
| `backspace`| reject              | reject challenger    | reject selected    |
| `f`        | favorite            | —                    | favorite           |
| `u`        | unrate              | —                    | unrate             |
| `← →`      | prev / next (hold to scrub) | pick challenger (hold) | prev / next (hold to traverse) |
| `↑ ↓`      | —                   | —                    | row up / down      |
| `space`    | 1:1 zoom (hold)     | 1:1 zoom (hold)      | —                  |
| `shift+space` | 2:1 zoom         | 2:1 zoom             | —                  |
| `l` `c` `g` | switch view (current view's key is a no-op) | | |
| `esc`      | back, or home confirm if no history | | |
| `i`        | exif + histogram    | exif + histogram     | —                  |
| `h`        | clipping overlay    | clipping overlay     | —                  |
| `p`        | focus peaking       | focus peaking        | —                  |
| `o`        | rule of thirds      | rule of thirds       | —                  |
| `t`        | toggle thumb strip  | toggle candidate strip | —                |
| `1 – 4`    | filter (all / unrated / keeps / ★) | — | filter           |
| `ctrl+z` / `ctrl+shift+z` | undo / redo | undo / redo | undo / redo |
| `ctrl+e`   | finish actions (move rejects / copy keeps) | same | same |
| `ctrl+,`   | settings (also from the home screen) | same | same |

## Rating model

Three states plus the absence of any rating. The pick/good flags (and any star)
are Lightroom-Classic-compatible so verdicts survive a Lightroom round-trip; the
`cull:fav` marker is CULL's own private-namespace attribute that Lightroom
ignores:

| State      | XMP                                                  |
| ---------- | ---------------------------------------------------- |
| reject     | `xmpDM:pick="-1"`, `xmpDM:good="false"`              |
| keep       | `xmpDM:pick="1"`,  `xmpDM:good="true"`               |
| favorite   | `xmpDM:pick="1"`,  `xmpDM:good="true"`, `cull:fav` (+ a courtesy `xmp:Rating="1"` only when the frame had no user star) |
| (unrated)  | no pick attribute                                    |

User stars 2–5 (LrC's edit-pass ratings) are never touched by CULL. A favorite on
a starless frame gets a courtesy 1★ (`cull:fav="star"`, removed on demote); a
favorite on a frame that already carries a user 1–5★ rides that star
(`cull:fav="flag"`) and never overwrites it — so a user's 3★ keep stays a 3★
favorite round-trip.

## Settings

Open with **Ctrl+,** or the gear icon on the home screen.

- **Storage mode** (`local` / `network`) — switches a performance profile
  with different concurrency, prefetch, and cache window numbers. Default
  `local`; flip to `network` if you're culling from a NAS / SMB share.
- **When you start a cull** — default filter, default overlays (info,
  clipping, peaking, thirds), default thumbnail strip.
- **File operations** — name of the rejected-subfolder created by
  "move rejects", default destination for "copy keeps" (ask each time or
  use a pinned folder).
- **On launch** — re-open the last folder automatically.

## Project layout

```
cull/
├── src/                      # React + TS frontend
│   ├── App.tsx               # orchestration + state machinery
│   ├── App.css
│   ├── main.tsx
│   ├── components/           # presentational components
│   ├── utils/                # pure helpers (format, filter, path, snap)
│   └── types/                # shared TS types
├── src-tauri/
│   ├── src/
│   │   ├── lib.rs            # Tauri command wiring
│   │   ├── cr3.rs            # pure-Rust CR3 parser
│   │   ├── bundle.rs         # read_bundle + extract_thumbnail
│   │   ├── scan.rs           # scan_folder + analyze_folder
│   │   ├── xmp.rs            # XMP sidecar I/O
│   │   ├── file_ops.rs       # move / copy after the cull
│   │   └── meta.rs           # ImageMetadata shared with the UI
│   └── Cargo.toml
└── sample_cr3s/              # real-CR3 fixtures for env-var-gated tests
```

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the design notes behind the
read pipeline, XMP scheme, and site navigation.
