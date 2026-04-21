//! `browser_open` — open a URL in Safari.
//!
//! Dangerous — drives the user's browser, so the spec flags
//! `dangerous: true` and the ConfirmGate intercepts the call
//! before dispatch lands here.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::string_arg;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["browser:open"];

const SCHEMA: &str =
    r#"{"type":"object","properties":{"url":{"type":"string"}},"required":["url"]}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let url = string_arg(&input, "url")?;
        crate::tools_browser::browser_open(url).await
    })
}

inventory::submit! {
    ToolSpec {
        name: "browser_open",
        description: "Open a URL in Safari.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalWrite,
        dangerous: true,
        invoke,
    }
}
