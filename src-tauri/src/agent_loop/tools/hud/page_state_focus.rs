//! `page_state_focus` — peek at the Focus page's visible state.

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
        crate::page_state::snapshot_json(&state, "focus")
    })
}

inventory::submit! {
    ToolSpec {
        name: "page_state_focus",
        description: "Return what the Focus page is currently showing. Use when Sunny asks 'am I in a focus session', 'how much time is left', 'what mode am I in'. Returns `{running, elapsed_secs, target_secs, mode: 'sprint'|'deep'|'flow'|null}`. Returns empty defaults before the user visits the Focus page.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke,
    }
}
