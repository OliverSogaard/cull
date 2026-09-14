# CULL — Silent Failure Hunt

Scope: `C:\Users\OSA\Developer\cull` (Tauri 2, React 19 + TS frontend in `src/`,
Rust backend in `src-tauri/src/`). Read-only review; nothing in the repo was
modified.

## Summary verdict

CULL's core save path (rating to `.xmp` sidecar) is unusually disciplined:
atomic temp+rename writes, a per-path serial write queue, a capped-exponential
retry schedule, a `failedWrites` set that blocks quit and shows an unsaved
indicator, and generation-guarded async completions everywhere in the image
pipeline. This is genuinely above-average engineering against silent failure,
and it should be the template for anything new.

The real gaps are at the seams the invariants don't cover: what happens to
in-memory app state after a file-moving action (move rejects / trash), what
happens when a directory listing or a settings/recents write fails, and how
failures in the advisory smart-culling and full-res zoom paths are (not)
surfaced. The single most important finding (#1 below) is that "move rejects"
and "move to trash" do not update the in-memory images list or guard the
rating-write path against a since-moved file, so a rating action on a
stale entry silently writes a real `.xmp` to a location whose CR3 no longer
exists there, and the write reports success the whole time.

No CRITICAL finding here is "CULL corrupts or deletes your CR3s" -- the
core invariant (CR3s are read-only, sidecars are atomic) holds up under
review. The findings are about wrong/stale state and unreported partial
failures around the edges of that solid core.

## Good patterns already present (copy these)

- `src-tauri/src/xmp.rs` -- `atomic_write_xmp` (temp write + `sync_all` +
  rename, temp cleaned up on rename failure), a process-wide temp-name
  sequence so overlapping writes never interleave, and an extensive
  round-trip test suite including real Lightroom Classic sample sidecars.
  This is the reference pattern for "a write either lands whole or not at
  all."
- `src/app/useRatingPersistence.ts` + `src/app/useQuitGuard.ts` -- a
  per-path serial write queue (`writeQueue: Map<path, Promise>`) so an undo
  immediately after a rate can't race the original write; a capped retry
  schedule (400/1500/4000ms); a `failedWrites` map that is exact per-path
  (a superseded older write can't resurrect a phantom failure -- see the
  `isLatest()` guard); and a quit guard that reads live refs (not lagged
  state) so a close request can never slip through a commit-lag window. This
  is the strongest "durability + honest failure surfacing" pattern in the
  codebase.
- `src-tauri/src/file_ops.rs` -- `FileOpResult` carries both a capped
  `errors` list (bounded IPC payload) AND an uncapped `error_count`, so a
  500-file batch with 300 failures can never read as "only 20 failed." Errors
  never abort the batch (skip-vs-error is explicit, idempotent re-runs treat
  "already moved" as a skip, not an error).
- `src/components/FinishDialog.tsx` (`FileOpResultLine`) and
  `src/App.tsx` (`doMoveRejects`) -- per-source-folder error isolation: one
  unreachable folder in a multi-folder session doesn't abort moves for the
  reachable ones, and the true error count (not just the capped list) is
  preserved through the merge.
- `src-tauri/src/tier_cache.rs` -- the on-disk cache treats every
  corruption class (truncated entry, torn write, stale version byte, wrong
  tier byte) identically: refuse, drop from the index, delete the dead file,
  and silently regenerate from source. This is the correct place to fail
  silently -- it's a cache, the source of truth is untouched, and the
  self-healing behavior is covered by dedicated tests
  (`refuses_corrupt_and_foreign_format_entries`,
  `stale_version_byte_is_refused_and_dropped`).
- `src-tauri/src/io_gate.rs` + `src-tauri/src/bundle.rs` (`gated`) --
  blocking reads that can't be cancelled on Windows/macOS are detached with a
  `dlog!` when the orphan eventually returns (the "stuck-permit detector"),
  so a hung NAS read degrades gracefully instead of stalling the UI, and a
  leak is at least diagnosable in a debug build.
- `src/image/tierErrors.ts` + `src/app/useFolderTrouble.ts` +
  `src/image/folderRetry.ts` -- the NAS-unreachable state machine
  (latched -> checking -> recovered|still) is a genuinely good example of
  "never let a retry button silently do nothing": every click walks through a
  visible state, and a concurrent re-latch can't be clobbered by a stale
  timer.
- `src/hooks/useSettings.ts` (`coerceSettings`) -- untrusted
  localStorage JSON is validated field-by-field with typed fallbacks
  instead of trusting the parsed blob, so a corrupt or hand-edited settings
  key degrades to defaults instead of crashing the image store at mount.

## Findings by severity

### CRITICAL

**#1 -- Finish actions do not update in-memory state; re-rating a moved file writes a real, orphaned sidecar and reports success**

Files: `src/App.tsx` (`doMoveRejects` L677-731, `doCopyKeeps` L739-772,
`rejectedPaths` L483-486, `FinishDialog` wiring L2149-2168),
`src/utils/filter.ts` (L9-28), `src-tauri/src/xmp.rs`
(`write_xmp_rating_sync` L84-109, `clear_xmp_rating_sync` L133-170).

After "Move rejects" (to `_rejected/` or Trash) or "Copy keeps" completes,
`onClose` just does `setActionsOpen(false)` -- nothing prunes, marks, or even
re-scans the `images` array. The `"all"` filter (`passesFilter` in
`filter.ts`) always returns `true` regardless of rating, so a moved/trashed
frame stays fully visible and navigable in Grid/Loupe under its original
path.

`write_xmp_rating_sync` / `clear_xmp_rating_sync` never check that the CR3
still exists at that path -- they only look at the derived `.xmp` path. If the
user keeps working the session after a "move rejects" pass (a very normal
workflow: declutter already-decided rejects mid-cull, keep rating the rest)
and then touches a rating on one of the moved frames -- via a keypress on a
stale grid cell, or via Ctrl+Z / Ctrl+Shift+Z replaying an undo/redo entry
whose path is now stale -- write_xmp_rating / clear_xmp_rating happily
create/rewrite a NEW sidecar in the ORIGINAL folder next to nothing (the CR3
already moved, taking its old sidecar with it per file_ops.rs's "sidecar
follows the CR3" behavior). The write succeeds. useRatingPersistence reports
it as saved. The user believes the rating landed. It never reached the photo
that actually exists (now sitting in `_rejected/` or the Trash); it created
an orphaned, CR3-less `.xmp` that CULL itself will never surface again
(subsequent scan_folder only lists `.CR3` files).

User experience: rate/re-rate/undo a frame shortly after "move rejects" ->
no error, no warning, "saved" -- but the change never reaches the real file.

Fix: after a successful move/copy/trash, remove (or mark
unavailable/moved) the affected entries from `images` so they can't be
re-rated; and/or have write_xmp_rating/clear_xmp_rating verify the CR3
still exists at `path` before writing, returning a distinguishable error
("source file no longer exists") instead of silently authoring a sidecar.

### HIGH

**#2 -- Sidecar move/copy/trash failures are invisible even in the batch result**

File: `src-tauri/src/file_ops.rs` (`batch_files` L100-116, `trash_batch`
L171-197).

```
if !dest_xmp.exists() {
    let _ = op_one(&src_xmp, &dest_xmp, &op);   // batch_files, L112
}
...
let _ = trash_op(&src_xmp);                      // trash_batch, L184
```

The CR3's own move/copy/trash is fully tracked (completed/errors/
error_count), but the sidecar ride-along is `let _ = ...` -- not even
counted. If the CR3 moves but the sidecar's move fails (permission on that
one file, a lock held by another process, a NAS blip mid-batch), the batch
reports 100% success. The result: a keeper exported without its rating
sidecar (Lightroom import shows no flag), or a rejected CR3 moved to
`_rejected/` while its rating sidecar is orphaned back in the source folder.

