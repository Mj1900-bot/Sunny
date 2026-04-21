//! `screen_capture` — capture the whole screen or a sub-region.
//!
//! Trust level: L0 (read-only).  No confirmation gate required.
//! As a side effect, populates the safety module's screen-bounds cache so
//! subsequent coordinate-validation calls know the display dimensions.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["macos.screen"];

// display? (1-based), region? {x,y,w,h}
const SCHEMA: &str = r#"{
  "type": "object",
  "properties": {
    "display": {"type": "integer", "minimum": 1, "description": "1-based display index. Omit for main display."},
    "region":  {
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
        let region = input.get("region");
        let display = input
            .get("display")
            .and_then(|v| v.as_u64())
            .and_then(|n| usize::try_from(n).ok());

        let img = if let Some(r) = region {
            let x = r.get("x").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
            let y = r.get("y").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
            let w = r.get("w").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
            let h = r.get("h").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
            if w <= 0 || h <= 0 {
                return Err("screen_capture: region w and h must be positive".into());
            }
            crate::vision::capture_region(x, y, w, h).await?
        } else {
            let img = crate::vision::capture_full_screen(display).await?;
            // Populate the coordinate-validation cache from the full-screen dims.
            crate::agent_loop::tools::computer_use::safety::set_screen_bounds(
                img.width as i32,
                img.height as i32,
            );
            img
        };

        serde_json::to_string(&img).map_err(|e| format!("screen_capture encode: {e}"))
    })
}

inventory::submit! {
    ToolSpec {
        name: "screen_capture",
        description: "Capture the full screen (or a sub-region) and return a base64 PNG with dimensions. \
                       Provide `display` (1-based) to target a secondary monitor. \
                       Provide `region` {x,y,w,h} to capture a sub-rectangle.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke,
    }
}
