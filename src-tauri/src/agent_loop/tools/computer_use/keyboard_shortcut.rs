//! `keyboard_shortcut` — press a chord of keys, e.g. ["cmd","shift","4"].
//!
//! Trust level: L3 — dangerous: true.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["macos.accessibility"];

const SCHEMA: &str = r#"{
  "type": "object",
  "properties": {
    "keys": {
      "type": "array",
      "items": {"type": "string"},
      "minItems": 1,
      "description": "Key names in order: modifiers first, tap key last. E.g. [\"cmd\",\"c\"]"
    },
    "force": {"type": "boolean", "default": false}
  },
  "required": ["keys"]
}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        use crate::agent_loop::tools::computer_use::safety::{is_blocked_app, rate_limit_check};

        let keys: Vec<String> = input
            .get("keys")
            .and_then(|v| v.as_array())
            .ok_or("keyboard_shortcut: missing array arg `keys`")?
            .iter()
            .filter_map(|v| v.as_str().map(|s| s.to_string()))
            .collect();

        if keys.is_empty() {
            return Err("keyboard_shortcut: `keys` array is empty".into());
        }

        let force = input.get("force").and_then(|v| v.as_bool()).unwrap_or(false);

        rate_limit_check()?;

        if let Ok(app) = crate::ax::focused_app().await {
            if is_blocked_app(&app.name, app.bundle_id.as_deref(), force) {
                return Err(format!(
                    "keyboard_shortcut blocked: '{}' is a protected app.", app.name
                ));
            }
        }

        let label = keys.join("+");
        crate::automation::key_combo(keys).await?;
        Ok(format!("pressed {label}"))
    })
}

inventory::submit! {
    ToolSpec {
        name: "keyboard_shortcut",
        description: "Press a keyboard chord, e.g. [\"cmd\",\"c\"] for copy, \
                       [\"cmd\",\"shift\",\"4\"] for screenshot. \
                       Modifiers are held while the last key is tapped. \
                       Blocked in protected apps unless force:true.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalWrite,
        dangerous: true,
        invoke,
    }
}
