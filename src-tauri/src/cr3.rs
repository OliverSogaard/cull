//! Native Canon CR3 reader — extracts embedded JPEGs and EXIF directly from the
//! ISO-BMFF container, no exiftool subprocess.
//!
//! CR3 layout (reverse-engineered + verified against exiftool on R6 III files):
//!   ftyp
//!   moov
//!     uuid (Canon metadata, 85c0b687…)
//!       CMT1  → TIFF IFD0   (Orientation, Model, …)
//!       CMT2  → TIFF ExifIFD (DateTimeOriginal, FNumber, ExposureTime, ISO, FocalLength)
//!       CMT3  → Canon MakerNote (AF data)
//!       CMT4  → TIFF GPS IFD
//!       THMB  → 160×120 thumbnail JPEG (24-byte box header, then JPEG)
//!     trak… (preview/video tracks)
//!   uuid (preview, eaf42b5e-1c98-4b88-b9fb-b7dc406e4d16)
//!     PRVW → 1620×1080 preview JPEG (16-byte sub-header, then JPEG)
//!   mdat → full-res embedded JPEG (≈32 MP), then RAW sensor data (CRAW)
//!
//! Because ftyp + moov + the preview uuid all sit before mdat, and the full-res
//! JPEG is the very first thing inside mdat, a single large read from offset 0
//! captures the full-res preview and all metadata at once — `read_bundle` exploits
//! this so each cull step is ONE open + (usually) ONE read, the difference between
//! snappy and sluggish on a high-latency NAS. The 160×120 THMB is NOT part of that
//! read: filmstrip thumbnails are fetched separately by `read_thumbnail` (a small
//! moov-head read on its own bounded pool). Orientation is applied by splicing an
//! EXIF tag into the JPEGs (no decode/re-encode).
//!
//! INVARIANT: read-only. Never writes to the CR3.

use std::fs::File;
use std::io::Read;

/// Canon "preview" uuid that wraps the PRVW box.
const PREVIEW_UUID: [u8; 16] = [
    0xea, 0xf4, 0x2b, 0x5e, 0x1c, 0x98, 0x4b, 0x88, 0xb9, 0xfb, 0xb7, 0xdc, 0x40, 0x6e, 0x4d, 0x16,
];

fn be_u32(d: &[u8], i: usize) -> Option<u32> {
    d.get(i..i + 4).map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
}
fn be_u64(d: &[u8], i: usize) -> Option<u64> {
    d.get(i..i + 8)
        .map(|b| u64::from_be_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]]))
}

/// Top-level / sibling boxes in [start, end) → (fourcc, content_start, box_end).
fn boxes(d: &[u8], start: usize, end: usize) -> Vec<([u8; 4], usize, usize)> {
    let mut out = Vec::new();
    let mut i = start;
    while i + 8 <= end {
        let Some(s32) = be_u32(d, i) else { break };
        let mut hdr = 8usize;
        let size = if s32 == 1 {
            hdr = 16;
            match be_u64(d, i + 8) {
                Some(s) => s as usize,
                None => break,
            }
        } else if s32 == 0 {
            end - i
        } else {
            s32 as usize
        };
        // Checked add: a 64-bit large-size box (s32 == 1) can carry a size near
        // usize::MAX, and `i + size` would wrap (release) or panic (debug). Bail
        // on overflow or a box that runs past the parent range.
        let Some(box_end) = i.checked_add(size) else { break };
        if size < hdr || box_end > end {
            break;
        }
        out.push(([d[i + 4], d[i + 5], d[i + 6], d[i + 7]], i + hdr, box_end));
        i = box_end;
    }
    out
}

/// First JPEG SOI (0xFFD8) in [start, end).
fn find_soi(d: &[u8], start: usize, end: usize) -> Option<usize> {
    let hi = end.min(d.len()).saturating_sub(1);
    (start..hi).find(|&i| d[i] == 0xFF && d[i + 1] == 0xD8)
}

/// Find a box by fourcc within [start, end) by signature (the 4 bytes preceding
/// it are its size), then return its embedded JPEG (SOI..box_end). The signature
/// always precedes the JPEG payload, so the first match is the real box.
fn jpeg_in_box(d: &[u8], start: usize, end: usize, want: &[u8; 4]) -> Option<Vec<u8>> {
    let hi = end.min(d.len());
    let mut i = start;
    while i + 8 <= hi {
        // Jump to the next candidate first byte instead of scanning every byte
        // (mirrors jpeg_extent's memchr idiom). Same bound + first-match semantics.
        let p = i + memchr::memchr(want[0], &d[i..hi])?;
        if p + 8 > hi {
            break; // no room left for a box header + payload
        }
        if &d[p..p + 4] == want {
            let box_start = p.checked_sub(4)?;
            let size = be_u32(d, box_start)? as usize;
            let box_end = (box_start + size).min(hi);
            let soi = find_soi(d, p + 4, box_end)?;
            return Some(d[soi..box_end].to_vec());
        }
        i = p + 1;
    }
    None
}

/// Extract the embedded 1620×1080 preview JPEG.
pub fn preview_jpeg(d: &[u8]) -> Option<Vec<u8>> {
    for (fourcc, cs, ce) in boxes(d, 0, d.len()) {
        if &fourcc == b"uuid" && ce - cs >= 16 && d[cs..cs + 16] == PREVIEW_UUID {
            return jpeg_in_box(d, cs + 16, ce, b"PRVW");
        }
    }
    None
}

/// Locate the content bytes of a CMT box (CMT1/2/3/4) given the [start, end)
/// range that directly contains the Canon metadata uuid box(es) — i.e. the moov
/// content range. Returns the TIFF blob (II/MM header onward).
fn cmt_in_uuid_range<'a>(d: &'a [u8], start: usize, end: usize, cmt: &[u8; 4]) -> Option<&'a [u8]> {
    for (fourcc, cs, ce) in boxes(d, start, end) {
        if &fourcc == b"uuid" && ce - cs >= 16 {
            for (f2, c2, e2) in boxes(d, cs + 16, ce) {
                if &f2 == cmt {
                    return d.get(c2..e2);
                }
            }
        }
    }
    None
}

/// Byte size of one component of a TIFF field type (0 = unknown).
fn type_size(typ: u16) -> usize {
    match typ {
        1 | 2 | 6 | 7 => 1, // BYTE / ASCII / SBYTE / UNDEFINED
        3 | 8 => 2,         // SHORT / SSHORT
        4 | 9 | 11 => 4,    // LONG / SLONG / FLOAT
        5 | 10 | 12 => 8,   // RATIONAL / SRATIONAL / DOUBLE
        _ => 0,
    }
}

