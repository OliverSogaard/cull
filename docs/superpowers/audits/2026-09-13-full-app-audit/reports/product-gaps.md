# CULL: Product Gap Analysis (fresh-eyes review, 2026-09-14)

Read-only review of `C:\Users\OSA\Developer\cull` (README, ARCHITECTURE, UX buildlist, settings/finish/keymap code, cr3.rs, scan.rs, xmp.rs, recents) against the 2026 culling market.

## Summary

CULL is a genuinely fast, genuinely safe, free, local culling tool for exactly one file type. Its architecture (one ~2 MiB head read per file, embedded-preview navigation, exact-range zoom tier, on-disk tier cache, NAS profile, advisory-only on-device ML) is Photo Mechanic-class speed with Aftershoot-class signals at zero cost, and its XMP discipline (never overwrites LrC stars, OS Trash only) is better than most paid tools. Three things keep it from being a product a stranger would install: it opens nothing but CR3, the installers are unsigned with no updater or crash reporting, and the verdict vocabulary (keep/reject/favorite) is narrower than the stars-and-labels grammar every competitor and every editor speaks. Four cheap misses would bite a working photographer on day one: no rejects review pass before the move, files sorted by path rather than capture time (wrong on two bodies), no video awareness, and no color labels or stars.

## Feature matrix

Prices are US list as of Sept 2026 from vendor pages where fetched, otherwise from secondary sources (flagged in Sources). "Speed" = vendor's own claim.

| Dimension | CULL | Photo Mechanic 6/Plus | FastRawViewer 2 | Narrative Select | Aftershoot | Imagen Culling | FilterPixel | Lightroom Classic 15 | Capture One |
|---|---|---|---|---|---|---|---|---|---|
| Formats | CR3 only | ~all raws via embedded previews, JPEG, video | ~800 cameras, true raw decode | major raws + JPEG | major raws + JPEG | major raws + JPEG | major raws + JPEG | all Adobe-supported raws, video | all C1-supported raws |
| Speed model | embedded preview, single head read; no import | embedded preview, no import; "fastest browser" | raw decode, GPU; near-instant | AI pass first, then instant browse | AI pass first (local) | cloud upload + AI | AI pass first | import + preview build (embedded/sidecar option) | import; "instant browsing" in Cull view |
| Rating model | keep / reject / favorite (+ courtesy 1 star; reads LrC 1-5) | stars, color classes, tag, flags; IPTC | stars, labels, flags, XMP | keep/reject + stars, colors on ship | stars, colors, flags on export | stars/colors on export | stars/colors/flags | flags, 1-5 stars, 5 color labels | stars, color tags |
| AI culling | local: sharpness/exposure/bursts/pHash + YuNet faces, eyes-open, DINOv2 dupes, CLIP aesthetic; advisory only | none | none | focus, eyes, close-ups panel, scenes | auto-select with sliders, dupes, blinks, sharpness | cloud AI (accuracy disputed) | DeepCull (self-reported 98.5%) | Assisted Culling: focus score, eyes, auto-stack (v15) | face-focus check, similar grouping |
| Integrations | XMP sidecars (LrC-compatible), copy keeps, move/trash rejects | ingest, rename, IPTC, catalog (Plus), GPS | XMP, rename, multi-window | Ship to Lightroom (plugin) | LrC catalog / XMP / C1 export | LrC, C1 | LrC, C1 | native | native, tethering |
| Multi-folder / resume | yes / yes (sidecar restore, resumes at first unrated) | yes / yes | yes / yes | project-based | project-based | project | project | catalog | catalog/session |
| Dual monitor | no (single window) | yes | yes (v2 multi-window) | no | no | no | no | yes | yes |
| Custom keys | no | yes | yes | limited | limited | no | no | partial | yes |
| Platform | Win x64, macOS arm64 | Win, Mac | Win, Mac | Mac, Win | Mac, Win | Mac, Win | Mac, Win | Mac, Win | Mac, Win |
| Pricing | free, MIT | $14.99/mo, $149/yr, $299 perpetual; Plus $24.99/$249/$399 | $23.99 one-time ($17.99 promo) | $10-60/mo annual ($15-79 monthly) | Selects $9.99/mo annual ($14.99 monthly) up to Max $59.99 | $0.05/photo, $7/mo min | $14.99/mo annual ($19.99 monthly) | Lightroom 1TB plan $14.99/mo annual, $22.49 monthly | Pro $216/yr or $28/mo; perpetual (no feature updates); +6% June 2026 |

