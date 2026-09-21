//! XMP sidecar I/O for CULL ratings.
//!
//! CULL writes Lightroom-Classic-compatible flags + a star, verified against
//! real LrC 15.3 sidecars (`sample_cr3s/sample_LrCFlaggedCR3s`):
//!
//! ```text
//!   reject   → xmpDM:pick="-1"  xmpDM:good="false"  + cull:fav="no"
//!   keep     → xmpDM:pick="1"   xmpDM:good="true"   + cull:fav="no"
//!   favorite → xmpDM:pick="1"   xmpDM:good="true"   + cull:fav="star"|"flag"
//! ```
//!
//! The pick flag means "survived the cull". EVERY rating CULL writes carries a
//! CULL-private `cull:fav` marker (see `CULL_NS` below): "star" = CULL added a
//! courtesy 1★ to a frame with no user rating; "flag" = the favorite rides the
//! user's existing 1–5★ and `xmp:Rating` is left untouched; "no" = explicitly
//! not a favorite. The marker disambiguates CULL's favorite stamp from a user's
//! Lightroom star (they used to collide at `xmp:Rating="1"`), and "no" is what
//! stops a keep on a genuine user 1★ reading back as a favorite. A sidecar with
//! NO marker at all is the only one the legacy "pick + lone 1★ = favorite"
//! fallback may still claim. Stars 2–5 are the user's LrC edit-pass ratings and
//! are NEVER touched by CULL. The pick/good flags ride in the xmpDM (Dynamic Media)
//! namespace exactly as LrC writes them, so picks / rejects / favorites
//! round-trip into Lightroom and back.
//!
//! ## Invariant
//!
//! Only the `{basename}.xmp` sidecar is ever written — the CR3 itself is never
//! modified. All writes go through [`atomic_write_xmp`] (temp + rename), so a
//! crash mid-write can't leave a half-file on disk.

use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

/// xmpDM namespace URI — the one LrC writes pick/good flags into.
const XMPDM_NS: &str = "http://ns.adobe.com/xmp/1.0/DynamicMedia/";

/// CULL's private namespace. Holds the favorite marker `cull:fav` so CULL can
/// always tell its own favorite stamp from a user's Lightroom star rating —
/// the two used to collide at `xmp:Rating="1"`, which silently destroyed user
/// stars. LrC and other tools preserve unknown namespaces, so this is inert to
/// everything except CULL.
const CULL_NS: &str = "http://ns.cull.photo/1.0/";

/// The core xmp namespace URI — `xmp:Rating` and `xmp:Label` live here.
const XMP_NS: &str = "http://ns.adobe.com/xap/1.0/";

/// Process-wide unique sequence for atomic-write temp files, shared by every
/// sidecar writer (write + clear) so two overlapping operations on the same
/// sidecar — e.g. a fast re-rate, or an unrate racing a prior write — can never
/// share a temp name and interleave into one corrupt temp. Each writes its own
/// temp; the last rename wins with a valid file.
static XMP_TMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// Atomic sidecar write: write a temp sibling, then rename over the target.
/// Survives a crash/power-loss mid-write.
fn atomic_write_xmp(xmp_path: &Path, contents: &str) -> Result<(), String> {
    use std::io::Write;
    let seq = XMP_TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp_path = xmp_path.with_extension(format!("xmp.{seq}.tmp"));
    // Write + flush + fsync the temp so its bytes are durable on disk BEFORE the
    // rename — the rename can then never publish a half-written file. (We don't
    // fsync the parent dir: opening a directory handle for fsync isn't portable on
    // the Windows/NTFS target, and NTFS journals the rename's metadata. Over
    // SMB/NFS full rename durability also depends on the server committing it.)
    {
        let mut f = std::fs::File::create(&tmp_path).map_err(|e| format!("create tmp xmp: {e}"))?;
        f.write_all(contents.as_bytes())
            .map_err(|e| format!("write tmp xmp: {e}"))?;
        f.sync_all().map_err(|e| format!("sync tmp xmp: {e}"))?;
    }
    std::fs::rename(&tmp_path, xmp_path).map_err(|e| {
        // Don't leave the temp sibling behind if the rename failed.
        let _ = std::fs::remove_file(&tmp_path);
        format!("rename xmp: {e}")
    })?;
    Ok(())
}

/// Refusal prefix for a sidecar write whose CR3 is no longer at its path. The
/// frontend matches on it (`utils/writeFailure.ts`) to skip its retry
/// schedule: nothing short of putting the photo back can make the write land.
pub(crate) const MISSING_SOURCE: &str = "source missing";

/// A sidecar is only ever written next to a CR3 that is actually there.
///
/// After "Move rejects" the frontend prunes the moved frames, but a stale
/// cell, an undo replay or a file deleted outside CULL could still ask — and
/// used to get a real, orphaned `.xmp` in the old folder plus a "saved"
/// report (audit 2026-09-13, CRITICAL). A transient stat failure (NAS blip) is
/// reported as such so the frontend's normal retry schedule still applies.
fn require_source(cr3: &Path) -> Result<(), String> {
    match std::fs::metadata(cr3) {
        Ok(md) if md.is_file() => Ok(()),
        Ok(_) => Err(format!("{MISSING_SOURCE}: {} is not a file", cr3.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            Err(format!("{MISSING_SOURCE}: {}", cr3.display()))
        }
        Err(e) => Err(format!("stat source {}: {e}", cr3.display())),
    }
}

/// Set a rating on the CR3's sidecar (creating the sidecar if absent).
#[tauri::command]
pub(crate) async fn write_xmp_rating(path: String, rating: String) -> Result<(), String> {
    // Spawn-blocking: the read-modify-atomic-write below is sync fs I/O
    // (including an fsync, possibly over SMB) and must not stall the async
    // runtime — same pattern as the file_ops commands.
    tauri::async_runtime::spawn_blocking(move || write_xmp_rating_sync(&path, &rating))
        .await
        .map_err(|e| format!("write_xmp_rating task failed: {e}"))?
}

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

/// Unrate: clear CULL's rating fields from the sidecar.
///
/// "u" in the UI. Removes CULL's pick flag (+ its good twin) and the favorite
/// 1★ so the frame reads back as UNRATED — while leaving any user 2–5★ rating
/// intact.
///
/// If CULL authored the sidecar purely to hold a rating (no other user data),
/// the whole file is removed so unrating leaves no litter on the NAS. If the
/// sidecar carries anything else (Lightroom edits, keywords, a label, …) only
/// CULL's own fields are stripped and everything else is preserved.
///
/// INVARIANT: only the `{basename}.xmp` sidecar is touched — the CR3 is never
/// modified.
///
/// No sidecar → already unrated → `Ok(())` even if the photo is gone; a
/// sidecar that exists is only touched when the CR3 is present (ownership
/// cannot be verified without the photo).
#[tauri::command]
pub(crate) async fn clear_xmp_rating(path: String) -> Result<(), String> {
    // Spawn-blocking for the same reason as write_xmp_rating: sync fs I/O
    // (read + possible fsync'd rewrite or remove) off the async runtime.
    tauri::async_runtime::spawn_blocking(move || clear_xmp_rating_sync(&path))
        .await
        .map_err(|e| format!("clear_xmp_rating task failed: {e}"))?
}

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

fn clear_xmp_rating_sync(path: &str) -> Result<(), String> {
    let cr3 = Path::new(path);
    let xmp_path = cr3.with_extension("xmp");

    let existing = match std::fs::read_to_string(&xmp_path) {
        Ok(s) => s,
        // No sidecar → already unrated. Nothing to do — even if the CR3 is
        // also gone, this is a no-op, not a refusal.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("read existing xmp: {e}")),
    };
    // A sidecar exists — only touch it once the CR3 is confirmed present:
    // ownership of an orphaned sidecar can't be verified without the photo.
    require_source(cr3)?;

    // created_by_cull, NOT authored_by_cull: a bare `xmlns:cull` declaration
    // means CULL wrote an attribute into someone else's file, which is never
    // a licence to delete it.
    let authored = created_by_cull(&existing);
    let stripped = strip_cull_fields(&existing);

    if authored && !xmp_has_user_content(&stripped) {
        match std::fs::remove_file(&xmp_path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("remove xmp: {e}")),
        }
        dlog!(
            "[cull] clear_xmp_rating({}): removed sidecar",
            xmp_path.display()
        );
        return Ok(());
    }

    // Nothing of CULL's to strip (e.g. already unrated but the sidecar holds user
    // data) → no write. Only pay the temp+fsync+rename when bytes actually change.
    if stripped != existing {
        atomic_write_xmp(&xmp_path, &stripped)?;
        dlog!(
            "[cull] clear_xmp_rating({}): stripped rating",
            xmp_path.display()
        );
    }
    Ok(())
}