// ── Minimal TIFF reader (little- or big-endian) ─────────────────────────────
struct Tiff<'a> {
    d: &'a [u8],
    le: bool,
}
impl<'a> Tiff<'a> {
    /// `t` is a CMT box's content: "II"/"MM" + 0x2A + IFD0 offset.
    fn new(t: &'a [u8]) -> Option<Tiff<'a>> {
        let le = match t.get(0..2)? {
            b"II" => true,
            b"MM" => false,
            _ => return None,
        };
        Some(Tiff { d: t, le })
    }
    fn u16(&self, i: usize) -> Option<u16> {
        let b = self.d.get(i..i + 2)?;
        Some(if self.le {
            u16::from_le_bytes([b[0], b[1]])
        } else {
            u16::from_be_bytes([b[0], b[1]])
        })
    }
    fn u32(&self, i: usize) -> Option<u32> {
        let b = self.d.get(i..i + 4)?;
        Some(if self.le {
            u32::from_le_bytes([b[0], b[1], b[2], b[3]])
        } else {
            u32::from_be_bytes([b[0], b[1], b[2], b[3]])
        })
    }
    /// First IFD offset (relative to the TIFF start).
    fn ifd0(&self) -> Option<usize> {
        self.u32(4).map(|o| o as usize)
    }
    /// Read a single SHORT-valued tag from the IFD at `ifd_off`.
    fn short_tag(&self, ifd_off: usize, tag: u16) -> Option<u16> {
        let count = self.u16(ifd_off)? as usize;
        for e in 0..count {
            let entry = ifd_off + 2 + e * 12;
            if self.u16(entry)? == tag {
                // SHORT value sits in the first 2 bytes of the value field.
                return self.u16(entry + 8);
            }
        }
        None
    }

    /// Find an IFD entry by tag → (type, count, absolute value offset). Values
    /// ≤ 4 bytes are inline at entry+8; larger ones live at the u32 offset there.
    fn find_entry(&self, ifd_off: usize, tag: u16) -> Option<(u16, u32, usize)> {
        let count = self.u16(ifd_off)? as usize;
        for e in 0..count {
            let entry = ifd_off + 2 + e * 12;
            if self.u16(entry)? == tag {
                let typ = self.u16(entry + 2)?;
                let cnt = self.u32(entry + 4)?;
                let bytes = type_size(typ).saturating_mul(cnt as usize);
                let voff = if bytes <= 4 { entry + 8 } else { self.u32(entry + 8)? as usize };
                return Some((typ, cnt, voff));
            }
        }
        None
    }

    /// ASCII tag (type 2): NUL-terminated, whitespace-trimmed, non-empty.
    fn ascii(&self, ifd_off: usize, tag: u16) -> Option<String> {
        let (typ, cnt, voff) = self.find_entry(ifd_off, tag)?;
        if typ != 2 {
            return None;
        }
        let raw = self.d.get(voff..voff + cnt as usize)?;
        let s = raw.split(|&b| b == 0).next().unwrap_or(&[]);
        let s = std::str::from_utf8(s).ok()?.trim();
        (!s.is_empty()).then(|| s.to_string())
    }

    fn urational_at(&self, off: usize) -> Option<f64> {
        let n = self.u32(off)? as f64;
        let d = self.u32(off + 4)?;
        Some(if d == 0 { 0.0 } else { n / d as f64 })
    }
    fn srational_at(&self, off: usize) -> Option<f64> {
        let n = self.u32(off)? as i32 as f64;
        let d = self.u32(off + 4)? as i32;
        Some(if d == 0 { 0.0 } else { n / d as f64 })
    }

    /// First RATIONAL (5) / SRATIONAL (10) value as f64.
    fn rational(&self, ifd_off: usize, tag: u16) -> Option<f64> {
        let (typ, cnt, voff) = self.find_entry(ifd_off, tag)?;
        if cnt == 0 {
            return None;
        }
        match typ {
            5 => self.urational_at(voff),
            10 => self.srational_at(voff),
            _ => None,
        }
    }

    /// All RATIONAL/SRATIONAL components (e.g. GPS deg/min/sec).
    fn rationals(&self, ifd_off: usize, tag: u16) -> Vec<f64> {
        let Some((typ, cnt, voff)) = self.find_entry(ifd_off, tag) else {
            return Vec::new();
        };
        if typ != 5 && typ != 10 {
            return Vec::new();
        }
        (0..cnt as usize)
            .filter_map(|k| {
                let o = voff + 8 * k;
                if typ == 10 { self.srational_at(o) } else { self.urational_at(o) }
            })
            .collect()
    }

    /// First SHORT (3) / LONG (4) value as u32.
    fn uint(&self, ifd_off: usize, tag: u16) -> Option<u32> {
        let (typ, cnt, voff) = self.find_entry(ifd_off, tag)?;
        if cnt == 0 {
            return None;
        }
        match typ {
            3 => self.u16(voff).map(|v| v as u32),
            4 => self.u32(voff),
            _ => None,
        }
    }
}

/// EXIF Orientation from a CMT1 TIFF blob (IFD0 tag 0x0112). 1 if absent.
fn orientation_from_cmt1(cmt1: Option<&[u8]>) -> u32 {
    cmt1.and_then(Tiff::new)
        .and_then(|t| {
            let ifd0 = t.ifd0()?;
            t.short_tag(ifd0, 0x0112)
        })
        .map(|o| o as u32)
        .unwrap_or(1)
}

// ── EXIF orientation injection ───────────────────────────────────────────────
//
// Canon stores the embedded JPEGs on the landscape sensor frame and keeps the
// real rotation only in CMT1's Orientation tag. Rather than decode + rotate +
// re-encode (slow, and a re-encode is generation loss), we splice a tiny EXIF
// APP1 segment carrying that Orientation into the JPEG. The webview (Chromium)
// honors `image-orientation: from-image` by default, so it rotates on display —
// microseconds of byte work, zero quality loss. INVARIANT: read-only w.r.t. CR3.

/// Minimal little-endian EXIF APP1 segment whose IFD0 holds exactly the
/// Orientation tag (0x0112, SHORT). 36 bytes total: the FF E1 marker + a 34-byte
/// segment (the 0x0022 length field counts itself + payload, not the marker).
fn build_orientation_app1(orient: u16) -> [u8; 36] {
    let v = orient.to_le_bytes();
    [
        0xFF, 0xE1, // APP1 marker
        0x00, 0x22, // segment length = 34 (big-endian, includes these 2 bytes)
        b'E', b'x', b'i', b'f', 0x00, 0x00, // "Exif\0\0"
        b'I', b'I', 0x2A, 0x00, // TIFF header: little-endian, magic 42
        0x08, 0x00, 0x00, 0x00, // IFD0 at offset 8
        0x01, 0x00, // 1 directory entry
        0x12, 0x01, // tag 0x0112 (Orientation)
        0x03, 0x00, // type 3 (SHORT)
        0x01, 0x00, 0x00, 0x00, // count 1
        v[0], v[1], 0x00, 0x00, // value (SHORT in the low 2 bytes), padded
        0x00, 0x00, 0x00, 0x00, // next IFD = 0
    ]
}

/// Drop any existing APP1/Exif segments from a JPEG's header so our injected one
/// is the single authority. Walks only the marker segments before SOS.
fn strip_app1_exif(jpeg: &mut Vec<u8>) {
    let mut i = 2; // past SOI
    while i + 4 <= jpeg.len() {
        if jpeg[i] != 0xFF {
            break;
        }
        let marker = jpeg[i + 1];
        if marker == 0xDA || marker == 0xD9 {
            break; // SOS (entropy follows) or EOI — header is done
        }
        if marker == 0x01 || (0xD0..=0xD7).contains(&marker) {
            i += 2; // standalone marker, no length field
            continue;
        }
        let len = ((jpeg[i + 2] as usize) << 8) | (jpeg[i + 3] as usize);
        if len < 2 || i + 2 + len > jpeg.len() {
            break;
        }
        let is_exif =
            marker == 0xE1 && jpeg.len() >= i + 10 && &jpeg[i + 4..i + 10] == b"Exif\0\0";
        if is_exif {
            jpeg.drain(i..i + 2 + len); // next segment shifts down to i
        } else {
            i += 2 + len;
        }
    }
}

/// Splice an EXIF Orientation tag into a JPEG so the webview rotates it on
/// display. Orientation 1 (upright) and the mirror-flip values (2/4/5/7) cameras
/// don't emit pass through untouched. INVARIANT: read-only w.r.t. CR3.
pub(crate) fn with_exif_orientation(mut jpeg: Vec<u8>, orientation: u32) -> Vec<u8> {
    if !matches!(orientation, 3 | 6 | 8) {
        return jpeg;
    }
    if jpeg.len() < 2 || jpeg[0] != 0xFF || jpeg[1] != 0xD8 {
        return jpeg; // not a JPEG we recognize; leave it alone
    }
    strip_app1_exif(&mut jpeg);
    let app1 = build_orientation_app1(orientation as u16);
    // Splice the APP1 segment in right after SOI, IN PLACE — shifts the tail once
    // inside the existing allocation (one realloc at most) rather than allocating
    // a second multi-MB Vec and copying the whole JPEG into it. Byte-identical
    // output (SOI + app1 + rest).
    jpeg.splice(2..2, app1);
    jpeg
}

// ── Bounded reads: one open, as few round-trips as possible (never the CRAW) ──

fn io_err(msg: &str) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidData, msg)
}

/// Content start of a named top-level box, located by walking box headers in the
/// in-memory buffer. Unlike `boxes`, this returns the offset even when the box's
/// declared size runs past the buffer end — essential for `mdat`, whose multi-MB
/// payload we never fully buffer. Boxes preceding the target (ftyp, moov, preview
/// uuid) are small and fully present, so skipping by size reaches the target.
fn top_box_content_start(d: &[u8], want: &[u8; 4]) -> Option<usize> {
    let mut i = 0usize;
    while i + 8 <= d.len() {
        let s32 = be_u32(d, i)?;
        let fourcc = [d[i + 4], d[i + 5], d[i + 6], d[i + 7]];
        let (size, hdr) = if s32 == 1 {
            (be_u64(d, i + 8)? as usize, 16usize)
        } else if s32 == 0 {
            (d.len() - i, 8usize) // extends to EOF
        } else {
            (s32 as usize, 8usize)
        };
        if &fourcc == want {
            return Some(i + hdr);
        }
        if size < hdr {
            break;
        }
        i = i.checked_add(size)?;
    }
    None
}

