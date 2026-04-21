//! `list_running_apps` — enumerate visible running applications.
//!
//! Trust level: L0 — read-only.  Uses `osascript` via `ax::list_windows`
//! and deduplicates on `app_name`.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["macos.accessibility"];

const SCHEMA: &str = r#"{"type":"object","properties":{}}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, _input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let windows = crate::ax::list_windows().await?;

        // Deduplicate by app_name, preserving first-seen order.
        let mut seen = std::collections::HashSet::new();
        let apps: Vec<serde_json::Value> = windows
            .into_iter()
            .filter(|w| seen.insert(w.app_name.clone()))
            .map(|w| {
                serde_json::json!({
                    "app_name": w.app_name,
                    "pid":      w.pid,
                })
            })
            .collect();

        serde_json::to_string(&apps).map_err(|e| format!("list_running_apps encode: {e}"))
    })
}

inventory::submit! {
    ToolSpec {
        name: "list_running_apps",
        description: "Return a list of [{app_name, pid}] for every visible running macOS application.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke,
    }
}
