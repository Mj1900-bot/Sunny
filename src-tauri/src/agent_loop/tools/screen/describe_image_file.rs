//! `describe_image_file` — caption an image file via a local vision model.
//!
//! Privacy level: L0 (no screen access; reads a caller-supplied file).
//!
//! ## Pipeline
//!
//! 1. Read + base64-encode the file.
//! 2. Attempt a local vision model caption (minicpm-v:8b → llava:13b) via
//!    the existing `tools_vision::image_describe` path.
//! 3. If no vision model is available, fall back to OCR + a text header so
//!    the agent still gets useful content.
//!
//! ## Distinction from `image_describe`
//!
//! `image_describe` (in `tools/vision/`) accepts `path` OR `base64` and is
//! the general-purpose image description primitive.  `describe_image_file`
//! wraps it with:
//!
//! * Explicit OCR fallback (returns text content even without Ollama).
//! * A `source` field so the caller knows which path was taken.
//! * Friendly error when the file is missing instead of a raw Ollama error.
//!
//! ## Return value
//!
//! ```json
//! {
//!   "description": "A screenshot of the login page showing a username…",
//!   "source": "vision_model",   // or "ocr_fallback"
//!   "width": 1440,
//!   "height": 900
//! }
//! ```

use serde_json::json;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["vision.describe"];

const SCHEMA: &str = r#"{
  "type": "object",
  "required": ["path"],
  "properties": {
    "path": {
      "type": "string",
      "description": "Absolute or ~/ path to a PNG or JPEG image file."
    },
    "prompt": {
      "type": "string",
      "description": "Optional custom instruction for the vision model."
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
            .ok_or("describe_image_file: `path` must be a non-empty string")?
            .to_string();

        let prompt = input
            .get("prompt")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        // Validate path (safety check).
        let expanded = crate::safety_paths::expand_home(&path)
            .map_err(|e| format!("describe_image_file: path: {e}"))?;
        crate::safety_paths::assert_read_allowed(&expanded)
            .map_err(|e| format!("describe_image_file: {e}"))?;
        if !expanded.is_file() {
            return Err(format!(
                "describe_image_file: not a readable file: {}",
                expanded.display()
            ));
        }

        // Read + encode.
        let bytes = std::fs::read(&expanded)
            .map_err(|e| format!("describe_image_file: read {}: {e}", expanded.display()))?;
        if bytes.is_empty() {
            return Err(format!("describe_image_file: empty file: {}", expanded.display()));
        }

        // Derive dimensions for the response (best-effort).
        let (width, height) = crate::vision::parse_png_dimensions(&bytes)
            .unwrap_or((0, 0));

        use base64::Engine;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);

        // Attempt vision model caption.
        let vision_input = crate::agent_loop::tools_vision::ImageDescribeInput {
            path: None,
            base64: Some(b64.clone()),
            prompt,
        };

        if let Ok(description) = crate::agent_loop::tools_vision::image_describe(vision_input).await {
            let out = json!({
                "description": description,
                "source": "vision_model",
                "width": width,
                "height": height,
            });
            return serde_json::to_string(&out)
                .map_err(|e| format!("describe_image_file: encode: {e}"));
        }

        // Fallback: OCR the image and return the text.
        let ocr_text = match crate::ocr::ocr_image_base64(b64, None).await {
            Ok(r) => r.text,
            Err(_) => String::new(),
        };

        let fallback_desc = format!(
            "[describe_image_file fallback — no vision model available]\n\
             Image: {}\n\
             Dimensions: {}x{}\n\
             OCR text:\n{}",
            expanded.display(),
            width,
            height,
            if ocr_text.is_empty() { "(no text recognized)" } else { &ocr_text }
        );

        let out = json!({
            "description": fallback_desc,
            "source": "ocr_fallback",
            "width": width,
            "height": height,
        });

        serde_json::to_string(&out)
            .map_err(|e| format!("describe_image_file: encode: {e}"))
    })
}

inventory::submit! {
    ToolSpec {
        name: "describe_image_file",
        description: "Caption an image file (PNG/JPEG) via a local vision model (minicpm-v:8b → llava:13b). \
                       Falls back to OCR + text description if no Ollama model is installed. \
                       Pass `path` (absolute or ~/) and optional `prompt` to customise the caption. \
                       Returns {description, source: 'vision_model'|'ocr_fallback', width, height}. \
                       Privacy level: L0 (no screen access; reads caller-supplied file; requires vision.describe).",
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
    fn missing_path_gives_none() {
        assert!(extract_path(&json!({})).is_none());
    }

    #[test]
    fn blank_path_gives_none() {
        assert!(extract_path(&json!({"path": "  "})).is_none());
    }

    #[test]
    fn valid_path_passes_through() {
        let v = json!({"path": "/tmp/img.png"});
        assert_eq!(extract_path(&v).as_deref(), Some("/tmp/img.png"));
    }

    #[test]
    fn parse_png_dimensions_rejects_garbage() {
        let bad: [u8; 10] = [0; 10];
        assert!(crate::vision::parse_png_dimensions(&bad).is_none());
    }

    #[test]
    fn parse_png_dimensions_accepts_minimal_png_header() {
        // 24-byte minimal PNG header: signature + IHDR length + "IHDR" + 1x1
        let mut h = [0u8; 24];
        h[0..8].copy_from_slice(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
        h[12..16].copy_from_slice(b"IHDR");
        h[16..20].copy_from_slice(&1u32.to_be_bytes()); // width=1
        h[20..24].copy_from_slice(&1u32.to_be_bytes()); // height=1
        assert_eq!(crate::vision::parse_png_dimensions(&h), Some((1, 1)));
    }
}
