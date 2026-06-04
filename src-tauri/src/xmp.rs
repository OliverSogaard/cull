//! XMP sidecar I/O for CULL ratings.
//!
//! CULL writes Lightroom-Classic-compatible flags + a star, verified against
//! real LrC 15.3 sidecars (`sample_cr3s/sample_LrCFlaggedCR3s`):
//!
//! ```text
//!   reject   → xmpDM:pick="-1"  xmpDM:good="false"
//!   keep     → xmpDM:pick="1"   xmpDM:good="true"
//!   favorite → xmpDM:pick="1"   xmpDM:good="true"  + xmp:Rating="1"
//! ```
//!
//! The pick flag means "survived the cull"; the 1★ marks favorites. Stars 2–5
//! are the user's LrC edit-pass ratings and are NEVER touched by CULL. Flags
//! ride in the xmpDM (Dynamic Media) namespace exactly as LrC writes them, so
//! picks / rejects / favorites round-trip into Lightroom and back.
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
    // rename — otherwise a power loss right after the rename can leave the new
    // directory entry pointing at an unflushed (zero/garbage) file.
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

/// Set a rating on the CR3's sidecar (creating the sidecar if absent).
#[tauri::command]
pub(crate) async fn write_xmp_rating(path: String, rating: String) -> Result<(), String> {
    let cr3 = Path::new(&path);
    let xmp_path = cr3.with_extension("xmp");

    let base = match std::fs::read_to_string(&xmp_path) {
        Ok(existing) => existing,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => fresh_xmp(),
        Err(e) => return Err(format!("read existing xmp: {e}")),
    };

    let contents = apply_rating_to_xmp(&base, &rating)?;
    atomic_write_xmp(&xmp_path, &contents)?;
    eprintln!("[cull] write_xmp_rating({}): {rating}", xmp_path.display());
    Ok(())
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
#[tauri::command]
pub(crate) async fn clear_xmp_rating(path: String) -> Result<(), String> {
    let cr3 = Path::new(&path);
    let xmp_path = cr3.with_extension("xmp");

    let existing = match std::fs::read_to_string(&xmp_path) {
        Ok(s) => s,
        // No sidecar → already unrated. Nothing to do.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("read existing xmp: {e}")),
    };

    let authored = authored_by_cull(&existing);
    let stripped = strip_cull_fields(&existing);

    if authored && !xmp_has_user_content(&stripped) {
        match std::fs::remove_file(&xmp_path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("remove xmp: {e}")),
        }
        eprintln!("[cull] clear_xmp_rating({}): removed sidecar", xmp_path.display());
        return Ok(());
    }

    atomic_write_xmp(&xmp_path, &stripped)?;
    eprintln!("[cull] clear_xmp_rating({}): stripped rating", xmp_path.display());
    Ok(())
}

/// Read a sidecar ONCE and derive both CULL's pick rating and the user's LrC
/// star rating from the same in-memory string.
///
/// The analyze restore pass needs both per file; reading the sidecar twice (one
/// open for the pick rating, another for the star) doubled the open count on
/// exactly the high-latency NAS path the whole design optimises around
/// ("one open per file" — see ARCHITECTURE.md). Both values come from the same
/// bytes, so a single read serves both.
///
/// The pick value follows the LrC-compatible flag scheme — `xmpDM:pick > 0` →
/// keep (favorite when the star is exactly 1), `pick < 0` → reject, `pick == 0`
/// → deliberately unflagged. Fallback (no pick attr present): older CULL
/// sidecars that stored only `xmp:Rating` with a Cull CreatorTool (keep→0,
/// reject→-1, favorite→5), so existing culls still resume after the format
/// change. The star value is the raw `xmp:Rating` (1–5), or `None`.
pub(crate) fn read_ratings(cr3_path: &str) -> (Option<String>, Option<u8>) {
    let xmp = Path::new(cr3_path).with_extension("xmp");
    match std::fs::read_to_string(&xmp) {
        Ok(content) => (classify_xmp(&content), parse_lrc_rating(&content)),
        Err(_) => (None, None),
    }
}

/// Read the user's Lightroom Classic 1–5★ star rating from a CR3's sidecar.
///
/// Returns `Some(n)` for `n ∈ 1..=5` and `None` for absent / zero / unparseable.
/// This is the RAW `xmp:Rating` value — including the lone 1★ that CULL itself
/// writes for its favorite mark. Disambiguating "user's pre-existing LrC rating"
/// vs "CULL's favorite stamp" needs the CULL rating too (a 1★ on a CULL-favorite
/// is just CULL's flag, not a pre-existing user rating); the frontend already
/// has both fields and applies that rule when rendering badges.
pub(crate) fn read_lrc_rating(cr3_path: &str) -> Option<u8> {
    let xmp = Path::new(cr3_path).with_extension("xmp");
    let content = std::fs::read_to_string(&xmp).ok()?;
    parse_lrc_rating(&content)
}

