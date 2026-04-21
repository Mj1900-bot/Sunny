//! `browser_cdp_type` — fill an input element with text.
//!
//! Risk: L4 on password/login pages; L1 otherwise.
//! Required capability: `browser:cdp`.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::{optional_string_arg, string_arg};
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};
use crate::browser::cdp::security::{action_risk, RiskLevel};
use crate::browser::cdp::session::cdp_type;

const CAPS: &[&str] = &["browser:cdp"];

const SCHEMA: &str = r#"{
  "type": "object",
  "properties": {
    "tab_id":   { "type": "string", "description": "Tab returned by browser_cdp_open." },
    "selector": { "type": "string", "description": "CSS selector of the input to fill." },
    "text":     { "type": "string", "description": "Text to type into the element." },
    "submit":   { "type": "boolean","description": "Press Enter after typing (default false)." },
    "page_url": { "type": "string", "description": "Current page URL — used for risk classification." }
  },
  "required": ["tab_id", "selector", "text"]
}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let tab_id = string_arg(&input, "tab_id")?;
        let selector = string_arg(&input, "selector")?;
        let text = string_arg(&input, "text")?;
        let submit = input.get("submit").and_then(|v| v.as_bool()).unwrap_or(false);
        let page_url = optional_string_arg(&input, "page_url").unwrap_or_default();

        let risk = action_risk(&page_url, &selector);
        if risk == RiskLevel::L4 {
            log::warn!(
                "[cdp:type] L4 action on sensitive page — tab={tab_id} sel={selector}"
            );
        }

        let result = cdp_type(&tab_id, &selector, &text, submit)
            .await
            .map_err(|e| e.to_string())?;

        serde_json::to_string(&result).map_err(|e| format!("serialise result: {e}"))
    })
}

inventory::submit! {
    ToolSpec {
        name: "browser_cdp_type",
        description: "Clear an input element and type text into it. \
            Set submit=true to press Enter after typing. \
            L4 risk on login/password pages — requires user confirmation.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalWrite,
        dangerous: true,
        invoke,
    }
}
