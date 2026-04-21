//! `browser_cdp_read` — read visible text from a Chromium tab.
//!
//! Risk: L1 (read-only; no side effects).
//! Required capability: `browser:cdp`.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::{optional_string_arg, string_arg};
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};
use crate::browser::cdp::session::cdp_read;
use crate::security;

const CAPS: &[&str] = &["browser:cdp"];

const SCHEMA: &str = r#"{
  "type": "object",
  "properties": {
    "tab_id":   { "type": "string", "description": "Tab returned by browser_cdp_open." },
    "selector": { "type": "string", "description": "CSS selector; defaults to body (full page)." }
  },
  "required": ["tab_id"]
}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let tab_id = string_arg(&input, "tab_id")?;
        let selector = optional_string_arg(&input, "selector");

        let result = cdp_read(&tab_id, selector.as_deref())
            .await
            .map_err(|e| e.to_string())?;

        // Page text is attacker-controllable — run ingress scrub.
        security::ingress::inspect("browser_cdp_read", &result.text);
        let scrubbed_text = security::ingress::scrub_for_context(&result.text);

        let scrubbed_result = crate::browser::cdp::types::CdpText {
            text: scrubbed_text,
            ..result
        };
        serde_json::to_string(&scrubbed_result).map_err(|e| format!("serialise result: {e}"))
    })
}

inventory::submit! {
    ToolSpec {
        name: "browser_cdp_read",
        description: "Read visible text from a Chromium tab. \
            Optionally scoped to a CSS selector (defaults to full page body). \
            Output is capped at 16 000 chars and injection-scrubbed.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke,
    }
}
