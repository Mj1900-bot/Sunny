//! `browser_read_page_text` — read visible text from the frontmost Safari tab.
//!
//! Output flows through the ingress scrub before being handed back to
//! the LLM — page text is attacker-controllable (prompt-injection via
//! a website's visible body), so the scrub mirrors the legacy
//! dispatcher's behaviour.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::usize_arg;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};
use crate::security;

const CAPS: &[&str] = &["browser:read"];

const SCHEMA: &str = r#"{"type":"object","properties":{}}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let max_chars = usize_arg(&input, "max_chars");
        let page = crate::tools_browser::browser_read_page_text(max_chars).await?;
        security::ingress::inspect("browser_read_page_text", &page);
        Ok(security::ingress::scrub_for_context(&page))
    })
}

inventory::submit! {
    ToolSpec {
        name: "browser_read_page_text",
        description: "Read visible text from the frontmost Safari tab.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke,
    }
}
