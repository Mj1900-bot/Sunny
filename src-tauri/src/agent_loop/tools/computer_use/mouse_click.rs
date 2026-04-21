//! `mouse_click` — move to (x, y) and click.
//!
//! Trust level: L3 — requires confirmation gate (dangerous: true).
//! Additional gates: coordinate clamp, dangerous-app check, rate limit.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["macos.screen", "macos.accessibility"];

const SCHEMA: &str = r#"{
  "type": "object",
  "properties": {
    "x":      {"type": "integer"},
    "y":      {"type": "integer"},
    "button": {"type": "string", "enum": ["left","right","middle"], "default": "left"},
    "count":  {"type": "integer", "minimum": 1, "maximum": 2, "default": 1},
    "force":  {"type": "boolean", "default": false,
               "description": "L5 override — allow clicking in dangerous apps."}
  },
  "required": ["x","y"]
}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        use crate::agent_loop::tools::computer_use::safety::{
            is_blocked_app, rate_limit_check, validate_coords,
        };

        let x = input.get("x").and_then(|v| v.as_i64())
            .ok_or("mouse_click: missing integer arg `x`")? as i32;
        let y = input.get("y").and_then(|v| v.as_i64())
            .ok_or("mouse_click: missing integer arg `y`")? as i32;
        let button = input.get("button").and_then(|v| v.as_str())
            .unwrap_or("left")
            .to_string();
        let count = input.get("count").and_then(|v| v.as_u64())
            .map(|n| n as u32)
            .unwrap_or(1);
        let force = input.get("force").and_then(|v| v.as_bool()).unwrap_or(false);

        validate_coords(x, y)?;
        rate_limit_check()?;

        // Check the currently focused app.
        if let Ok(app) = crate::ax::focused_app().await {
            let bid = app.bundle_id.as_deref();
            if is_blocked_app(&app.name, bid, force) {
                return Err(format!(
                    "mouse_click blocked: '{}' is a protected app. \
                     Pass force:true for L5 override.",
                    app.name
                ));
            }
        }

        crate::automation::click_at(x, y, button, count).await?;
        Ok(format!("clicked ({x},{y})"))
    })
}

inventory::submit! {
    ToolSpec {
        name: "mouse_click",
        description: "Move the cursor to (x, y) and click. \
                       button: left|right|middle (default left). \
                       count: 1 or 2 (default 1). \
                       Blocked in Terminal, Keychain, password managers, System Settings \
                       unless force:true is supplied.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalWrite,
        dangerous: true,
        invoke,
    }
}
