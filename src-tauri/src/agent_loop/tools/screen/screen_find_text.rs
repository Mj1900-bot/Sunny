//! `screen_find_text` — OCR the full screen and return bounding boxes for
//! every occurrence of a query string.
//!
//! Privacy level: L1.
//!
//! ## Use case
//!
//! Useful as a pre-step before `computer_use/mouse_click`: the agent can call
//! `screen_find_text("Submit")` to discover the on-screen coordinate of a
//! button before issuing a click.
//!
//! ## Matching
//!
//! The search is case-insensitive substring matching against each OCR word's
//! text.  Whole-word and exact-case matching are opt-in via `exact` / `whole_word`.
//!
//! ## Return value
//!
//! ```json
//! {
//!   "query": "Submit",
//!   "matches": [
//!     {"text": "Submit", "x": 840, "y": 610, "w": 65, "h": 22, "confidence": 94.5}
//!   ],
//!   "total_words": 312
//! }
//! ```

use serde_json::json;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["macos.screen"];

const SCHEMA: &str = r#"{
  "type": "object",
  "required": ["query"],
  "properties": {
    "query": {
      "type": "string",
      "description": "Text to search for on screen (case-insensitive by default)."
    },
    "exact": {
      "type": "boolean",
      "description": "If true, match is case-sensitive. Default false."
    },
    "whole_word": {
      "type": "boolean",
      "description": "If true, the query must match a complete OCR word, not a substring. Default false."
    },
    "display": {
      "type": "integer",
      "minimum": 1,
      "description": "1-based display index. Omit for main display."
    }
  }
}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: serde_json::Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let query = input
            .get("query")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or("screen_find_text: `query` must be a non-empty string")?
            .to_string();

        let exact = input
            .get("exact")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let whole_word = input
            .get("whole_word")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let display = input
            .get("display")
            .and_then(|v| v.as_u64())
            .and_then(|n| usize::try_from(n).ok());

        let ocr = crate::ocr::ocr_full_screen(display, None)
            .await
            .map_err(|e| format!("screen_find_text: OCR failed: {e}"))?;

        let total_words = ocr.boxes.len();

        let needle_lower = query.to_lowercase();
        let matches: Vec<super::ScreenBBox> = ocr
            .boxes
            .iter()
            .filter(|b| {
                let haystack = if exact { b.text.clone() } else { b.text.to_lowercase() };
                let needle = if exact { query.clone() } else { needle_lower.clone() };
                if whole_word {
                    haystack == needle
                } else {
                    haystack.contains(&needle)
                }
            })
            .map(|b| super::ScreenBBox::from_ocr_box(b, 0.0, 0.0))
            .collect();

        let result = json!({
            "query": query,
            "matches": matches,
            "total_words": total_words,
        });

        serde_json::to_string(&result)
            .map_err(|e| format!("screen_find_text: encode: {e}"))
    })
}

inventory::submit! {
    ToolSpec {
        name: "screen_find_text",
        description: "OCR the full screen and return bounding boxes for every word that contains \
                       `query` (case-insensitive by default). Set `exact: true` for case-sensitive, \
                       `whole_word: true` to require a full-word match. \
                       Returns {query, matches[{text,x,y,w,h,confidence}], total_words}. \
                       Ideal as a coordinate lookup before mouse_click. \
                       Privacy level: L1 (reads full screen; requires macos.screen).",
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
    use crate::ocr::OcrBox;
    use super::super::ScreenBBox;

    fn make_box(text: &str, x: f64, y: f64) -> OcrBox {
        OcrBox { text: text.into(), x, y, w: 60.0, h: 20.0, confidence: 90.0 }
    }

    fn filter_boxes<'a>(
        boxes: &'a [OcrBox],
        query: &str,
        exact: bool,
        whole_word: bool,
    ) -> Vec<&'a OcrBox> {
        let needle_lower = query.to_lowercase();
        boxes
            .iter()
            .filter(|b| {
                let haystack = if exact { b.text.clone() } else { b.text.to_lowercase() };
                let needle = if exact { query.to_string() } else { needle_lower.clone() };
                if whole_word { haystack == needle } else { haystack.contains(&needle) }
            })
            .collect()
    }

    #[test]
    fn case_insensitive_substring_finds_partial_matches() {
        let boxes = vec![make_box("Submit", 100.0, 200.0), make_box("Cancel", 200.0, 200.0)];
        let hits = filter_boxes(&boxes, "sub", false, false);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].text, "Submit");
    }

    #[test]
    fn case_sensitive_exact_misses_different_case() {
        let boxes = vec![make_box("Submit", 0.0, 0.0)];
        let hits = filter_boxes(&boxes, "submit", true, false);
        assert!(hits.is_empty(), "exact match should be case-sensitive");
    }

    #[test]
    fn whole_word_requires_exact_equality() {
        let boxes = vec![
            make_box("Submit", 0.0, 0.0),
            make_box("Submitting", 10.0, 0.0),
        ];
        let hits = filter_boxes(&boxes, "submit", false, true);
        assert_eq!(hits.len(), 1, "whole_word should not match 'submitting'");
        assert_eq!(hits[0].text, "Submit");
    }

    #[test]
    fn empty_screen_returns_no_matches() {
        let boxes: Vec<OcrBox> = vec![];
        let hits = filter_boxes(&boxes, "OK", false, false);
        assert!(hits.is_empty());
    }

    #[test]
    fn bbox_coordinates_preserved_for_match() {
        let b = OcrBox { text: "OK".into(), x: 350.0, y: 480.0, w: 40.0, h: 18.0, confidence: 95.0 };
        let sb = ScreenBBox::from_ocr_box(&b, 0.0, 0.0);
        assert_eq!(sb.x, 350.0);
        assert_eq!(sb.y, 480.0);
    }
}
