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

/// Process-wide unique sequence for atomic-write temp files, shared by every
/// sidecar writer (write + clear) so two overlapping operations on the same
/// sidecar — e.g. a fast re-rate, or an unrate racing a prior write — can never
/// share a temp name and interleave into one corrupt temp. Each writes its own
/// temp; the last rename wins with a valid file.
static XMP_TMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// Atomic sidecar write: write a temp sibling, then rename over the target.
/// Survives a crash/power-loss mid-write.
fn atomic_write_xmp(xmp_path: &Path, contents: &str) -> Result<(), String> {
    let seq = XMP_TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp_path = xmp_path.with_extension(format!("xmp.{seq}.tmp"));
    std::fs::write(&tmp_path, contents.as_bytes()).map_err(|e| format!("write tmp xmp: {e}"))?;
    std::fs::rename(&tmp_path, xmp_path).map_err(|e| format!("rename xmp: {e}"))?;
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

    let by_cull = existing.contains("Cull");
    let stripped = {
        let s = remove_desc_attr(&existing, "xmpDM:pick");
        let s = remove_desc_attr(&s, "xmpDM:good");
        remove_fav_star(&s) // drops only the 1★, never a user's 2–5★
    };

    if by_cull && !xmp_has_user_content(&stripped) {
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

/// Read a rating back from a CR3's sidecar.
///
/// Primary: the LrC-compatible flag scheme — `xmpDM:pick > 0` → keep (favorite
/// when the star is exactly 1), `pick < 0` → reject, `pick == 0` → deliberately
/// unflagged. Fallback (no pick attr present): older CULL sidecars that stored
/// only `xmp:Rating` with a Cull CreatorTool (keep→0, reject→-1, favorite→5),
/// so existing culls still resume after the format change.
pub(crate) fn read_xmp_rating(cr3_path: &str) -> Option<String> {
    let xmp = Path::new(cr3_path).with_extension("xmp");
    let content = std::fs::read_to_string(&xmp).ok()?;
    classify_xmp(&content)
}

// ── XMP string transforms ─────────────────────────────────────────────────
// Everything below is pure on a `&str` so the test suite can exercise it
// without touching the filesystem.

/// Apply a rating to a sidecar string, preserving everything else.
fn apply_rating_to_xmp(xmp: &str, rating: &str) -> Result<String, String> {
    let (pick, good, fav) = match rating {
        "keep" => ("1", "true", false),
        "reject" => ("-1", "false", false),
        "favorite" => ("1", "true", true),
        other => return Err(format!("unknown rating: {other}")),
    };
    let mut out = ensure_xmpdm_ns(xmp);
    out = set_desc_attr(&out, "xmpDM:pick", pick);
    out = set_desc_attr(&out, "xmpDM:good", good);
    out = if fav { set_rating(&out, 1) } else { remove_fav_star(&out) };
    Ok(out)
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

/// Insert a string right after `rdf:about=""` — the one anchor present in
/// every `rdf:Description`. XML attribute order is irrelevant, so this is safe.
fn insert_after_about(xmp: &str, ins: &str) -> String {
    if let Some(pos) = xmp.find("rdf:about=\"\"") {
        let at = pos + "rdf:about=\"\"".len();
        return format!("{}{}{}", &xmp[..at], ins, &xmp[at..]);
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
    MARKERS.iter().any(|m| xmp.contains(m))
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
            return Some(if star == Some(1) { "favorite" } else { "keep" }.to_string());
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
        let stripped = remove_fav_star(&remove_desc_attr(&remove_desc_attr(&fav, "xmpDM:pick"), "xmpDM:good"));
        assert_eq!(classify_xmp(&stripped), None);
        assert!(!xmp_has_user_content(&stripped), "pure CULL sidecar → deletable");
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
}
