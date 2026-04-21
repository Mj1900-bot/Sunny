//! `messaging_list_chats` — list recent Messages conversations.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::usize_arg;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["macos.messaging"];

const SCHEMA: &str = r#"{"type":"object","properties":{"limit":{"type":"integer"}}}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let limit = usize_arg(&input, "limit");
        let chats = crate::messaging::list_chats(limit).await?;
        serde_json::to_string(&chats).map_err(|e| format!("chats encode: {e}"))
    })
}

inventory::submit! {
    ToolSpec {
        name: "messaging_list_chats",
        description: "List recent Messages conversations with participants.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke,
    }
}
