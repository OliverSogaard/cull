//! Image metadata surfaced to the UI.
//!
//! Mirror of the subset of EXIF the frontend renders in the (i) panel. All
//! fields are optional because not every CR3 carries every tag — GPS is often
//! absent, and a few cameras skip drive-mode or white-balance entries.
//!
//! The conversion from [`crate::cr3::Cr3Meta`] lives here so both the
//! parser-facing struct and the IPC-facing one can evolve independently. The
//! file_size field is intentionally not on `Cr3Meta`: it's a `std::fs::metadata`
//! lookup the bundle handler does once, not something to re-derive from CR3 bytes.

use crate::cr3;

/// EXIF subset for the UI. `camelCase` on the wire to match the TS type.
/// Deserialize: smart culling re-reads cached prvw wire headers (`serde(default)`
/// keeps old cache entries readable if a field is ever added — same additive
/// discipline as the tier-cache VERSION contract).
#[derive(serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct ImageMetadata {
    /// Local capture time, ISO-8601-ish (`YYYY-MM-DDTHH:MM:SS`).
    pub captured_at: Option<String>,
    /// Sub-second fraction of `captured_at` in milliseconds (EXIF
    /// SubSecTimeOriginal) — the true burst cadence for smart culling.
    pub sub_sec_ms: Option<u16>,
    pub camera: Option<String>,
    pub lens: Option<String>,
    pub focal_length_mm: Option<f32>,
    pub aperture: Option<f32>,
    /// Frontend formats this as `1/Xs` or `Xs`.
    pub shutter_seconds: Option<f64>,
    pub iso: Option<u32>,
    pub gps_lat: Option<f64>,
    pub gps_lon: Option<f64>,
    /// Active AF point in *displayed-image* coordinates (0–100 %, top-left
    /// origin) — already transformed by EXIF orientation, so it lines up with
    /// the rotated preview. `None` if not parseable; frontend falls back to
    /// the centre.
    pub af_x_pct: Option<f32>,
    pub af_y_pct: Option<f32>,
    /// Exposure compensation, signed EV.
    pub exposure_bias: Option<f64>,
    /// Canon WhiteBalance: 0 = auto, 1 = manual.
    pub white_balance: Option<u32>,
    /// Canon ContinuousDrive (0 = single, anything continuous-shaped else).
    pub drive_mode: Option<u32>,
    /// Native sensor pixels of the main image.
    pub pixel_width: Option<u32>,
    pub pixel_height: Option<u32>,
    /// CR3 file size on disk. Filled in by the bundle handler — not from CR3
    /// content.
    pub file_size: Option<u64>,
    /// Lightroom Classic 1–5★ rating from the `.xmp` sidecar. Always `None`
    /// on the per-image read path since pipeline Phase 0 (re-opening the
    /// sidecar per navigation cost one NAS round-trip): the value arrives in
    /// bulk via `analyze_folder`'s `lrc_ratings`, and the frontend seeds +
    /// carries it. Note: a lone 1★ on a frame CULL marked as favorite is just
    /// CULL's own stamp, not a user rating — the frontend filters that case
    /// using the (cull) rating it already has.
    pub lrc_rating: Option<u8>,
    /// 64-bit DCT pHash of the DECODED THUMBNAIL (Rec.601 luma, `phash::phash64`),
    /// 16 lowercase hex chars — STRING because JS numbers lose bits past 2^53.
    /// Filled in by the thumb handler ONLY (`bundle::extract_thumbnail`), not
    /// from CR3/EXIF content — same "patched after `From`" pattern as
    /// `file_size`. This is the STANDING near-duplicate signal (always
    /// available once a frame's thumbnail has decoded, independent of smart
    /// culling) and is a DIFFERENT source than `analyze::ImageScore.phash`
    /// (computed from the PRVW decode, a different resolution) — the two must
    /// never be Hamming-compared against each other. `None` on a thumb decode
    /// failure.
    pub phash: Option<String>,
}