/// moov box range [start, end) within a prefix buffer. moov is small and fully
/// buffered once we've grown to cover it.
fn moov_range(d: &[u8]) -> Option<(usize, usize)> {
    boxes(d, 0, d.len())
        .into_iter()
        .find(|(f, _, _)| f == b"moov")
        .map(|(_, s, e)| (s, e))
}

/// First child box with the given fourcc inside [start, end).
fn child_box(d: &[u8], start: usize, end: usize, want: &[u8; 4]) -> Option<(usize, usize)> {
    boxes(d, start, end)
        .into_iter()
        .find(|(f, _, _)| f == want)
        .map(|(_, s, e)| (s, e))
}

/// Exact (offset, length) of the full-res mdat JPEG, derived from moov's sample
/// tables — the hint that lets `read_fullres_at` replace the 12 MiB head +
/// 8 MiB grow-loop scan with ONE exact-range read.
///
/// Walks every trak → mdia → minf → stbl, taking the first sample's size
/// (`stsz`) and first chunk's offset (`stco`/`co64`), then picks the candidate
/// with the SMALLEST offset: the full-res JPEG is the first item inside mdat,
/// ahead of the CRAW payload (layout doc above). Deliberately does NOT decode
/// `stsd` to identify the JPEG track — robustness comes from read-time
/// validation (SOI at offset, EOI inside the range; `read_fullres_at`), with
/// the legacy scan as the fallback, and from the corpus gate test that asserts
/// hint == mdat-scan for every sample CR3.
pub fn full_jpeg_location(d: &[u8], moov_start: usize, moov_end: usize) -> Option<(u64, u64)> {
    let mut best: Option<(u64, u64)> = None;
    for (fourcc, ts, te) in boxes(d, moov_start, moov_end) {
        if &fourcc != b"trak" {
            continue;
        }
        let Some((ms, me)) = child_box(d, ts, te, b"mdia") else { continue };
        let Some((ns, ne)) = child_box(d, ms, me, b"minf") else { continue };
        let Some((ss, se)) = child_box(d, ns, ne, b"stbl") else { continue };

        // stsz (full box): ver/flags u32, sample_size u32, sample_count u32,
        // then per-sample u32 entries when sample_size == 0.
        let size = child_box(d, ss, se, b"stsz").and_then(|(zs, _)| {
            let fixed = be_u32(d, zs + 4)?;
            if fixed != 0 {
                Some(fixed as u64)
            } else {
                let count = be_u32(d, zs + 8)?;
                if count == 0 {
                    return None;
                }
                be_u32(d, zs + 12).map(|v| v as u64)
            }
        });
        // stco / co64 (full box): ver/flags u32, entry_count u32, then offsets.
        let offset = child_box(d, ss, se, b"stco")
            .and_then(|(cs, _)| {
                if be_u32(d, cs + 4)? == 0 {
                    return None;
                }
                be_u32(d, cs + 8).map(|v| v as u64)
            })
            .or_else(|| {
                child_box(d, ss, se, b"co64").and_then(|(cs, _)| {
                    if be_u32(d, cs + 4)? == 0 {
                        return None;
                    }
                    be_u64(d, cs + 8)
                })
            });

        if let (Some(off), Some(len)) = (offset, size) {
            if len > 0 && best.is_none_or(|(bo, _)| off < bo) {
                best = Some((off, len));
            }
        }
    }
    best
}

/// Open `path` and read its first `n` bytes (or the whole file if shorter) in a
/// single syscall. Returns the buffer, the still-open file (cursor left at the
/// end of the read, ready for sequential growth) and the file length.
fn read_head(path: &str, n: usize) -> std::io::Result<(Vec<u8>, File, usize)> {
    let mut f = File::open(path)?;
    let flen = f.metadata()?.len() as usize;
    let mut buf = vec![0u8; flen.min(n)];
    f.read_exact(&mut buf)?;
    Ok((buf, f, flen))
}

/// Append up to `by` more bytes (clamped to EOF) to `buf` with one sequential
/// read. Relies on the file cursor sitting at `buf.len()` — true after
/// `read_head` and successive `grow`s, since we never seek elsewhere. Returns
/// false when already at EOF.
fn grow(f: &mut File, buf: &mut Vec<u8>, by: usize, flen: usize) -> std::io::Result<bool> {
    let cur = buf.len();
    if cur >= flen {
        return Ok(false);
    }
    let target = (cur + by).min(flen);
    buf.resize(target, 0);
    f.read_exact(&mut buf[cur..target])?;
    Ok(true)
}

/// Walk a JPEG's marker segments from its SOI to the byte index just past its
/// EOI (exclusive). Skips APPn segments by length — crucially the EXIF
/// thumbnail's own SOI/EOI nested inside APP1 — then scans the entropy stream
/// after SOS for the real FF D9. Returns None if `d` doesn't yet hold the whole
/// image, so the caller can read more. Assumes a baseline stream (Canon's
/// embedded JPEGs are SOF0): in entropy, FF is only ever followed by 00
/// (stuffing) or D0–D7 (restart).
fn jpeg_extent(d: &[u8], soi: usize) -> Option<usize> {
    let mut i = soi.checked_add(2)?;
    loop {
        if i + 1 >= d.len() {
            return None;
        }
        if d[i] != 0xFF {
            return None;
        }
        let mut k = i + 1;
        while d[k] == 0xFF {
            k += 1;
            if k >= d.len() {
                return None;
            }
        }
        let marker = d[k];
        i = k + 1;
        match marker {
            0xD9 => return Some(i),         // EOI
            0xDA => break,                  // SOS → entropy data follows
            0x01 | 0xD0..=0xD7 => continue, // standalone markers, no length
            _ => {
                if i + 1 >= d.len() {
                    return None;
                }
                let len = ((d[i] as usize) << 8) | (d[i + 1] as usize);
                if len < 2 {
                    return None;
                }
                i = i.checked_add(len)?;
            }
        }
    }
    // `i` is at the SOS segment's length field; skip the SOS header to the entropy.
    if i + 1 >= d.len() {
        return None;
    }
    let sos_len = ((d[i] as usize) << 8) | (d[i + 1] as usize);
    if sos_len < 2 {
        return None;
    }
    i = i.checked_add(sos_len)?;
    // Entropy stream: scan for the real FF D9 (EOI), skipping FF 00 stuffing and
    // FF D0–D7 restart markers. memchr (SIMD) jumps between FF bytes instead of
    // touching every byte of the multi-MB stream — the per-image hot loop.
    while i + 1 < d.len() {
        let rel = memchr::memchr(0xFF, &d[i..d.len() - 1])?;
        let p = i + rel; // p + 1 < d.len() guaranteed (searched only up to len-1)
        match d[p + 1] {
            0xD9 => return Some(p + 2), // EOI
            0xFF => i = p + 1,          // fill byte before next marker
            _ => i = p + 2,             // 00 stuffing / D0–D7 restart
        }
    }
    None
}

/// Grow `buf` (reading sequentially from `f`) until the first complete JPEG at
/// the head of `mdat` is present, then return it. Falls back to the PRVW preview
/// if `mdat` carries no JPEG. The full-res JPEG (≈32 MP on R6-class bodies) is
/// the first item inside `mdat`, ahead of the CRAW payload, so this reads only a
/// little past it — never the bulky RAW. INVARIANT: read-only.
fn read_fullres_from(f: &mut File, buf: &mut Vec<u8>, flen: usize) -> std::io::Result<Vec<u8>> {
    const GROW: usize = 8 << 20;
    const MAX_JPEG: usize = 64 << 20; // safety cap against a runaway scan
    loop {
        if let Some(mstart) = top_box_content_start(buf, b"mdat") {
            let window_full = buf.len() >= mstart + 8192;
            let scan_hi = (mstart + 8192).min(buf.len());
            match find_soi(buf, mstart, scan_hi) {
                Some(soi) => {
                    if let Some(end) = jpeg_extent(buf, soi) {
                        return Ok(buf[soi..end].to_vec()); // common path: complete
                    }
                    // SOI present but the JPEG runs past the buffer — read more.
                }
                None if window_full => break, // mdat has no leading JPEG → PRVW
                None => {}                     // mdat just reached buffer tail → read more
            }
        }
        if buf.len() >= flen.min(MAX_JPEG) || !grow(f, buf, GROW, flen)? {
            break;
        }
    }
    preview_jpeg(buf).ok_or_else(|| io_err("no embedded JPEG"))
}

