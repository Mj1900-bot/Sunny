//! Trait-registry adapter for `web_browse`.
//!
//! The composite implementation lives in
//! `agent_loop::web_browse`. This module wires it into the
//! `inventory::submit!` registry so `dispatch.rs` no longer needs a
//! match arm for it.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const SCHEMA: &str = r#"{"type":"object","properties":{"start_url":{"type":"string","description":"URL to begin navigation from. Must start with http:// or https://."},"goal":{"type":"string","description":"What the sub-agent should achieve. Plain English."},"max_steps":{"type":"integer","description":"Hard cap on tool calls the sub-agent may make. Default 8, max 20."}},"required":["start_url","goal"]}"#;

fn invoke<'a>(ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let (start_url, goal, max_steps) = crate::agent_loop::web_browse::parse_input(&input)?;
        crate::agent_loop::web_browse::web_browse(
            ctx.app,
            &start_url,
            &goal,
            max_steps,
            ctx.session_id,
            ctx.depth,
        )
        .await
    })
}

inventory::submit! {
    ToolSpec {
        name: "web_browse",
        description: "Drive Safari to accomplish a navigation goal. Spawns a browser_driver sub-agent with access to browser_open, browser_read_page_text, web_extract_links, and web_fetch. The sub-agent navigates from `start_url` toward `goal` within a `max_steps` cap (default 8, max 20). Use when Sunny says 'open X and find me Y', 'look up the price on this site', 'browse to the docs page and tell me about Z'. Each `browser_open` call the sub-agent makes still goes through the user's confirm gate (dangerous tool), so Sunny retains control over Safari itself. Returns a short ANSWER + RELEVANT_URLS block.",
        input_schema: SCHEMA,
        required_capabilities: &["browser:open", "browser:read", "web:fetch"],
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke,
    }
}
