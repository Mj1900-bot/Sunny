//! `keyboard_type` — type a Unicode string into the focused application.
//!
//! Trust level: L3 — dangerous: true.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::string_arg;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["macos.accessibility"];

const SCHEMA: &str = r#"{
  "type": "object",
  "properties": {
    "text":  {"type": "string"},
    "force": {"type": "boolean", "default": false}
  },
  "required": ["text"]
}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        use crate::agent_loop::tools::computer_use::safety::{is_blocked_app, rate_limit_check};

        let text = string_arg(&input, "text")?;
        let force = input.get("force").and_then(|v| v.as_bool()).unwrap_or(false);

        rate_limit_check()?;

        if let Ok(app) = crate::ax::focused_app().await {
            if is_blocked_app(&app.name, app.bundle_id.as_deref(), force) {
                return Err(format!(
                    "keyboard_type blocked: '{}' is a protected app.", app.name
                ));
            }
        }

        crate::automation::type_text(text.clone()).await?;
        Ok(format!("typed {} chars", text.chars().count()))
    })
}

inventory::submit! {
    ToolSpec {
        name: "keyboard_type",
        description: "Type `text` as keyboard input into the currently focused app. \
                       Does NOT interpret shortcuts — use keyboard_shortcut for that. \
                       Blocked in protected apps unless force:true.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalWrite,
        dangerous: true,
        invoke,
    }
}
