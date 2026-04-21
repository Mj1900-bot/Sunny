//! `media_play_pause` — toggle play/pause on the active media app. DANGEROUS.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["macos.media.write"];

const SCHEMA: &str = r#"{"type":"object","properties":{}}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, _input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        crate::media::media_toggle_play_pause()
            .await
            .map(|_| "toggled".to_string())
    })
}

inventory::submit! {
    ToolSpec {
        name: "media_play_pause",
        description: "Toggle play/pause on the active media app.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalWrite,
        dangerous: true,
        invoke,
    }
}
