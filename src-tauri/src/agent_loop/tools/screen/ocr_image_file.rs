//! `ocr_image_file` — OCR an arbitrary image file (not the live screen).
//!
//! Privacy level: L0 (no screen access; reads a user-specified file).
//!
//! ## Use cases
//!
//! * "What does this scanned document say?" → `ocr_image_file("~/Downloads/scan.png")`
//! * Post-process a screenshot the caller already saved.
//! * Any tool that has a PNG path and needs its text content.
//!
//! The tool delegates to `crate::ocr::ocr_image_base64` after reading and
//! encoding the file.  It does NOT require `macos.screen` — only file-read
//! access.  `safety_paths::assert_read_allowed` guards against path traversal.
//!
//! ## Return value
//!
//! Same `OcrResult` shape as `screen_ocr`:
//! `{text, boxes[{text,x,y,w,h,confidence}], engine, width, height, psm, avg_confidence}`

use serde_json::json;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

// No screen capability required — just filesystem read access.
const CAPS: &[&str] = &[];

const SCHEMA: &str = r#"{
  "type": "object",
  "required": ["path"],
  "properties": {
    "path": {
      "type": "string",
      "description": "Absolute or ~/ path to a PNG or JPEG image file."
    },
    "lang": {
      "type": "string",
      "description": "Tesseract language code(s), e.g. 'eng', 'eng+fra'. Default 'eng'."
    },
    "min_confidence": {
      "type": "number",
      "minimum": 0,
      "maximum": 100,
      "description": "Drop words below this confidence (0-100). Default 0."
    }
  }
}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: serde_json::Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let path = input
            .get("path")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or("ocr_image_file: `path` must be a non-empty string")?
            .to_string();

        let lang = input
            .get("lang")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let min_conf = input
            .get("min_confidence")
            .and_then(|v| v.as_f64())
            .map(|c| c.clamp(0.0, 100.0));

        // Expand and validate path.
        let expanded = crate::safety_paths::expand_home(&path)
            .map_err(|e| format!("ocr_image_file: path expand: {e}"))?;
        crate::safety_paths::assert_read_allowed(&expanded)
            .map_err(|e| format!("ocr_image_file: {e}"))?;

        if !expanded.is_file() {
            return Err(format!("ocr_image_file: not a readable file: {}", expanded.display()));
        }

        let bytes = std::fs::read(&expanded)
            .map_err(|e| format!("ocr_image_file: read {}: {e}", expanded.display()))?;

        if bytes.is_empty() {
            return Err(format!("ocr_image_file: file is empty: {}", expanded.display()));
        }

        use base64::Engine;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);

        let opts = crate::ocr::OcrOptions {
            lang,
            min_conf,
            psm: None,
        };

        let result = crate::ocr::ocr_image_base64(b64, Some(opts))
            .await
            .map_err(|e| format!("ocr_image_file: OCR: {e}"))?;

        // Return the full OcrResult.  No redaction needed — the caller
        // supplied the file themselves and is aware of its content.
        let out = json!({
            "text": result.text,
            "boxes": result.boxes,
            "engine": result.engine,
            "width": result.width,
            "height": result.height,
            "psm": result.psm,
            "avg_confidence": result.avg_confidence,
        });

        serde_json::to_string(&out)
            .map_err(|e| format!("ocr_image_file: encode: {e}"))
    })
}

inventory::submit! {
    ToolSpec {
        name: "ocr_image_file",
        description: "OCR an image file (PNG or JPEG) and return its text content with bounding boxes. \
                       Does NOT capture the live screen — pass a file path instead. \
                       Optional `lang` (e.g. 'eng+fra') and `min_confidence` (0-100). \
                       Returns {text, boxes[{text,x,y,w,h,confidence}], engine, width, height, avg_confidence}. \
                       Privacy level: L0 (no screen access; reads caller-supplied file).",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::Pure,
        dangerous: false,
        invoke,
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    // Path-validation logic is exercised via safety_paths tests.
    // OCR correctness is covered by ocr.rs's own test suite.
    // Here we test the input-parsing contract.

    use serde_json::json;

    fn extract_path(input: &serde_json::Value) -> Option<String> {
        input
            .get("path")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
    }

    #[test]
    fn missing_path_yields_none() {
        let input = json!({"lang": "eng"});
        assert!(extract_path(&input).is_none());
    }

    #[test]
    fn whitespace_path_yields_none() {
        let input = json!({"path": "   "});
        assert!(extract_path(&input).is_none());
    }

    #[test]
    fn valid_path_is_extracted() {
        let input = json!({"path": "/tmp/test.png"});
        assert_eq!(extract_path(&input).as_deref(), Some("/tmp/test.png"));
    }

    #[test]
    fn min_confidence_clamped() {
        let clamp = |v: f64| v.clamp(0.0, 100.0);
        assert_eq!(clamp(-5.0), 0.0);
        assert_eq!(clamp(110.0), 100.0);
        assert_eq!(clamp(80.0), 80.0);
    }
}