## Obvious misses (prioritized)

P0: a photographer cannot adopt CULL without these.

1. **Formats beyond CR3.** Every competitor opens everything. Even Canon-only shooters have CR2 archives or a second body. Nothing else on this list matters until this is fixed (see Expansion 1).
2. **Signed installers, auto-update, crash reporting.** SmartScreen "More info, Run anyway" and the macOS right-click dance are where non-technical users stop. No `tauri-plugin-updater`, no Sentry/panic upload, so bugs on other people's drives and bodies are invisible. Apple Silicon only excludes 2019-2020 MacBook Pros still common among pros.
3. **Rejects review pass.** `Filter` has all / unrated / keeps / smart; there is no `rejects` filter. Every culling tool lets you look at the reject pile before you act on it; here the only way is scanning glyphs in the grid. This is a safety expectation, not a nicety, given "Move rejects" and "Trash" sit one confirm away.
4. **Capture-time sort.** `scan_folder` sorts lexicographically by path. With multi-folder sessions already supported (`multiple: true`, recents v2), two bodies at a wedding interleave wrongly and burst grouping across folders is confused. Sort by `captured_at + sub_sec_ms` with a per-folder time offset is small work and unlocks the multi-body case.

P1: expected on day one by anyone coming from PM, FRV, LrC or C1.

5. **Stars and color labels as first-class verdicts.** The app reads LrC 1-5 and writes only a courtesy 1 star. Pros cull on "1 star keep, 2 star select, red = client" grammars; CULL cannot express them and the private `cull:fav` marker is invisible in Lightroom (a favorite lands as pick + 1 star).
6. **Video awareness.** R6 III shoots MP4/CRM alongside CR3; today they are counted as "ignored". Hybrid shooters need at least placeholders that ride along on move/copy.
7. **Lightroom / Capture One handoff.** "Copy keeps" + sidecars is fine; what pros compare it to is Narrative's Ship to Lightroom (LrC plugin imports and flags) or Aftershoot's catalog export. Also missing: reveal in Explorer/Finder.
8. **Ingest.** PM's core is card to two destinations with verify and rename templates. CULL starts after ingest, so PM stays in the workflow anyway.
9. **Batch rename and copyright/IPTC stamping.** Even a creator/copyright field written into the sidecar on finish is cheap and expected.
10. **Dual monitor / second window.** Grid on one screen, loupe on the other is standard in PM, LrC, C1, FRV.
11. **Custom keymap.** Keys are hard-coded in `useCullKeymap.ts`; Enter/Backspace is opinionated. PM users have decades of muscle memory. Non-US layouts are only partially handled (`e.code` fallback on a few keys).
12. **GPS / map.** `gps_lat/lon` are parsed in `meta.rs` but never rendered; even coordinates plus an "open in Maps" link is a one-hour item.
13. **Survey (N-up) compare and a face close-ups panel.** Compare is strictly 2-up; YuNet boxes already exist but no eyes/face crop strip like Narrative's.
14. **Localization, light theme, screen-reader support.** Low priority for this audience; note only.
15. **Tethering.** Capture One's moat; deliberately out of scope, and should stay so.

## Expansion directions