/// Everything one sidecar read yields. A struct rather than a tuple because
/// there are now three values and their types no longer tell them apart.
/// `Debug` so `Result::unwrap_err` on a failed read still prints in tests.
#[derive(Debug)]
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

/// Read a sidecar ONCE and derive CULL's pick rating, the user's LrC star
/// rating and the colour label from the same in-memory string.
///
/// The analyze restore pass needs all of them per file; reading the sidecar
/// twice (one open for the pick rating, another for the star) doubled the open
/// count on exactly the high-latency NAS path the whole design optimises around
/// ("one open per file" — see ARCHITECTURE.md). Every value comes from the same
/// bytes, so a single read serves them all.
///
/// The pick value follows the LrC-compatible flag scheme — `xmpDM:pick > 0` →
/// keep (favorite when `cull:fav` says so, or, with no marker at all, when the
/// star is exactly 1), `pick < 0` → reject, `pick == 0` → deliberately
/// unflagged. Fallback (no pick attr present): older CULL sidecars that stored
/// only `xmp:Rating` with a Cull CreatorTool (keep→0, reject→-1, favorite→5),
/// so existing culls still resume after the format change. The star value is
/// the raw `xmp:Rating` (1–5), or `None`. The colour label rides the same bytes
/// ([`parse_label`]), so the analyze pass still opens each sidecar exactly once.
///
/// Absent sidecar → an all-`None` [`SidecarRead`] (unrated). Any other read
/// failure is an `Err` the analyze pass counts and reports — a sidecar that IS
/// there but can't be read must not silently become "no rating".
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

/// The user's Lightroom Classic 1–5★ star rating from a sidecar string.
///
/// Returns `Some(n)` for `n ∈ 1..=5` and `None` for absent / zero / unparseable
/// — and `None` when the star is CULL's OWN favorite stamp
/// ([`cull_owned_fav_star`]): the courtesy 1★ is a flag, not a user rating.
/// Ownership is decided HERE, at the read boundary, because the frontend keys
/// its badges on the CURRENT rating — which changes on demote while the loaded
/// star value doesn't, leaving a phantom "LrC 1★" (the live bug this fixes).
/// A flag-mode favorite's user star (any 1–5★, `cull:fav="flag"`) still reads
/// back in full. Reached only through [`read_ratings`]'s bulk analyze pass —
/// the per-navigation sidecar read was removed from the nav path (one NAS
/// round-trip saved per nav).
fn parse_lrc_rating(content: &str) -> Option<u8> {
    if cull_owned_fav_star(content) {
        return None;
    }
    let n = parse_xmp_rating(content)?;
    if (1..=5).contains(&n) {
        Some(n as u8)
    } else {
        None
    }
}

// ── XMP string transforms ─────────────────────────────────────────────────
// Everything below is pure on a `&str` so the test suite can exercise it
// without touching the filesystem.

