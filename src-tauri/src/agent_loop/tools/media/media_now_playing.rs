//! `media_now_playing` — read currently-playing track.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["macos.media"];

const SCHEMA: &str = r#"{"type":"object","properties":{}}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, _input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let np = crate::media::media_now_playing().await?;
        serde_json::to_string(&np).map_err(|e| format!("now_playing encode: {e}"))
    })
}

inventory::submit! {
    ToolSpec {
        name: "media_now_playing",
        description: "Currently playing track: app, title, artist, album, position.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke,
    }
}
