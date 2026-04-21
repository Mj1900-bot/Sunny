//! `browser_cdp_screenshot` — capture a PNG from a Chromium tab.
//!
//! Risk: L1 (read-only snapshot; writes only to ~/Downloads/sunny-browser/).
//! Required capability: `browser:cdp`.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::string_arg;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};
use crate::browser::cdp::session::cdp_screenshot;

const CAPS: &[&str] = &["browser:cdp"];

const SCHEMA: &str = r#"{
  "type": "object",
  "properties": {
    "tab_id":    { "type": "string",  "description": "Tab returned by browser_cdp_open." },
    "full_page": { "type": "boolean", "description": "Capture full scrollable page (default false = viewport only)." }
  },
  "required": ["tab_id"]
}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let tab_id = string_arg(&input, "tab_id")?;
        let full_page = input.get("full_page").and_then(|v| v.as_bool()).unwrap_or(false);

        let result = cdp_screenshot(&tab_id, full_page)
            .await
            .map_err(|e| e.to_string())?;

        serde_json::to_string(&result).map_err(|e| format!("serialise result: {e}"))
    })
}

inventory::submit! {
    ToolSpec {
        name: "browser_cdp_screenshot",
        description: "Capture a PNG screenshot of a Chromium tab. \
            Returns the absolute path to the saved file under ~/Downloads/sunny-browser/. \
            Set full_page=true for a full scrollable-page capture.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke,
    }
}
