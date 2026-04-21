//! `active_window_info` — frontmost app name, bundle ID, window title, bounds.
//!
//! Trust level: L0 — read-only, no side effects.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["macos.accessibility"];

const SCHEMA: &str = r#"{"type":"object","properties":{}}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, _input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        // Get focused app info (name, bundle_id, pid).
        let app = crate::ax::focused_app().await?;

        // Get window list to find the frontmost window's title and bounds.
        let windows = crate::ax::list_windows().await.unwrap_or_default();
        let front_window = windows
            .iter()
            .find(|w| w.app_name == app.name)
            .cloned();

        let result = serde_json::json!({
            "app_name":  app.name,
            "bundle_id": app.bundle_id,
            "pid":       app.pid,
            "window_title": front_window.as_ref().map(|w| &w.title),
            "bounds": front_window.as_ref().map(|w| serde_json::json!({
                "x": w.x, "y": w.y, "w": w.w, "h": w.h
            })),
        });

        serde_json::to_string(&result).map_err(|e| format!("active_window_info encode: {e}"))
    })
}

inventory::submit! {
    ToolSpec {
        name: "active_window_info",
        description: "Return {app_name, bundle_id, pid, window_title, bounds} for the \
                       currently frontmost macOS window.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke,
    }
}