Fix: fold the sidecar op's Result into the same errors/error_count
accounting as the CR3 op (a distinct message like "{path}.xmp: {e}" is
enough -- no need to fail the whole entry).

**#3 -- A single unreadable parent directory silently makes every file in it read back as "unrated" and unordered**

File: `src-tauri/src/scan.rs` (`analyze_folder_sync`, L243-246).

```rust
for dir in parents {
    let Ok(entries) = std::fs::read_dir(dir) else {
        continue;                              // L244 -- silently skips the whole folder
    };
    ...
}
```

If read_dir fails for one parent folder in a multi-folder session
(permission hiccup, NAS timeout, share momentarily unmounted), none of that
folder's files get an mtime or get flagged as having an .xmp -- so
order_by_capture sinks them to the very end (missing-time group), and the
restore loop (to_read, gated on xmp_stems) never even attempts to read
their sidecars, so every file in that folder comes back UNRATED even if
it was fully culled in a previous session. There is no error, no partial-
failure indicator -- analyze_folder returns Ok(...) regardless.

Compounding this: `src-tauri/src/xmp.rs::read_ratings` (L187-193) collapses
every error kind -- not just NotFound -- to (None, None), so a genuine
permission/IO error on an individual sidecar read is indistinguishable from
"never rated."

User experience: reopen a previously-culled multi-folder session during a
transient NAS blip -> one folder's worth of frames looks completely unrated
and jumps to the back of the sort order, with no indication anything failed.
Not data loss (the sidecars are untouched on disk), but a convincing false
signal that could cause the user to re-cull already-decided frames.

