//! `page_state_calendar` — peek at the Calendar page's visible state.

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
        crate::page_state::snapshot_json(&state, "calendar")
    })
}

inventory::submit! {
    ToolSpec {
        name: "page_state_calendar",
        description: "Return what the Calendar page is currently showing. Use when Sunny asks 'what day am I on', 'which event is selected', 'what calendars are hidden', or any question about the calendar view's current state. Returns `{active_date, view_mode: 'day'|'week'|'month', selected_event_id?, hidden_calendars[]}`. Returns empty defaults if the user has not visited the Calendar page yet.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke,
    }
}
