//! macOS Finder tag (colored label) read/write via extended attributes.
//!
//! ## Wire format
//!
//! Finder tags are stored in the `com.apple.metadata:_kMDItemUserTags`
//! extended attribute as a **binary property list** (bplist00).  The top-level
//! object is an NSArray of NSString — one entry per tag, where the string is
//! the tag name optionally followed by `\n<color-index>` (0 = None, 1 = Gray,
//! 2 = Green, 3 = Blue, 4 = Yellow, 5 = Red, 6 = Orange, 7 = Purple).
//!
//! We write tags using the `xattr` CLI (`xattr -w -x`) with a hand-built
//! bplist64 payload to avoid pulling in a full plist parser.  We read tags
//! using `xattr -p` and parse the bplist ourselves.

use tokio::process::Command;

// path_guard is used by callers; doc-imported only

// ---------------------------------------------------------------------------
// bplist helpers
// ---------------------------------------------------------------------------

/// Build a minimal binary plist (bplist00) encoding an array of UTF-8 strings.
///
/// Layout:
///   magic      8 bytes  "bplist00"
///   objects    variable (one ASCIIString object per tag)
///   offset_tbl variable (one 1-byte or 2-byte entry per object + array)
///   trailer    32 bytes
///
/// We restrict to ASCII-safe tag names (Finder tag names in practice); any
/// non-ASCII byte in the tag is still encoded as a Unicode string object.
fn build_bplist(tags: &[String]) -> Vec<u8> {
    // We build a concrete bplist:
    //  object 0        = array of object refs [1, 2, ..., N]
    //  objects 1..=N   = each tag string
    let n = tags.len();
    // total objects = n strings + 1 array
    let total_objects = n + 1;

    let mut objects: Vec<Vec<u8>> = Vec::with_capacity(total_objects);

    // --- string objects first (objects 1..=N) ---
    for tag in tags {
        objects.push(encode_bplist_string(tag));
    }

    // --- array object (object 0, referencing objects 1..N) ---
    // The array must come last in the encoded stream so its refs point forward
    // to already-computed offsets.  But in bplist the object ordering doesn't
    // matter; we put the array at index 0, strings at 1..N.
    // Rebuild with array first.
    let mut all_objs: Vec<Vec<u8>> = Vec::with_capacity(total_objects);
    let array_bytes = encode_bplist_array(n); // refs are 1-based
    all_objs.push(array_bytes);
    all_objs.extend_from_slice(&objects);

    // --- build byte stream ---
    let mut buf: Vec<u8> = Vec::new();
    buf.extend_from_slice(b"bplist00");

    let mut offsets: Vec<u64> = Vec::with_capacity(total_objects);
    for obj in &all_objs {
        offsets.push(buf.len() as u64);
        buf.extend_from_slice(obj);
    }

    // --- offset table ---
    let offset_table_start = buf.len() as u64;
    // Determine offset_size: smallest byte-count that fits all offsets.
    let max_offset = *offsets.iter().max().unwrap_or(&0);
    let offset_size: u8 = if max_offset <= 0xFF {
        1
    } else if max_offset <= 0xFFFF {
        2
    } else {
        4
    };

    for &off in &offsets {
        match offset_size {
            1 => buf.push(off as u8),
            2 => buf.extend_from_slice(&(off as u16).to_be_bytes()),
            _ => buf.extend_from_slice(&(off as u32).to_be_bytes()),
        }
    }

    // --- 32-byte trailer ---
    // 6 bytes unused, offset_size, ref_size(1), num_objects(8), top_obj(8), offset_tbl_start(8)
    buf.extend_from_slice(&[0u8; 5]); // 5 unused
    buf.push(0); // sort version = 0
    buf.push(offset_size);
    buf.push(1u8); // ref_size = 1 (max 255 objects)
    buf.extend_from_slice(&(total_objects as u64).to_be_bytes());
    buf.extend_from_slice(&0u64.to_be_bytes()); // top object = index 0 (the array)
    buf.extend_from_slice(&offset_table_start.to_be_bytes());

    buf
}

/// Encode a single UTF-8 string as a bplist string object.
/// Uses ASCII (0x5N marker) for all-ASCII strings; Unicode (0x6N) otherwise.
fn encode_bplist_string(s: &str) -> Vec<u8> {
    let mut out = Vec::new();
    if s.is_ascii() {
        let len = s.len();
        if len < 0x0F {
            out.push(0x50 | len as u8);
        } else {
            out.push(0x5F);
            out.extend_from_slice(&encode_bplist_int(len as u64));
        }
        out.extend_from_slice(s.as_bytes());
    } else {
        // Encode as UTF-16BE
        let utf16: Vec<u16> = s.encode_utf16().collect();
        let len = utf16.len();
        if len < 0x0F {
            out.push(0x60 | len as u8);
        } else {
            out.push(0x6F);
            out.extend_from_slice(&encode_bplist_int(len as u64));
        }
        for unit in utf16 {
            out.extend_from_slice(&unit.to_be_bytes());
        }
    }
    out
}

