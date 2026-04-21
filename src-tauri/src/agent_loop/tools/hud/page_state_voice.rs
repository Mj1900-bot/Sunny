//! `page_state_voice` — peek at the Voice page's visible state.

use serde_json::Value;
use tauri::Manager;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["hud.read"];

const SCHEMA: &str = r#"{"type":"object","properties":{}}"#;

fn invoke<'a>(ctx: &'a ToolCtx<'a>, _input: Value) -> ToolFuture<'a> {
    let app = ctx.app.clone();
    Box::pin(async move {
        let state: tauri::State<'_, crate::page_state::PageStates> = app.state();
        crate::page_state::snapshot_json(&state, "voice")
    })
}

inventory::submit! {
    ToolSpec {
        name: "page_state_voice",
        description: "Return what the Voice page is currently showing. Use when Sunny asks 'am I recording', 'what was the last transcript', 'how many clips do I have'. Returns `{recording, last_transcript?, clip_count}`. Returns empty defaults before the user visits the Voice page.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke,
    }
}
