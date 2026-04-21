//! `browser_cdp_list_tabs` — list all open Chromium tabs.
//!
//! Risk: L1 (read-only).
//! Required capability: `browser:cdp`.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};
use crate::browser::cdp::session::cdp_list_tabs;

const CAPS: &[&str] = &["browser:cdp"];

const SCHEMA: &str = r#"{"type":"object","properties":{}}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, _input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let tabs = cdp_list_tabs().await.map_err(|e| e.to_string())?;
        if tabs.is_empty() {
            return Ok("No Chromium tabs open (browser may not be running).".into());
        }
        serde_json::to_string(&tabs).map_err(|e| format!("serialise result: {e}"))
    })
}

inventory::submit! {
    ToolSpec {
        name: "browser_cdp_list_tabs",
        description: "List all open Chromium tabs managed by SUNNY. \
            Returns an array of {tab_id, url, title} objects.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::Pure,
        dangerous: false,
        invoke,
    }
}
