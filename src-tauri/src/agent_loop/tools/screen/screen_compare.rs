//! `screen_compare` — diff two screenshots and describe what changed.
//!
//! Privacy level: L1.
//!
//! ## Use case
//!
//! After a `mouse_click` the agent can call `screen_compare` with the
//! pre-click screenshot path to verify the action had an effect:
//! "a dialog appeared", "the button text changed from 'Submit' to 'Loading…'",
//! "nothing visible changed".
//!
//! ## Inputs
//!
//! | Field         | Required | Description                                         |
//! |---------------|----------|-----------------------------------------------------|
//! | `before_path` | yes      | Absolute path to the "before" PNG (saved by caller) |
//! | `after_path`  | no       | Absolute path to the "after" PNG. If omitted, a     |
//! |               |          | fresh capture is taken automatically.               |
//! | `region`      | no       | `{x,y,w,h}` to restrict comparison to a sub-area   |
//!
//! ## Algorithm
//!
//! Both images are OCR'd.  The diff is computed on the word sets:
//!
//! * Words in `after` but not in `before` → "appeared".
//! * Words in `before` but not in `after` → "disappeared".
//!
//! This is deliberately text-level (not pixel-level) because the agent loop
//! cares about semantic changes ("the error message appeared"), not pixels.
//! A pixel diff would require `image` crate; this approach needs only tesseract.
//!
//! ## Return value
//!
//! ```json
//! {
//!   "summary": "Text 'Cancel' disappeared; text 'Loading…' appeared.",
//!   "appeared": ["Loading…"],
//!   "disappeared": ["Cancel"],
//!   "unchanged_count": 42
//! }
//! ```

use serde_json::json;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["macos.screen"];

const SCHEMA: &str = r#"{
  "type": "object",
  "required": ["before_path"],
  "properties": {
    "before_path": {
      "type": "string",
      "description": "Absolute path to the 'before' PNG screenshot."
    },
    "after_path": {
      "type": "string",
      "description": "Absolute path to the 'after' PNG. If omitted, a fresh capture is taken."
    },
    "region": {
      "type": "object",
      "properties": {
        "x": {"type": "integer"},
        "y": {"type": "integer"},
        "w": {"type": "integer", "minimum": 1},
        "h": {"type": "integer", "minimum": 1}
      },
      "required": ["x","y","w","h"]
    }
  }
}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: serde_json::Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let before_path = input
            .get("before_path")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or("screen_compare: `before_path` must be a non-empty string")?
            .to_string();

        // Load "before" PNG from file.
        let before_bytes = load_png_file(&before_path)
            .map_err(|e| format!("screen_compare: before_path: {e}"))?;
        let before_b64 = base64_encode(&before_bytes);

        // Obtain "after" PNG: from file or fresh capture.
        let after_b64 = if let Some(ap) = input.get("after_path").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
            let bytes = load_png_file(ap)
                .map_err(|e| format!("screen_compare: after_path: {e}"))?;
            base64_encode(&bytes)
        } else {
            // Fresh capture, optionally restricted to a region.
            let img = if let Some(r) = input.get("region") {
                let x = r.get("x").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
                let y = r.get("y").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
                let w = r.get("w").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
                let h = r.get("h").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
                if w <= 0 || h <= 0 {
                    return Err("screen_compare: region w and h must be positive".into());
                }
                crate::vision::capture_region(x, y, w, h).await?
            } else {
                crate::vision::capture_full_screen(None).await?
            };
            img.base64
        };

        // OCR both sides.
        let before_ocr = crate::ocr::ocr_image_base64(before_b64, None)
            .await
            .map_err(|e| format!("screen_compare: OCR before: {e}"))?;
        let after_ocr = crate::ocr::ocr_image_base64(after_b64, None)
            .await
            .map_err(|e| format!("screen_compare: OCR after: {e}"))?;

        let diff = text_diff(&before_ocr.text, &after_ocr.text);

        let result = json!({
            "summary": diff.summary,
            "appeared": diff.appeared,
            "disappeared": diff.disappeared,
            "unchanged_count": diff.unchanged_count,
        });

        serde_json::to_string(&result)
            .map_err(|e| format!("screen_compare: encode: {e}"))
    })
}

pub(crate) struct DiffResult {
    summary: String,
    appeared: Vec<String>,
    disappeared: Vec<String>,
    unchanged_count: usize,
}

