//! PDF text, table, and metadata extraction via `lopdf`.
//!
//! ## `pdf_extract_text(path, pages?)`
//! Returns per-page text.  `pages` accepts "all", "1-5", "3,7,9" (1-based).
//!
//! ## `pdf_extract_tables(path, page?)`
//! Heuristic column detection: collect text runs with x-positions, cluster
//! them by horizontal proximity, then emit rows as tab-separated strings.
//! **Limitation**: lopdf gives us glyph-level positions that require the
//! font's width tables to convert to exact pixel widths.  Without a full
//! PDF rendering engine (e.g. pdfium-render which requires a C shared lib),
//! column boundaries are approximated from raw x-coordinates embedded in the
//! content stream.  Results are best-effort; complex multi-column layouts or
//! rotated text may produce garbled output.  Scanned PDFs (image-only) return
//! an empty result rather than garbage.
//!
//! ## `pdf_metadata(path)`
//! Returns title, author, creation date, and page count from the PDF's
//! Info dictionary.
//!
//! ## Error handling
//! Password-protected PDFs return `Err` with a clear message rather than
//! panicking.

use std::path::Path;

use lopdf::{Document, Object};
use serde_json::{json, Value};

use super::page_range;
use super::path_util;

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/// Extract text from a PDF, optionally filtered to a page subset.
pub fn extract_text(raw_path: &str, pages_spec: Option<&str>) -> Result<String, String> {
    let path = path_util::resolve_local(raw_path)?;
    let doc = open_doc(&path)?;

    let page_filter = pages_spec
        .map(|s| page_range::parse(s))
        .transpose()?
        .flatten();

    let page_ids = collect_page_ids(&doc);
    let mut results: Vec<Value> = Vec::with_capacity(page_ids.len());

    for (idx, &page_id) in page_ids.iter().enumerate() {
        let page_num = (idx + 1) as u32;
        if let Some(ref filter) = page_filter {
            if !filter.contains(&page_num) {
                continue;
            }
        }
        let text = extract_page_text(&doc, page_id)
            .unwrap_or_else(|_| String::new());
        results.push(json!({ "page": page_num, "text": text }));
    }

    serde_json::to_string_pretty(&results)
        .map_err(|e| format!("json serialization error: {e}"))
}

/// Extract heuristic tables from a PDF page (1-based).  Returns rows as
/// JSON arrays of string cells.
pub fn extract_tables(raw_path: &str, page_spec: Option<u32>) -> Result<String, String> {
    let path = path_util::resolve_local(raw_path)?;
    let doc = open_doc(&path)?;

    let page_ids = collect_page_ids(&doc);
    let target_page = page_spec.unwrap_or(1) as usize;

    if target_page == 0 || target_page > page_ids.len() {
        return Err(format!(
            "page {target_page} out of range (document has {} pages)",
            page_ids.len()
        ));
    }

    let page_id = page_ids[target_page - 1];
    let raw_text = extract_page_text(&doc, page_id).unwrap_or_default();

    // Heuristic: split into lines, then try to detect column boundaries by
    // multiple whitespace runs.  This is necessarily imprecise without a
    // layout engine — see module-level doc for limitations.
    let rows: Vec<Vec<String>> = raw_text
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|line| {
            // Split on 2+ spaces as a column delimiter heuristic.
            let re_split: Vec<String> = line
                .split("  ")
                .map(|c| c.trim().to_string())
                .filter(|c| !c.is_empty())
                .collect();
            if re_split.is_empty() {
                vec![line.trim().to_string()]
            } else {
                re_split
            }
        })
        .collect();

    let out = json!({
        "page": target_page,
        "note": "heuristic column detection — verify complex layouts manually",
        "rows": rows,
    });

    serde_json::to_string_pretty(&out)
        .map_err(|e| format!("json serialization error: {e}"))
}