Fix: track per-directory read failures and surface them (a warning banner,
similar to ScanFailureCard) instead of silently treating them as "no
files here"; consider distinguishing NotFound from other I/O errors in
read_ratings.

**#4 -- Full-res "zoom" tier read failures are never shown to the user, in an app whose entire purpose is judging sharpness**

Files: `src/image/stage.ts` (`resolveStage`, L50-71),
`src/image/imageStore.ts` (`fetchZoomInto` catch block, L1265-1278).

resolveStage only promotes `s.full?.status === "error"` (the 1620px NAV
preview tier) into Resolved.error; s.zoomFull's "error" status is never
inspected there, so it never reaches the UI at all. fetchZoomInto's catch
records the failure into zoomErrors purely for internal backoff/cooldown
bookkeeping (inCooldown, noteTierError) -- there is no user-visible signal
that the 32MP zoom failed to load. The presenter's documented fallback chain
("mid -> preview always renders") means the frame just keeps showing the
lower-resolution preview forever, indistinguishable from "you haven't zoomed
in yet."

User experience: settle on/zoom into a frame on a flaky NAS; the zoom read
times out or errors; the loupe keeps showing the soft 1620px preview with no
error chip, no retry affordance, nothing distinguishing it from a frame that
simply hasn't finished loading. A user judging critical sharpness could
keep a soft frame or reject a sharp one never having actually seen full
resolution -- the one thing this app exists to let them do.

Fix: surface zoomFull errors distinctly (even a subtle icon on the
loupe, "full-res failed to load -- tap to retry") rather than folding
silently into the preview fallback.

### MEDIUM

**#5 -- localStorage write failures for settings and recents are swallowed with zero user-facing indicator**

Files: `src/hooks/useSettings.ts` (persist effect, L102-113),
`src/hooks/useRecents.ts` (persist effect L169-180, migration write
L155-161).

```ts
try {
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
} catch {
  // Quota / private mode -- already living in memory, so no further action.
}
```

