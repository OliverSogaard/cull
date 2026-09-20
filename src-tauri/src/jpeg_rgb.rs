//! The one shared "JPEG → tightly-packed RGB8" decode ritual.
//!
//! Every consumer of a decoded JPEG in this crate (preview metric pass, mid
//! tier generation, thumbnail pHash, ML smoke tests) needs the same three
//! steps: zune-jpeg decode with RGB8 output requested, dimensions from the
//! decoder's header info, and the `len == w*h*3` buffer validation that
//! guards the pixel math downstream. Canon payloads are YCbCr internally;
//! zune converts on output.

use zune_jpeg::zune_core::bytestream::ZCursor;
use zune_jpeg::zune_core::colorspace::ColorSpace;
use zune_jpeg::zune_core::options::DecoderOptions;
use zune_jpeg::JpegDecoder;

/// The decoded buffer must be exactly `w*h*3` bytes AND describe at least one
/// pixel: a 0×0 header passes the length check with an empty buffer and would
/// panic the AF-crop clamp downstream (audit 2026-09-13, analyze.rs:326).
fn validate_dims(len: usize, w: usize, h: usize) -> Result<(), String> {
    if w == 0 || h == 0 {
        return Err(format!("decode: empty image ({w}x{h})"));
    }
    if len != w * h * 3 {
        return Err(format!(
            "decode: unexpected buffer ({len} bytes for {w}x{h} RGB)"
        ));
    }
    Ok(())
}

/// Decode a JPEG to RGB8, returning `(rgb, width, height)` with the buffer
/// length validated against the decoded dimensions. Errors are prefixed
/// `decode:` so call sites can prepend their tier ("prvw decode: …",
/// "mid decode: …") without double-wording.
pub(crate) fn decode_rgb(jpeg: &[u8]) -> Result<(Vec<u8>, usize, usize), String> {
    let opts = DecoderOptions::default().jpeg_set_out_colorspace(ColorSpace::RGB);
    let mut dec = JpegDecoder::new_with_options(ZCursor::new(jpeg), opts);
    let rgb = dec.decode().map_err(|e| format!("decode: {e:?}"))?;
    let info = dec.info().ok_or("decode: no header info")?;
    let (w, h) = (info.width as usize, info.height as usize);
    validate_dims(rgb.len(), w, h)?;
    Ok((rgb, w, h))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::synth_jpeg;

    #[test]
    fn decodes_a_synthetic_jpeg_to_validated_rgb() {
        let jpeg = synth_jpeg(160, 120, 90);
        let (rgb, w, h) = decode_rgb(&jpeg).expect("decodable");
        assert_eq!((w, h), (160, 120));
        assert_eq!(rgb.len(), w * h * 3);
    }

    #[test]
    fn errors_on_undecodable_bytes() {
        assert!(decode_rgb(b"not a jpeg").is_err());
        assert!(decode_rgb(&[]).is_err());
    }

    #[test]
    fn validate_dims_rejects_empty_and_mismatched_buffers() {
        assert!(validate_dims(0, 0, 0).unwrap_err().contains("empty"));
        assert!(validate_dims(0, 4, 0).unwrap_err().contains("empty"));
        assert!(validate_dims(11, 2, 2)
            .unwrap_err()
            .contains("unexpected buffer"));
        assert_eq!(validate_dims(12, 2, 2), Ok(()));
    }
}
