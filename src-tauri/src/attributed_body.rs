//! Best-effort extraction of message text from `message.attributedBody`.
//!
//! Starting with iOS 16 / macOS Ventura, Messages writes outgoing message
//! text into `message.attributedBody` (an NSTypedStream BLOB) and leaves the
//! legacy `message.text` column null. If we only read `text` we end up
//! showing "—" for half of every conversation.
//!
//! `attributedBody` is an `NSArchiver` (typedstream) blob, NOT an
//! `NSKeyedArchiver` plist. A proper parser would walk every opcode; we only
//! need the first UTF-8 string payload, so this module implements a narrow
//! pattern match plus a printable-run fallback.
//!
//! # Strategy
//!
//! 1. Precise path: locate `NSString\x01` in the blob, then scan forward for
//!    the `+` (0x2B) opcode which introduces a variable-length object.
//!    Decode the length prefix and read that many UTF-8 bytes.
//! 2. Heuristic fallback: if step 1 yields nothing plausible, walk the blob,
//!    collect every run of printable ASCII / UTF-8 continuation bytes >= 4
//!    long, strip known AppKit / iMessage class names, and return the
//!    longest surviving run.
//!
//! Both paths are forgiving — we return `None` on any malformation and fall
//! back to whatever the caller already had (usually `[attachment]` or `—`).

const TYPEDSTREAM_CLASS_NAMES: &[&str] = &[
    "streamtyped",
    "NSString",
    "NSMutableString",
    "NSAttributedString",
    "NSMutableAttributedString",
    "NSDictionary",
    "NSMutableDictionary",
    "NSArray",
    "NSMutableArray",
    "NSNumber",
    "NSObject",
    "NSValue",
    "NSFont",
    "NSColor",
    "NSParagraphStyle",
    "NSMutableParagraphStyle",
    "__kIMMessagePartAttributeName",
    "__kIMBaseWritingDirectionAttributeName",
    "__kIMFileTransferGUIDAttributeName",
    "__kIMMessagePartContextAttributeName",
    "__kIMMentionConfirmedMention",
    "__kIMOneTimeCodeAttributeName",
    "__kIMDataDetectedAttributeName",
    "__kIMTextUnderlineColorAttributeName",
    "__kIMTextBaseWritingDirectionAttributeName",
    "NSDictionaryKey",
];

/// Decode a hex string (as emitted by sqlite `HEX(attributedBody)`) and
/// run it through `extract_text`. Convenience used by callers that already
/// have the `.mode json` output.
pub fn extract_text_from_hex(hex_str: &str) -> Option<String> {
    if hex_str.is_empty() {
        return None;
    }
    let bytes = hex_to_bytes(hex_str)?;
    extract_text(&bytes)
}

fn hex_to_bytes(hex_str: &str) -> Option<Vec<u8>> {
    if hex_str.len() % 2 != 0 {
        return None;
    }
    let bytes = hex_str.as_bytes();
    let mut out = Vec::with_capacity(hex_str.len() / 2);
    for pair in bytes.chunks(2) {
        let hi = hex_digit(pair[0])?;
        let lo = hex_digit(pair[1])?;
        out.push((hi << 4) | lo);
    }
    Some(out)
}

