//! `system_metrics` — CPU / memory / disk snapshot.

use serde_json::Value;
use tauri::Manager;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["system.metrics"];

const SCHEMA: &str = r#"{"type":"object","properties":{}}"#;

fn invoke<'a>(ctx: &'a ToolCtx<'a>, _input: Value) -> ToolFuture<'a> {
    let app = ctx.app.clone();
    Box::pin(async move {
        let state: tauri::State<'_, crate::app_state::AppState> = app.state();
        let mut collector = state
            .collector
            .lock()
            .map_err(|e| format!("collector lock: {e}"))?;
        let sample = collector.sample();
        serde_json::to_string(&sample).map_err(|e| format!("metrics encode: {e}"))
    })
}

inventory::submit! {
    ToolSpec {
        name: "system_metrics",
        description: "Snapshot of CPU, memory, and disk usage on this Mac.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke,
    }
}