/// Word-set diff between two OCR text blobs.  Uses a multiset so repeated
/// words (like "OK" appearing twice in a form) are handled correctly.
pub(crate) fn text_diff(before: &str, after: &str) -> DiffResult {
    use std::collections::HashMap;

    fn word_counts(text: &str) -> HashMap<String, usize> {
        let mut map: HashMap<String, usize> = HashMap::new();
        for w in text.split_whitespace() {
            *map.entry(w.to_string()).or_default() += 1;
        }
        map
    }

    let before_counts = word_counts(before);
    let after_counts = word_counts(after);

    let mut appeared: Vec<String> = Vec::new();
    let mut disappeared: Vec<String> = Vec::new();
    let mut unchanged_count = 0usize;

    // Words in after not (fully) covered by before → appeared.
    // Shared occurrences (min of before/after counts) are always unchanged.
    for (word, &after_n) in &after_counts {
        let before_n = before_counts.get(word).copied().unwrap_or(0);
        if after_n > before_n {
            for _ in 0..(after_n - before_n) {
                appeared.push(word.clone());
            }
        }
        unchanged_count += before_n.min(after_n);
    }

    // Words in before not (fully) covered by after → disappeared.
    for (word, &before_n) in &before_counts {
        let after_n = after_counts.get(word).copied().unwrap_or(0);
        if before_n > after_n {
            for _ in 0..(before_n - after_n) {
                disappeared.push(word.clone());
            }
        }
    }

    appeared.sort();
    disappeared.sort();

    let summary = build_summary(&appeared, &disappeared, unchanged_count);

    DiffResult { summary, appeared, disappeared, unchanged_count }
}

fn build_summary(appeared: &[String], disappeared: &[String], unchanged: usize) -> String {
    match (appeared.is_empty(), disappeared.is_empty()) {
        (true, true) => format!("No text changes detected ({unchanged} words unchanged)."),
        (false, true) => format!(
            "Text appeared: {}. ({unchanged} words unchanged.)",
            quote_list(appeared)
        ),
        (true, false) => format!(
            "Text disappeared: {}. ({unchanged} words unchanged.)",
            quote_list(disappeared)
        ),
        (false, false) => format!(
            "Text appeared: {}; disappeared: {}. ({unchanged} words unchanged.)",
            quote_list(appeared),
            quote_list(disappeared)
        ),
    }
}

fn quote_list(items: &[String]) -> String {
    items
        .iter()
        .map(|s| format!("'{s}'"))
        .collect::<Vec<_>>()
        .join(", ")
}

fn load_png_file(path: &str) -> Result<Vec<u8>, String> {
    let expanded = crate::safety_paths::expand_home(path)?;
    crate::safety_paths::assert_read_allowed(&expanded)?;
    if !expanded.is_file() {
        return Err(format!("not a readable file: {}", expanded.display()));
    }
    std::fs::read(&expanded)
        .map_err(|e| format!("read {}: {e}", expanded.display()))
}

fn base64_encode(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

inventory::submit! {
    ToolSpec {
        name: "screen_compare",
        description: "Diff two screenshots (text-level) and describe what changed. \
                       Pass `before_path` (a previously saved PNG). \
                       If `after_path` is omitted a fresh capture is taken automatically. \
                       Optional `region` {x,y,w,h} restricts the comparison area. \
                       Returns {summary, appeared[], disappeared[], unchanged_count}. \
                       Ideal after mouse_click to verify the action had an effect. \
                       Privacy level: L1 (reads screen; requires macos.screen).",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke,
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_change_detected_on_identical_text() {
        let d = text_diff("Hello world foo", "Hello world foo");
        assert!(d.appeared.is_empty());
        assert!(d.disappeared.is_empty());
        assert_eq!(d.unchanged_count, 3);
        assert!(d.summary.contains("No text changes"));
    }

    #[test]
    fn word_appearance_detected() {
        let d = text_diff("Hello world", "Hello world Submit");
        assert_eq!(d.appeared, vec!["Submit"]);
        assert!(d.disappeared.is_empty());
    }

    #[test]
    fn word_disappearance_detected() {
        let d = text_diff("Hello Cancel world", "Hello world");
        assert_eq!(d.disappeared, vec!["Cancel"]);
        assert!(d.appeared.is_empty());
    }

    #[test]
    fn both_appear_and_disappear() {
        let d = text_diff("Click Cancel to abort", "Click OK to continue");
        assert!(d.appeared.contains(&"OK".to_string()));
        assert!(d.appeared.contains(&"continue".to_string()));
        assert!(d.disappeared.contains(&"Cancel".to_string()));
        assert!(d.disappeared.contains(&"abort".to_string()));
        assert!(d.summary.contains("appeared"));
        assert!(d.summary.contains("disappeared"));
    }

    #[test]
    fn multiset_handles_repeated_words() {
        // "OK" appears twice after but only once before → one new occurrence.
        let d = text_diff("OK submit", "OK OK submit");
        assert_eq!(d.appeared, vec!["OK"]);
        assert!(d.disappeared.is_empty());
        assert_eq!(d.unchanged_count, 2); // one "OK" + "submit" are shared
    }

    #[test]
    fn empty_before_and_after_gives_no_change() {
        let d = text_diff("", "");
        assert!(d.appeared.is_empty());
        assert!(d.disappeared.is_empty());
        assert_eq!(d.unchanged_count, 0);
    }

    #[test]
    fn summary_mentions_word_in_appeared_list() {
        let d = text_diff("", "Loading");
        assert!(d.summary.contains("Loading"), "summary: {}", d.summary);
    }
}
