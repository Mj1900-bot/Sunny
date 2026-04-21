//! `agent_broadcast` — post a message into every sibling sub-agent's inbox.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::dialogue;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["agent.dialogue"];

const SCHEMA: &str = r#"{"type":"object","properties":{"message":{"type":"string","description":"Body to broadcast (max 4000 chars)."}},"required":["message"]}"#;

fn invoke<'a>(ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    let from = ctx
        .initiator
        .strip_prefix("agent:")
        .unwrap_or(dialogue::MAIN_AGENT_ID)
        .to_string();
    Box::pin(async move {
        let message_val = input.get("message").cloned().unwrap_or(Value::Null);
        let delivered = dialogue::broadcast_to_siblings(&from, message_val).await?;
        Ok(format!("broadcast delivered to {delivered} sibling(s)"))
    })
}

inventory::submit! {
    ToolSpec {
        name: "agent_broadcast",
        description: "Send a message into every sibling sub-agent's inbox in one call. Returns the count of inboxes delivered to. Shape matches `agent_message` but without the `to` field — the recipient set is your current sibling set (see `agent_list_siblings`). Use for announce-style coordination: 'I'm done researching, here are my findings'.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke,
    }
}