1. **Format expansion (M to L overall).** Two routes. (a) Hand-rolled TIFF/IFD preview extractors, reusing the `Tiff` reader already inside `cr3.rs` for CMT boxes: CR2 (S; full-size JPEG at IFD0 strip, same Canon MakerNote AF parser), Sony ARW (S for nav tier; 1616x1080 preview at IFD0 tag 0x0201/0x0202, near-identical to PRVW), DNG (S to M; preview location and size vary by producer), Nikon NEF (M; full-size JPEG in a SubIFD, Nikon MakerNote header quirk), Fujifilm RAF (M; fixed-offset header to an embedded JPEG whose APP1 carries the EXIF). MIT-clean, matches the "no C deps" discipline, and each format ships with a corpus test like `CULL_TEST_CR3_DIR`. (b) Adopt `rawler` (pure Rust, v0.8.0, LGPL-2.1, 40-plus formats, decodes previews to `DynamicImage` rather than byte-extracting) or LibRaw bindings (`rsraw`, C++). Faster to breadth, but LGPL static linking into an MIT binary needs care and both decode rather than splice, costing the bit-for-bit preview and single-read latency. Recommendation: route (a) with a `RawReader` trait now (thumb, nav preview, full-res range hint, metadata), and `rawler` behind a feature flag only for a true 1:1 zoom on formats with no full-size embedded JPEG (ARW, most RAF). Architecture cost: the pipeline hard-codes PRVW assumptions (1620x1080 hysteresis in the mid tier, the ~2 MiB head read, moov sample-table zoom range, tier-cache header v3). Every format needs its own preview dims and a cache version bump; CR2/NEF full-size previews make the mid-tier generator mandatory rather than optional.
2. **Trust and distribution (S to M).** Apple Developer ID plus notarization, Windows signing (Azure Trusted Signing is cheap), `tauri-plugin-updater`, opt-in crash upload, Intel Mac in the CI matrix. This converts a friend-build into a product and is the only way to learn what breaks on other bodies and NASes.
3. **Verdict grammar (M).** Stars 1-5 and color labels as first-class ratings, keymap presets ("Photo Mechanic", "Lightroom", "CULL"), and custom bindings. Touches `Rating`, `xmp.rs`, filters, undo, and the smart verdicts; do it before other people's sidecars exist.
4. **Workflow bookends (M).** Ingest (copy to two destinations, verify, rename template) on the front; "Ship to Lightroom" via a small Lua SDK plugin that imports a manifest and applies flags on the back. With both, CULL replaces PM for a Canon shooter instead of sitting beside it.
5. **Productize the smart layer (M).** Close-ups panel from existing face boxes, chronological scene clustering, multi-body burst grouping, and a one-key "accept all reject suggestions at high confidence" that keeps the advisory invariant (the user presses the key). This is the differentiator: PM and FRV have no AI; Narrative and Aftershoot charge $10-60 a month for it.
6. **Capture-time sort and multi-body offset (S).** Prerequisite for 4 and 5.
7. **Dual monitor and N-up survey (M).** Tauri multi-window is easy; the singleton `imageStore` inside one webview is not, so a second window means either duplicated caches or an IPC-fed presenter.
8. **Video rows (M).** List MP4/MOV with poster frames via the webview's native decoder, keep/reject them, and carry them through move/copy. CRM raw video stays out of scope.

## Positioning

What CULL already does better than every competitor, honestly:

- **Time to first frame.** No import, no project, no upload, no catalog: one head read per file and the shoot is browsable. Photo Mechanic is the only peer in this class, and it costs $149 a year.
- **Free local ML with a hard advisory line.** Faces, eyes-open, DINOv2 look-alikes and a CLIP aesthetic rank run on-device for nothing; nothing is ever written by the AI. Aftershoot and Narrative sell that per month; Imagen sends photos to the cloud.
- **XMP safety.** Never overwrites LrC stars, disambiguates its own 1 star, atomic writes, OS Trash only, compound undo. Better than several paid tools.
- **NAS honesty.** A network profile with admission control and bounded lanes; most competitors assume local SSD.
- **Keyboard craft.** Hold-to-scrub, hold-space zoom, rate-while-zoomed, champion/challenger compare, hold-Tab help.

Where it is not better: it opens one format, has a narrower rating grammar than everyone, no ingest, no handoff, no second window, and no public speed benchmark against PM.

Ideal user today: a Canon-only, high-volume, keyboard-centric shooter (sports, events, wildlife, weddings on two R bodies) who culls from card or NAS before importing keepers into Lightroom Classic, wants no subscription and no cloud, and tolerates an unsigned build. That is a real but small niche, and it is Oliver's exact profile.

