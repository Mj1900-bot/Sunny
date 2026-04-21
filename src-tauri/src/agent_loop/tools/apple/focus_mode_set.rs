//! `focus_mode_set` — activate a Focus / Do Not Disturb mode via a same-named Shortcut.
//! L2 (changes notification policy on the device).

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::string_arg;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["shortcut:run"];

const SCHEMA: &str = r#"{
  "type": "object",
  "properties": {
    "mode_name": {"type": "string", "description": "Focus mode name to activate (must match a Shortcut with the same name, e.g. 'Do Not Disturb')."}
  },
  "required": ["mode_name"]
}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let mode = string_arg(&input, "mode_name")?;
        super::core::focus_mode_set(&mode).await
    })
}

inventory::submit! {
    ToolSpec {
        name: "focus_mode_set",
        description: "Activate a Focus / Do Not Disturb mode via a same-named Shortcut (e.g. 'Do Not Disturb', 'Work', 'Sleep').",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalWrite,
        dangerous: false,
        invoke,
    }
}