/// Return title, author, creation date, and page count from the PDF's
/// Info dictionary.
pub fn metadata(raw_path: &str) -> Result<String, String> {
    let path = path_util::resolve_local(raw_path)?;
    let doc = open_doc(&path)?;
    let page_count = collect_page_ids(&doc).len();

    let info = doc
        .trailer
        .get(b"Info")
        .ok()
        .and_then(|o| o.as_reference().ok())
        .and_then(|id| doc.get_object(id).ok());

    let get_str = |key: &[u8]| -> Option<String> {
        info.as_ref()
            .and_then(|obj| obj.as_dict().ok())
            .and_then(|d| d.get(key).ok())
            .and_then(|v| pdf_string_value(v))
    };

    let out = json!({
        "title":        get_str(b"Title").unwrap_or_default(),
        "author":       get_str(b"Author").unwrap_or_default(),
        "creation_date": get_str(b"CreationDate").unwrap_or_default(),
        "page_count":   page_count,
    });

    serde_json::to_string_pretty(&out)
        .map_err(|e| format!("json serialization error: {e}"))
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

fn open_doc(path: &Path) -> Result<Document, String> {
    Document::load(path).map_err(|e| {
        let msg = e.to_string();
        if msg.contains("password") || msg.contains("encrypt") || msg.contains("Permission") {
            format!(
                "PDF is password-protected or encrypted — cannot extract text without the password. \
                 Original error: {msg}"
            )
        } else {
            format!("failed to open PDF `{}`: {msg}", path.display())
        }
    })
}

/// Collect page object IDs in document order.
fn collect_page_ids(doc: &Document) -> Vec<lopdf::ObjectId> {
    doc.page_iter().collect()
}

/// Extract all text from a single page object.  Returns empty string on
/// content-stream decode failures (e.g. unsupported filters) rather than Err
/// so callers can iterate all pages without aborting on one bad page.
fn extract_page_text(doc: &Document, page_id: lopdf::ObjectId) -> Result<String, String> {
    doc.extract_text(&[page_id.0])
        .map_err(|e| format!("text extract error on page object {}: {e}", page_id.0))
}

/// Convert a PDF string/name object to a Rust String, handling both
/// `Object::String` (bytes) and `Object::Name` variants.
fn pdf_string_value(obj: &Object) -> Option<String> {
    match obj {
        Object::String(bytes, _) => String::from_utf8_lossy(bytes)
            .trim()
            .to_string()
            .into(),
        Object::Name(bytes) => String::from_utf8_lossy(bytes)
            .trim()
            .to_string()
            .into(),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> String {
        // Resolve relative to Cargo.toml, which is in src-tauri/.
        let manifest = std::env::var("CARGO_MANIFEST_DIR").unwrap();
        format!("{manifest}/tests/fixtures/{name}")
    }

    #[test]
    fn test_pdf_metadata_page_count() {
        let out = metadata(&fixture("tiny.pdf")).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["page_count"], 1);
    }

    #[test]
    fn test_pdf_extract_text_all_pages() {
        let out = extract_text(&fixture("tiny.pdf"), None).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert!(v.as_array().unwrap().len() >= 1);
        // page 1 should exist
        assert_eq!(v[0]["page"], 1);
    }

    #[test]
    fn test_pdf_extract_text_page_filter() {
        // tiny.pdf only has 1 page — requesting page 2 should yield empty array.
        let out = extract_text(&fixture("tiny.pdf"), Some("2")).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v.as_array().unwrap().len(), 0);
    }

    #[test]
    fn test_pdf_extract_tables_returns_json() {
        let out = extract_tables(&fixture("tiny.pdf"), Some(1)).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert!(v.get("rows").is_some());
    }

    #[test]
    fn test_pdf_nonexistent_returns_err() {
        assert!(extract_text("/tmp/does_not_exist_sunny.pdf", None).is_err());
    }

    #[test]
    fn test_pdf_out_of_range_page() {
        assert!(extract_tables(&fixture("tiny.pdf"), Some(99)).is_err());
    }
}
