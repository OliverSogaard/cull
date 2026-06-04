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
#[derive(serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImageMetadata {
    /// Local capture time, ISO-8601-ish (`YYYY-MM-DDTHH:MM:SS`).
    pub captured_at: Option<String>,
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
    /// Lightroom Classic 1–5★ rating from the `.xmp` sidecar, surfaced so the
    /// UI can show pre-existing LrC ratings (a row in the (i) panel + a grid
    /// badge). `None` for absent / 0 / unparseable. Note: a lone 1★ on a frame
    /// CULL marked as favorite is just CULL's own stamp, not a user rating —
    /// the frontend filters that case using the (cull) rating it already has.
    pub lrc_rating: Option<u8>,
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
        }
    }
}
