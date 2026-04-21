//! `clipboard_history` — recent clipboard entries captured by SUNNY.
//!
//! Post-read, clipboard contents are scanned for prompt-injection +
//! canary leaks (classic indirect-injection vector) before being
//! handed back to the model.

use serde_json::Value;
use tauri::Manager;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::usize_arg;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};
use crate::security;

const CAPS: &[&str] = &["macos.clipboard"];

const SCHEMA: &str = r#"{"type":"object","properties":{"limit":{"type":"integer"}}}"#;

fn invoke<'a>(ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    let app = ctx.app.clone();
    Box::pin(async move {
        let limit = usize_arg(&input, "limit").unwrap_or(10);
        let state: tauri::State<'_, crate::app_state::AppState> = app.state();
        let entries: Vec<crate::clipboard::ClipboardEntry> = {
            let guard = state
                .clipboard
                .lock()
                .map_err(|e| format!("clipboard lock: {e}"))?;
            guard.iter().take(limit).cloned().collect()
        };
        // Scan for prompt-injection + canary leaks before handing back.
        let joined: String = entries
            .iter()
            .map(|e| e.text.clone())
            .collect::<Vec<_>>()
            .join("\n");
        security::ingress::inspect("clipboard", &joined);
        if security::canary::contains_canary(&joined) {
            security::canary::trip(
                "clipboard_read",
                "agent pulled canary via clipboard_history",
            );
        }
        let entries: Vec<crate::clipboard::ClipboardEntry> = entries
            .into_iter()
            .map(|mut e| {
                e.text = security::ingress::scrub_for_context(&e.text);
                e
            })
            .collect();
        serde_json::to_string(&entries).map_err(|e| format!("clipboard encode: {e}"))
    })
}

inventory::submit! {
    ToolSpec {
        name: "clipboard_history",
        description: "Recent clipboard entries captured by SUNNY.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke,
    }
}
