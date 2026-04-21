//! `browser_cdp_wait` — explicit wait for a selector or network-idle.
//!
//! Risk: L1 (read-only; no side effects).
//! Required capability: `browser:cdp`.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::{string_arg, usize_arg};
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};
use crate::browser::cdp::session::cdp_wait;

const CAPS: &[&str] = &["browser:cdp"];

const SCHEMA: &str = r#"{
  "type": "object",
  "properties": {
    "tab_id":      { "type": "string",  "description": "Tab returned by browser_cdp_open." },
    "wait_for":    { "type": "string",  "description": "CSS selector OR the literal string 'networkidle'." },
    "timeout_ms":  { "type": "integer", "description": "Max wait in milliseconds (default 5000)." }
  },
  "required": ["tab_id", "wait_for"]
}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let tab_id = string_arg(&input, "tab_id")?;
        let wait_for = string_arg(&input, "wait_for")?;
        let timeout_ms = usize_arg(&input, "timeout_ms").map(|n| n as u64);

        let result = cdp_wait(&tab_id, &wait_for, timeout_ms)
            .await
            .map_err(|e| e.to_string())?;

        serde_json::to_string(&result).map_err(|e| format!("serialise result: {e}"))
    })
}

inventory::submit! {
    ToolSpec {
        name: "browser_cdp_wait",
        description: "Wait until a CSS selector appears in the DOM, or until network activity \
            is idle. Pass 'networkidle' as wait_for to wait for network quiet. \
            Returns elapsed_ms on success; errors on timeout.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::Pure,
        dangerous: false,
        invoke,
    }
}
