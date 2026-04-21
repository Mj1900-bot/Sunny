//! `browser_cdp_click` — click a CSS-selected element.
//!
//! Risk: L1 normally; L4 on login/password pages (confirm gate fires).
//! Required capability: `browser:cdp`.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::{optional_string_arg, string_arg, usize_arg};
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};
use crate::browser::cdp::security::{action_risk, RiskLevel};
use crate::browser::cdp::session::cdp_click;

const CAPS: &[&str] = &["browser:cdp"];

const SCHEMA: &str = r#"{
  "type": "object",
  "properties": {
    "tab_id":     { "type": "string", "description": "Tab returned by browser_cdp_open." },
    "selector":   { "type": "string", "description": "CSS selector of the element to click." },
    "timeout_ms": { "type": "integer", "description": "Max wait for element (default 5000 ms)." },
    "page_url":   { "type": "string",  "description": "Current page URL — used to determine risk level." }
  },
  "required": ["tab_id", "selector"]
}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let tab_id = string_arg(&input, "tab_id")?;
        let selector = string_arg(&input, "selector")?;
        let timeout_ms = usize_arg(&input, "timeout_ms").map(|n| n as u64);
        let page_url = optional_string_arg(&input, "page_url").unwrap_or_default();

        // Annotate risk but do NOT gate here — confirm.rs handles dangerous=true
        // via the dispatcher. We surface risk in the returned JSON so the
        // confirm modal can show context.
        let risk = action_risk(&page_url, &selector);
        if risk == RiskLevel::L4 {
            log::warn!(
                "[cdp:click] L4 action on sensitive page — tab={tab_id} sel={selector}"
            );
        }

        let result = cdp_click(&tab_id, &selector, timeout_ms)
            .await
            .map_err(|e| e.to_string())?;

        serde_json::to_string(&result).map_err(|e| format!("serialise result: {e}"))
    })
}

inventory::submit! {
    ToolSpec {
        name: "browser_cdp_click",
        description: "Click the first element matching a CSS selector in a Chromium tab. \
            Waits up to 5 s (configurable) for the element to appear. \
            L4 risk on login/password pages.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalWrite,
        dangerous: true,
        invoke,
    }
}
