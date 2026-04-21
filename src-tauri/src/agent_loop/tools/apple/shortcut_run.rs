//! `shortcut_run` — run a named macOS Shortcut with optional input.
//! L3 (runs arbitrary user automation — potentially any side effect).

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::{optional_string_arg, string_arg};
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["shortcut:run"];

const SCHEMA: &str = r#"{
  "type": "object",
  "properties": {
    "name":  {"type": "string", "description": "Exact Shortcut name (case-sensitive)."},
    "input": {"type": "string", "description": "Optional text / URL / file path passed as Shortcut input."}
  },
  "required": ["name"]
}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let name = string_arg(&input, "name")?;
        let sc_input = optional_string_arg(&input, "input");
        super::core::shortcut_run(&name, sc_input.as_deref()).await
    })
}

inventory::submit! {
    ToolSpec {
        name: "apple_shortcut_run",
        description: "Run a named macOS Shortcut (validates it exists first). Optionally pass text/URL/file as input.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalWrite,
        dangerous: true,
        invoke,
    }
}
