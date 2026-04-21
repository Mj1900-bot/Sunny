//! `browser_cdp_eval` — evaluate JavaScript in a Chromium tab.
//!
//! Risk: L4 (arbitrary code execution / network-write risk).
//! Required capability: `browser:eval` (stricter than `browser:cdp`).
//! ALWAYS flagged `dangerous: true` — the confirm gate always fires.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::string_arg;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};
use crate::browser::cdp::session::cdp_eval;

/// Stricter capability — operator must explicitly grant `browser:eval`.
const CAPS: &[&str] = &["browser:cdp", "browser:eval"];

const SCHEMA: &str = r#"{
  "type": "object",
  "properties": {
    "tab_id": { "type": "string", "description": "Tab returned by browser_cdp_open." },
    "js":     { "type": "string", "description": "JavaScript expression to evaluate." }
  },
  "required": ["tab_id", "js"]
}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let tab_id = string_arg(&input, "tab_id")?;
        let js = string_arg(&input, "js")?;

        let result = cdp_eval(&tab_id, &js)
            .await
            .map_err(|e| e.to_string())?;

        serde_json::to_string(&result).map_err(|e| format!("serialise result: {e}"))
    })
}

inventory::submit! {
    ToolSpec {
        name: "browser_cdp_eval",
        description: "Evaluate a JavaScript expression in a Chromium tab and return the \
            JSON-serialisable result. GATED L4 — requires browser:eval capability AND \
            user confirmation on every call. Use browser_cdp_click / browser_cdp_type \
            for form automation instead of raw JS where possible.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalWrite,
        dangerous: true,
        invoke,
    }
}
