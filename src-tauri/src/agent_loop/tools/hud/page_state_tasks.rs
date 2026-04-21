//! `page_state_tasks` — peek at the Tasks page's visible state.

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
        crate::page_state::snapshot_json(&state, "tasks")
    })
}

inventory::submit! {
    ToolSpec {
        name: "page_state_tasks",
        description: "Return what the Tasks page is currently showing. Use when Sunny asks 'what tab am I on', 'what tasks are selected', 'how many are done', or any question about the tasks view. Returns `{active_tab, selected_ids[], filter_query, total_count, completed_count}`. Returns empty defaults before the user visits the Tasks page.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke,
    }
}