/// Encode an array with refs 1..=count (1-byte refs, 0-indexed objects).
fn encode_bplist_array(count: usize) -> Vec<u8> {
    let mut out = Vec::new();
    if count < 0x0F {
        out.push(0xA0 | count as u8);
    } else {
        out.push(0xAF);
        out.extend_from_slice(&encode_bplist_int(count as u64));
    }
    // refs: object 1 through object count
    for i in 1..=(count as u8) {
        out.push(i);
    }
    out
}

/// Encode a positive integer as a bplist int object (used for lengths > 14).
fn encode_bplist_int(n: u64) -> Vec<u8> {
    let mut out = Vec::new();
    if n <= 0xFF {
        out.push(0x10); // int, 1 byte
        out.push(n as u8);
    } else if n <= 0xFFFF {
        out.push(0x11); // int, 2 bytes
        out.extend_from_slice(&(n as u16).to_be_bytes());
    } else {
        out.push(0x12); // int, 4 bytes
        out.extend_from_slice(&(n as u32).to_be_bytes());
    }
    out
}

// ---------------------------------------------------------------------------
// Parse bplist tags from xattr output
// ---------------------------------------------------------------------------

/// Parse the raw bytes from `xattr -px com.apple.metadata:_kMDItemUserTags`.
/// The output is a hex-encoded binary plist; we parse the hex, then walk the
/// bplist manually to extract string objects.
///
/// We do a tolerant best-effort parse — only ASCII/UTF-16 string markers are
/// handled; anything exotic is skipped.
pub fn parse_tag_xattr(hex_bytes: &str) -> Vec<String> {
    // Strip whitespace / newlines from the hex dump
    let hex_clean: String = hex_bytes.chars().filter(|c| !c.is_whitespace()).collect();
    let bytes = match hex::decode(&hex_clean) {
        Ok(b) => b,
        Err(_) => return Vec::new(),
    };

    if bytes.len() < 8 || &bytes[..8] != b"bplist00" {
        return Vec::new();
    }

    extract_strings_from_bplist(&bytes)
}

/// Walk the binary plist and return all string objects found.
fn extract_strings_from_bplist(bytes: &[u8]) -> Vec<String> {
    let mut tags = Vec::new();
    let len = bytes.len();
    if len < 40 {
        return tags;
    }

    // Trailer starts at bytes[len-32]
    let trailer = &bytes[len - 32..];
    let offset_size = trailer[6] as usize;
    let _ref_size = trailer[7] as usize;
    let num_objects = u64::from_be_bytes(trailer[8..16].try_into().unwrap_or([0; 8])) as usize;
    let offset_tbl_start =
        u64::from_be_bytes(trailer[24..32].try_into().unwrap_or([0; 8])) as usize;

    if offset_size == 0 || num_objects == 0 || offset_tbl_start + num_objects * offset_size > len {
        return tags;
    }

    // Read object offsets
    let offsets: Vec<usize> = (0..num_objects)
        .filter_map(|i| {
            let start = offset_tbl_start + i * offset_size;
            let end = start + offset_size;
            if end > len {
                return None;
            }
            let slice = &bytes[start..end];
            Some(match offset_size {
                1 => slice[0] as usize,
                2 => u16::from_be_bytes([slice[0], slice[1]]) as usize,
                4 => u32::from_be_bytes([slice[0], slice[1], slice[2], slice[3]]) as usize,
                _ => return None,
            })
        })
        .collect();

    // Parse each object; collect string objects
    for &off in &offsets {
        if off >= len {
            continue;
        }
        let marker = bytes[off];
        let type_byte = marker >> 4;
        let extra = (marker & 0x0F) as usize;

        match type_byte {
            0x5 => {
                // ASCII string
                if let Some(s) = read_ascii_string(bytes, off + 1, extra, len) {
                    // Strip optional "\n<color>" suffix
                    let tag_name = s.split('\n').next().unwrap_or(&s).to_string();
                    if !tag_name.is_empty() {
                        tags.push(tag_name);
                    }
                }
            }
            0x6 => {
                // UTF-16 string
                if let Some(s) = read_utf16_string(bytes, off + 1, extra, len) {
                    let tag_name = s.split('\n').next().unwrap_or(&s).to_string();
                    if !tag_name.is_empty() {
                        tags.push(tag_name);
                    }
                }
            }
            _ => {} // array, int, dict, etc. — skip
        }
    }

    // Deduplicate while preserving order
    let mut seen = std::collections::HashSet::new();
    tags.retain(|t| seen.insert(t.clone()));
    tags
}

