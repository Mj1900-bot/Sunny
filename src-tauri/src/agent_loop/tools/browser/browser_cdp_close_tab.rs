//! `browser_cdp_close_tab` — close a Chromium tab by tab_id.
//!
//! Risk: L1 (no network write; just closes a tab).
//! Required capability: `browser:cdp`.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::string_arg;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};
use crate::browser::cdp::session::cdp_close_tab;

const CAPS: &[&str] = &["browser:cdp"];

const SCHEMA: &str = r#"{
  "type": "object",
  "properties": {
    "tab_id": { "type": "string", "description": "Tab returned by browser_cdp_open." }
  },
  "required": ["tab_id"]
}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let tab_id = string_arg(&input, "tab_id")?;
        cdp_close_tab(&tab_id).await.map_err(|e| e.to_string())?;
        Ok(format!("closed tab {tab_id}"))
    })
}

inventory::submit! {
    ToolSpec {
        name: "browser_cdp_close_tab",
        description: "Close a Chromium tab. \
            The tab_id is invalidated after this call.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::Pure,
        dangerous: false,
        invoke,
    }
}
