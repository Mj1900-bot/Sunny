//! `photos_recent` — list recent photos from Photos.app.
//! L1 (reads private photos library).

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["macos.photos"];

const SCHEMA: &str = r#"{
  "type": "object",
  "properties": {
    "count": {"type": "integer", "minimum": 1, "maximum": 100, "default": 10, "description": "Number of recent photos to return."}
  }
}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let count = input
            .get("count")
            .and_then(|v| v.as_u64())
            .map(|v| v as u32)
            .unwrap_or(10);
        super::core::photos_recent(count).await
    })
}

inventory::submit! {
    ToolSpec {
        name: "photos_recent",
        description: "List recent photos from Photos.app: id, date, dimensions. Requires Photos access in System Settings.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke,
    }
}