// MAINTAINERS: this mapping is exhaustive on purpose — adding a field to
// `ImageMetadata` without mapping it here fails to compile (missing field). The
// one silent direction is the reverse: if you add a tag to `cr3::Cr3Meta`,
// remember to add the matching field here AND map it, or the new tag silently
// never reaches the UI.
impl From<cr3::Cr3Meta> for ImageMetadata {
    fn from(m: cr3::Cr3Meta) -> Self {
        ImageMetadata {
            captured_at: m.captured_at,
            sub_sec_ms: m.sub_sec_ms,
            camera: m.camera,
            lens: m.lens,
            focal_length_mm: m.focal_length_mm,
            aperture: m.aperture,
            shutter_seconds: m.shutter_seconds,
            iso: m.iso,
            gps_lat: m.gps_lat,
            gps_lon: m.gps_lon,
            af_x_pct: m.af_x_pct,
            af_y_pct: m.af_y_pct,
            exposure_bias: m.exposure_bias,
            white_balance: m.white_balance,
            drive_mode: m.drive_mode,
            pixel_width: m.pixel_width,
            pixel_height: m.pixel_height,
            file_size: None,
            lrc_rating: None,
            phash: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// From<Cr3Meta> carries every EXIF field across verbatim, drops the
    /// parser-only `orientation`, and leaves the three "patched later" fields
    /// (file_size, lrc_rating, phash) None — those are filled by the bundle /
    /// thumb / analyze passes, never derived from CR3 bytes. Distinct sentinel
    /// per field so a mis-wired mapping (two fields crossed) can't pass.
    #[test]
    fn from_cr3meta_maps_every_field() {
        let src = cr3::Cr3Meta {
            captured_at: Some("2026-05-17T17:18:14".to_string()),
            sub_sec_ms: Some(470),
            camera: Some("Canon EOS R6m3".to_string()),
            lens: Some("RF 85mm F1.2".to_string()),
            focal_length_mm: Some(85.0),
            aperture: Some(1.2),
            shutter_seconds: Some(1.0 / 500.0),
            iso: Some(400),
            gps_lat: Some(55.6761),
            gps_lon: Some(12.5683),
            af_x_pct: Some(42.5),
            af_y_pct: Some(60.0),
            exposure_bias: Some(-0.33),
            white_balance: Some(1),
            drive_mode: Some(8),
            pixel_width: Some(6960),
            pixel_height: Some(4640),
            orientation: 6,
        };
        let m = ImageMetadata::from(src);

        assert_eq!(m.captured_at.as_deref(), Some("2026-05-17T17:18:14"));
        assert_eq!(m.sub_sec_ms, Some(470));
        assert_eq!(m.camera.as_deref(), Some("Canon EOS R6m3"));
        assert_eq!(m.lens.as_deref(), Some("RF 85mm F1.2"));
        assert_eq!(m.focal_length_mm, Some(85.0));
        assert_eq!(m.aperture, Some(1.2));
        assert_eq!(m.shutter_seconds, Some(1.0 / 500.0));
        assert_eq!(m.iso, Some(400));
        assert_eq!(m.gps_lat, Some(55.6761));
        assert_eq!(m.gps_lon, Some(12.5683));
        assert_eq!(m.af_x_pct, Some(42.5));
        assert_eq!(m.af_y_pct, Some(60.0));
        assert_eq!(m.exposure_bias, Some(-0.33));
        assert_eq!(m.white_balance, Some(1));
        assert_eq!(m.drive_mode, Some(8));
        assert_eq!(m.pixel_width, Some(6960));
        assert_eq!(m.pixel_height, Some(4640));
        // Orientation is parser-only — it has no ImageMetadata home and must
        // not silently reappear under another field.
        // Patched by later passes, never by `From`:
        assert_eq!(m.file_size, None);
        assert_eq!(m.lrc_rating, None);
        assert_eq!(m.phash, None);
    }

    /// A default (all-absent) Cr3Meta yields an all-None ImageMetadata — the
    /// "CR3 carries no EXIF" floor.
    #[test]
    fn from_default_cr3meta_is_all_none() {
        let m = ImageMetadata::from(cr3::Cr3Meta::default());
        assert!(m.captured_at.is_none());
        assert!(m.camera.is_none());
        assert!(m.focal_length_mm.is_none());
        assert!(m.drive_mode.is_none());
        assert!(m.pixel_width.is_none());
        assert!(m.file_size.is_none());
        assert!(m.phash.is_none());
    }
}
