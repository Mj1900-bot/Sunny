//! `mouse_drag` — press, drag, release between two points.
//!
//! Trust level: L3 — dangerous: true.
//! Enigo does not have a native drag API; we emulate it with
//! `move_mouse + button(Press) + move_mouse + button(Release)` via a single
//! `spawn_blocking` closure so the three operations are atomic from the OS's
//! perspective.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["macos.screen", "macos.accessibility"];

const SCHEMA: &str = r#"{
  "type": "object",
  "properties": {
    "from_x": {"type": "integer"},
    "from_y": {"type": "integer"},
    "to_x":   {"type": "integer"},
    "to_y":   {"type": "integer"},
    "force":  {"type": "boolean", "default": false}
  },
  "required": ["from_x","from_y","to_x","to_y"]
}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        use crate::agent_loop::tools::computer_use::safety::{
            is_blocked_app, rate_limit_check, validate_coords,
        };
        use enigo::{Button, Coordinate, Direction, Enigo, Mouse, Settings};

        let from_x = input.get("from_x").and_then(|v| v.as_i64())
            .ok_or("mouse_drag: missing `from_x`")? as i32;
        let from_y = input.get("from_y").and_then(|v| v.as_i64())
            .ok_or("mouse_drag: missing `from_y`")? as i32;
        let to_x = input.get("to_x").and_then(|v| v.as_i64())
            .ok_or("mouse_drag: missing `to_x`")? as i32;
        let to_y = input.get("to_y").and_then(|v| v.as_i64())
            .ok_or("mouse_drag: missing `to_y`")? as i32;
        let force = input.get("force").and_then(|v| v.as_bool()).unwrap_or(false);

        validate_coords(from_x, from_y)?;
        validate_coords(to_x, to_y)?;
        rate_limit_check()?;

        if let Ok(app) = crate::ax::focused_app().await {
            if is_blocked_app(&app.name, app.bundle_id.as_deref(), force) {
                return Err(format!(
                    "mouse_drag blocked: '{}' is a protected app.", app.name
                ));
            }
        }

        tokio::task::spawn_blocking(move || {
            let mut enigo = Enigo::new(&Settings::default())
                .map_err(|e| format!("enigo init: {e}"))?;
            enigo.move_mouse(from_x, from_y, Coordinate::Abs)
                .map_err(|e| format!("move to drag start: {e}"))?;
            enigo.button(Button::Left, Direction::Press)
                .map_err(|e| format!("drag press: {e}"))?;
            enigo.move_mouse(to_x, to_y, Coordinate::Abs)
                .map_err(|e| format!("drag move: {e}"))?;
            enigo.button(Button::Left, Direction::Release)
                .map_err(|e| format!("drag release: {e}"))?;
            Ok::<String, String>(format!("dragged ({from_x},{from_y}) → ({to_x},{to_y})"))
        })
        .await
        .map_err(|e| format!("drag task panicked: {e}"))?
    })
}

inventory::submit! {
    ToolSpec {
        name: "mouse_drag",
        description: "Press the left button at (from_x, from_y), drag to (to_x, to_y), then release. \
                       Blocked in protected apps unless force:true.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalWrite,
        dangerous: true,
        invoke,
    }
}
