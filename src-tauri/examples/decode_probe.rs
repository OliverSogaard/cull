//! Dev probe: decode a JPEG with the app's exact zune-jpeg configuration and
//! report dims + per-band brightness, to diagnose partial/cut decodes.
//! Usage: cargo run --example decode_probe -- /path/to/file.jpg

use zune_jpeg::zune_core::bytestream::ZCursor;
use zune_jpeg::zune_core::colorspace::ColorSpace;
use zune_jpeg::zune_core::options::DecoderOptions;

fn main() {
    let path = std::env::args().nth(1).expect("usage: decode_probe <jpeg>");
    let bytes = std::fs::read(&path).expect("read file");
    let opts = DecoderOptions::default().jpeg_set_out_colorspace(ColorSpace::RGB);
    let mut dec = zune_jpeg::JpegDecoder::new_with_options(ZCursor::new(&bytes[..]), opts);
    match dec.decode() {
        Ok(rgb) => {
            let info = dec.info().expect("info");
            let (w, h) = (info.width as usize, info.height as usize);
            println!(
                "decode OK: {w}x{h}, buffer {} bytes (expected {})",
                rgb.len(),
                w * h * 3
            );
            // Mean luma per 10% horizontal band — a truncated decode shows
            // black (0) bands at the bottom.
            for band in 0..10 {
                let y0 = h * band / 10;
                let y1 = h * (band + 1) / 10;
                let mut sum = 0u64;
                let mut n = 0u64;
                for y in y0..y1 {
                    for x in 0..w {
                        let p = (y * w + x) * 3;
                        sum += (rgb[p] as u64 + rgb[p + 1] as u64 + rgb[p + 2] as u64) / 3;
                        n += 1;
                    }
                }
                println!("band {band} (rows {y0}..{y1}): mean {}", sum / n.max(1));
            }
        }
        Err(e) => println!("decode FAILED: {e:?}"),
    }
}
