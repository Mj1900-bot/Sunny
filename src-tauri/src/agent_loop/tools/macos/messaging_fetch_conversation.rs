//! `messaging_fetch_conversation` — fetch recent messages from a chat.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::{string_arg, usize_arg};
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["macos.messaging"];

const SCHEMA: &str = r#"{"type":"object","properties":{"chat_id":{"type":"string"},"limit":{"type":"integer"}},"required":["chat_id"]}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let chat_id = string_arg(&input, "chat_id")?;
        let limit = usize_arg(&input, "limit");
        let msgs = crate::messaging::fetch_conversation(chat_id, limit, None).await?;
        serde_json::to_string(&msgs).map_err(|e| format!("conversation encode: {e}"))
    })
}

inventory::submit! {
    ToolSpec {
        name: "messaging_fetch_conversation",
        description: "Fetch recent messages from a specific chat identifier. Pass the contact's name directly as chat_id; the tool resolves contacts internally. Do NOT call contacts_lookup first.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke,
    }
}