/// Everything one CR3 open yields for the main view: the full-res preview and
/// EXIF/AF metadata, parsed from a single bounded read. (Filmstrip thumbnails are
/// fetched separately via `read_thumbnail` through their own bounded pool, so they
/// don't ride the 12 MB bundle read.)
pub struct Bundle {
    pub preview: Vec<u8>, // full-res (or PRVW fallback) JPEG, EXIF-oriented
    pub meta: Cr3Meta,
    pub orientation: u32,
    /// CR3 byte length — obtained from the already-open handle during the read,
    /// so the IPC handler doesn't need a second `std::fs::metadata` stat (an extra
    /// NAS round-trip per full read).
    pub file_size: u64,
}

/// Read preview + metadata from ONE file open and (usually) ONE read. On the
/// high-latency NAS this app culls from, per-file round-trips dominate, so
/// collapsing the old opens + ~dozen seeks into a single large read is the
/// headline win. The head almost always holds ftyp, moov (giving metadata) and
/// the full-res JPEG at the start of mdat; the JPEG reader grows the buffer only
/// in the rare case it spills past the head. INVARIANT: read-only.
pub fn read_bundle(path: &str) -> std::io::Result<Bundle> {
    const HEAD: usize = 12 << 20; // ftyp + moov + preview uuid + most full-res JPEGs
    // Bound on how far we'll grow the buffer hunting for moov: a malformed file
    // with no moov box must not be read in its entirety into RAM (OOM/DoS). moov
    // sits near the front of any real CR3, so 64 MiB is generous.
    const MOOV_SCAN_CAP: usize = 64 << 20;
    let (mut buf, mut f, flen) = read_head(path, HEAD)?;

    // Ensure the (small) moov box is fully buffered before parsing it.
    while moov_range(&buf).is_none() && buf.len() < MOOV_SCAN_CAP && grow(&mut f, &mut buf, 4 << 20, flen)? {}

    let meta = metadata_from_prefix(&buf);
    let orient = meta.orientation; // parsed once in metadata_from_prefix; reuse it
    let preview = with_exif_orientation(read_fullres_from(&mut f, &mut buf, flen)?, orient);

    Ok(Bundle { preview, meta, orientation: orient, file_size: flen as u64 })
}

/// Everything one ~2 MiB head read yields for the NAVIGATION tier (Phase 2):
/// the 1620×1080 PRVW preview, full metadata, and the exact-range hint for the
/// zoom tier's mdat JPEG — all from ONE open and (usually) ONE read.
pub struct PreviewBundle {
    pub preview: Vec<u8>, // PRVW JPEG, EXIF-oriented
    pub meta: Cr3Meta,
    pub orientation: u32,
    pub file_size: u64,
    /// (offset, length) of the full-res mdat JPEG per moov's sample tables;
    /// `None` when the tables don't yield one (read_fullres falls back to the
    /// scan). Validated at read time — see [`read_fullres_at`].
    pub full_hint: Option<(u64, u64)>,
}

/// Navigation hot path (Phase 2): ONE open, ONE ~2 MiB read capturing
/// ftyp + moov + the PRVW uuid box (layout doc above) — growing only when one
/// of them spills past the head (instrument: rare on R6-class bodies). The
/// 32.5 MP mdat JPEG is NOT read here at all; its exact range ships back as a
/// hint for the zoom tier. `cancelled` is checked between grow chunks so a
/// superseded navigation dies within ~one chunk instead of finishing a
/// multi-MB read. INVARIANT: read-only.
pub fn read_preview_bundle(
    path: &str,
    cancelled: &dyn Fn() -> bool,
) -> std::io::Result<PreviewBundle> {
    const HEAD: usize = 2 << 20;
    const GROW: usize = 2 << 20;
    const SCAN_CAP: usize = 64 << 20; // malformed-input bound (no moov → no OOM)
    let (mut buf, mut f, flen) = read_head(path, HEAD)?;

    // Grow until moov AND the preview uuid are fully buffered. `boxes()` only
    // yields fully-contained boxes, so "present" ⟺ "complete". Seeing mdat's
    // box header means every preceding top-level box is complete — if PRVW
    // hasn't shown by then it does not exist (don't grow into the RAW payload).
    loop {
        let have_moov = moov_range(&buf).is_some();
        let have_prvw = boxes(&buf, 0, buf.len())
            .into_iter()
            .any(|(fcc, cs, ce)| &fcc == b"uuid" && ce - cs >= 16 && buf[cs..cs + 16] == PREVIEW_UUID);
        if (have_moov && have_prvw) || top_box_content_start(&buf, b"mdat").is_some() {
            break;
        }
        if cancelled() {
            return Err(cancelled_err());
        }
        if buf.len() >= SCAN_CAP || !grow(&mut f, &mut buf, GROW, flen)? {
            break;
        }
    }

    let meta = metadata_from_prefix(&buf);
    let orient = meta.orientation;
    let full_hint = moov_range(&buf).and_then(|(ms, me)| full_jpeg_location(&buf, ms, me));
    // Edge contract: PRVW absent (other bodies/firmware) → Err("no PRVW"); the
    // frontend marks the PATH previewUnavailable and routes its nav tier to full.
    let prvw = preview_jpeg(&buf).ok_or_else(|| io_err("no PRVW"))?;
    Ok(PreviewBundle {
        preview: with_exif_orientation(prvw, orient),
        meta,
        orientation: orient,
        file_size: flen as u64,
        full_hint,
    })
}

/// Distinct error for generation-cancelled reads, so command handlers can
/// tell "superseded, drop quietly" from a real failure (which falls back).
fn cancelled_err() -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::Interrupted, "cancelled")
}

/// True when an io::Error is the cancellation sentinel from `cancelled_err`.
/// Checks kind AND message: `read_exact` already retries OS-level EINTR
/// internally, but `File::open` does not — an astronomically-rare genuine
/// Interrupted from the OS must not masquerade as our cancellation.
pub fn is_cancelled(e: &std::io::Error) -> bool {
    e.kind() == std::io::ErrorKind::Interrupted && e.to_string() == "cancelled"
}

/// Zoom tier (Phase 2): seek + ONE exact-range read of the full-res mdat JPEG
/// using the moov hint — no 12 MiB head, no grow-loop scan. Read in ≤2 MiB
/// chunks with a cancellation check between chunks (a superseded zoom dies
/// within ~one chunk). Validation per the edge contract: SOI at byte 0 of the
/// hinted range AND `jpeg_extent` confirming EOI inside it — anything else is
/// an InvalidData error the caller answers with the legacy scan fallback.
/// INVARIANT: read-only.
pub fn read_fullres_at(
    path: &str,
    offset: u64,
    len: u64,
    cancelled: &dyn Fn() -> bool,
) -> std::io::Result<Vec<u8>> {
    use std::io::{Seek, SeekFrom};
    const CHUNK: usize = 2 << 20;
    const MAX_JPEG: u64 = 64 << 20; // same runaway cap as the scan path
    if len == 0 || len > MAX_JPEG {
        return Err(io_err("implausible full-res hint"));
    }
    let mut f = File::open(path)?;
    f.seek(SeekFrom::Start(offset))?;
    let mut buf = vec![0u8; len as usize];
    let mut done = 0usize;
    while done < buf.len() {
        if cancelled() {
            return Err(cancelled_err());
        }
        let end = (done + CHUNK).min(buf.len());
        f.read_exact(&mut buf[done..end])?;
        done = end;
    }
    if buf.len() < 2 || buf[0] != 0xFF || buf[1] != 0xD8 {
        return Err(io_err("hint mismatch: no SOI at hinted offset"));
    }
    let Some(end) = jpeg_extent(&buf, 0) else {
        return Err(io_err("hint mismatch: no EOI inside hinted range"));
    };
    buf.truncate(end);
    Ok(buf)
}

