//! `page_state_notes` — peek at the Notes page's visible state.

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
        crate::page_state::snapshot_json(&state, "notes")
    })
}

inventory::submit! {
    ToolSpec {
        name: "page_state_notes",
        description: "Return what the Notes page is currently showing. Use when Sunny asks 'what note am I on', 'what folder am I in', 'what am I searching for'. Returns `{selected_note_id?, folder, search_query}`. Returns empty defaults before the user visits the Notes page.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke,
    }
}
