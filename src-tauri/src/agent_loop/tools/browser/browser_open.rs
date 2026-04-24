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
        description: "Open a URL in the user's real Safari (AppleScript-driven). SIDE EFFECT — pops a visible tab on the user's screen and may steal focus. Use only when the user explicitly says 'open in Safari' or 'open in my browser'. Do NOT use to read a page's content (use web_fetch for text, or browser_cdp_* for JS-heavy pages). Do NOT use to silently 'visit' a site to check it works. URL must be http/https. Triggers a dangerous-action ConfirmGate on first use.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalWrite,
        dangerous: true,
        invoke,
    }
}