/// Locate the full-res mdat range + orientation from a ~2 MiB moov head —
/// the cheap prelude for HINTLESS full reads (Phase 8's idle sweep generates
/// mids for paths whose preview was never read, so no echoed hint exists):
/// ~2 MiB + one exact-range read instead of resurrecting the 12 MiB+ grow
/// scan as a common path. Returns `(range hint, orientation)`; a `None` hint
/// (or any later range-validation failure) falls back to the scan as usual.
/// INVARIANT: read-only.
pub fn locate_fullres(
    path: &str,
    cancelled: &dyn Fn() -> bool,
) -> std::io::Result<(Option<(u64, u64)>, u32)> {
    const HEAD: usize = 2 << 20;
    const GROW: usize = 2 << 20;
    const SCAN_CAP: usize = 64 << 20; // malformed-input bound (no moov → no OOM)
    let (mut buf, mut f, flen) = read_head(path, HEAD)?;
    while moov_range(&buf).is_none() && buf.len() < SCAN_CAP {
        if cancelled() {
            return Err(cancelled_err());
        }
        if !grow(&mut f, &mut buf, GROW, flen)? {
            break;
        }
    }
    let orientation = metadata_from_prefix(&buf).orientation;
    let hint = moov_range(&buf).and_then(|(ms, me)| full_jpeg_location(&buf, ms, me));
    Ok((hint, orientation))
}

/// Legacy scan fallback for the zoom tier: the pre-hint head+grow mdat scan,
/// kept as the validation net for any future body that lays out mdat
/// differently. Rare path — no chunked cancellation (it rides read_bundle's
/// proven machinery unchanged). Returns the file's own EXIF orientation too:
/// the moov is already in the head buffer, and a hintless caller has no echo
/// to splice — stamping orientation 1 on a rotated frame would poison the
/// cached blob with unrotated pixels (the portrait-zoom bug from the macOS
/// manual matrix).
pub fn read_fullres_scan(path: &str) -> std::io::Result<(Vec<u8>, u32)> {
    const HEAD: usize = 12 << 20;
    const MOOV_SCAN_CAP: usize = 64 << 20;
    let (mut buf, mut f, flen) = read_head(path, HEAD)?;
    while moov_range(&buf).is_none() && buf.len() < MOOV_SCAN_CAP && grow(&mut f, &mut buf, 4 << 20, flen)? {}
    let orientation = metadata_from_prefix(&buf).orientation;
    let jpeg = read_fullres_from(&mut f, &mut buf, flen)?;
    Ok((jpeg, orientation))
}

/// What one thumbnail read yields: the (EXIF-oriented) THMB JPEG, the
/// orientation, and the DISPLAY pixel dimensions (orientation-adjusted) so the
/// UI can set the correct aspect ratio for a frame before any raster decodes.
pub struct Thumbnail {
    pub jpeg: Vec<u8>,
    /// Read by tests (assert thumb/preview orientation agree); the production
    /// path doesn't need it — the JPEG is already EXIF-oriented and the display
    /// dims below are orientation-adjusted.
    #[allow(dead_code)]
    pub orientation: u32,
    pub width: Option<u32>,
    pub height: Option<u32>,
    /// Full metadata — the moov head was already parsed for orientation/dims,
    /// so the complete `Cr3Meta` is free (Phase 2 metadata fast path: EXIF
    /// rail / status-bar MP populate when the THUMB lands, not the full).
    pub meta: Cr3Meta,
}

/// Display dimensions: the EXIF sensor `pixel_width/height` are stored in the
/// UNrotated sensor frame; only the 90°/270° orientations (6/8) — the ones
/// `with_exif_orientation` actually rotates — display transposed, so swap for
/// those alone. (Mirror orientations 2/4/5/7 are never emitted by Canon and are
/// passed through un-rotated, so they must NOT swap or the placeholder aspect
/// would disagree with the painted JPEG.)
fn display_dims(orient: u32, pw: Option<u32>, ph: Option<u32>) -> (Option<u32>, Option<u32>) {
    match orient {
        6 | 8 => (ph, pw),
        _ => (pw, ph),
    }
}

/// Extract the filmstrip thumbnail + orientation + the display dimensions. THMB
/// lives in moov near the file start, so this reads a small head, growing only
/// if an unusually large moov spills past it. Used for strip cells outside the
/// preview-prefetch window.
pub fn read_thumbnail(path: &str) -> std::io::Result<Thumbnail> {
    const HEAD: usize = 1 << 20; // moov (with THMB) virtually always fits in 1 MiB
    const MOOV_SCAN_CAP: usize = 64 << 20; // bound the hunt on malformed input (OOM/DoS)
    let (mut buf, mut f, flen) = read_head(path, HEAD)?;
    while moov_range(&buf).is_none() && buf.len() < MOOV_SCAN_CAP && grow(&mut f, &mut buf, 2 << 20, flen)? {}
    let raw = thumbnail_from_prefix(&buf).ok_or_else(|| io_err("no thumbnail box"))?;
    // The moov head already holds the CMT TIFF, so orientation + EXIF pixel dims
    // — and with them the whole Cr3Meta — come free.
    let meta = metadata_from_prefix(&buf);
    let orient = meta.orientation;
    let (width, height) = display_dims(orient, meta.pixel_width, meta.pixel_height);
    Ok(Thumbnail {
        jpeg: with_exif_orientation(raw, orient),
        orientation: orient,
        width,
        height,
        meta,
    })
}

// ── Native EXIF + AF metadata (replaces the exiftool subprocess) ─────────────

/// Subset of EXIF the app needs, parsed straight from the CR3's CMT TIFF blobs.
/// Every field is optional — not every CR3 carries every tag (GPS especially).
#[derive(Default)]
pub struct Cr3Meta {
    pub captured_at: Option<String>, // "YYYY-MM-DDTHH:MM:SS" (camera local clock)
    pub sub_sec_ms: Option<u16>,     // SubSecTimeOriginal (0x9291) as ms — burst cadence
    pub camera: Option<String>,
    pub lens: Option<String>,
    pub focal_length_mm: Option<f32>,
    pub aperture: Option<f32>,
    pub shutter_seconds: Option<f64>,
    pub iso: Option<u32>,
    pub gps_lat: Option<f64>,
    pub gps_lon: Option<f64>,
    pub af_x_pct: Option<f32>,
    pub af_y_pct: Option<f32>,
    pub exposure_bias: Option<f64>, // EV, signed (Exif 0x9204 ExposureBiasValue)
    pub white_balance: Option<u32>, // Exif 0xA403: 0 = auto, 1 = manual
    pub drive_mode: Option<u32>,    // Canon ContinuousDrive (0 = single, else continuous)
    pub pixel_width: Option<u32>,   // Exif 0xA002 PixelXDimension (main image)
    pub pixel_height: Option<u32>,  // Exif 0xA003 PixelYDimension
    pub orientation: u32,           // EXIF Orientation (CMT1 0x0112); 1 = upright
}

/// Parse EXIF + active-AF metadata from a prefix buffer that contains the moov
/// box (with its header) — i.e. the bundle buffer, so no extra file open.
/// CMT1 = IFD0 (Model, Orientation); CMT2 = Exif IFD (time/exposure/ISO/lens);
/// CMT3 = Canon MakerNote (AFInfo2); CMT4 = GPS IFD.
fn metadata_from_prefix(d: &[u8]) -> Cr3Meta {
    let mut m = Cr3Meta::default();
    let Some((ms, me)) = moov_range(d) else {
        m.orientation = 1; // no moov → upright fallback (matches a missing CMT1)
        return m;
    };
    // Locate CMT1 once; reuse the slice for both orientation and the camera tag.
    let cmt1 = cmt_in_uuid_range(d, ms, me, b"CMT1");
    m.orientation = orientation_from_cmt1(cmt1);

    if let Some(t) = cmt1.and_then(Tiff::new) {
        if let Some(ifd) = t.ifd0() {
            m.camera = t.ascii(ifd, 0x0110);
        }
    }
    if let Some(t) = cmt_in_uuid_range(d, ms, me, b"CMT2").and_then(Tiff::new) {
        if let Some(ifd) = t.ifd0() {
            m.captured_at = t.ascii(ifd, 0x9003).map(|s| normalize_datetime(&s));
            m.sub_sec_ms = t.ascii(ifd, 0x9291).as_deref().and_then(sub_sec_to_ms);
            m.lens = t.ascii(ifd, 0xA434);
            m.focal_length_mm = t.rational(ifd, 0x920A).map(|x| x as f32);
            m.aperture = t.rational(ifd, 0x829D).map(|x| x as f32);
            m.shutter_seconds = t.rational(ifd, 0x829A);
            m.iso = t.uint(ifd, 0x8827);
            m.exposure_bias = t.rational(ifd, 0x9204); // ExposureBiasValue (SRATIONAL)
            m.white_balance = t.uint(ifd, 0xA403); // 0 = auto, 1 = manual
            m.pixel_width = t.uint(ifd, 0xA002); // PixelXDimension (main image)
            m.pixel_height = t.uint(ifd, 0xA003); // PixelYDimension
        }
    }
    if let Some(t) = cmt_in_uuid_range(d, ms, me, b"CMT4").and_then(Tiff::new) {
        if let Some(ifd) = t.ifd0() {
            m.gps_lat = gps_coord(&t, ifd, 0x0002, 0x0001);
            m.gps_lon = gps_coord(&t, ifd, 0x0004, 0x0003);
        }
    }
    if let Some(t) = cmt_in_uuid_range(d, ms, me, b"CMT3").and_then(Tiff::new) {
        if let Some((x, y)) = af_display(&t, m.orientation) {
            m.af_x_pct = Some(x);
            m.af_y_pct = Some(y);
        }
        m.drive_mode = canon_drive_mode(&t);
    }
    m
}

