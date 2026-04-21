//! Smart screen-reading tools — L1/L2 privacy tier.
//!
//! These tools sit one level above the raw `computer_use` capture tools:
//! they add active-window targeting, query-driven text finding, multi-step
//! flow guidance, screenshot diffing, and file-backed OCR / description.
//!
//! ## Tool surface
//!
//! | Tool                    | Privacy | Description                                  |
//! |-------------------------|---------|----------------------------------------------|
//! | `screen_read_active_window` | L1  | OCR the focused window; redacts passwords    |
//! | `screen_find_text`      | L1      | OCR full screen, return matching bbox list   |
//! | `screen_describe_flow`  | L2      | Screenshot → OCR → GLM guidance step        |
//! | `screen_compare`        | L1      | Diff two screenshots, return change text     |
//! | `ocr_image_file`        | L0      | OCR an arbitrary image file (no live screen) |
//! | `describe_image_file`   | L0      | Caption an image file via local vision model |
//!
//! ## Redaction pipeline (L1 tools)
//!
//! Every OCR output that leaves `screen_read_active_window` is passed through
//! `crate::security::redact::RedactionSet::scrub` before being returned.
//! If any substitution is made a `SecurityEvent::Notice` at `Severity::Warn`
//! is emitted on the bus so the Security page surfaces it.
//!
//! ## Screenshot bytes
//!
//! No screenshot pixels are persisted to disk by these tools unless the caller
//! explicitly passes a `before_path` / `after_path` to `screen_compare`.  All
//! intermediate capture data lives in memory for the lifetime of the tool call
//! only.
//!
//! ## Apple Vision framework
//!
//! All OCR uses the existing `crate::ocr` pipeline (tesseract).  A Swift shim
//! would be required to use `VNRecognizeTextRequest` directly; that is noted
//! in individual tool docs where it would meaningfully improve accuracy but is
//! NOT a hard dependency.

pub mod describe_image_file;
pub mod ocr_image_file;
pub mod screen_compare;
pub mod screen_describe_flow;
pub mod screen_find_text;
pub mod screen_read_active_window;

// ---------------------------------------------------------------------------
// Shared helpers used by multiple tools in this module
// ---------------------------------------------------------------------------

use crate::ocr::OcrBox;

/// Axis-aligned bounding box with screen coordinates.
///
/// `ocr_image_base64` returns coordinates in PNG-pixel space.  For tools that
/// capture a sub-region (e.g. `screen_read_active_window`) the caller adds the
/// region's origin before building this struct so the caller always sees screen
/// coordinates.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ScreenBBox {
    pub text: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub confidence: f64,
}

impl ScreenBBox {
    /// Translate a pixel-space `OcrBox` (origin at region top-left) into
    /// screen coordinates by adding the region's origin.
    pub fn from_ocr_box(b: &OcrBox, origin_x: f64, origin_y: f64) -> Self {
        Self {
            text: b.text.clone(),
            x: b.x + origin_x,
            y: b.y + origin_y,
            w: b.w,
            h: b.h,
            confidence: b.confidence,
        }
    }
}

/// Scrub OCR text and emit a security warning if anything was redacted.
///
/// Returns `(scrubbed_text, was_redacted)`.
pub fn redact_ocr(raw: &str) -> (String, bool) {
    let set = crate::security::redact::RedactionSet::get();
    let scrubbed = set.scrub(raw);
    let was_redacted = scrubbed != raw;
    if was_redacted {
        crate::security::emit(crate::security::SecurityEvent::Notice {
            at: now_ms(),
            source: "screen_read_active_window".into(),
            message: "OCR output contained potential secrets; redacted before returning".into(),
            severity: crate::security::Severity::Warn,
        });
    }
    (scrubbed, was_redacted)
}

/// Current Unix timestamp in milliseconds.
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Unit tests for shared helpers
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ocr::OcrBox;

    // ── ScreenBBox coordinate arithmetic ────────────────────────────────────

    #[test]
    fn bbox_origin_offset_is_additive() {
        let b = OcrBox {
            text: "OK".into(),
            x: 10.0,
            y: 20.0,
            w: 50.0,
            h: 15.0,
            confidence: 90.0,
        };
        let sb = ScreenBBox::from_ocr_box(&b, 100.0, 200.0);
        assert_eq!(sb.x, 110.0, "x = ocr.x + origin_x");
        assert_eq!(sb.y, 220.0, "y = ocr.y + origin_y");
        assert_eq!(sb.w, 50.0, "w unchanged");
        assert_eq!(sb.h, 15.0, "h unchanged");
        assert_eq!(sb.text, "OK");
    }

    #[test]
    fn bbox_zero_origin_is_identity() {
        let b = OcrBox {
            text: "Hi".into(),
            x: 5.0,
            y: 7.0,
            w: 30.0,
            h: 12.0,
            confidence: 95.0,
        };
        let sb = ScreenBBox::from_ocr_box(&b, 0.0, 0.0);
        assert_eq!(sb.x, 5.0);
        assert_eq!(sb.y, 7.0);
    }

    #[test]
    fn bbox_negative_origin_subtracts() {
        let b = OcrBox {
            text: "X".into(),
            x: 50.0,
            y: 50.0,
            w: 10.0,
            h: 10.0,
            confidence: 80.0,
        };
        // Multi-display: secondary display at x = -1920.
        let sb = ScreenBBox::from_ocr_box(&b, -1920.0, 0.0);
        assert_eq!(sb.x, 50.0 - 1920.0);
    }

    // ── Redaction helper ────────────────────────────────────────────────────

    #[test]
    fn redact_ocr_clean_text_is_unchanged() {
        let (out, redacted) = redact_ocr("Hello world");
        assert_eq!(out, "Hello world");
        assert!(!redacted, "clean text must not be flagged as redacted");
    }

    #[test]
    fn redact_ocr_strips_api_key() {
        let raw = "Password: sk-proj-abcdefghij1234567890ABCDEF";
        let (out, redacted) = redact_ocr(raw);
        assert!(redacted, "api key must be detected");
        assert!(!out.contains("sk-proj-"), "key must be removed from output");
        assert!(out.contains("***"), "replacement marker must be present");
    }

    #[test]
    fn redact_ocr_empty_string_is_clean() {
        let (out, redacted) = redact_ocr("");
        assert_eq!(out, "");
        assert!(!redacted);
    }

    // ── now_ms sanity ────────────────────────────────────────────────────────

    #[test]
    fn now_ms_is_positive_and_reasonable() {
        let ts = now_ms();
        // 2020-01-01 00:00:00 UTC in ms
        assert!(ts > 1_577_836_800_000, "timestamp must be after 2020: {ts}");
    }
}