fn read_ascii_string(bytes: &[u8], start: usize, len: usize, total: usize) -> Option<String> {
    let end = start + len;
    if end > total {
        return None;
    }
    String::from_utf8(bytes[start..end].to_vec()).ok()
}

fn read_utf16_string(bytes: &[u8], start: usize, len: usize, total: usize) -> Option<String> {
    let byte_len = len * 2;
    let end = start + byte_len;
    if end > total {
        return None;
    }
    let units: Vec<u16> = bytes[start..end]
        .chunks_exact(2)
        .map(|c| u16::from_be_bytes([c[0], c[1]]))
        .collect();
    String::from_utf16(&units).ok()
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const XATTR_KEY: &str = "com.apple.metadata:_kMDItemUserTags";

/// Read the current Finder tags on a file. Returns an empty list if the
/// attribute is absent. Path must already be resolved (use `path_guard::resolve`).
pub async fn get_tags(resolved_path: &str) -> Result<Vec<String>, String> {
    let output = Command::new("xattr")
        .args(["-px", XATTR_KEY, resolved_path])
        .output()
        .await
        .map_err(|e| format!("xattr read failed: {e}"))?;

    if !output.status.success() {
        // Attribute absent is not an error — return empty.
        return Ok(Vec::new());
    }

    let raw = String::from_utf8_lossy(&output.stdout).to_string();
    Ok(parse_tag_xattr(&raw))
}

/// Write (replace) all Finder tags on a file.
pub async fn set_tags(resolved_path: &str, tags: &[String]) -> Result<(), String> {
    let plist_bytes = build_bplist(tags);
    // xattr -wx expects the value as a hex string
    let hex_val = hex::encode(&plist_bytes);

    let status = Command::new("xattr")
        .args(["-wx", XATTR_KEY, &hex_val, resolved_path])
        .status()
        .await
        .map_err(|e| format!("xattr write failed: {e}"))?;

    if !status.success() {
        return Err(format!("xattr write exited non-zero for `{resolved_path}`"));
    }
    Ok(())
}

/// Add tags to a file, preserving any existing tags.
pub async fn add_tags(resolved_path: &str, new_tags: &[String]) -> Result<Vec<String>, String> {
    let mut existing = get_tags(resolved_path).await?;
    for tag in new_tags {
        if !existing.contains(tag) {
            existing.push(tag.clone());
        }
    }
    set_tags(resolved_path, &existing).await?;
    Ok(existing)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // -- bplist round-trip (no I/O) -------------------------------------------

    #[test]
    fn bplist_empty_tags() {
        let bytes = build_bplist(&[]);
        // Must start with magic and have trailer
        assert!(bytes.starts_with(b"bplist00"), "missing magic");
        assert!(bytes.len() >= 40, "too short for trailer");
    }

    #[test]
    fn bplist_single_tag_round_trips() {
        let tags = vec!["Red".to_string()];
        let bytes = build_bplist(&tags);
        let parsed = extract_strings_from_bplist(&bytes);
        assert_eq!(parsed, vec!["Red"]);
    }

    #[test]
    fn bplist_multiple_tags_round_trip() {
        let tags = vec!["Work".to_string(), "Important".to_string(), "Blue".to_string()];
        let bytes = build_bplist(&tags);
        let parsed = extract_strings_from_bplist(&bytes);
        assert_eq!(parsed, tags);
    }

    #[test]
    fn bplist_tag_with_color_suffix_stripped_on_parse() {
        // Tags in the wild often have a "\n<N>" color suffix.  Our parser
        // must strip it on read.  Simulate by building a plist with a
        // "\n2" suffix then parsing it.
        let tags_raw = vec!["Green\n2".to_string()];
        let bytes = build_bplist(&tags_raw);
        let parsed = extract_strings_from_bplist(&bytes);
        assert_eq!(parsed, vec!["Green"]);
    }

    #[test]
    fn parse_tag_xattr_ignores_invalid_hex() {
        let result = parse_tag_xattr("not hex at all !!!");
        assert!(result.is_empty());
    }

    #[test]
    fn parse_tag_xattr_ignores_non_bplist() {
        // Valid hex but not a bplist
        let result = parse_tag_xattr("deadbeef");
        assert!(result.is_empty());
    }

    // -- path_guard integration -----------------------------------------------

    #[test]
    fn resolve_dotdot_rejected_before_tag_ops() {
        use super::super::path_guard::resolve;
        let home = dirs::home_dir().unwrap();
        let bad = format!("{}/Documents/../../etc/passwd", home.display());
        let err = resolve(&bad).unwrap_err();
        assert!(err.contains("..") || err.contains("denied"), "got: {err}");
    }
}
