//! `music_now_playing` — read now-playing state from Music.app.
//! L0 (read-only, no side effects).

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["macos.media"];

const SCHEMA: &str = r#"{"type":"object","properties":{}}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, _input: Value) -> ToolFuture<'a> {
    Box::pin(async move { super::core::music_now_playing().await })
}

inventory::submit! {
    ToolSpec {
        name: "music_now_playing",
        description: "Get current Music.app track: title, artist, album, state, progress %.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::Pure,
        dangerous: false,
        invoke,
    }
}