/// Canon ContinuousDrive from the MakerNote CameraSettings array (tag 0x0001, a
/// SHORT array; ContinuousDrive sits at index 5 — index 0 is the record's byte
/// count — per exiftool's long-stable layout). Returns the raw value; the UI maps
/// 0 → single, non-zero → continuous (we don't claim the exact sub-mode).
fn canon_drive_mode(cmt3: &Tiff) -> Option<u32> {
    let ifd = cmt3.ifd0()?;
    let (typ, cnt, voff) = cmt3.find_entry(ifd, 0x0001)?;
    if typ != 3 || (cnt as usize) <= 5 {
        return None;
    }
    cmt3.u16(voff + 2 * 5).map(|v| v as u32)
}

/// THMB thumbnail JPEG located within the moov box of a prefix buffer.
fn thumbnail_from_prefix(d: &[u8]) -> Option<Vec<u8>> {
    let (ms, me) = moov_range(d)?;
    jpeg_in_box(d, ms, me, b"THMB")
}

/// EXIF SubSecTimeOriginal ("47" = 0.47 s) → milliseconds (470). Digits only;
/// more than 3 digits truncate (ms precision is all burst grouping needs).
fn sub_sec_to_ms(s: &str) -> Option<u16> {
    let digits = s.trim_end_matches(' ');
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let ms: u16 = digits
        .bytes()
        .take(3)
        .enumerate()
        .map(|(i, b)| (b - b'0') as u16 * [100, 10, 1][i])
        .sum();
    Some(ms)
}

/// "2025:10:13 18:07:30" → "2025-10-13T18:07:30". Pass-through if unexpected.
fn normalize_datetime(s: &str) -> String {
    let b = s.as_bytes();
    // Require the canonical ASCII "YYYY:MM:DD HH:MM:SS" shape across the first 19
    // bytes before slicing. `is_ascii()` guarantees every index 0..=19 is a char
    // boundary, so a malformed/non-ASCII value (e.g. a multibyte char straddling
    // byte 19 after from_utf8_lossy) falls through to pass-through instead of
    // panicking on a mid-char slice.
    if b.len() >= 19 && b[..19].is_ascii() && b[4] == b':' && b[7] == b':' && b[10] == b' ' {
        format!("{}-{}-{}T{}", &s[0..4], &s[5..7], &s[8..10], &s[11..19])
    } else {
        s.to_string()
    }
}

/// One GPS coordinate from a CMT4 GPS IFD: RATIONAL deg/min/sec + ASCII ref →
/// signed decimal degrees (S/W negative). None if the value tag is absent.
fn gps_coord(t: &Tiff, ifd: usize, val_tag: u16, ref_tag: u16) -> Option<f64> {
    let parts = t.rationals(ifd, val_tag);
    if parts.is_empty() {
        return None;
    }
    let deg = parts.first().copied().unwrap_or(0.0)
        + parts.get(1).copied().unwrap_or(0.0) / 60.0
        + parts.get(2).copied().unwrap_or(0.0) / 3600.0;
    let neg = matches!(
        t.ascii(ifd, ref_tag).and_then(|s| s.chars().next()),
        Some('S') | Some('s') | Some('W') | Some('w')
    );
    Some(if neg { -deg } else { deg })
}

/// Active AF point → displayed-image coordinates (0-100%, top-left origin).
///
/// Canon's AFInfo2 (MakerNote tag 0x0026) is a SHORT array whose position
/// entries are two's-complement signed, in the SENSOR (landscape) frame with an
/// image-CENTER origin and Y positive-UP (verified against R6 III samples). We
/// centroid the active areas, convert to top-left %, then rotate by the EXIF
/// orientation so the point lands on the rotated preview the UI shows.
///
/// AFInfo2 layout (i = SHORT index): [2]=NumAFPoints N, [6]=AFImageWidth,
/// [7]=AFImageHeight, [8+2N..8+3N]=AFAreaXPositions, [8+3N..8+4N]=AFAreaYPositions.
fn af_display(cmt3: &Tiff, orientation: u32) -> Option<(f32, f32)> {
    let ifd = cmt3.ifd0()?;
    let (typ, cnt, voff) = cmt3.find_entry(ifd, 0x0026)?;
    let cnt = cnt as usize;
    if typ != 3 || cnt < 8 {
        return None;
    }
    let at = |k: usize| cmt3.u16(voff + 2 * k);
    let n = at(2)? as usize;
    let img_w = at(6)? as f64;
    let img_h = at(7)? as f64;
    if n == 0 || img_w <= 0.0 || img_h <= 0.0 || cnt < 8 + 4 * n {
        return None;
    }
    let (x_base, y_base) = (8 + 2 * n, 8 + 3 * n);

    // Centroid of active areas — a non-zero position marks an in-use AF area;
    // unused slots are padded with (0, 0).
    let (mut sx, mut sy, mut count) = (0i64, 0i64, 0i64);
    for k in 0..n {
        let x = at(x_base + k)? as i16 as i64;
        let y = at(y_base + k)? as i16 as i64;
        if x != 0 || y != 0 {
            sx += x;
            sy += y;
            count += 1;
        }
    }
    if count == 0 {
        return None;
    }
    let cx = sx as f64 / count as f64;
    let cy = sy as f64 / count as f64;

    // Sensor center-origin → top-left %. X positive-right, Y positive-UP.
    let px = ((img_w / 2.0 + cx) / img_w * 100.0) as f32;
    let py = ((img_h / 2.0 - cy) / img_h * 100.0) as f32;
    let (dx, dy) = orient_point(px, py, orientation);
    Some((dx.clamp(0.0, 100.0), dy.clamp(0.0, 100.0)))
}