## Risks

1. **CR3 is baked into the invariants.** "One head read", PRVW dimensions, the moov-derived zoom range and the tier-cache format are Canon specifics presented as architecture. Expansion needs a reader abstraction and graceful degradation when a format has no 32 MP embedded JPEG (zoom becomes upscaled preview or requires a raw decoder).
2. **Three-state rating end to end.** `Rating` is a closed union through TS, XMP writer, filters, undo and smart verdicts; adding stars and labels later means migrating real users' sidecars. `cull:fav` being invisible to Lightroom also means the favorite tier does not travel.
3. **Single-window singleton store and a 23k-line frontend with `App.tsx` as composition root.** Dual monitor and any second view are architecturally expensive.
4. **Validated on one body.** The parser and corpus tests come from an R6 III. Older CR3 bodies, C-RAW, dual-pixel RAW and HDR PQ CR3s (which may embed HEIF rather than JPEG previews) need verification; the "no PRVW" error path exists but has no real-world coverage. Without crash reporting this stays unknown.
5. **DNG semantics conflict with "never touch the raw."** Lightroom writes DNG metadata into the file and does not read sidecars for DNG, so DNG support either breaks the invariant or breaks the LrC handoff. Decide before promising DNG.
6. **Advisory-only closes a market.** Aftershoot and FilterPixel win on auto-cull with sliders; keep the invariant but make bulk acceptance one keystroke, or the feature reads as timid.
7. **ML supply chain.** `ort` pinned to an rc, 220 MB of models pulled from a GitHub release at build time, DirectML/CoreML variance across GPUs: a support surface with no telemetry.
8. **Windows x64 plus Apple Silicon only.** Excludes Intel Macs and Windows on ARM; both are CI-matrix changes, not code.

## Sources

- Photo Mechanic pricing (vendor): https://home.camerabits.com/get-photomechanic/
- FastRawViewer purchase and v2 features (vendor): https://www.fastrawviewer.com/purchase , https://www.fastrawviewer.com/blog/FastRawViewer-2-0-Release
- Narrative Select pricing (vendor): https://narrative.so/pricing
- Aftershoot pricing (vendor): https://account.aftershoot.com/pricing , https://aftershoot.com/blog/aftershoot-pricing-tiers/
- Imagen and FilterPixel pricing and accuracy claims (competitor-authored, treat as biased): https://filterpixel.com/imagen-ai-pricing , https://filterpixel.com/ai-photo-culling-software , https://imagen-ai.com/valuable-tips/best-filterpixel-alternatives-competitors/
- Lightroom Classic Assisted Culling (Adobe): https://helpx.adobe.com/lightroom-classic/help/assisted-culling.html
- Lightroom 1TB plan pricing (Adobe FAQ): https://helpx.adobe.com/lightroom-cc/kb/lightroom-1tb-plan-faq.html
- Capture One pricing change FAQ and June 2026 increase: https://support.captureone.com/hc/en-us/articles/36166555555485-Changes-to-Our-Pricing-FAQ , https://petapixel.com/2026/05/27/capture-one-to-increase-all-product-prices-by-6/
- Rust raw crates: https://docs.rs/rawler (v0.8.0, LGPL-2.1), https://github.com/pedrocr/rawloader , https://crates.io/crates/raw_preview_rs , https://lib.rs/crates/rsraw (LibRaw bindings)
- Repo files read: README.md, ARCHITECTURE.md, docs/superpowers/plans/2026-07-06-ux-buildlist.md, src/types/settings.ts, src/types/rating.ts, src/components/FinishDialog.tsx, src/app/useCullKeymap.ts, src/hooks/useRecents.ts, src-tauri/Cargo.toml, src-tauri/src/{cr3,scan,meta,xmp}.rs, src-tauri/tauri.conf.json

Note: rawler's per-format list and preview API (`RawDecoder::full_image`, `thumbnail_image`) are from prior knowledge; the docs.rs and README fetches did not enumerate them. Verify before committing to route (b).
