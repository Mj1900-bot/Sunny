//! DOCX text extraction.
//!
//! A DOCX file is a ZIP archive containing `word/document.xml`.  We parse
//! that XML file directly using the standard library's `zip` crate plus a
//! hand-written XML text walk — no C deps, no heavyweight ODF library.
//!
//! Paragraphs are delimited by `<w:p>` elements; runs by `<w:r><w:t>`.
//! Table cells (`<w:tc>`) are treated as paragraphs.  Line-breaks
//! (`<w:br/>`) emit `\n`.  All other elements are skipped.

use std::io::{Cursor, Read};

use serde_json::{json, Value};

use super::path_util;

/// Extract plain text from a DOCX file.  Returns a JSON object with
/// `{ "paragraphs": [...], "text": "<joined>" }`.
pub fn extract_text(raw_path: &str) -> Result<String, String> {
    let path = path_util::resolve_local(raw_path)?;
    let bytes = std::fs::read(&path)
        .map_err(|e| format!("cannot read `{}`: {e}", path.display()))?;

    let document_xml = read_document_xml(&bytes)?;
    let paragraphs = parse_paragraphs(&document_xml);
    let joined = paragraphs.join("\n");

    let out = json!({
        "paragraphs": paragraphs,
        "text": joined,
    });
    serde_json::to_string_pretty(&out)
        .map_err(|e| format!("json serialization error: {e}"))
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Open the ZIP and return the raw bytes of `word/document.xml`.
fn read_document_xml(bytes: &[u8]) -> Result<String, String> {
    let cursor = Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor)
        .map_err(|e| format!("not a valid ZIP/DOCX: {e}"))?;

    let mut file = archive
        .by_name("word/document.xml")
        .map_err(|_| "missing `word/document.xml` — not a valid DOCX".to_string())?;

    let mut content = String::new();
    file.read_to_string(&mut content)
        .map_err(|e| format!("failed to read word/document.xml: {e}"))?;

    Ok(content)
}

/// Walk the XML character-by-character, collecting text inside `<w:t>` tags
/// and emitting paragraph breaks at `</w:p>`.
fn parse_paragraphs(xml: &str) -> Vec<String> {
    let mut paragraphs: Vec<String> = Vec::new();
    let mut current: String = String::new();
    let mut in_wt = false;
    let mut pos = 0;
    let bytes = xml.as_bytes();
    let len = bytes.len();

    while pos < len {
        if bytes[pos] == b'<' {
            // Find end of tag
            let tag_start = pos;
            let mut tag_end = pos + 1;
            while tag_end < len && bytes[tag_end] != b'>' {
                tag_end += 1;
            }
            let tag = &xml[tag_start + 1..tag_end];

            let tag_name = tag.split_whitespace().next().unwrap_or("");
            match tag_name {
                "w:t" => {
                    in_wt = true;
                }
                "/w:t" => {
                    in_wt = false;
                }
                "/w:p" | "/w:tc" => {
                    let trimmed = current.trim().to_string();
                    if !trimmed.is_empty() {
                        paragraphs.push(trimmed);
                    }
                    current = String::new();
                }
                "w:br/" | "w:br" => {
                    current.push('\n');
                }
                _ => {}
            }
            pos = tag_end + 1;
        } else {
            if in_wt {
                // Collect text content, decoding minimal XML entities
                if pos + 4 <= len && &xml[pos..pos + 4] == "&lt;" {
                    current.push('<');
                    pos += 4;
                } else if pos + 4 <= len && &xml[pos..pos + 4] == "&gt;" {
                    current.push('>');
                    pos += 4;
                } else if pos + 5 <= len && &xml[pos..pos + 5] == "&amp;" {
                    current.push('&');
                    pos += 5;
                } else if pos + 6 <= len && &xml[pos..pos + 6] == "&quot;" {
                    current.push('"');
                    pos += 6;
                } else {
                    current.push(bytes[pos] as char);
                    pos += 1;
                }
            } else {
                pos += 1;
            }
        }
    }

    // Flush any trailing content
    let trimmed = current.trim().to_string();
    if !trimmed.is_empty() {
        paragraphs.push(trimmed);
    }

    paragraphs
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> String {
        let manifest = std::env::var("CARGO_MANIFEST_DIR").unwrap();
        format!("{manifest}/tests/fixtures/{name}")
    }

    #[test]
    fn test_docx_extract_text_has_paragraphs() {
        let out = extract_text(&fixture("tiny.docx")).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        let paras = v["paragraphs"].as_array().unwrap();
        assert!(!paras.is_empty(), "expected at least one paragraph");
    }

    #[test]
    fn test_docx_extract_text_content() {
        let out = extract_text(&fixture("tiny.docx")).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        let text = v["text"].as_str().unwrap();
        assert!(text.contains("Hello"), "expected 'Hello' in extracted text, got: {text}");
    }

    #[test]
    fn test_docx_text_field_is_joined_paragraphs() {
        let out = extract_text(&fixture("tiny.docx")).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        let paras: Vec<&str> = v["paragraphs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p.as_str().unwrap())
            .collect();
        let joined = paras.join("\n");
        assert_eq!(v["text"].as_str().unwrap(), joined);
    }

    #[test]
    fn test_docx_nonexistent_returns_err() {
        assert!(extract_text("/tmp/does_not_exist_sunny.docx").is_err());
    }
}