/// Map a point (0-100%) from the stored sensor frame to the displayed frame
/// after the EXIF-orientation rotation the UI applies.
fn orient_point(x: f32, y: f32, orientation: u32) -> (f32, f32) {
    match orientation {
        3 => (100.0 - x, 100.0 - y), // 180°
        6 => (100.0 - y, x),         // 90° CW
        8 => (y, 100.0 - x),         // 270° CW
        _ => (x, y),                 // 1 (and unhandled mirror flips)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::codecs::jpeg::{JpegDecoder, JpegEncoder};
    use image::{DynamicImage, ImageDecoder, RgbImage};
    use std::io::Cursor;

    /// A small valid baseline (landscape, no EXIF) JPEG to exercise injection.
    fn sample_jpeg() -> Vec<u8> {
        let img = RgbImage::from_fn(64, 32, |x, _| image::Rgb([(x * 3) as u8, 9, 200]));
        let mut bytes = Vec::new();
        JpegEncoder::new_with_quality(&mut bytes, 90)
            .encode_image(&DynamicImage::ImageRgb8(img))
            .expect("encode sample jpeg");
        bytes
    }

    /// EXIF orientation a JPEG decoder reads back (1 when absent).
    fn exif_orientation_of(jpeg: &[u8]) -> u8 {
        let mut dec = JpegDecoder::new(Cursor::new(jpeg)).expect("decode header");
        dec.orientation().expect("read orientation").to_exif()
    }

    // The webview rotates previews via the EXIF Orientation tag we splice in. This
    // validates that splice against image's INDEPENDENT EXIF parser — the same
    // logic Chromium uses — so we can trust it without a real CR3 on hand.
    #[test]
    fn injects_exif_orientation_that_a_decoder_reads_back() {
        let base = sample_jpeg();
        assert_eq!(exif_orientation_of(&base), 1, "fresh encode is upright");

        for o in [3u32, 6, 8] {
            let oriented = with_exif_orientation(base.clone(), o);
            assert_eq!(&oriented[..2], &[0xFF, 0xD8], "SOI preserved");
            assert_eq!(
                exif_orientation_of(&oriented),
                o as u8,
                "decoder must read back orientation {o}"
            );
            image::load_from_memory(&oriented).expect("oriented jpeg still decodes");
        }

        // Orientation 1 (and mirror flips we never emit) pass through untouched.
        assert_eq!(with_exif_orientation(base.clone(), 1), base, "upright untouched");
        assert_eq!(with_exif_orientation(base.clone(), 2), base, "mirror untouched");
    }

    // Re-injecting must REPLACE, not stack, EXIF segments.
    #[test]
    fn reinjection_replaces_existing_exif() {
        let twice = with_exif_orientation(with_exif_orientation(sample_jpeg(), 6), 8);
        assert_eq!(exif_orientation_of(&twice), 8);
        let single = with_exif_orientation(sample_jpeg(), 8);
        assert_eq!(twice.len(), single.len(), "old EXIF stripped, not stacked");
    }

    // Validates the full bundle against a real CR3. Gated on an env var so it only
    // runs when pointed at a file: `CULL_TEST_CR3=path cargo test`.
    #[test]
    fn bundle_extracts_preview_thumbnail_and_metadata() {
        let Ok(path) = std::env::var("CULL_TEST_CR3") else {
            eprintln!("skip: set CULL_TEST_CR3 to a .CR3 path to run this test");
            return;
        };
        let b = read_bundle(&path).expect("read_bundle failed");
        assert_eq!(&b.preview[..2], &[0xFF, 0xD8], "preview missing SOI");
        assert_eq!(&b.preview[b.preview.len() - 2..], &[0xFF, 0xD9], "preview missing EOI");
        let img = image::load_from_memory(&b.preview).expect("preview decode failed");
        // Thumbnail is now a separate read (its own pool), not part of the bundle.
        let tn = read_thumbnail(&path).expect("read_thumbnail failed");
        let (thumb, torient) = (tn.jpeg, tn.orientation);
        eprintln!(
            "preview {}x{}, {} B, orient {}; thumb {} B; camera {:?}",
            img.width(), img.height(), b.preview.len(), b.orientation, thumb.len(), b.meta.camera,
        );
        // Sensor frame is landscape regardless of how the shot was framed.
        assert!(
            img.width() >= 6000 && img.height() >= 4000,
            "not full resolution: {}x{}", img.width(), img.height()
        );
        // The spliced tag must match the CR3's CMT1 orientation.
        if matches!(b.orientation, 3 | 6 | 8) {
            assert_eq!(exif_orientation_of(&b.preview), b.orientation as u8);
        }
        assert_eq!(torient, b.orientation, "thumb/preview orientation agree");
        assert!(thumb.starts_with(&[0xFF, 0xD8]), "thumb missing SOI");
    }

    /// SubSecTimeOriginal is an ASCII fraction of a second with camera-defined
    /// digit count; burst grouping needs milliseconds. Trailing spaces are the
    /// EXIF padding convention.
    #[test]
    fn sub_sec_converts_fraction_digits_to_ms() {
        assert_eq!(sub_sec_to_ms("4"), Some(400), "one digit = tenths");
        assert_eq!(sub_sec_to_ms("47"), Some(470), "two digits = hundredths");
        assert_eq!(sub_sec_to_ms("473"), Some(473), "three digits = ms");
        assert_eq!(sub_sec_to_ms("4738"), Some(473), "extra precision truncates");
        assert_eq!(sub_sec_to_ms("47 "), Some(470), "EXIF space padding tolerated");
        assert_eq!(sub_sec_to_ms("000"), Some(0), "zero is a real value, not absent");
        assert_eq!(sub_sec_to_ms(""), None, "empty = absent");
        assert_eq!(sub_sec_to_ms("  "), None, "only padding = absent");
        assert_eq!(sub_sec_to_ms("x7"), None, "non-digit garbage = absent");
    }

    /// display_dims swaps width/height for the 90°/270° orientations (6/8) only —
    /// the ones with_exif_orientation actually rotates. 1/3 (upright/180°) and the
    /// never-emitted, un-rotated mirror values 5/7 must NOT swap.
    #[test]
    fn display_dims_swaps_for_rotated_orientations() {
        assert_eq!(display_dims(1, Some(6000), Some(4000)), (Some(6000), Some(4000)));
        assert_eq!(display_dims(3, Some(6000), Some(4000)), (Some(6000), Some(4000)));
        assert_eq!(display_dims(6, Some(6000), Some(4000)), (Some(4000), Some(6000)));
        assert_eq!(display_dims(8, Some(6000), Some(4000)), (Some(4000), Some(6000)));
        // Mirror orientations are passed through un-rotated, so dims stay as-is.
        assert_eq!(display_dims(5, Some(6000), Some(4000)), (Some(6000), Some(4000)));
        assert_eq!(display_dims(7, Some(6000), Some(4000)), (Some(6000), Some(4000)));
    }

    // Exercises read_bundle over every .CR3 in a directory, validating each and
    // printing a table — useful for confirming the single-read assumption holds
    // across a real shoot. Gated: `CULL_TEST_CR3_DIR=path cargo test -- --nocapture`.
    #[test]
    fn bundle_over_sample_dir() {
        let Ok(dir) = std::env::var("CULL_TEST_CR3_DIR") else {
            eprintln!("skip: set CULL_TEST_CR3_DIR to a folder of .CR3 files");
            return;
        };
        let mut paths: Vec<_> = std::fs::read_dir(&dir)
            .expect("read dir")
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("cr3")))
            .collect();
        paths.sort();
        assert!(!paths.is_empty(), "no CR3 files in {dir}");

        eprintln!("{:<16} {:>5} {:>6} {:>6} {:>8} {:>7}", "file", "orient", "MP", "thmbKB", "prevKB", "fit1read");
        for p in &paths {
            let ps = p.to_string_lossy().to_string();
            let b = read_bundle(&ps).unwrap_or_else(|e| panic!("read_bundle({ps}): {e}"));

            // Preview is a valid JPEG at full sensor resolution.
            assert_eq!(&b.preview[..2], &[0xFF, 0xD8], "{ps}: preview SOI");
            assert_eq!(&b.preview[b.preview.len() - 2..], &[0xFF, 0xD9], "{ps}: preview EOI");
            let img = image::load_from_memory(&b.preview).unwrap_or_else(|e| panic!("{ps}: decode {e}"));
            assert!(img.width() >= 6000 && img.height() >= 4000, "{ps}: {}x{}", img.width(), img.height());

            // The thumbnail (separate read) is a real, EXIF-oriented JPEG.
            let tn = read_thumbnail(&ps).unwrap_or_else(|e| panic!("{ps}: thumb {e}"));
            let (thumb, torient) = (tn.jpeg, tn.orientation);
            assert!(thumb.starts_with(&[0xFF, 0xD8]), "{ps}: thumbnail missing/!JPEG");
            if matches!(b.orientation, 3 | 6 | 8) {
                assert_eq!(exif_orientation_of(&b.preview), b.orientation as u8, "{ps}: preview orient");
                assert_eq!(exif_orientation_of(&thumb), torient as u8, "{ps}: thumb orient");
            }

            // Did the full-res JPEG fit inside the 12 MiB head (no grow)? It does
            // if preview bytes + the small moov/preview-uuid prefix stay under it.
            let fit = b.preview.len() + (2 << 20) <= (12 << 20);
            eprintln!(
                "{:<16} {:>5} {:>5.1} {:>6} {:>8} {:>7}",
                p.file_name().unwrap().to_string_lossy(),
                b.orientation,
                (img.width() as f64 * img.height() as f64) / 1.0e6,
                thumb.len() / 1024,
                b.preview.len() / 1024,
                if fit { "yes" } else { "GREW" },
            );
            // Print EXIF extras to eyeball against known values.
            eprintln!(
                "    exif {:?}x{:?}  eV={:?}  wb={:?}  drive={:?}",
                b.meta.pixel_width, b.meta.pixel_height,
                b.meta.exposure_bias, b.meta.white_balance, b.meta.drive_mode,
            );
        }
    }

    // Edge contract: a CR3-shaped file with NO preview uuid (other bodies /
    // firmware) must fail fast with "no PRVW" — and must NOT grow-scan into
    // the (potentially huge) mdat payload hunting for one.
    #[test]
    fn preview_bundle_errs_no_prvw_without_scanning_mdat() {
        let mut d = Vec::new();
        d.extend_from_slice(&16u32.to_be_bytes());
        d.extend_from_slice(b"ftyp");
        d.extend_from_slice(&[0u8; 8]);
        d.extend_from_slice(&8u32.to_be_bytes());
        d.extend_from_slice(b"moov"); // empty moov — present is what matters
        d.extend_from_slice(&16u32.to_be_bytes());
        d.extend_from_slice(b"mdat");
        d.extend_from_slice(&[0u8; 8]);
        let p = std::env::temp_dir().join(format!("cull-noprvw-{}.cr3", std::process::id()));
        std::fs::write(&p, &d).unwrap();
        let err = read_preview_bundle(&p.to_string_lossy(), &|| false)
            .err()
            .expect("expected the no-PRVW error");
        assert!(err.to_string().contains("no PRVW"), "got: {err}");
        let _ = std::fs::remove_file(&p);
    }

    // Range-read edge contract: SOI/EOI validation, mismatch errors (the
    // command layer answers those with the scan fallback), and cancellation.
    #[test]
    fn read_fullres_at_validates_hint_and_honours_cancellation() {
        let jpeg = sample_jpeg();
        let off = 1024u64;
        let mut d = vec![0u8; off as usize];
        d.extend_from_slice(&jpeg);
        d.extend_from_slice(&[0u8; 512]); // trailing padding past EOI
        let p = std::env::temp_dir().join(format!("cull-range-{}.bin", std::process::id()));
        std::fs::write(&p, &d).unwrap();
        let ps = p.to_string_lossy().to_string();

        // Exact hint → the JPEG, truncated at its parsed EOI even when the
        // hinted length overshoots into padding.
        let got = read_fullres_at(&ps, off, jpeg.len() as u64 + 512, &|| false).unwrap();
        assert_eq!(got, jpeg);

        // Wrong offset → no SOI → InvalidData mismatch (not cancellation).
        let err = read_fullres_at(&ps, 0, jpeg.len() as u64, &|| false).unwrap_err();
        assert!(err.to_string().contains("no SOI"), "got: {err}");
        assert!(!is_cancelled(&err));

        // Truncated range (EOI outside) → mismatch.
        let err = read_fullres_at(&ps, off, (jpeg.len() - 4) as u64, &|| false).unwrap_err();
        assert!(err.to_string().contains("no EOI"), "got: {err}");

        // Cancelled before the first chunk → the Interrupted sentinel.
        let err = read_fullres_at(&ps, off, jpeg.len() as u64, &|| true).unwrap_err();
        assert!(is_cancelled(&err));

        let _ = std::fs::remove_file(&p);
    }

    // End-to-end over the corpus: the navigation-tier read yields a decodable
    // PRVW + a hint, and the hint feeds an exact-range read that yields the
    // same JPEG the legacy scan finds. Gated on CULL_TEST_CR3_DIR.
    #[test]
    fn preview_bundle_and_range_read_over_sample_dir() {
        let Ok(dir) = std::env::var("CULL_TEST_CR3_DIR") else {
            eprintln!("skip: set CULL_TEST_CR3_DIR to a folder of .CR3 files");
            return;
        };
        let mut paths: Vec<_> = walkdir::WalkDir::new(&dir)
            .into_iter()
            .flatten()
            .filter(|e| e.file_type().is_file())
            .map(|e| e.path().to_path_buf())
            .filter(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("cr3")))
            .collect();
        paths.sort();
        assert!(!paths.is_empty(), "no CR3 files under {dir}");

        for p in &paths {
            let ps = p.to_string_lossy().to_string();
            let b = read_preview_bundle(&ps, &|| false)
                .unwrap_or_else(|e| panic!("read_preview_bundle({ps}): {e}"));
            // PRVW is a real 1620-class JPEG.
            assert_eq!(&b.preview[..2], &[0xFF, 0xD8], "{ps}: PRVW SOI");
            let img = image::load_from_memory(&b.preview)
                .unwrap_or_else(|e| panic!("{ps}: PRVW decode {e}"));
            assert!(img.width() >= 1000, "{ps}: PRVW too small {}", img.width());
            // The hint feeds the exact-range read; the result matches the scan.
            let (off, len) = b.full_hint.unwrap_or_else(|| panic!("{ps}: no hint"));
            let ranged = read_fullres_at(&ps, off, len, &|| false)
                .unwrap_or_else(|e| panic!("{ps}: range read {e}"));
            let (scanned, scan_orient) = read_fullres_scan(&ps)
                .unwrap_or_else(|e| panic!("{ps}: scan {e}"));
            assert_eq!(ranged, scanned, "{ps}: ranged JPEG != scanned JPEG");
            // The scan's self-derived orientation must agree with the preview
            // header's (the hintless zoom path splices this one).
            assert_eq!(scan_orient, b.orientation, "{ps}: scan orientation");
        }
    }

    // THE Phase 2 hard validation gate (IMAGE_PIPELINE_PLAN.md): the moov
    // sample-table hint must agree with the mdat scan for EVERY corpus CR3
    // (subfolders included). No frontend work may depend on range-reads until
    // this passes on all samples. Gated on CULL_TEST_CR3_DIR.
    #[test]
    fn full_jpeg_location_hint_matches_mdat_scan_for_every_sample() {
        let Ok(dir) = std::env::var("CULL_TEST_CR3_DIR") else {
            eprintln!("skip: set CULL_TEST_CR3_DIR to a folder of .CR3 files");
            return;
        };
        let mut paths: Vec<_> = walkdir::WalkDir::new(&dir)
            .into_iter()
            .flatten()
            .filter(|e| e.file_type().is_file())
            .map(|e| e.path().to_path_buf())
            .filter(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("cr3")))
            .collect();
        paths.sort();
        assert!(!paths.is_empty(), "no CR3 files under {dir}");

        for p in &paths {
            let ps = p.to_string_lossy().to_string();
            let d = std::fs::read(p).unwrap_or_else(|e| panic!("read {ps}: {e}"));

            // Ground truth: the scan path's result, on the WHOLE file.
            let mstart = top_box_content_start(&d, b"mdat")
                .unwrap_or_else(|| panic!("{ps}: no mdat box"));
            let soi = find_soi(&d, mstart, (mstart + 8192).min(d.len()))
                .unwrap_or_else(|| panic!("{ps}: no SOI at mdat head"));
            let end = jpeg_extent(&d, soi).unwrap_or_else(|| panic!("{ps}: no EOI"));

            // The hint, from moov's sample tables alone.
            let (ms, me) = moov_range(&d).unwrap_or_else(|| panic!("{ps}: no moov"));
            let hint = full_jpeg_location(&d, ms, me)
                .unwrap_or_else(|| panic!("{ps}: full_jpeg_location returned None"));

            assert_eq!(
                hint.0, soi as u64,
                "{ps}: hint offset {} != scanned SOI {soi}", hint.0
            );
            // stsz may legitimately pad past EOI; the hinted range must CONTAIN
            // the JPEG (read_fullres_at truncates at the parsed EOI), and not
            // overshoot by more than a sanity margin.
            let scanned_len = (end - soi) as u64;
            assert!(
                hint.1 >= scanned_len,
                "{ps}: hint len {} < scanned JPEG len {scanned_len}", hint.1
            );
            assert!(
                hint.1 <= scanned_len + 64 * 1024,
                "{ps}: hint len {} overshoots scanned len {scanned_len} by >64KiB", hint.1
            );
            eprintln!(
                "{:<24} hint=({}, {})  scan=({soi}, {scanned_len})  ok",
                p.file_name().unwrap().to_string_lossy(),
                hint.0,
                hint.1,
            );
        }
    }
}