fn hex_digit(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// Top-level entry point. Takes the raw `attributedBody` BLOB and tries to
/// extract the human-readable message text.
pub fn extract_text(blob: &[u8]) -> Option<String> {
    if blob.is_empty() {
        return None;
    }
    if let Some(t) = extract_precise(blob) {
        let trimmed = t.trim();
        if !trimmed.is_empty() && !is_known_class(trimmed) {
            return Some(trimmed.to_string());
        }
    }
    extract_heuristic(blob)
}

fn is_known_class(s: &str) -> bool {
    TYPEDSTREAM_CLASS_NAMES.contains(&s)
}

// ---------------------------------------------------------------------------
// Precise path: NSTypedStream walk (partial)
// ---------------------------------------------------------------------------

fn extract_precise(blob: &[u8]) -> Option<String> {
    let needle = b"NSString\x01";
    let mut cursor = 0;
    while let Some(pos) = find_subslice(&blob[cursor..], needle) {
        let after_class = cursor + pos + needle.len();
        // Within ~24 bytes of the class marker we expect the `+` opcode that
        // introduces a variable-length object (the actual string payload).
        // Empirically the gap is 3–12 bytes of type glue; 24 is a safe
        // upper bound that avoids false positives from `+` characters in
        // surrounding strings.
        let search_end = (after_class + 24).min(blob.len());
        for i in after_class..search_end {
            if blob[i] == b'+' {
                if let Some(text) = read_typedstream_string(&blob[i + 1..]) {
                    if !text.is_empty() && !is_known_class(&text) {
                        return Some(text);
                    }
                }
            }
        }
        cursor = after_class;
    }
    None
}

fn read_typedstream_string(rest: &[u8]) -> Option<String> {
    if rest.is_empty() {
        return None;
    }
    let (len, offset) = parse_length(rest)?;
    let end = offset + len;
    if end > rest.len() {
        return None;
    }
    let bytes = &rest[offset..end];
    // Some payloads prefix the UTF-8 with a single NUL that isn't part of
    // the text. Strip a leading NUL rather than reject the whole parse.
    let cleaned = if let Some(b) = bytes.first() {
        if *b == 0 { &bytes[1..] } else { bytes }
    } else {
        bytes
    };
    std::str::from_utf8(cleaned).ok().map(str::to_string)
}

/// Decode a typedstream length prefix and return `(length, bytes_consumed)`.
fn parse_length(rest: &[u8]) -> Option<(usize, usize)> {
    let first = *rest.first()?;
    if first < 0x81 {
        return Some((first as usize, 1));
    }
    match first {
        0x81 => {
            // Next 1 byte (big-endian) is the length.
            let b = *rest.get(1)?;
            Some((b as usize, 2))
        }
        0x82 => {
            let a = *rest.get(1)?;
            let b = *rest.get(2)?;
            Some((u16::from_be_bytes([a, b]) as usize, 3))
        }
        0x83 => {
            let a = *rest.get(1)?;
            let b = *rest.get(2)?;
            let c = *rest.get(3)?;
            let d = *rest.get(4)?;
            Some((u32::from_be_bytes([a, b, c, d]) as usize, 5))
        }
        _ => None,
    }
}

fn find_subslice(hay: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || hay.len() < needle.len() {
        return None;
    }
    hay.windows(needle.len()).position(|w| w == needle)
}

// ---------------------------------------------------------------------------
// Heuristic fallback: longest printable UTF-8 run
// ---------------------------------------------------------------------------

fn extract_heuristic(blob: &[u8]) -> Option<String> {
    // Collect every run of printable / UTF-8 continuation bytes >= 4 chars.
    let mut runs: Vec<Vec<u8>> = Vec::new();
    let mut current: Vec<u8> = Vec::new();
    for &b in blob {
        let printable = (b >= 0x20 && b < 0x7F) || b >= 0x80;
        if printable {
            current.push(b);
        } else {
            if current.len() >= 4 {
                runs.push(std::mem::take(&mut current));
            } else {
                current.clear();
            }
        }
    }
    if current.len() >= 4 {
        runs.push(current);
    }

    // Split each run along every known class-name boundary, then pick the
    // longest remaining fragment across every run. This handles the common
    // case where the body is sandwiched between type metadata in a single
    // printable-byte block (e.g. `NSMutableAttributedString...hi...NSDictionary`).
    let mut best: Option<String> = None;
    for run in runs {
        let Ok(s) = std::str::from_utf8(&run) else { continue };
        for frag in split_on_class_names(s) {
            let cleaned = frag
                .trim_matches(|c: char| !c.is_ascii_graphic() && !c.is_whitespace());
            if cleaned.chars().count() < 4 {
                continue;
            }
            if is_mostly_glyphs_only(cleaned) {
                continue;
            }
            if matches!(&best, Some(b) if b.len() >= cleaned.len()) {
                continue;
            }
            best = Some(cleaned.to_string());
        }
    }
    best
}

fn split_on_class_names(input: &str) -> Vec<&str> {
    let mut fragments = vec![input];
    for name in TYPEDSTREAM_CLASS_NAMES {
        let mut next: Vec<&str> = Vec::new();
        for frag in fragments {
            for piece in frag.split(name) {
                next.push(piece);
            }
        }
        fragments = next;
    }
    fragments
}

/// Reject fragments that look like binary glue: pure punctuation, single
/// repeated character, or mostly non-letter bytes.
fn is_mostly_glyphs_only(s: &str) -> bool {
    let total = s.chars().count();
    if total == 0 {
        return true;
    }
    let letters = s.chars().filter(|c| c.is_alphanumeric()).count();
    // Real message text is >= ~40 % letters (the rest being punctuation /
    // spaces / emoji). Anything below that is almost certainly type glue.
    letters * 5 < total * 2
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a minimal typedstream-like blob: class marker + `+` opcode +
    /// length byte + UTF-8 payload. This isn't a full NSArchiver stream but
    /// exercises the exact decoder path we use in practice.
    fn synth(text: &str) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(b"\x04\x0bstreamtyped\x81\xe8\x03");
        v.extend_from_slice(b"NSString\x01");
        // class glue
        v.extend_from_slice(&[0x94, 0x84, 0x01]);
        // + opcode marker + length + payload
        v.push(b'+');
        assert!(text.len() < 0x81, "test helper only encodes short strings");
        v.push(text.len() as u8);
        v.extend_from_slice(text.as_bytes());
        v
    }

    #[test]
    fn extract_precise_finds_short_string() {
        let blob = synth("hey there");
        assert_eq!(extract_text(&blob).as_deref(), Some("hey there"));
    }

    #[test]
    fn extract_text_handles_emoji() {
        let blob = synth("ok 🎉 see you");
        assert_eq!(extract_text(&blob).as_deref(), Some("ok 🎉 see you"));
    }

    #[test]
    fn extract_heuristic_ignores_class_names() {
        // A blob that has no `+` opcode but does contain class name runs.
        // Class names + payload must be SEPARATED BY NON-PRINTABLE BYTES so
        // `extract_heuristic` cuts them into distinct runs — otherwise the
        // whole blob reads as a single run that (contains class names and
        // therefore) gets rejected wholesale. Real typedstream blobs use
        // NULs / opcode bytes as separators; we use 0x01 here for the same
        // effect.
        let mut blob: Vec<u8> = Vec::new();
        blob.extend_from_slice(b"streamtyped");
        blob.push(0x01);
        blob.extend_from_slice(b"NSMutableAttributedString");
        blob.push(0x01);
        blob.extend_from_slice(b"real message body here");
        blob.push(0x01);
        blob.extend_from_slice(b"NSDictionary");
        let text = extract_text(&blob).unwrap_or_default();
        // The extractor should pick "real message body here", skipping every
        // TYPEDSTREAM_CLASS_NAMES entry.
        assert!(text.contains("real message body"), "got: {text:?}");
    }

    #[test]
    fn extract_empty_blob_is_none() {
        assert!(extract_text(&[]).is_none());
    }

    #[test]
    fn parse_length_handles_prefix_bytes() {
        assert_eq!(parse_length(&[0x05]), Some((5, 1)));
        assert_eq!(parse_length(&[0x81, 0xA0]), Some((0xA0, 2)));
        assert_eq!(parse_length(&[0x82, 0x01, 0x00]), Some((256, 3)));
        assert!(parse_length(&[]).is_none());
    }

    #[test]
    fn find_subslice_basic() {
        assert_eq!(find_subslice(b"hello world", b"world"), Some(6));
        assert_eq!(find_subslice(b"hello", b"missing"), None);
    }
}
