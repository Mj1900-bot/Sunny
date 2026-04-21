//! `page_state_inbox` — peek at the Inbox page's visible state.

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
        crate::page_state::snapshot_json(&state, "inbox")
    })
}

inventory::submit! {
    ToolSpec {
        name: "page_state_inbox",
        description: "Return what the Inbox page is currently showing. Use when Sunny asks 'which message am I reading', 'what filter is active', or any question about the inbox view. Returns `{selected_item_id?, filter, triage_labels_summary}`. Returns empty defaults before the user visits the Inbox page.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke,
    }
}