This is a deliberate, documented tradeoff ("the cull still works, the choice
just won't persist") -- but there is genuinely no user-facing signal anywhere
that a setting (rejected-subfolder name, pinned export folder, smart-culling
toggles) or a recents/session entry stopped persisting. Every subsequent
change looks like it "took" in the running session and then silently reverts
on relaunch. Low likelihood (needs quota exhaustion or private-mode-like
localStorage), but the failure mode is genuinely invisible.

Fix: on a caught write failure, set a one-time in-memory flag and show a
small non-blocking toast ("settings aren't saving -- storage is full or
blocked") rather than a bare comment.

**#6 -- An unrelated localStorage write failure is misreported as a folder-scan failure**

File: `src/app/useSessionLifecycle.ts` (`openFoldersByPaths`, L236-280,
specifically `localStorage.setItem("cull:lastDir", folderPath)` at L249).

The cull:lastDir bookkeeping write sits inside the SAME per-folder
try/catch as the actual scan_folder invoke. If localStorage.setItem
throws (quota/private mode) right after a perfectly successful scan, the
catch at L271 treats it exactly like a failed scan: the folder is pushed
into `failures` with the localStorage exception's message, and -- because
the throw happens before the images are appended (L251-269) -- the folder's
CR3s are never staged, even though the scan itself succeeded.

User experience: on a machine with exhausted/blocked localStorage, every
folder-open attempt reports a confusing "scan failed: QuotaExceededError..."
for folders that scan perfectly fine, and no images ever load.

Fix: move the cull:lastDir write outside the scan's try/catch (or wrap it
in its own try, swallowed independently) so a bookkeeping failure can never
masquerade as a scan failure.

**#7 -- Smart-culling chunk failures are diagnostic-gated behind a hidden dev flag**

Files: `src/smart/analysisDriver.ts` (`runAnalysis`, L56-72),
`src/smart/useSmartCulling.ts` (`onChunkFailed`, L97-104).

By design (advisory-only, never writes anything -- acceptable per the
invariant), a chunk that fails twice is skipped with onChunkFailed, whose
only consumer logs to console.debug AND ONLY IF
`localStorage.getItem("cull:devhud") === "1"`. In a normal build, if scoring
keeps failing for a run of frames (corrupted embedded preview, ONNX runtime
hiccup, NAS timeout mid-analysis), the user sees zero suggestions for those
frames with no indication why, and no way to tell "still computing" from
"gave up" apart from the progress bar completing with gaps.

Fix: no data is at risk here, but consider a lightweight always-on signal
(e.g. "N frames could not be scored" in the Smart tab's empty-state copy)
rather than a hidden-flag-only diagnostic.

**#8 -- openFoldersByPaths has no outer catch; two callers fire it without one either**

File: `src/app/useSessionLifecycle.ts` (L234-339 outer try{...}finally{...},
no catch), `src/app/useDragAndDrop.ts` (L64,
`void openFoldersByPathsRef.current(dropped)`), and the mount auto-open
effect (`useSessionLifecycle.ts` L396-398, `void openFoldersByPaths(...)`).

Everything inside the per-folder loop is defensively caught, but a handful of
statements outside it (state setters, commitSessionRecent) are not. If any
of those ever throws, the returned promise rejects with nothing downstream
to observe it -- an unhandled promise rejection, silent in production. Low
likelihood given the statements involved, but worth a top-level .catch for
defense in depth given two call sites already use void.

### LOW

**#9 -- read_ratings folds every I/O error into "no rating," not just NotFound**

File: `src-tauri/src/xmp.rs` (L187-193). Already covered as a contributing
factor to Finding #3, but worth calling out on its own: even outside the
directory-listing failure mode, a per-file permission error or transient
read failure on an individual sidecar reads back identically to "this frame
was never rated." Diagnostic-only impact on its own; compounds with #3.

**#10 -- dlog diagnostics are correctly gated but mean release builds have zero trace of most of the "best-effort" fallbacks above**

Files: `src-tauri/src/lib.rs` (dlog! macro, L31-46), `src/utils/dlog.ts`.

Intentional and reasonable for a desktop app (no telemetry, no log
shipping), but worth naming explicitly: nearly every "best effort, quietly
regenerates/skips" comment in this codebase (tier_cache.rs, file_ops.rs
sidecar ride-along, midSweep.ts) has NO trace at all in a release build
unless the user manually flips a hidden flag first. That is an acceptable
tradeoff given the invariants that actually matter (ratings) are mostly NOT
in this bucket -- but it means Findings #2, #3, and #7 are entirely
unobservable after the fact if a user reports "some of my ratings or
exports seem off."

## Top 10 prioritized fixes

1. (Finding #1, CRITICAL) Prune/mark `images` entries after a successful
   move/copy/trash, and/or make write_xmp_rating/clear_xmp_rating verify
   the CR3 still exists before writing -- this is the one path where a user
   can believe a rating saved when it silently orphaned itself.
2. (Finding #2, HIGH) Fold sidecar move/copy/trash failures into
   FileOpResult.errors/error_count in file_ops.rs instead of `let _ =`.
3. (Finding #4, HIGH) Surface zoom-tier (full-res) read failures in the
   loupe/compare UI -- this directly touches the app's core judgment task.
4. (Finding #3, HIGH) Treat a failed read_dir in analyze_folder_sync
   as a reportable partial failure, not a silent zero-file folder; consider
   splitting NotFound from other errors in read_ratings.
5. (Finding #6, MEDIUM) Move the cull:lastDir bookkeeping write outside
   the scan's error-classification try/catch in openFoldersByPaths.
6. (Finding #5, MEDIUM) Add a one-time, non-blocking "settings/recents
   aren't saving" indicator when the localStorage write path throws.
7. (Finding #7, MEDIUM) Give smart-culling chunk failures a small
   always-on surface (e.g. "N frames couldn't be scored") instead of
   hidden-flag-only logging.
8. (Finding #8, MEDIUM) Add a defensive outer .catch around
   openFoldersByPaths's two fire-and-forget call sites.
9. (Finding #9, LOW) Distinguish NotFound from other I/O error kinds in
   xmp::read_ratings so a permission/transient error does not read as
   "unrated."
10. Keep doing what useRatingPersistence.ts/useQuitGuard.ts/xmp.rs
    already do -- when extending file_ops or the analyze path, copy their
    "count everything, cap only the display, never let success and failure
    look the same" discipline rather than inventing a new pattern.
