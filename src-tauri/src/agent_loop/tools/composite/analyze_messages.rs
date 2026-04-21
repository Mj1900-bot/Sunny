//! Trait-registry adapter for `analyze_messages`.
//!
//! The composite implementation lives in
//! `agent_loop::analyze_messages`. This module wires it into the
//! `inventory::submit!` registry so `dispatch.rs` no longer needs a
//! match arm for it.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const SCHEMA: &str = r#"{"type":"object","properties":{"name":{"type":"string","description":"Person's name as it appears in Contacts (first name is fine if unique)"},"limit":{"type":"integer","description":"Max messages to analyse (default 500, hard cap 2000)"}},"required":["name"]}"#;

fn invoke<'a>(ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let (name, limit) = crate::agent_loop::analyze_messages::parse_input(&input)?;
        crate::agent_loop::analyze_messages::analyze_messages(
            ctx.app,
            &name,
            limit,
            ctx.session_id,
            ctx.depth,
        )
        .await
    })
}

inventory::submit! {
    ToolSpec {
        name: "analyze_messages",
        description: "Pull Sunny's full iMessage history with a named person and produce a written personal-relationship briefing: who they are (from context), rhythm of contact, recurring themes, open loops, emotional read, and facts to remember. Use this when Sunny says things like 'analyze my texts with Tomas', 'what have I been talking to Jane about', or 'give me a report on my conversation with X'. Composes contacts lookup + Messages.app chat.db query + a researcher sub-agent internally — Sunny should never have to ask for those three steps individually. Returns a plain-text briefing (600 words or less) suitable to speak aloud or write to a note.",
        input_schema: SCHEMA,
        required_capabilities: &["macos.messaging", "macos.contacts"],
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke,
    }
}
