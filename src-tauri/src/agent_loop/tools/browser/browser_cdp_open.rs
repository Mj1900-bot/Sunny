//! `browser_cdp_open` — open a URL in persistent Chromium via CDP.
//!
//! Risk: L4 (opens a new browser tab — write side effect).
//! Required capability: `browser:cdp`.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::{optional_string_arg, string_arg};
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};
use crate::browser::cdp::session::cdp_open;

const CAPS: &[&str] = &["browser:cdp"];

const SCHEMA: &str = r#"{
  "type": "object",
  "properties": {
    "url": { "type": "string", "description": "HTTP/HTTPS URL to open." },
    "tab_id": { "type": "string", "description": "Existing tab_id to reuse; omit to open a new tab." }
  },
  "required": ["url"]
}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let url = string_arg(&input, "url")?;
        let tab_id = optional_string_arg(&input, "tab_id");

        let result = cdp_open(&url, tab_id.as_deref())
            .await
            .map_err(|e| e.to_string())?;

        serde_json::to_string(&result).map_err(|e| format!("serialise result: {e}"))
    })
}

inventory::submit! {
    ToolSpec {
        name: "browser_cdp_open",
        description: "Open a URL in a persistent Chromium browser tab. \
            Returns a tab_id for subsequent CDP tool calls. \
            Pass tab_id to re-navigate an existing tab instead of opening a new one.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalWrite,
        dangerous: false,
        invoke,
    }
}
