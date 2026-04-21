//! `screen_ocr` — capture a fresh screenshot then OCR it.
//!
//! Trust level: L0 (read-only).  Wraps `crate::ocr::ocr_region` / `ocr_full_screen`
//! with an optional region argument.  Returns `{text, bounding_boxes[]}`.
//!
//! Supersedes `system::screen_ocr` which was a no-argument variant.
//! `system::screen_ocr` is renamed to `screen_ocr_full` to avoid the
//! duplicate `inventory` registration.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["macos.screen"];

const SCHEMA: &str = r#"{
  "type": "object",
  "properties": {
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

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let result = if let Some(r) = input.get("region") {
            let x = r.get("x").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
            let y = r.get("y").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
            let w = r.get("w").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
            let h = r.get("h").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
            if w <= 0 || h <= 0 {
                return Err("screen_ocr: region w and h must be positive".into());
            }
            crate::ocr::ocr_region(x, y, w, h, None).await?
        } else {
            crate::ocr::ocr_full_screen(None, None).await?
        };

        serde_json::to_string(&result).map_err(|e| format!("screen_ocr encode: {e}"))
    })
}

inventory::submit! {
    ToolSpec {
        name: "screen_ocr",
        description: "Capture a fresh screenshot and OCR it. Returns {text, boxes[{text,x,y,w,h,confidence}]}. \
                       Provide `region` {x,y,w,h} to limit to a sub-rectangle.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke,
    }
}
