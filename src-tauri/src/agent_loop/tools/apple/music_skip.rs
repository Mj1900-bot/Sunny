//! `music_skip` — skip forward N tracks in Music.app.
//! L2 (controls playback state).

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["macos.media.write"];

const SCHEMA: &str = r#"{
  "type": "object",
  "properties": {
    "count": {"type": "integer", "minimum": 1, "default": 1, "description": "Number of tracks to skip forward."}
  }
}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let count = input
            .get("count")
            .and_then(|v| v.as_u64())
            .map(|v| v as u32)
            .unwrap_or(1);
        super::core::music_skip(count).await
    })
}

inventory::submit! {
    ToolSpec {
        name: "music_skip",
        description: "Skip forward N tracks in Music.app (default 1).",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalWrite,
        dangerous: false,
        invoke,
    }
}