/// Apply a rating to a sidecar string, preserving everything else.
///
/// Favorite handling never confuses CULL's mark with a user star (see [`CULL_NS`]):
///   - favorite on a frame with no user star → write the courtesy 1★ +
///     `cull:fav="star"` (CULL owns the star; safe to remove on demote).
///   - favorite on a frame that already has a user 1–5★ → leave the star
///     untouched and mark `cull:fav="flag"` (favorite rides the user's star).
///   - keep/reject → record `cull:fav="no"` (an EXPLICIT not-a-favorite), and
///     remove the 1★ only when CULL owned it.
fn apply_rating_to_xmp(xmp: &str, rating: &str) -> Result<String, String> {
    let (pick, good) = match rating {
        "keep" => ("1", "true"),
        "reject" => ("-1", "false"),
        "favorite" => ("1", "true"),
        other => return Err(format!("unknown rating: {other}")),
    };
    let mut out = ensure_xmpdm_ns(xmp);
    out = set_desc_attr(&out, "xmpDM:pick", pick);
    out = set_desc_attr(&out, "xmpDM:good", good);

    if rating == "favorite" {
        out = ensure_cull_ns(&out);
        let star = parse_xmp_rating(&out);
        let cull_owns_star = cull_fav_value(&out).as_deref() == Some("star");
        if star.is_none() || star == Some(0) || cull_owns_star {
            // No pre-existing user star (or CULL already owns it): (re)write the
            // courtesy 1★ and record that CULL authored it.
            out = set_rating(&out, 1);
            out = set_desc_attr(&out, "cull:fav", "star");
        } else {
            // A real user star (1–5) is present — NEVER overwrite it. Favorite
            // is flag-only; the user's star stays as their rating.
            out = set_desc_attr(&out, "cull:fav", "flag");
        }
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
    Ok(out)
}

/// True when the sidecar's `xmp:Rating="1"` was authored by CULL as a favorite
/// stamp (and is therefore safe to remove on demote/unrate). Either the explicit
/// `cull:fav="star"` marker, or a legacy CULL-authored favorite that predates
/// the marker (CULL CreatorTool + a lone 1★). A user's star — including a
/// genuine 1★ from Lightroom — returns false and is never touched.
fn cull_owned_fav_star(xmp: &str) -> bool {
    match cull_fav_value(xmp).as_deref() {
        Some("star") => true,
        Some(_) => false, // "flag": the star is the user's
        // The pre-marker arm gates on [`created_by_cull`], not
        // `authored_by_cull`: a pre-marker CULL sidecar always carried the tool
        // stamp, whereas a bare `xmlns:cull` declaration is what a rating write
        // leaves in SOMEONE ELSE's file — and an unrate strips the marker but
        // not the declaration, so trusting it would let the next write delete a
        // genuine Lightroom 1★ as if it were CULL's own courtesy stamp.
        //
        // It also requires a POSITIVE `xmpDM:pick`, because a courtesy star was
        // only ever written alongside one: the pre-marker favorite was
        // `pick="1"` + a lone 1★, and the older Rating-only scheme spelled a
        // favorite `5`, never `1`. Without that clause a 1★ the user sets
        // THROUGH CULL — a CULL-created sidecar, no marker, no verdict — would
        // be read as CULL's own stamp: hidden from the UI, and deleted by the
        // next rating write. Stars are a Phase 5A feature; CULL is an author of
        // 1★s now, so ownership can no longer be inferred from the value alone.
        None => {
            created_by_cull(xmp)
                && parse_xmp_rating(xmp) == Some(1)
                && matches!(parse_attr_i32(xmp, "xmpDM:pick"), Some(p) if p > 0)
        }
    }
}

/// Pure core of unrate: strip CULL's pick/good flags + favorite marker from a
/// sidecar string, removing the visible 1★ only when CULL owned it. A user's
/// 2–5★ (and a genuine 1★) is preserved.
fn strip_cull_fields(existing: &str) -> String {
    let cull_owns_star = cull_owned_fav_star(existing);
    let s = remove_desc_attr(existing, "xmpDM:pick");
    let s = remove_desc_attr(&s, "xmpDM:good");
    let s = remove_desc_attr(&s, "cull:fav");
    if cull_owns_star {
        remove_fav_star(&s)
    } else {
        s
    }
}

/// Ensure the xmpDM namespace is declared on `rdf:Description`. LrC sidecars
/// and a fresh CULL one already have it; this covers a third-party sidecar
/// that doesn't.
fn ensure_xmpdm_ns(xmp: &str) -> String {
    if xmp.contains("xmlns:xmpDM=") {
        return xmp.to_string();
    }
    insert_after_about(xmp, &format!("\n    xmlns:xmpDM=\"{XMPDM_NS}\""))
}

/// Ensure CULL's private namespace is declared on `rdf:Description` before we
/// write a `cull:fav` attribute into it.
fn ensure_cull_ns(xmp: &str) -> String {
    if xmp.contains("xmlns:cull=") {
        return xmp.to_string();
    }
    insert_after_about(xmp, &format!("\n    xmlns:cull=\"{CULL_NS}\""))
}

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

/// Read CULL's private favorite marker: `Some("star")` (CULL also wrote the
/// visible 1★, safe to strip on demote), `Some("flag")` (favorite rides on a
/// user star we must never touch), or `None` (not a marker-tagged favorite).
fn cull_fav_value(xmp: &str) -> Option<String> {
    let needle = "cull:fav=\"";
    let s = xmp.find(needle)? + needle.len();
    let rel = xmp[s..].find('"')?;
    Some(xmp[s..s + rel].to_string())
}

/// True when CULL CREATED this sidecar, as opposed to merely annotating one
/// that was already on disk. Only the tool stamps [`fresh_xmp`] writes count.
///
/// Split out of [`authored_by_cull`] when every rating started carrying a
/// `cull:fav` marker: writing that marker calls [`ensure_cull_ns`], so even a
/// plain keep now adds `xmlns:cull` to a third-party sidecar — and the unrate
/// delete gate, which used `authored_by_cull`, would then have REMOVED a file
/// CULL did not write. (Favoriting has always declared the namespace, so the
/// hole predates this change; it just got wider.) "CULL touched this" is the
/// right question for classification; "CULL made this" is the only one that may
/// authorise a delete — of the file, or of a star inside it.
fn created_by_cull(xmp: &str) -> bool {
    // Two marker generations: pre-rebrand sidecars say "Cull 1.0", current
    // ones say "CULL" (the contains check is case-sensitive).
    xmp.contains("CreatorTool=\"Cull")
        || xmp.contains("x:xmptk=\"Cull")
        || xmp.contains("CreatorTool=\"CULL")
        || xmp.contains("x:xmptk=\"CULL")
}

/// True when CULL authored this sidecar (vs an LrC/third-party sidecar CULL only
/// annotated). Tighter than a bare "Cull" substring so a stray
/// keyword/path/person-name can't trip it. Destructive paths use the stricter
/// [`created_by_cull`] instead.
fn authored_by_cull(xmp: &str) -> bool {
    created_by_cull(xmp) || xmp.contains("xmlns:cull=")
}

/// Set (replace or insert) an `rdf:Description` attribute, preserving LrC's
/// one-attribute-per-line layout. Insertion goes right after `rdf:about=""`.
fn set_desc_attr(xmp: &str, attr: &str, value: &str) -> String {
    let needle = format!("{attr}=\"");
    if let Some(start) = xmp.find(&needle) {
        let inner = start + needle.len();
        if let Some(rel) = xmp[inner..].find('"') {
            let end = inner + rel;
            return format!("{}{}{}", &xmp[..inner], value, &xmp[end..]);
        }
    }
    insert_after_about(xmp, &format!("\n   {attr}=\"{value}\""))
}

/// Remove an `rdf:Description` attribute, eating the leading whitespace +
/// newline before it so no dangling blank line is left. No-op if absent.
fn remove_desc_attr(xmp: &str, attr: &str) -> String {
    let needle = format!("{attr}=\"");
    let Some(open) = xmp.find(&needle) else {
        return xmp.to_string();
    };
    let inner = open + needle.len();
    let Some(rel) = xmp[inner..].find('"') else {
        return xmp.to_string();
    };
    let end = inner + rel + 1;
    let b = xmp.as_bytes();
    let mut start = open;
    while start > 0 && (b[start - 1] == b' ' || b[start - 1] == b'\t') {
        start -= 1;
    }
    if start > 0 && b[start - 1] == b'\n' {
        start -= 1;
        if start > 0 && b[start - 1] == b'\r' {
            start -= 1;
        }
    }
    let mut out = xmp.to_string();
    out.replace_range(start..end, "");
    out
}

/// Insert a string right after the `rdf:about="…"` attribute — the one anchor
/// present in every `rdf:Description`. Handles both the empty form LrC/CULL write
/// (`rdf:about=""`) and a non-empty form (`rdf:about="uuid:…"`) that some tools
/// emit; matching only the empty literal used to make every attribute write
/// silently no-op on those sidecars. XML attribute order is irrelevant, so
/// inserting here is safe.
fn insert_after_about(xmp: &str, ins: &str) -> String {
    let needle = "rdf:about=\"";
    if let Some(pos) = xmp.find(needle) {
        let inner = pos + needle.len();
        if let Some(rel) = xmp[inner..].find('"') {
            let at = inner + rel + 1; // just past the closing quote
            return format!("{}{}{}", &xmp[..at], ins, &xmp[at..]);
        }
    }
    xmp.to_string()
}

/// Set `xmp:Rating` to `n` (replacing an existing element form if present,
/// else as an attribute matching LrC's style).
fn set_rating(xmp: &str, n: i32) -> String {
    if let Some(start) = xmp.find("<xmp:Rating>") {
        let inner = start + "<xmp:Rating>".len();
        if let Some(rel) = xmp[inner..].find("</xmp:Rating>") {
            let end = inner + rel;
            return format!("{}{}{}", &xmp[..inner], n, &xmp[end..]);
        }
    }
    set_desc_attr(xmp, "xmp:Rating", &n.to_string())
}

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
///   - 1–5 on a favorite → write the star, flip the marker to "flag" (the
///     favorite now rides the user's star);
///   - clear on a favorite → the courtesy 1★ comes back, marker "star";
///   - 1–5 otherwise → write the star, touch no marker;
///   - clear otherwise → remove `xmp:Rating` entirely. Lightroom's own `0`
///     means "remove rating", and the user asked.
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

/// Remove `xmp:Rating` ONLY when it's the 1★ CULL writes for favorites — a
/// user's 2–5★ LrC rating is left untouched.
fn remove_fav_star(xmp: &str) -> String {
    if parse_xmp_rating(xmp) == Some(1) {
        remove_property(xmp, "xmp:Rating")
    } else {
        xmp.to_string()
    }
}

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

/// True if the sidecar carries user/edit data we must never delete. CULL's own
/// sidecar only writes `xmp:Rating` / `xmp:CreatorTool` / `xmp:ModifyDate`,
/// none of which match these markers, so a pure CULL sidecar reports false →
/// safe to remove.
fn xmp_has_user_content(xmp: &str) -> bool {
    const MARKERS: [&str; 9] = [
        "xmp:Label",
        "dc:",
        "lr:",
        "crs:",
        "photoshop:",
        "tiff:",
        "exif:",
        "aux:",
        "xmpMM:",
    ];
    if MARKERS.iter().any(|m| xmp.contains(m)) {
        return true;
    }
    // A surviving 1–5★ is the user's edit-pass rating — never delete a sidecar
    // that still carries one, even if nothing else marks it as user data. (CULL's
    // own favorite star is already stripped before this check via strip_cull_fields.)
    matches!(parse_xmp_rating(xmp), Some(n) if (1..=5).contains(&n))
}

/// A fresh CULL sidecar skeleton (no rating yet): the xmp + xmpDM namespaces
/// and a Cull CreatorTool marker (so unrate can recognise a CULL-only sidecar
/// and delete it). [`apply_rating_to_xmp`] then inserts the pick flag / star.
fn fresh_xmp() -> String {
    let now = chrono::Local::now().to_rfc3339();
    format!(
        "<?xpacket begin=\"\u{feff}\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>\n\
<x:xmpmeta xmlns:x=\"adobe:ns:meta/\" x:xmptk=\"CULL\">\n\
 <rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">\n\
  <rdf:Description rdf:about=\"\"\n\
    xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\"\n\
    xmlns:xmpDM=\"{XMPDM_NS}\"\n\
   xmp:CreatorTool=\"CULL\"\n\
   xmp:ModifyDate=\"{now}\">\n\
  </rdf:Description>\n\
 </rdf:RDF>\n\
</x:xmpmeta>\n\
<?xpacket end=\"w\"?>"
    )
}

/// Classify a sidecar string into a CULL rating (or `None` for unrated).
fn classify_xmp(content: &str) -> Option<String> {
    let star = parse_xmp_rating(content);
    match parse_attr_i32(content, "xmpDM:pick") {
        Some(p) if p < 0 => return Some("reject".to_string()),
        Some(p) if p > 0 => {
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
            return Some(if fav { "favorite" } else { "keep" }.to_string());
        }
        Some(_) => return None, // pick == 0 → explicitly unflagged
        None => {}
    }
    // Backward-compat with the pre-flag CULL scheme. Gate on the SAME tight marker
    // the destructive paths use (not a bare "Cull" substring) so a third-party
    // sidecar that merely mentions "Cull" (a surname, place, keyword) plus a real
    // user 5★ isn't misread as a CULL favorite.
    if authored_by_cull(content) {
        return match star {
            Some(-1) => Some("reject".to_string()),
            Some(5) => Some("favorite".to_string()),
            Some(0) => Some("keep".to_string()),
            _ => None,
        };
    }
    None
}

/// Read `xmp:Rating` (element OR attribute form) as an integer.
fn parse_xmp_rating(xmp: &str) -> Option<i32> {
    if let Some(s) = xmp.find("<xmp:Rating>") {
        let inner = s + "<xmp:Rating>".len();
        if let Some(e) = xmp[inner..].find("</xmp:Rating>") {
            return xmp[inner..inner + e].trim().parse().ok();
        }
    }
    parse_attr_i32(xmp, "xmp:Rating")
}

/// Read an integer-valued `rdf:Description` attribute (`attr="N"`).
fn parse_attr_i32(xmp: &str, attr: &str) -> Option<i32> {
    let needle = format!("{attr}=\"");
    let s = xmp.find(&needle)? + needle.len();
    let rel = xmp[s..].find('"')?;
    xmp[s..s + rel].trim().parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every state, written onto a fresh sidecar, reads back as itself.
    #[test]
    fn fresh_states_round_trip() {
        for rating in ["keep", "reject", "favorite"] {
            let xmp = apply_rating_to_xmp(&fresh_xmp(), rating).unwrap();
            assert_eq!(
                classify_xmp(&xmp).as_deref(),
                Some(rating),
                "round-trip {rating}"
            );
        }
    }

    /// The bytes match what LrC writes (pick flag in xmpDM; favorite gets 1★).
    #[test]
    fn flag_encoding_matches_lrc() {
        let keep = apply_rating_to_xmp(&fresh_xmp(), "keep").unwrap();
        assert!(keep.contains("xmpDM:pick=\"1\"") && keep.contains("xmpDM:good=\"true\""));
        assert!(!keep.contains("xmp:Rating"), "keep carries no star");

        let reject = apply_rating_to_xmp(&fresh_xmp(), "reject").unwrap();
        assert!(reject.contains("xmpDM:pick=\"-1\"") && reject.contains("xmpDM:good=\"false\""));

        let fav = apply_rating_to_xmp(&fresh_xmp(), "favorite").unwrap();
        assert!(fav.contains("xmpDM:pick=\"1\"") && fav.contains("xmp:Rating=\"1\""));
    }

    /// Demoting favorite→keep drops only CULL's 1★; a user's 2–5★ survives.
    #[test]
    fn favorite_demote_and_user_star_preservation() {
        let fav = apply_rating_to_xmp(&fresh_xmp(), "favorite").unwrap();
        let keep = apply_rating_to_xmp(&fav, "keep").unwrap();
        assert_eq!(parse_xmp_rating(&keep), None, "1★ removed on demote");
        assert_eq!(classify_xmp(&keep).as_deref(), Some("keep"));

        let three = set_rating(&fresh_xmp(), 3);
        let kept = apply_rating_to_xmp(&three, "keep").unwrap();
        assert_eq!(parse_xmp_rating(&kept), Some(3), "user 3★ preserved");
        assert_eq!(
            classify_xmp(&kept).as_deref(),
            Some("keep"),
            "flag+3★ is keep, not favorite"
        );
    }

    /// Re-rating a real-looking LrC sidecar preserves its edits and namespace.
    #[test]
    fn preserves_lrc_content_on_rerate() {
        let lrc = "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\">\n <rdf:RDF>\n  <rdf:Description rdf:about=\"\"\n    xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\"\n    xmlns:xmpDM=\"http://ns.adobe.com/xmp/1.0/DynamicMedia/\"\n    xmlns:crs=\"http://ns.adobe.com/camera-raw-settings/1.0/\"\n   xmpDM:pick=\"0\"\n   crs:Contrast2012=\"25\">\n  </rdf:Description>\n </rdf:RDF>\n</x:xmpmeta>";
        let out = apply_rating_to_xmp(lrc, "reject").unwrap();
        assert!(
            out.contains("crs:Contrast2012=\"25\""),
            "user edits preserved"
        );
        assert_eq!(parse_attr_i32(&out, "xmpDM:pick"), Some(-1));
        assert_eq!(classify_xmp(&out).as_deref(), Some("reject"));
    }

    #[test]
    fn unflagged_is_unrated() {
        assert_eq!(classify_xmp("xmpDM:pick=\"0\"").as_deref(), None);
        assert_eq!(classify_xmp("no markers here").as_deref(), None);
    }

    /// Older CULL sidecars (Rating-only + Cull marker) still resume. The marker
    /// must be CULL's own (x:xmptk / CreatorTool / xmlns:cull) — a bare "Cull"
    /// substring no longer qualifies (see classify_xmp's authored_by_cull gate).
    #[test]
    fn backward_compat_old_scheme() {
        assert_eq!(
            classify_xmp("x:xmptk=\"Cull 1.0\" <xmp:Rating>5</xmp:Rating>").as_deref(),
            Some("favorite")
        );
        assert_eq!(
            classify_xmp("x:xmptk=\"Cull 1.0\" xmp:Rating=\"0\"").as_deref(),
            Some("keep")
        );
        assert_eq!(
            classify_xmp("x:xmptk=\"Cull 1.0\" <xmp:Rating>-1</xmp:Rating>").as_deref(),
            Some("reject")
        );
        // A stranger's sidecar that merely mentions "Cull" + a genuine 5★ is NOT
        // misclassified as a CULL favorite.
        assert_eq!(
            classify_xmp("photographer: Cullen <xmp:Rating>5</xmp:Rating>"),
            None
        );
    }

    /// The rebrand writes `CreatorTool="CULL"`; sidecars from earlier versions
    /// say `"Cull 1.0"`. Both generations must stay recognisable or unrate
    /// stops cleaning up the older ones.
    #[test]
    fn authored_by_cull_matches_old_and_new_creator_tool() {
        assert!(authored_by_cull("xmp:CreatorTool=\"Cull 1.0\""));
        assert!(authored_by_cull("x:xmptk=\"Cull 1.0\""));
        assert!(authored_by_cull("xmp:CreatorTool=\"CULL\""));
        assert!(authored_by_cull("x:xmptk=\"CULL\""));
        assert!(!authored_by_cull(
            "xmp:CreatorTool=\"Adobe Lightroom 15.3\""
        ));
        // Fresh sidecars must carry a marker the gate recognises.
        assert!(authored_by_cull(&fresh_xmp()));
    }

    /// Unrate strips CULL's fields; a fresh CULL sidecar becomes deletable.
    #[test]
    fn unrate_strips_to_deletable() {
        let fav = apply_rating_to_xmp(&fresh_xmp(), "favorite").unwrap();
        let stripped = strip_cull_fields(&fav);
        assert_eq!(classify_xmp(&stripped), None);
        assert!(
            !xmp_has_user_content(&stripped),
            "pure CULL sidecar → deletable"
        );
    }

    /// CRITICAL regression (favorite over a user star): favoriting a frame that
    /// already carries a user 1–5★ must NOT overwrite that star. The favorite is
    /// recorded flag-only via cull:fav, and the frame still reads as favorite.
    #[test]
    fn favorite_never_clobbers_a_user_star() {
        for n in [1, 2, 3, 4, 5] {
            let starred = set_rating(&fresh_xmp(), n);
            let fav = apply_rating_to_xmp(&starred, "favorite").unwrap();
            assert_eq!(
                parse_xmp_rating(&fav),
                Some(n),
                "user {n}★ preserved through favorite"
            );
            assert_eq!(
                classify_xmp(&fav).as_deref(),
                Some("favorite"),
                "still reads favorite at {n}★"
            );
            assert!(
                fav.contains("cull:fav=\"flag\""),
                "favorite is flag-only at {n}★"
            );
            // Demoting the flag-only favorite leaves the user's star intact.
            let keep = apply_rating_to_xmp(&fav, "keep").unwrap();
            assert_eq!(
                parse_xmp_rating(&keep),
                Some(n),
                "user {n}★ survives favorite→keep"
            );
            // THE Phase 5A fix (scout R3): at n == 1 this read back as
            // "favorite", because classify_xmp's legacy fallback could not
            // tell a user's 1★ from CULL's own favorite stamp.
            assert_eq!(
                classify_xmp(&keep).as_deref(),
                Some("keep"),
                "a demoted favorite on a user {n}★ is a keep, not a favorite"
            );
        }
    }

    /// CRITICAL regression (genuine user 1★): a real 1★ from Lightroom (LrC
    /// CreatorTool, no CULL marker) must survive keep / reject / unrate — CULL
    /// must not mistake it for its own favorite stamp and delete it.
    #[test]
    fn genuine_user_one_star_survives_all_paths() {
        let lrc = "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\" x:xmptk=\"Adobe XMP Core\">\n \
<rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">\n  \
<rdf:Description rdf:about=\"\"\n    xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\"\n   \
xmp:CreatorTool=\"Adobe Lightroom Classic\"\n   xmp:Rating=\"1\">\n  </rdf:Description>\n \
</rdf:RDF>\n</x:xmpmeta>";
        assert!(!authored_by_cull(lrc), "LrC sidecar is not CULL-authored");
        let keep = apply_rating_to_xmp(lrc, "keep").unwrap();
        assert_eq!(parse_xmp_rating(&keep), Some(1), "user 1★ survives keep");
        assert_eq!(
            classify_xmp(&keep).as_deref(),
            Some("keep"),
            "a KEEP on a frame carrying a genuine Lightroom 1★ must read back \
             as a keep — it used to read back as a FAVORITE (scout R3)"
        );
        let reject = apply_rating_to_xmp(lrc, "reject").unwrap();
        assert_eq!(
            parse_xmp_rating(&reject),
            Some(1),
            "user 1★ survives reject"
        );
        // Unrate (pure core): strip CULL fields, the user's 1★ stays and keeps
        // the sidecar from being deleted as litter.
        let stripped = strip_cull_fields(&keep);
        assert_eq!(
            parse_xmp_rating(&stripped),
            Some(1),
            "user 1★ survives unrate"
        );
        assert!(
            xmp_has_user_content(&stripped),
            "surviving 1★ blocks sidecar deletion"
        );
    }

    /// CULL's own favorite (courtesy 1★ + cull:fav="star") IS removable on demote
    /// — only its own stamp, never a user star.
    #[test]
    fn cull_favorite_star_removable_on_demote() {
        let fav = apply_rating_to_xmp(&fresh_xmp(), "favorite").unwrap();
        assert!(fav.contains("cull:fav=\"star\""), "CULL-owned star marker");
        assert_eq!(parse_xmp_rating(&fav), Some(1));
        let keep = apply_rating_to_xmp(&fav, "keep").unwrap();
        assert_eq!(
            parse_xmp_rating(&keep),
            None,
            "CULL's own 1★ removed on demote"
        );
        assert!(
            keep.contains("cull:fav=\"no\""),
            "a demote records an EXPLICIT not-a-favorite, so the legacy \
             `pick + lone 1star` fallback can never claim this sidecar"
        );
        assert_eq!(classify_xmp(&keep).as_deref(), Some("keep"));
    }

    /// insert_after_about handles a non-empty rdf:about (some tools emit one);
    /// the rating write must not silently no-op on those sidecars.
    #[test]
    fn writes_into_nonempty_rdf_about() {
        let xmp = "<rdf:Description rdf:about=\"uuid:abc-123\"\n    xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\">\n  </rdf:Description>";
        let out = apply_rating_to_xmp(xmp, "reject").unwrap();
        assert_eq!(
            parse_attr_i32(&out, "xmpDM:pick"),
            Some(-1),
            "rating actually landed"
        );
        assert!(
            out.contains("rdf:about=\"uuid:abc-123\""),
            "about value untouched"
        );
    }

    /// Re-applying the same rating is idempotent on the resulting bytes.
    #[test]
    fn rating_application_is_idempotent() {
        for rating in ["keep", "reject", "favorite"] {
            let once = apply_rating_to_xmp(&fresh_xmp(), rating).unwrap();
            let twice = apply_rating_to_xmp(&once, rating).unwrap();
            assert_eq!(once, twice, "re-applying {rating} should be a no-op");
        }
    }

    /// Validate against real Lightroom Classic 15.3 sidecars when present.
    #[test]
    fn classifies_real_lrc_sidecars() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../sample_cr3s/sample_LrCFlaggedCR3s");
        if !dir.exists() {
            eprintln!("[cull] skipping real-LrC test: {} absent", dir.display());
            return;
        }
        for (file, want) in [
            ("Default.xmp", None),
            ("KeepFlagged.xmp", Some("keep")),
            ("RejectFalgged.xmp", Some("reject")),
            ("Fav1Star.xmp", Some("favorite")),
        ] {
            let content = std::fs::read_to_string(dir.join(file)).unwrap();
            assert_eq!(classify_xmp(&content).as_deref(), want, "{file}");
        }
    }

    /// LrC star parse: 1–5 round-trip, 0 / negative / missing → None.
    #[test]
    fn parses_lrc_rating_from_xmp() {
        // Attribute form (LrC style).
        for n in 1..=5u8 {
            let xmp = format!("rdf:about=\"\" xmp:Rating=\"{n}\"");
            assert_eq!(parse_lrc_rating(&xmp), Some(n));
        }
        // 0 / negative / missing → None (not a user rating).
        assert_eq!(parse_lrc_rating("xmp:Rating=\"0\""), None);
        assert_eq!(parse_lrc_rating("xmp:Rating=\"-1\""), None);
        assert_eq!(parse_lrc_rating("no rating here"), None);
        // Element form (older sidecars).
        assert_eq!(parse_lrc_rating("<xmp:Rating>3</xmp:Rating>"), Some(3));
    }

    /// CULL's own favorite stamp must never read back as a user LrC rating —
    /// otherwise demoting a favorite leaves a phantom "LrC 1★" in the UI
    /// (the restore pass loaded the raw stamp before the demote cleaned it).
    #[test]
    fn cull_favorite_stamp_is_not_an_lrc_rating() {
        // CULL-stamped courtesy star → not a user rating.
        assert_eq!(
            parse_lrc_rating("xmp:Rating=\"1\" cull:fav=\"star\" xmpDM:pick=\"1\""),
            None
        );
        // Flag-mode favorite riding the user's own stars → user rating stands,
        // including a genuine user 1★.
        assert_eq!(
            parse_lrc_rating("xmp:Rating=\"3\" cull:fav=\"flag\" xmpDM:pick=\"1\""),
            Some(3)
        );
        assert_eq!(
            parse_lrc_rating("xmp:Rating=\"1\" cull:fav=\"flag\" xmpDM:pick=\"1\""),
            Some(1)
        );
        // Legacy CULL favorite (pre-marker: CULL-created + a lone 1★ + the
        // pick flag it was always written with) → stamp.
        assert_eq!(
            parse_lrc_rating("x:xmptk=\"Cull 1.0\" xmpDM:pick=\"1\" <xmp:Rating>1</xmp:Rating>"),
            None
        );
        // WITHOUT the pick flag the same bytes are a user 1★, not a stamp:
        // no CULL scheme ever wrote a courtesy star without a verdict beside
        // it (the Rating-only scheme spelled a favorite `5`), and Phase 5A
        // makes CULL an author of user 1★s. Reading this as a stamp hid the
        // star from the UI and let the next rating write delete it.
        assert_eq!(
            parse_lrc_rating("x:xmptk=\"Cull 1.0\" <xmp:Rating>1</xmp:Rating>"),
            Some(1)
        );
        // A genuine LrC 1★ with no CULL involvement is a real user rating.
        assert_eq!(
            parse_lrc_rating("x:xmptk=\"Adobe XMP Core\" xmp:Rating=\"1\""),
            Some(1)
        );
        // End-to-end: favorite a fresh frame, then read back — the stamp must
        // classify as favorite WITHOUT surfacing as an LrC star.
        let fav = apply_rating_to_xmp(&fresh_xmp(), "favorite").unwrap();
        assert_eq!(classify_xmp(&fav).as_deref(), Some("favorite"));
        assert_eq!(parse_lrc_rating(&fav), None);
    }

    /// LrC rating reads back what LrC 15.3 wrote on real sample files. CULL's
    /// favorite stamp also lands as `1` here — disambiguating CULL-fav vs
    /// pre-existing 1★ is the frontend's job (it has the CULL rating too).
    #[test]
    fn reads_lrc_rating_from_real_sidecars() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../sample_cr3s/sample_LrCFlaggedCR3s");
        if !dir.exists() {
            eprintln!(
                "[cull] skipping real-LrC star test: {} absent",
                dir.display()
            );
            return;
        }
        for (file, want) in [
            ("Default.xmp", None),
            ("KeepFlagged.xmp", None),
            ("RejectFalgged.xmp", None),
            ("Fav1Star.xmp", Some(1u8)),
        ] {
            let content = std::fs::read_to_string(dir.join(file)).unwrap();
            assert_eq!(parse_lrc_rating(&content), want, "{file}");
        }
    }

    /// The async command wrappers keep their result shape end-to-end on disk:
    /// Ok(()) on a fresh write, on the idempotent re-write (skip path), and on
    /// clear — with the sidecar appearing and disappearing accordingly. Pins
    /// the behavior across the spawn-blocking refactor.
    #[test]
    fn command_wrappers_round_trip_on_disk() {
        let work = std::env::temp_dir().join(format!("cull-xmp-cmd-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&work);
        std::fs::create_dir_all(&work).unwrap();
        let cr3 = work.join("r.cr3");
        std::fs::write(&cr3, b"cr3").unwrap();
        let p = cr3.to_string_lossy().to_string();

        let write = tauri::async_runtime::block_on(write_xmp_rating(p.clone(), "keep".into()));
        assert_eq!(write, Ok(()));
        assert_eq!(read_ratings(&p).unwrap().rating.as_deref(), Some("keep"));

        // Re-rating to the value already on disk takes the no-write skip path.
        let rewrite = tauri::async_runtime::block_on(write_xmp_rating(p.clone(), "keep".into()));
        assert_eq!(rewrite, Ok(()));

        let clear = tauri::async_runtime::block_on(clear_xmp_rating(p.clone()));
        assert_eq!(clear, Ok(()));
        assert!(
            !cr3.with_extension("xmp").exists(),
            "CULL-authored sidecar removed on unrate"
        );

        let _ = std::fs::remove_dir_all(&work);
    }

    /// An absent sidecar is "unrated", not an error; a sidecar that exists but
    /// can't be read (here: a directory wearing the name) is an error the
    /// analyze pass reports instead of folding into "no rating".
    #[test]
    fn read_ratings_distinguishes_absent_from_unreadable() {
        let work = std::env::temp_dir().join(format!("cull-xmp-read-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&work);
        std::fs::create_dir_all(&work).unwrap();
        let absent = work.join("absent.cr3");
        let r = read_ratings(&absent.to_string_lossy()).unwrap();
        assert!(r.rating.is_none() && r.star.is_none() && r.label.is_none());

        let blocked = work.join("blocked.cr3");
        std::fs::create_dir_all(blocked.with_extension("xmp")).unwrap();
        let err = read_ratings(&blocked.to_string_lossy()).unwrap_err();
        assert!(err.contains("blocked.xmp"), "{err}");
        let _ = std::fs::remove_dir_all(&work);
    }

    /// Rating a CR3 that is no longer at its path (moved by "Move rejects",
    /// deleted outside CULL) must refuse — never write an orphan sidecar into
    /// the old folder and report "saved".
    #[test]
    fn write_refuses_when_cr3_is_missing() {
        let work = std::env::temp_dir().join(format!("cull-xmp-nosrc-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&work);
        std::fs::create_dir_all(&work).unwrap();
        let cr3 = work.join("moved.cr3"); // never created

        let err = write_xmp_rating_sync(&cr3.to_string_lossy(), "keep").unwrap_err();
        assert!(err.starts_with(MISSING_SOURCE), "{err}");
        assert!(
            !cr3.with_extension("xmp").exists(),
            "no orphan sidecar written"
        );

        let _ = std::fs::remove_dir_all(&work);
    }

    /// Unrating a missing CR3 refuses too, and leaves whatever sidecar is
    /// there untouched — ownership can't be verified without the photo.
    #[test]
    fn clear_refuses_when_cr3_is_missing_and_leaves_sidecar() {
        let work = std::env::temp_dir().join(format!("cull-xmp-noclr-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&work);
        std::fs::create_dir_all(&work).unwrap();
        let cr3 = work.join("gone.cr3");
        let xmp = cr3.with_extension("xmp");
        std::fs::write(&xmp, b"<orphan/>").unwrap();

        let err = clear_xmp_rating_sync(&cr3.to_string_lossy()).unwrap_err();
        assert!(err.starts_with(MISSING_SOURCE), "{err}");
        assert_eq!(
            std::fs::read(&xmp).unwrap(),
            b"<orphan/>",
            "sidecar untouched"
        );

        let _ = std::fs::remove_dir_all(&work);
    }

    /// A frame with no sidecar is already unrated: clearing it is a no-op even
    /// when the photo itself is gone — never a permanent "unsaved" the user
    /// cannot retry out of.
    #[test]
    fn clear_is_a_no_op_when_cr3_and_sidecar_are_both_missing() {
        let work = std::env::temp_dir().join(format!("cull-xmp-noop-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&work);
        std::fs::create_dir_all(&work).unwrap();
        let cr3 = work.join("gone.cr3"); // neither the CR3 nor gone.xmp exists
        assert_eq!(clear_xmp_rating_sync(&cr3.to_string_lossy()), Ok(()));
        assert!(!cr3.with_extension("xmp").exists());
        let _ = std::fs::remove_dir_all(&work);
    }

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
            assert!(
                out.contains("xmlns:cull="),
                "{rating} declares the namespace"
            );
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
        assert!(
            after_keep.contains("xmlns:cull="),
            "the marker declared the ns"
        );
        assert!(
            !created_by_cull(&after_keep),
            "CULL did not create this file"
        );
        assert!(authored_by_cull(&after_keep), "…but it did annotate it");

        assert_eq!(clear_xmp_rating_sync(&p), Ok(()));
        assert!(xmp.exists(), "a third-party sidecar must survive an unrate");
        let after_clear = std::fs::read_to_string(&xmp).unwrap();
        assert!(
            after_clear.contains("SomeOtherTool"),
            "their data is intact"
        );
        assert_eq!(classify_xmp(&after_clear), None, "CULL's fields are gone");

        let _ = std::fs::remove_dir_all(&work);
    }

    /// A genuine Lightroom 1★ must survive keep → unrate → keep on a sidecar
    /// CULL did not create. Writing `cull:fav="no"` declares `xmlns:cull`, and
    /// an unrate strips the marker but not the declaration — leaving a
    /// third-party sidecar that `authored_by_cull` accepts and a lone 1★ that
    /// `cull_owned_fav_star` would then claim as CULL's own courtesy stamp:
    /// hidden from the UI on the read, and DELETED by the next rating write.
    /// Ownership of a star, like ownership of the file, is `created_by_cull`.
    #[test]
    fn a_user_star_survives_keep_unrate_keep_on_a_sidecar_cull_did_not_create() {
        let lrc = "<rdf:Description rdf:about=\"\"\n    xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\"\n   \
             xmp:CreatorTool=\"Adobe Lightroom Classic\"\n   xmp:Rating=\"1\">\n  </rdf:Description>";
        let keep = apply_rating_to_xmp(lrc, "keep").unwrap();
        let unrated = strip_cull_fields(&keep);
        assert!(
            unrated.contains("xmlns:cull="),
            "the ns declaration outlives the marker — that is the trap"
        );
        assert_eq!(
            parse_xmp_rating(&unrated),
            Some(1),
            "the star is still on disk"
        );
        assert_eq!(
            parse_lrc_rating(&unrated),
            Some(1),
            "and still the user's, so the UI must still show it"
        );
        let again = apply_rating_to_xmp(&unrated, "keep").unwrap();
        assert_eq!(
            parse_xmp_rating(&again),
            Some(1),
            "a second keep must never eat a star CULL did not write"
        );
    }

    // ── Stars ────────────────────────────────────────────────────────────

    /// A star round-trips in BOTH XMP forms — LrC writes the attribute form,
    /// older packets the element form, and set_rating handles both.
    #[test]
    fn a_star_round_trips_in_both_xmp_forms() {
        for n in 1..=5u8 {
            let attr = apply_star_to_xmp(&fresh_xmp(), Some(n)).unwrap();
            assert_eq!(
                parse_xmp_rating(&attr),
                Some(i32::from(n)),
                "attribute form {n}"
            );
            assert_eq!(
                parse_lrc_rating(&attr),
                Some(n),
                "reads back as a user star"
            );
        }
        let element = "<rdf:Description rdf:about=\"\" xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\">\
                       <xmp:Rating>2</xmp:Rating></rdf:Description>";
        let out = apply_star_to_xmp(element, Some(4)).unwrap();
        assert!(
            out.contains("<xmp:Rating>4</xmp:Rating>"),
            "element form replaced in place"
        );
        assert!(
            !out.contains("xmp:Rating=\""),
            "no second attribute copy was added"
        );
    }

    /// Clearing removes the property outright — Lightroom's `0` means
    /// "remove rating", not "rating zero".
    #[test]
    fn clearing_a_star_removes_the_property() {
        let three = apply_star_to_xmp(&fresh_xmp(), Some(3)).unwrap();
        let cleared = apply_star_to_xmp(&three, None).unwrap();
        assert_eq!(parse_xmp_rating(&cleared), None);
        assert!(
            !cleared.contains("xmp:Rating"),
            "no empty attribute left behind"
        );
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
        assert_eq!(
            cull_fav_value(&starred).as_deref(),
            Some("flag"),
            "the star is the user's now"
        );
        assert_eq!(
            classify_xmp(&starred).as_deref(),
            Some("favorite"),
            "still a favorite"
        );
        assert_eq!(
            parse_lrc_rating(&starred),
            Some(4),
            "and the star is visible"
        );

        let cleared = apply_star_to_xmp(&starred, None).unwrap();
        assert_eq!(
            parse_xmp_rating(&cleared),
            Some(1),
            "courtesy star restored"
        );
        assert_eq!(
            cull_fav_value(&cleared).as_deref(),
            Some("star"),
            "CULL owns it again"
        );
        assert_eq!(classify_xmp(&cleared).as_deref(), Some("favorite"));
        assert_eq!(
            parse_lrc_rating(&cleared),
            None,
            "a courtesy star is not a user star"
        );
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
            assert!(
                out.contains(&format!("xmp:Label=\"{text}\"")),
                "{key} writes {text}"
            );
            assert_eq!(parse_label(&out).as_deref(), Some(key), "{key} reads back");
        }
        let element = "<rdf:Description rdf:about=\"\" xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\">\
                       <xmp:Label>Blue</xmp:Label></rdf:Description>";
        assert_eq!(
            parse_label(element).as_deref(),
            Some("blue"),
            "element form reads"
        );
        let out = apply_label_to_xmp(element, Some("green")).unwrap();
        assert!(
            out.contains("<xmp:Label>Green</xmp:Label>"),
            "element form replaced in place"
        );
        assert!(
            !out.contains("xmp:Label=\""),
            "no second attribute copy was added"
        );
    }

    /// Case-insensitive on read (LrC has shipped both "Red" and "red"), and
    /// ANY other non-empty string is the user's own label: reported as
    /// "custom", never rewritten by a read.
    #[test]
    fn an_unknown_label_string_is_custom_and_is_preserved() {
        assert_eq!(parse_label("xmp:Label=\"RED\"").as_deref(), Some("red"));
        assert_eq!(
            parse_label("xmp:Label=\"Urgent\"").as_deref(),
            Some("custom")
        );
        assert_eq!(parse_label("xmp:Label=\"Rot\"").as_deref(), Some("custom"));
        assert_eq!(
            parse_label("xmp:Label=\"\""),
            None,
            "an empty label is no label"
        );
        assert_eq!(parse_label("no label here"), None);
        // A rating write never touches someone else's label.
        let custom = "<rdf:Description rdf:about=\"\" xmp:Label=\"Urgent\"></rdf:Description>";
        let rated = apply_rating_to_xmp(custom, "reject").unwrap();
        assert_eq!(
            parse_label(&rated).as_deref(),
            Some("custom"),
            "still theirs"
        );
        assert!(
            rated.contains("xmp:Label=\"Urgent\""),
            "byte-for-byte theirs"
        );
    }

    /// Clearing removes the property; an unknown label key is refused.
    #[test]
    fn clearing_a_label_removes_the_property_and_an_unknown_key_is_refused() {
        let red = apply_label_to_xmp(&fresh_xmp(), Some("red")).unwrap();
        let cleared = apply_label_to_xmp(&red, None).unwrap();
        assert_eq!(parse_label(&cleared), None);
        assert!(
            !cleared.contains("xmp:Label"),
            "no empty attribute left behind"
        );
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
        assert!(
            !xmp_has_user_content(&strip_cull_fields(&bare)),
            "nothing left to keep"
        );
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
        assert!(write_xmp_star_sync(&p, None)
            .unwrap_err()
            .starts_with(MISSING_SOURCE));
        assert!(write_xmp_label_sync(&p, None)
            .unwrap_err()
            .starts_with(MISSING_SOURCE));
        assert!(
            !cr3.with_extension("xmp").exists(),
            "no orphan sidecar written"
        );

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
        assert_eq!(
            read.rating, None,
            "a star is not a verdict — the frame is unrated"
        );
        assert_eq!(read.star, Some(4));
        assert_eq!(read.label.as_deref(), Some("green"));

        assert_eq!(
            tauri::async_runtime::block_on(write_xmp_star(p.clone(), None)),
            Ok(())
        );
        assert_eq!(
            tauri::async_runtime::block_on(write_xmp_label(p.clone(), None)),
            Ok(())
        );
        let cleared = read_ratings(&p).unwrap();
        assert_eq!(cleared.star, None);
        assert_eq!(cleared.label, None);

        let _ = std::fs::remove_dir_all(&work);
    }

    /// Clearing a star on a frame that has no sidecar must not CREATE one: the
    /// edit changes nothing against `fresh_xmp()`, so the unchanged-bytes skip
    /// fires and no litter lands next to the photo.
    #[test]
    fn clearing_a_star_on_a_frame_with_no_sidecar_writes_no_file() {
        let work = std::env::temp_dir().join(format!("cull-xmp-nolit-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&work);
        std::fs::create_dir_all(&work).unwrap();
        let cr3 = work.join("n.cr3");
        std::fs::write(&cr3, b"cr3").unwrap();
        let p = cr3.to_string_lossy().to_string();

        assert_eq!(write_xmp_star_sync(&p, None), Ok(()));
        assert_eq!(write_xmp_label_sync(&p, None), Ok(()));
        assert!(
            !cr3.with_extension("xmp").exists(),
            "clearing nothing creates nothing"
        );

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
}
