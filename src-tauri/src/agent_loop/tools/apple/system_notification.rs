//! `system_notification` — post a native macOS notification.
//! L0 (informational output only, no data is read or mutated).

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::{optional_string_arg, string_arg};
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &[];

const SCHEMA: &str = r#"{
  "type": "object",
  "properties": {
    "title": {"type": "string", "description": "Notification title (required)."},
    "body":  {"type": "string", "description": "Notification body text."},
    "sound": {"type": "boolean", "default": false, "description": "Play the default notification sound."}
  },
  "required": ["title"]
}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let title = string_arg(&input, "title")?;
        let body = optional_string_arg(&input, "body").unwrap_or_default();
        let sound = input
            .get("sound")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        super::core::system_notification(&title, &body, sound).await
    })
}

inventory::submit! {
    ToolSpec {
        name: "system_notification",
        description: "Post a native macOS notification with title and body. Optionally plays a sound.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::Pure,
        dangerous: false,
        invoke,
    }
}