/// Same as [`read_lrc_rating`] but works on a sidecar string in memory.
fn parse_lrc_rating(content: &str) -> Option<u8> {
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
///   - keep/reject → drop `cull:fav`, and remove the 1★ only when CULL owned it.
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
    } else if cull_owned_fav_star(&out) {
        out = remove_desc_attr(&out, "cull:fav");
        out = remove_fav_star(&out); // CULL's own 1★ only; never a user star
    } else {
        out = remove_desc_attr(&out, "cull:fav");
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
        None => authored_by_cull(xmp) && parse_xmp_rating(xmp) == Some(1),
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

/// Read CULL's private favorite marker: `Some("star")` (CULL also wrote the
/// visible 1★, safe to strip on demote), `Some("flag")` (favorite rides on a
/// user star we must never touch), or `None` (not a marker-tagged favorite).
fn cull_fav_value(xmp: &str) -> Option<String> {
    let needle = "cull:fav=\"";
    let s = xmp.find(needle)? + needle.len();
    let rel = xmp[s..].find('"')?;
    Some(xmp[s..s + rel].to_string())
}

/// True when CULL authored this sidecar (vs an LrC/third-party sidecar CULL only
/// annotated). Gates destructive cleanup. Tighter than a bare "Cull" substring
/// so a stray keyword/path/person-name can't trip it into deleting user data.
fn authored_by_cull(xmp: &str) -> bool {
    xmp.contains("CreatorTool=\"Cull")
        || xmp.contains("x:xmptk=\"Cull")
        || xmp.contains("xmlns:cull=")
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

/// Remove `xmp:Rating` ONLY when it's the 1★ CULL writes for favorites — a
/// user's 2–5★ LrC rating is left untouched.
fn remove_fav_star(xmp: &str) -> String {
    if parse_xmp_rating(xmp) == Some(1) {
        remove_rating_from_xmp(xmp)
    } else {
        xmp.to_string()
    }
}

/// Strip `xmp:Rating` from a sidecar (element form AND Lightroom's attribute
/// form), leaving every other field intact. The element form swallows its
/// leading indentation + trailing newline so we don't leave a dangling blank
/// line.
fn remove_rating_from_xmp(xmp: &str) -> String {
    let mut out = xmp.to_string();

    if let Some(open) = out.find("<xmp:Rating>") {
        if let Some(rel) = out[open..].find("</xmp:Rating>") {
            let mut start = open;
            let mut end = open + rel + "</xmp:Rating>".len();
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

    if let Some(open) = out.find("xmp:Rating=\"") {
        let inner = open + "xmp:Rating=\"".len();
        if let Some(rel) = out[inner..].find('"') {
            let mut start = open;
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

/// True if the sidecar carries user/edit data we must never delete. CULL's own
/// sidecar only writes `xmp:Rating` / `xmp:CreatorTool` / `xmp:ModifyDate`,
/// none of which match these markers, so a pure CULL sidecar reports false →
/// safe to remove.
fn xmp_has_user_content(xmp: &str) -> bool {
    const MARKERS: [&str; 9] = [
        "xmp:Label", "dc:", "lr:", "crs:", "photoshop:", "tiff:", "exif:", "aux:", "xmpMM:",
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
<x:xmpmeta xmlns:x=\"adobe:ns:meta/\" x:xmptk=\"Cull 1.0\">\n\
 <rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">\n\
  <rdf:Description rdf:about=\"\"\n\
    xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\"\n\
    xmlns:xmpDM=\"{XMPDM_NS}\"\n\
   xmp:CreatorTool=\"Cull 1.0\"\n\
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
            // Favorite is CULL's private marker when present (so a favorite on an
            // already-starred frame still reads as favorite). Fallback for
            // sidecars without the marker — including LrC-authored ones that
            // round-trip a flagged 1★ — keep the historical "pick + lone 1★ =
            // favorite" rule. Detection is read-only, so this ambiguity is safe;
            // the destructive paths gate on cull_owned_fav_star instead.
            let fav = cull_fav_value(content).is_some() || star == Some(1);
            return Some(if fav { "favorite" } else { "keep" }.to_string());
        }
        Some(_) => return None, // pick == 0 → explicitly unflagged
        None => {}
    }
    // Backward-compat with the pre-flag CULL scheme.
    if content.contains("Cull") {
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
            assert_eq!(classify_xmp(&xmp).as_deref(), Some(rating), "round-trip {rating}");
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
        assert_eq!(classify_xmp(&kept).as_deref(), Some("keep"), "flag+3★ is keep, not favorite");
    }

    /// Re-rating a real-looking LrC sidecar preserves its edits and namespace.
    #[test]
    fn preserves_lrc_content_on_rerate() {
        let lrc = "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\">\n <rdf:RDF>\n  <rdf:Description rdf:about=\"\"\n    xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\"\n    xmlns:xmpDM=\"http://ns.adobe.com/xmp/1.0/DynamicMedia/\"\n    xmlns:crs=\"http://ns.adobe.com/camera-raw-settings/1.0/\"\n   xmpDM:pick=\"0\"\n   crs:Contrast2012=\"25\">\n  </rdf:Description>\n </rdf:RDF>\n</x:xmpmeta>";
        let out = apply_rating_to_xmp(lrc, "reject").unwrap();
        assert!(out.contains("crs:Contrast2012=\"25\""), "user edits preserved");
        assert_eq!(parse_attr_i32(&out, "xmpDM:pick"), Some(-1));
        assert_eq!(classify_xmp(&out).as_deref(), Some("reject"));
    }

    #[test]
    fn unflagged_is_unrated() {
        assert_eq!(classify_xmp("xmpDM:pick=\"0\"").as_deref(), None);
        assert_eq!(classify_xmp("no markers here").as_deref(), None);
    }

    /// Older CULL sidecars (Rating-only + Cull marker) still resume.
    #[test]
    fn backward_compat_old_scheme() {
        assert_eq!(classify_xmp("Cull <xmp:Rating>5</xmp:Rating>").as_deref(), Some("favorite"));
        assert_eq!(classify_xmp("Cull 1.0 xmp:Rating=\"0\"").as_deref(), Some("keep"));
        assert_eq!(classify_xmp("Cull <xmp:Rating>-1</xmp:Rating>").as_deref(), Some("reject"));
    }

    /// Unrate strips CULL's fields; a fresh CULL sidecar becomes deletable.
    #[test]
    fn unrate_strips_to_deletable() {
        let fav = apply_rating_to_xmp(&fresh_xmp(), "favorite").unwrap();
        let stripped = strip_cull_fields(&fav);
        assert_eq!(classify_xmp(&stripped), None);
        assert!(!xmp_has_user_content(&stripped), "pure CULL sidecar → deletable");
    }

    /// CRITICAL regression (favorite over a user star): favoriting a frame that
    /// already carries a user 2–5★ must NOT overwrite that star. The favorite is
    /// recorded flag-only via cull:fav, and the frame still reads as favorite.
    #[test]
    fn favorite_never_clobbers_user_2to5_star() {
        for n in [2, 3, 4, 5] {
            let starred = set_rating(&fresh_xmp(), n);
            let fav = apply_rating_to_xmp(&starred, "favorite").unwrap();
            assert_eq!(parse_xmp_rating(&fav), Some(n), "user {n}★ preserved through favorite");
            assert_eq!(classify_xmp(&fav).as_deref(), Some("favorite"), "still reads favorite at {n}★");
            assert!(fav.contains("cull:fav=\"flag\""), "favorite is flag-only at {n}★");
            // Demoting the flag-only favorite leaves the user's star intact.
            let keep = apply_rating_to_xmp(&fav, "keep").unwrap();
            assert_eq!(parse_xmp_rating(&keep), Some(n), "user {n}★ survives favorite→keep");
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
        let reject = apply_rating_to_xmp(lrc, "reject").unwrap();
        assert_eq!(parse_xmp_rating(&reject), Some(1), "user 1★ survives reject");
        // Unrate (pure core): strip CULL fields, the user's 1★ stays and keeps
        // the sidecar from being deleted as litter.
        let stripped = strip_cull_fields(&keep);
        assert_eq!(parse_xmp_rating(&stripped), Some(1), "user 1★ survives unrate");
        assert!(xmp_has_user_content(&stripped), "surviving 1★ blocks sidecar deletion");
    }

    /// CULL's own favorite (courtesy 1★ + cull:fav="star") IS removable on demote
    /// — only its own stamp, never a user star.
    #[test]
    fn cull_favorite_star_removable_on_demote() {
        let fav = apply_rating_to_xmp(&fresh_xmp(), "favorite").unwrap();
        assert!(fav.contains("cull:fav=\"star\""), "CULL-owned star marker");
        assert_eq!(parse_xmp_rating(&fav), Some(1));
        let keep = apply_rating_to_xmp(&fav, "keep").unwrap();
        assert_eq!(parse_xmp_rating(&keep), None, "CULL's own 1★ removed on demote");
        assert!(!keep.contains("cull:fav"), "favorite marker cleared");
        assert_eq!(classify_xmp(&keep).as_deref(), Some("keep"));
    }

    /// insert_after_about handles a non-empty rdf:about (some tools emit one);
    /// the rating write must not silently no-op on those sidecars.
    #[test]
    fn writes_into_nonempty_rdf_about() {
        let xmp = "<rdf:Description rdf:about=\"uuid:abc-123\"\n    xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\">\n  </rdf:Description>";
        let out = apply_rating_to_xmp(xmp, "reject").unwrap();
        assert_eq!(parse_attr_i32(&out, "xmpDM:pick"), Some(-1), "rating actually landed");
        assert!(out.contains("rdf:about=\"uuid:abc-123\""), "about value untouched");
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

    /// LrC rating reads back what LrC 15.3 wrote on real sample files. CULL's
    /// favorite stamp also lands as `1` here — disambiguating CULL-fav vs
    /// pre-existing 1★ is the frontend's job (it has the CULL rating too).
    #[test]
    fn reads_lrc_rating_from_real_sidecars() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../sample_cr3s/sample_LrCFlaggedCR3s");
        if !dir.exists() {
            eprintln!("[cull] skipping real-LrC star test: {} absent", dir.display());
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
}
