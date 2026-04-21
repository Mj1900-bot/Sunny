//! `current_page_state` — which HUD page is currently visible.

use serde_json::Value;
use tauri::Manager;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["hud.read"];

const SCHEMA: &str = r#"{"type":"object","properties":{}}"#;

fn invoke<'a>(ctx: &'a ToolCtx<'a>, _input: Value) -> ToolFuture<'a> {
    let app = ctx.app.clone();
    Box::pin(async move {
        let state: tauri::State<'_, crate::app_state::AppState> = app.state();
        let guard = state
            .current_view
            .lock()
            .map_err(|_| "current_page_state: mutex poisoned".to_string())?;
        match guard.clone() {
            Some(cv) => serde_json::to_string(&cv)
                .map_err(|e| format!("current_page_state: encode: {e}")),
            None => Ok("null".to_string()),
        }
    })
}

inventory::submit! {
    ToolSpec {
        name: "current_page_state",
        description: "Return which HUD page is currently visible and its title / subtitle. Use when Sunny asks 'what am I looking at', 'what page is this', 'where am I in the app'. Returns `{view, title, subtitle?}`. If no page has registered itself yet (very early boot), returns null — answer with 'overview' as a sensible default.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke,
    }
}
