//! `homekit_scene_run` — activate a HomeKit scene via a same-named Shortcut.
//! L3 (physical effect on smart-home devices).

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::string_arg;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["shortcut:run"];

const SCHEMA: &str = r#"{
  "type": "object",
  "properties": {
    "scene_name": {"type": "string", "description": "HomeKit scene name (must match a Shortcut with the same name)."}
  },
  "required": ["scene_name"]
}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let scene = string_arg(&input, "scene_name")?;
        super::core::homekit_scene_run(&scene).await
    })
}

inventory::submit! {
    ToolSpec {
        name: "homekit_scene_run",
        description: "Activate a HomeKit scene by running a Shortcut with the same name (e.g. 'Lights Off'). Physical side effect.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalWrite,
        dangerous: true,
        invoke,
    }
}
