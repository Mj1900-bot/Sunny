//! `music_volume` — read or set Music.app volume (0–100).
//! Read is L0; set is L2.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["macos.media"];

const SCHEMA: &str = r#"{
  "type": "object",
  "properties": {
    "level": {"type": "integer", "minimum": 0, "maximum": 100, "description": "Volume level 0–100. Omit to read current volume."}
  }
}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let level = input
            .get("level")
            .and_then(|v| v.as_u64())
            .map(|v| v as u32);
        super::core::music_volume(level).await
    })
}

inventory::submit! {
    ToolSpec {
        name: "music_volume",
        description: "Read or set Music.app volume (0–100). Omit `level` to read current volume.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::Pure,
        dangerous: false,
        invoke,
    }
}
